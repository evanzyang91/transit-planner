// The CLIENT side of the Ask AI map-chat protocol, as the benchmark speaks it:
// build each request body, cut the SSE byte stream into events, and fold those
// events into one record per turn (answer text, map actions, progress steps,
// latency marks, errors).
//
// Nothing here touches the network, Langfuse or the real clock — run.mjs does
// the fetch() and passes in the response body plus a clock function — so all
// of it can be unit-tested offline (conversation.test.mjs).
//
// The protocol itself is defined in web/src/lib/map-assistant-protocol.ts
// (MapChatRequest, MapChatEvent, MapUiSnapshot). This file is plain JavaScript
// and can't import TypeScript types, so the shapes are restated in comments;
// questions.test.mjs imports the real contract to catch drift in tool names
// and layer ids.
//
// 📖 Learn: "stateless server" — the server forgets everything after each
// request. Like the browser, the benchmark keeps the conversation itself: each
// reply ends with a {type:"turn"} event holding that turn's messages, and the
// next request sends all of them back as `history`.

/**
 * How much of each tool_call's args the benchmark keeps. Some args are huge —
 * show_simulation carries the whole simulation result (a path per commuter),
 * highlight_area carries real polygons — and the task's output is uploaded to
 * Langfuse as the item's output, so it is trimmed first.
 *
 * Consequence for checks (scoring.mjs): argsMatch / argsContains only see the
 * first 30 items of any array and the first 2,000 characters of any string.
 * Upside: what Langfuse shows as the item's output is exactly what was scored.
 */
export const MAX_ARRAY_ITEMS_KEPT = 30;
export const MAX_STRING_CHARS_KEPT = 2_000;

// ── Item input → turns → request bodies ─────────────────────────────────────

/**
 * Turns a dataset item's `input` into the list of turns to send, filling in
 * networkRoutes / ui for turns that don't set their own.
 *
 * Two input shapes (see questions.mjs):
 *   { message, networkRoutes?, ui? }                  → one turn
 *   { turns: [{ message, networkRoutes?, ui? }, …] }  → several turns
 *
 * Why inherit: the real browser sends its live map state with EVERY message,
 * so a follow-up like "now shade it" happens on the same map as the question
 * before it. Item-level networkRoutes / ui (next to `turns`) are the starting
 * values.
 */
export function resolveTurns(input) {
  const rawTurns = Array.isArray(input.turns)
    ? input.turns
    : [{ message: input.message, networkRoutes: input.networkRoutes, ui: input.ui }];

  let networkRoutes = input.networkRoutes;
  let ui = input.ui;
  const turns = [];
  for (const rawTurn of rawTurns) {
    if (rawTurn.networkRoutes !== undefined) networkRoutes = rawTurn.networkRoutes;
    if (rawTurn.ui !== undefined) ui = rawTurn.ui;
    turns.push({ message: rawTurn.message, networkRoutes, ui });
  }
  return turns;
}

/**
 * The JSON body for POST /api/ai/chat (MapChatRequest in the contract).
 * There is no assistantId / threadId any more: the conversation travels in
 * `history`, so a server restart can't lose it.
 *
 * 📖 Learn: JSON.stringify leaves out every property whose value is
 * `undefined` — that is how the optional fields below get "omitted".
 */
export function buildRequestBody({ message, networkRoutes, ui, history, benchmarkRunId, provider }) {
  return {
    message,
    mapTools: true,
    // questions.mjs uses `networkRoutes: []` to mean "the default network",
    // but the API reads an explicit [] as an EMPTY map (Reset → Empty map),
    // so an empty list is left out instead. A non-empty list REPLACES the
    // default network: it stands for the user's whole map.
    networkRoutes: Array.isArray(networkRoutes) && networkRoutes.length > 0 ? networkRoutes : undefined,
    // What the user can see (MapUiSnapshot). Optional — older items have none.
    ui,
    // Every message from the earlier turns, oldest first; [] on the first turn.
    // No client-side trimming to HISTORY_LIMITS: benchmark conversations are a
    // couple of turns long, far below the caps (the server enforces them anyway).
    history: history ?? [],
    // Only this script sets it: tags the server's Langfuse trace so run.mjs can
    // find that trace again and check the READ tools.
    benchmarkRunId,
    // undefined → the server's default provider.
    provider,
  };
}

// ── SSE stream → events ──────────────────────────────────────────────────────

