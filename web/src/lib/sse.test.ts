import { describe, expect, it, vi } from "vitest";
import { createSSEParser, readSSE } from "./sse";

// ── Helpers ──────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** A fetch-like Response whose body delivers exactly these byte chunks. */
function responseFromChunks(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream);
}

/** Cuts `bytes` at the given byte offsets (sorted, unique, inside the array). */
function splitAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of cuts) {
    chunks.push(bytes.slice(start, cut));
    start = cut;
  }
  chunks.push(bytes.slice(start));
  return chunks;
}

/**
 * Tiny seeded random generator (mulberry32) so a failing split is reproducible.
 * 📖 Learn: Math.random() can't be seeded, so tests that "randomise" use a PRNG.
 */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCuts(length: number, random: () => number): number[] {
  const cuts = new Set<number>();
  const howMany = Math.floor(random() * 40) + 1;
  for (let i = 0; i < howMany; i++) {
    cuts.add(1 + Math.floor(random() * (length - 1)));
  }
  return [...cuts].sort((a, b) => a - b);
}

async function collect(response: Response): Promise<unknown[]> {
  const events: unknown[] = [];
  await readSSE(response, (data) => events.push(data));
  return events;
}

// A realistic event mix: a big road-snapped corridor (~6 KB, like the one the
// old parser lost), multi-byte text, a CRLF frame, comments and [DONE].
const bigPath = Array.from({ length: 180 }, (_, i) => [-79.4 + i * 0.0011, 43.65 + i * 0.0007]);
const EVENTS: unknown[] = [
  { type: "start", model: "claude-haiku-5-5" },
  { type: "status", id: "s1", tool: "rank_service_areas", label: "Ranking service areas", state: "running" },
  { type: "text", delta: "Café on Bloor — 東京 has a great subway 🚇 too." },
  { type: "tool_call", name: "draw_corridor", args: { label: "Eglinton East", path: bigPath } },
  { type: "text", delta: " ✅ Done: ½ of the gap is now covered." },
  { type: "done" },
];

