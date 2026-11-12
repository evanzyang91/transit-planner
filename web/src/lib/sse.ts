/**
 * A small, correct reader for Server-Sent Events (SSE) delivered over `fetch`.
 *
 * Why not just `chunk.split("\n")`? The network does not deliver one event per
 * read. A read can end in the middle of a line, in the middle of a JSON object,
 * or even in the middle of a multi-byte character like "é" or "🚇". The old
 * chat parser split each read on its own, so any event cut in two was silently
 * dropped (shapes that never appeared, blank answers). This parser keeps the
 * unfinished part in a buffer until the rest arrives.
 *
 * 📖 Learn: SSE wire format — the body is plain text made of "frames". Each
 * frame is one or more `field: value` lines, and a BLANK line ends the frame:
 *
 *     data: {"type":"text","delta":"Hi"}
 *     <blank line>
 *
 * Lines can end with "\n", "\r\n" or a lone "\r". A frame may carry several
 * `data:` lines; they are joined with "\n". Lines starting with ":" are
 * comments (often used as keep-alive pings).
 *
 * Why not the browser's built-in `EventSource`? It can only make GET requests,
 * and the chat needs to POST a JSON body.
 */

export interface SSEParser {
  /** Feed the next piece of already-decoded text. Complete frames are dispatched right away. */
  feed(text: string): void;
  /** Call once when the stream has ended: dispatches a final frame that had no closing blank line. */
  end(): void;
}

/**
 * Creates a parser that calls `onData` with the joined `data:` payload of every
 * complete frame. It knows nothing about JSON — `readSSE` below adds that.
 * Exported separately so the line/frame logic can be unit-tested without streams.
 */
export function createSSEParser(onData: (data: string) => void): SSEParser {
  // Text received but not yet split into complete lines.
  let buffer = "";
  // `data:` values collected for the frame currently being read.
  let dataLines: string[] = [];

  function dispatchFrame() {
    if (dataLines.length === 0) return; // a frame with only comments / other fields
    const data = dataLines.join("\n");
    dataLines = [];
    onData(data);
  }

  function processLine(line: string) {
    if (line === "") {
      // A blank line ends the current frame.
      dispatchFrame();
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive

    // "field: value" — split on the FIRST colon only (JSON values contain colons).
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // The spec strips exactly one leading space after the colon, no more.
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    // `event:`, `id:` and `retry:` are valid SSE fields, but this app's server
    // puts everything in `data:` (the JSON has its own `type`), so they're ignored.
  }

  /**
   * Splits as many complete lines off the buffer as possible.
   * `streamEnded` matters for one edge case: a "\r" at the very end of the
   * buffer might be the first half of a "\r\n" whose "\n" is still in flight.
   */
  function drainLines(streamEnded: boolean) {
    let start = 0;
    while (start < buffer.length) {
      const lf = buffer.indexOf("\n", start);
      const cr = buffer.indexOf("\r", start);
      if (lf === -1 && cr === -1) break; // no complete line yet — keep the partial text

      // Whichever terminator comes first ends the line.
      const crComesFirst = cr !== -1 && (lf === -1 || cr < lf);
      if (crComesFirst) {
        const crIsLastChar = cr === buffer.length - 1;
        if (crIsLastChar && !streamEnded) break; // wait: the next read may start with "\n"
        processLine(buffer.slice(start, cr));
        const isCrLf = buffer[cr + 1] === "\n";
        start = cr + (isCrLf ? 2 : 1);
      } else {
        processLine(buffer.slice(start, lf));
        start = lf + 1;
      }
    }
    // Keep only the unfinished tail. (Slicing once per feed keeps this linear.)
    buffer = buffer.slice(start);
  }

  return {
    feed(text: string) {
      if (text === "") return;
      buffer += text;
      drainLines(false);
    },
    end() {
      drainLines(true);
      // Deliberately lenient: a last line without a newline still counts, and
      // a last frame without its closing blank line is still dispatched. (The
      // browser's EventSource would drop it; for a chat answer it is better to
      // try — a truncated JSON payload is then REPORTED by readSSE, not lost.)
      if (buffer !== "") {
        processLine(buffer);
        buffer = "";
      }
      dispatchFrame();
    },
  };
}

export interface ReadSSEOptions {
  /** Abort to stop reading. readSSE then rejects with the abort reason (an "AbortError"). */
  signal?: AbortSignal;
  /**
   * Called when a COMPLETE frame's data is not valid JSON. Defaults to
   * console.error — a broken frame is a server bug worth seeing, so it is never
   * dropped silently. Reading continues with the next frame either way.
   */
  onParseError?: (error: unknown, rawData: string) => void;
}

/**
 * Reads an SSE response to the end, calling `onEvent` with each frame's JSON
 * payload, in order. Frames whose data is "[DONE]" are skipped (an end marker
 * some servers send). Resolves when the stream ends; rejects if the network
 * fails or `opts.signal` is aborted. After an abort, no further events are
 * delivered, even ones that were already buffered.
 */
export async function readSSE(
  response: Response,
  onEvent: (data: unknown) => void,
  opts: ReadSSEOptions = {},
): Promise<void> {
  const { signal } = opts;
  const reportParseError =
    opts.onParseError ??
    ((error: unknown, rawData: string) => {
      console.error("[sse] Ignored a frame whose data is not valid JSON:", rawData.slice(0, 200), error);
    });

  if (!response.body) throw new Error("The response has no body to read.");
  // 📖 Learn: AbortSignal.throwIfAborted() throws signal.reason (a DOMException
  // named "AbortError" by default) if abort() was already called.
  signal?.throwIfAborted();

  const parser = createSSEParser((data) => {
    if (signal?.aborted) return; // never deliver events after Stop / New chat
    if (data.trim() === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      reportParseError(error, data);
      return;
    }
    onEvent(parsed); // outside the try: a bug in onEvent must not look like bad JSON
  });

  const reader = response.body.getReader();
  // 📖 Learn: TextDecoder with { stream: true } holds back the first bytes of a
  // multi-byte character that was cut between two reads, instead of turning
  // them into "�". The final decode() call (no arguments) flushes it.
  const decoder = new TextDecoder();

  // If the caller aborts while we are waiting in reader.read(), cancel the
  // reader so that read() returns immediately. (When the same signal was given
  // to fetch(), the body errors out on its own; this also covers bodies that
  // aren't tied to the signal, e.g. in tests.)
  const cancelOnAbort = () => {
    reader.cancel().catch(() => {
      /* already closed or errored — nothing left to cancel */
    });
  };
  signal?.addEventListener("abort", cancelOnAbort);

  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode()); // flush any held-back bytes
    parser.end();
    finished = true;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    // On an error or abort, release the network connection instead of leaving
    // the body half-read.
    if (!finished) {
      reader.cancel().catch(() => {
        /* already closed or errored */
      });
    }
  }
}