/**
 * Splits buffered SSE text into complete event payloads.
 *
 * 📖 Learn: Server-Sent Events (SSE) — each event is one or more "data: …"
 * lines followed by a blank line ("\n\n"). A network chunk can end in the
 * MIDDLE of an event, so the unfinished tail comes back as `rest`, to be glued
 * in front of the next chunk. (Splitting every chunk on its own is the bug the
 * old browser client had: a JSON line cut in two was silently dropped.)
 *
 * @param {string} buffer  leftover text from earlier chunks + the new chunk
 * @returns {{ payloads: string[], rest: string }}
 */
export function splitSseEvents(buffer) {
  const blocks = buffer.split("\n\n");
  // The last piece has no blank line after it (yet), so it may be incomplete.
  const rest = blocks.pop() ?? "";

  const payloads = [];
  for (const block of blocks) {
    const dataLines = [];
    for (const line of block.split("\n")) {
      // Lines that aren't "data:" (comments like ": ping", "event:", "id:")
      // carry nothing this protocol uses.
      if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length));
    }
    // Per the SSE spec, several data lines in one event are joined by "\n".
    if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
  }
  return { payloads, rest };
}

// ── Events → one turn record ─────────────────────────────────────────────────

/**
 * Everything the benchmark remembers about one turn.
 *
 * @typedef {object} TurnRecord
 * @property {string} text  The answer as the user ends up seeing it: only the
 *   text streamed since the last text_reset.
 * @property {Array<{name: string, args: object}>} toolCalls  The tool_call
 *   events (CLIENT names, e.g. highlight_area, set_map_layers), args trimmed by
 *   compactForLog.
 * @property {Array<{id: string, tool: string, label: string, state: string}>} steps
 *   Progress steps from `status` events (SERVER tool names), final state per id.
 * @property {string[]} notes  `note`s from text_reset events.
 * @property {string|undefined} model  From the `start` event.
 * @property {object[]|undefined} transcript  The messages from the `turn`
 *   event — what gets appended to the history for the next turn.
 * @property {string[]} errors  Anything that must FAIL the item.
 * @property {boolean} sawDone
 * @property {{ttfbMs?: number, firstUiEventMs?: number, firstTextMs?: number, totalMs?: number}} latency
 *   Milliseconds since the request was sent (see the mark* helpers below).
 */

/** @returns {TurnRecord} */
export function createTurnRecord() {
  return {
    text: "",
    toolCalls: [],
    steps: [],
    notes: [],
    model: undefined,
    transcript: undefined,
    errors: [],
    sawDone: false,
    latency: {
      ttfbMs: undefined,
      firstUiEventMs: undefined,
      firstTextMs: undefined,
      totalMs: undefined,
    },
  };
}

/**
 * "Time to first byte": the first chunk of the response BODY, not the headers.
 * For a streamed reply the headers alone show the user nothing; the first
 * chunk (normally the `start` event) is the earliest the UI can react.
 */
export function markFirstByte(record, elapsedMs) {
  if (record.latency.ttfbMs === undefined) record.latency.ttfbMs = elapsedMs;
}

/**
 * "First status / map action": the first `status` or `tool_call` event — the
 * first moment the UI shows something besides a spinner (a progress line or a
 * change on the map).
 */
function markFirstUiEvent(record, elapsedMs) {
  if (record.latency.firstUiEventMs === undefined) record.latency.firstUiEventMs = elapsedMs;
}

/** "Total": the `done` event — when the browser treats the reply as finished. */
function markDone(record, elapsedMs) {
  // Keep the FIRST done: a duplicate must not move the finish line.
  if (record.sawDone) return;
  record.sawDone = true;
  record.latency.totalMs = elapsedMs;
}

/**
 * Applies one raw SSE payload (the text after "data: ") to the record.
 * A payload that isn't valid JSON is a server bug, so it fails the item
 * instead of being skipped (skipping it could hide a lost tool_call).
 */
export function applySsePayload(record, payload, elapsedMs) {
  // The pre-2026-11 server ended with a bare "[DONE]" sentinel instead of a
  // {type:"done"} event; accept both so a run against an older deploy still
  // measures a total.
  if (payload === "[DONE]") {
    markDone(record, elapsedMs);
    return;
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    record.errors.push(`malformed SSE payload (not JSON): ${payload.slice(0, 200)}`);
    return;
  }
  applyEvent(record, event, elapsedMs);
}