function wireFormat(): string {
  const [start, status, text1, toolCall, text2, done] = EVENTS.map((e) => JSON.stringify(e));
  return (
    ": keep-alive comment\n\n" +
    `data: ${start}\n\n` +
    `event: progress\nid: 7\ndata: ${status}\n\n` +
    `data: ${text1}\r\n\r\n` + // CRLF framing
    `data: ${toolCall}\n\n` +
    `data:${text2}\n\n` + // no space after the colon is also valid
    `data: ${done}\n\n` +
    "data: [DONE]\n\n"
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("readSSE", () => {
  it("delivers every frame's JSON in order when the body arrives in one piece", async () => {
    const events = await collect(responseFromChunks([encoder.encode(wireFormat())]));
    expect(events).toEqual(EVENTS);
  });

  it("survives 300 random chunk splits, including mid-JSON and mid-character cuts", async () => {
    const bytes = encoder.encode(wireFormat());
    for (let seed = 1; seed <= 300; seed++) {
      const random = seededRandom(seed);
      const chunks = splitAt(bytes, randomCuts(bytes.length, random));
      const events = await collect(responseFromChunks(chunks));
      expect(events, `split with seed ${seed}`).toEqual(EVENTS);
    }
  });

  it("survives 1-byte chunks (every possible cut at once)", async () => {
    const bytes = encoder.encode(wireFormat());
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    expect(await collect(responseFromChunks(chunks))).toEqual(EVENTS);
  });

  it("re-assembles a 4-byte emoji cut between two reads", async () => {
    const bytes = encoder.encode(`data: ${JSON.stringify({ type: "text", delta: "🚇" })}\n\n`);
    const emojiStart = bytes.indexOf(0xf0); // first byte of the 4-byte UTF-8 sequence
    expect(emojiStart).toBeGreaterThan(0);
    for (const cut of [emojiStart + 1, emojiStart + 2, emojiStart + 3]) {
      const events = await collect(responseFromChunks(splitAt(bytes, [cut])));
      expect(events).toEqual([{ type: "text", delta: "🚇" }]);
    }
  });

  it('treats "\\r" + "\\n" split across reads as ONE line ending', async () => {
    // Two data lines in ONE frame. A naive parser sees "\r" (end of line) and
    // then "\n" (another, blank line) and wrongly ends the frame early.
    const chunks = ["data: [1,\r", "\ndata: 2]\r\n\r\n"].map((s) => encoder.encode(s));
    expect(await collect(responseFromChunks(chunks))).toEqual([[1, 2]]);
  });

  it("accepts lone \\r line endings", async () => {
    const body = `data: {"a":1}\r\rdata: {"b":2}\r\r`;
    expect(await collect(responseFromChunks([encoder.encode(body)]))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("joins multi-line data fields with a newline", async () => {
    const body = 'data: {"type":"text",\ndata: "delta":"two lines"}\n\n';
    expect(await collect(responseFromChunks([encoder.encode(body)]))).toEqual([
      { type: "text", delta: "two lines" },
    ]);
  });

  it("dispatches a final frame that has no closing blank line", async () => {
    const body = 'data: {"type":"text","delta":"a"}\n\ndata: {"type":"done"}';
    expect(await collect(responseFromChunks([encoder.encode(body)]))).toEqual([
      { type: "text", delta: "a" },
      { type: "done" },
    ]);
  });

  it("reports a complete frame with invalid JSON and keeps reading", async () => {
    const body = 'data: {"type":"text","delta":"ok"}\n\ndata: {"type": oops}\n\ndata: {"type":"done"}\n\n';
    const onParseError = vi.fn();
    const events: unknown[] = [];
    await readSSE(responseFromChunks([encoder.encode(body)]), (e) => events.push(e), { onParseError });
    expect(events).toEqual([{ type: "text", delta: "ok" }, { type: "done" }]);
    expect(onParseError).toHaveBeenCalledTimes(1);
    expect(onParseError.mock.calls[0]?.[1]).toBe('{"type": oops}');
  });

  it("uses console.error for bad JSON when no handler is given (never silent)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined); // keep test output quiet
    await collect(responseFromChunks([encoder.encode("data: {broken\n\n")]));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("reports a stream that was cut off mid-JSON instead of dropping it", async () => {
    const onParseError = vi.fn();
    const onEvent = vi.fn();
    await readSSE(responseFromChunks([encoder.encode('data: {"type":"tex')]), onEvent, { onParseError });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onParseError).toHaveBeenCalledTimes(1);
  });

  it("stops delivering events after abort and rejects with an AbortError", async () => {
    const controller = new AbortController();
    // The body sends two frames in one chunk and then stays open forever.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: {"n":1}\n\ndata: {"n":2}\n\n'));
      },
    });
    const events: unknown[] = [];
    const reading = readSSE(
      new Response(stream),
      (e) => {
        events.push(e);
        controller.abort(); // e.g. the user pressed Stop while handling event 1
      },
      { signal: controller.signal },
    );
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual([{ n: 1 }]); // frame 2 was already buffered but never delivered
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const reading = readSSE(responseFromChunks([encoder.encode('data: {"n":1}\n\n')]), () => {
      throw new Error("must not be called");
    }, { signal: controller.signal });
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createSSEParser", () => {
  it("strips exactly one space after the colon", () => {
    const seen: string[] = [];
    const parser = createSSEParser((d) => seen.push(d));
    parser.feed("data:  two spaces\n\n");
    expect(seen).toEqual([" two spaces"]);
  });

  it("ignores frames that only contain comments or other fields", () => {
    const seen: string[] = [];
    const parser = createSSEParser((d) => seen.push(d));
    parser.feed(": ping\n\nevent: x\nid: 3\nretry: 100\n\n");
    parser.end();
    expect(seen).toEqual([]);
  });
});