/**
 * Folds one parsed MapChatEvent into the record. (A "reducer": current state +
 * one event → next state. Here the record is updated in place.)
 */
export function applyEvent(record, event, elapsedMs) {
  switch (event?.type) {
    case "start":
      record.model = event.model;
      break;

    case "status": {
      markFirstUiEvent(record, elapsedMs);
      // The server sends the same id again with state "done" / "error" when
      // the step finishes, so update that step instead of adding a duplicate.
      // A step that ends in "error" does NOT fail the item: a rejected tool is
      // often the expected outcome (see the edge-case items in questions.mjs).
      const existingStep = record.steps.find((step) => step.id === event.id);
      if (existingStep) {
        existingStep.state = event.state;
      } else {
        record.steps.push({ id: event.id, tool: event.tool, label: event.label, state: event.state });
      }
      break;
    }

    case "text":
      if (typeof event.delta === "string" && event.delta.length > 0) {
        // First text the user SAW, even if a text_reset removes it later —
        // it was on screen at that moment.
        if (record.latency.firstTextMs === undefined) record.latency.firstTextMs = elapsedMs;
        record.text += event.delta;
      }
      break;

    case "text_reset":
      // The text so far was mid-step narration ("Let me check Scarborough…"),
      // not the answer: the browser removes it, so the checks must not see it.
      record.text = "";
      if (typeof event.note === "string" && event.note.length > 0) record.notes.push(event.note);
      break;

    case "tool_call":
      markFirstUiEvent(record, elapsedMs);
      record.toolCalls.push({ name: event.name, args: compactForLog(event.args ?? {}) });
      break;

    case "turn":
      if (Array.isArray(event.messages)) {
        record.transcript = event.messages;
      } else {
        record.errors.push("protocol: turn event without a messages array");
      }
      break;

    case "error":
      record.errors.push(`server sent an error event: ${event.error}${event.retryable ? " (retryable)" : ""}`);
      break;

    case "done":
      markDone(record, elapsedMs);
      break;

    default:
      // Unknown events (or the old protocol's `metadata` event) are ignored on
      // purpose, so the server can add an event type without breaking this script.
      break;
  }
}

/**
 * Called once the stream has closed normally. Fills in the total if `done`
 * never came, and flags contract breaks: per the contract the server ALWAYS
 * ends a turn with `turn` then `done` — even after an error — and without the
 * `turn` event the browser can't store the turn, i.e. the assistant would
 * forget it (the very bug this protocol fixes).
 */
export function finishTurn(record, elapsedMs) {
  if (record.latency.totalMs === undefined) record.latency.totalMs = elapsedMs;
  if (!record.sawDone) {
    record.errors.push("protocol: the stream ended without a done event");
  }
  if (record.transcript === undefined) {
    record.errors.push("protocol: no turn event, so this turn could not be saved to the conversation history");
  }
}

/**
 * Reads a whole /api/ai/chat response body into the record, chunk by chunk,
 * then closes the turn (finishTurn). Rejects if the stream breaks (e.g. the
 * request timed out) — run.mjs turns that into an error on the record.
 *
 * @param {ReadableStream<Uint8Array>} body  the fetch() response body
 * @param {TurnRecord} record
 * @param {() => number} elapsedMs  ms since the request was sent; run.mjs
 *   passes a performance.now() clock, tests pass a fake one
 */
export async function readTurnStream(body, record, elapsedMs) {
  const reader = body.getReader();
  // 📖 Learn: TextDecoder with { stream: true } — a multi-byte character (like
  // "—", 3 bytes in UTF-8) can be split across two chunks; stream mode holds
  // the first bytes back until the rest arrive instead of printing "�".
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Every event in this chunk arrived at the same moment, so they all get
    // the same timestamp — the browser couldn't have seen any of them sooner.
    const chunkArrivedMs = elapsedMs();
    markFirstByte(record, chunkArrivedMs);
    buffer += decoder.decode(value, { stream: true });
    const { payloads, rest } = splitSseEvents(buffer);
    buffer = rest;
    for (const payload of payloads) applySsePayload(record, payload, chunkArrivedMs);
  }

  // Stream closed: flush the decoder, and parse a last event that wasn't
  // followed by a blank line (adding one completes it).
  buffer += decoder.decode();
  const { payloads } = splitSseEvents(`${buffer}\n\n`);
  const closedMs = elapsedMs();
  for (const payload of payloads) applySsePayload(record, payload, closedMs);
  finishTurn(record, closedMs);
}

// ── A whole conversation ─────────────────────────────────────────────────────

/**
 * Plays a multi-turn conversation the way the browser does: send a turn,
 * append its transcript to the history, send the next turn with that history,
 * and so on, stopping at the first failed turn.
 *
 * 📖 Learn: dependency injection — `send` is passed in instead of imported, so
 * run.mjs can hand it the real HTTP call and the tests a fake server.
 *
 * @param {Array<{message: string, networkRoutes?: unknown, ui?: object}>} turns  from resolveTurns
 * @param {object} options
 * @param {(request: {message: string, networkRoutes?: unknown, ui?: object, history: object[], benchmarkRunId: string}) => Promise<TurnRecord>} options.send
 * @param {(turnIndex: number, record: TurnRecord) => void} [options.onTurnDone]  e.g. print a progress line
 * @returns {Promise<{text: string, turnToolCalls: Array<Array<{name: string, args: object}>>, turns: object[], errors: string[], model: string|undefined, lastBenchmarkRunId: string|undefined}>}
 */
export async function runConversation(turns, { send, onTurnDone }) {
  let history = []; // the conversation so far, exactly as the browser would store it
  const turnToolCalls = []; // one array of client tool_calls per turn — needed to
  // check artifact-id consistency ACROSS turns, not just the final turn's calls.
  const turnSummaries = [];
  const errors = [];
  let text = "";
  let model;
  let lastBenchmarkRunId;

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    // A fresh id per TURN, not per item — reusing one id across turns would
    // make run.mjs's trace lookup match either turn's trace nondeterministically
    // for items whose expectations target a specific turn.
    lastBenchmarkRunId = crypto.randomUUID();
    const record = await send({ ...turn, history, benchmarkRunId: lastBenchmarkRunId });
    if (onTurnDone) onTurnDone(turnIndex, record);

    turnToolCalls.push(record.toolCalls);
    text = record.text;
    if (model === undefined) model = record.model;
    turnSummaries.push({
      message: turn.message,
      ok: record.errors.length === 0,
      // Kept so a failing turn's server trace can be found by hand in Langfuse
      // (filter observations on metadata.benchmarkRunId).
      benchmarkRunId: lastBenchmarkRunId,
      latency: record.latency,
      steps: record.steps,
      notes: record.notes,
      text: record.text,
    });
    for (const error of record.errors) {
      errors.push(turns.length > 1 ? `turn ${turnIndex + 1}: ${error}` : error);
    }

    // Remember the turn the way the browser does: append its transcript. A
    // NEW array each time, so the request that was already sent keeps the
    // history it really had.
    if (record.transcript) {
      history = [...history, ...record.transcript];
    }

    // A failed turn ends the conversation: the item has failed already, and a
    // follow-up asked on top of a broken turn would only add noise (and cost).
    if (record.errors.length > 0) break;
  }

  return { text, turnToolCalls, turns: turnSummaries, errors, model, lastBenchmarkRunId };
}

// ── Keeping the output small ─────────────────────────────────────────────────

/**
 * Returns a trimmed COPY of a JSON value: arrays cut to MAX_ARRAY_ITEMS_KEPT
 * items (plus one marker string saying how many were dropped), strings cut to
 * MAX_STRING_CHARS_KEPT characters. Objects keep all their keys.
 *
 * 📖 Learn: recursion — the function calls itself on each nested value, so it
 * handles any depth of objects-in-arrays-in-objects without special cases.
 */
export function compactForLog(value) {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_CHARS_KEPT) return value;
    const dropped = value.length - MAX_STRING_CHARS_KEPT;
    return `${value.slice(0, MAX_STRING_CHARS_KEPT)}…(+${dropped} chars)`;
  }

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS_KEPT).map((item) => compactForLog(item));
    if (value.length > MAX_ARRAY_ITEMS_KEPT) {
      kept.push(`…(+${value.length - MAX_ARRAY_ITEMS_KEPT} more items)`);
    }
    return kept;
  }

  if (value !== null && typeof value === "object") {
    const copy = {};
    for (const [key, nested] of Object.entries(value)) copy[key] = compactForLog(nested);
    return copy;
  }

  // numbers, booleans, null
  return value;
}
