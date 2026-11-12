import "server-only";

/**
 * The Ask AI conversation history, as the SERVER sees it.
 *
 * Since the 2026-11 rework the server is stateless: the browser keeps the chat
 * (localStorage) and sends it back as `history` with every message. That makes
 * the history UNTRUSTED input — it may be old, damaged, hand-edited, or simply
 * too big — and the Anthropic API rejects the whole request (HTTP 400) if even
 * one tool_use block is missing its tool_result. So before anything reaches a
 * model, `sanitizeHistory` turns whatever arrived into a transcript the API is
 * guaranteed to accept, applying HISTORY_LIMITS on the way.
 *
 * `rehydrateArtifacts` then rebuilds the server-side memory that a stateless
 * server loses between requests: the area polygons behind ids like "gap_1".
 *
 * The browser applies the same caps before sending (lib/map-assistant-history.ts)
 * so requests stay small; this file is the authoritative copy.
 */

import { HISTORY_LIMITS, type TranscriptBlock, type TranscriptMessage } from "~/lib/map-assistant-protocol";
import { runReadTool, type ToolContext } from "./tools";

// ── Small shared helpers (also used by the agent loop in ai-map-stream.ts) ───

/** Plain `{...}` object — not null, not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cut `text` to at most `max` characters, ending with "…" when it was cut.
 * Identical to the browser's truncateText, so both sides cut the same way.
 * 📖 Learn: UTF-16 surrogate pairs — an emoji is TWO JavaScript string units;
 * slicing between them leaves half a character, so we step back one unit.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1; // leave room for the ellipsis
  const lastKept = text.charCodeAt(end - 1);
  const isHighSurrogate = lastKept >= 0xd800 && lastKept <= 0xdbff;
  if (isHighSurrogate) end -= 1;
  return text.slice(0, end) + "…";
}

/** A message's content as a block array (a plain string is shorthand for one text block). */
export function blocksOf(message: TranscriptMessage): TranscriptBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

/** Size of a value as UTF-8 JSON — what HISTORY_LIMITS.maxBytes is measured in. */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// ── Limits that only matter for hostile input ────────────────────────────────

// Never even look at more than this many raw messages / blocks. Legit history
// is far smaller (12 turns × ~20 messages); this just bounds CPU on garbage.
const MAX_RAW_MESSAGES = 400;
const MAX_RAW_BLOCKS_PER_MESSAGE = 64;
// Tool arguments are small JSON objects (a few hundred chars). A huge one is
// either corrupt or an attempt to smuggle a giant payload into the prompt.
const MAX_TOOL_INPUT_CHARS = HISTORY_LIMITS.maxTextChars;
// Anthropic only accepts tool ids made of these characters; anything else
// would 400 the request, so it is dropped here instead.
const TOOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isValidToolId(value: unknown): value is string {
  return typeof value === "string" && TOOL_ID_PATTERN.test(value);
}

// ── Step 1: coerce raw JSON into well-formed messages ────────────────────────

/** One raw block → a clean block, or null if it isn't allowed in this role. */
function coerceBlock(
  raw: unknown,
  role: TranscriptMessage["role"],
  toolNames: Set<string>,
): TranscriptBlock | null {
  if (!isPlainObject(raw)) return null;

  if (raw.type === "text") {
    // The API rejects empty text blocks, so blank ones are dropped.
    if (typeof raw.text !== "string" || raw.text.trim() === "") return null;
    return { type: "text", text: truncateText(raw.text, HISTORY_LIMITS.maxTextChars) };
  }

  if (raw.type === "tool_use") {
    // Only the assistant calls tools, and only tools that still exist: the API
    // validates every historical tool_use name against today's `tools` list.
    if (role !== "assistant") return null;
    if (!isValidToolId(raw.id)) return null;
    if (typeof raw.name !== "string" || !toolNames.has(raw.name)) return null;
    if (!isPlainObject(raw.input)) return null;
    if (JSON.stringify(raw.input).length > MAX_TOOL_INPUT_CHARS) return null;
    return { type: "tool_use", id: raw.id, name: raw.name, input: raw.input };
  }

  if (raw.type === "tool_result") {
    if (role !== "user") return null;
    if (!isValidToolId(raw.tool_use_id)) return null;
    if (typeof raw.content !== "string") return null;
    const block: TranscriptBlock = {
      type: "tool_result",
      tool_use_id: raw.tool_use_id,
      content: truncateText(raw.content, HISTORY_LIMITS.maxToolResultChars),
    };
    if (raw.is_error === true) block.is_error = true;
    return block;
  }

  // Everything else — notably "thinking" / "redacted_thinking" — is dropped on
  // purpose: thinking from EARLIER turns must never be sent back to the model.
  return null;
}

function coerceMessages(raw: unknown, toolNames: Set<string>): TranscriptMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptMessage[] = [];

  for (const item of raw.slice(-MAX_RAW_MESSAGES)) {
    if (!isPlainObject(item)) continue;
    const role = item.role;
    if (role !== "user" && role !== "assistant") continue;

    let rawBlocks: unknown[];
    if (typeof item.content === "string") rawBlocks = [{ type: "text", text: item.content }];
    else if (Array.isArray(item.content)) rawBlocks = item.content.slice(0, MAX_RAW_BLOCKS_PER_MESSAGE);
    else continue;

    const blocks: TranscriptBlock[] = [];
    for (const rawBlock of rawBlocks) {
      const block = coerceBlock(rawBlock, role, toolNames);
      if (block) blocks.push(block);
    }
    if (blocks.length === 0) continue;

    if (role === "assistant") {
      out.push({ role, content: blocks });
      continue;
    }

    // A user message may mix tool results (answering the previous assistant
    // message) with new typed text. Split it in two — results first, as the
    // API requires — so a "turn" always starts at a text-only user message and
    // trimming at turn boundaries can never separate a tool call from its result.
    const results = blocks.filter((b) => b.type === "tool_result");
    const texts = blocks.filter((b) => b.type === "text");
    if (results.length > 0) out.push({ role: "user", content: results });
    if (texts.length > 0) out.push({ role: "user", content: texts });
  }
  return out;
}

// ── Step 2: every tool_use answered in the very next message ─────────────────

/**
 * Keep a tool_use only if the NEXT message is a user message holding a
 * tool_result with the same id; keep a tool_result only if the message right
 * before it asked for it. Strays on either side are dropped, along with any
 * message left empty.
 *
 * Also used by the agent loop to make a turn's transcript coherent after an
 * error or a cut-off reply (exported for that reason).
 */
export function pairToolCalls(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  // Tool ids must be unique across the whole conversation — a repeated id
  // (corrupt or forged history) is treated as unanswered.
  const usedIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const blocks = blocksOf(message);

    if (message.role === "user") {
      // A user message reached here was NOT consumed by the assistant branch
      // below, so any tool_result in it has no matching tool_use: drop those.
      const kept = blocks.filter((b) => b.type !== "tool_result");
      if (kept.length > 0) out.push({ role: "user", content: kept });
      continue;
    }

    // Assistant message. Which of its tool calls are answered next?
    const next = messages[i + 1];
    const answeredIds = new Set<string>();
    if (next?.role === "user") {
      for (const b of blocksOf(next)) if (b.type === "tool_result") answeredIds.add(b.tool_use_id);
    }

    const keptCallIds = new Set<string>();
    const keptAssistant = blocks.filter((b) => {
      if (b.type !== "tool_use") return true;
      const ok = answeredIds.has(b.id) && !usedIds.has(b.id) && !keptCallIds.has(b.id);
      if (ok) keptCallIds.add(b.id);
      return ok;
    });
    for (const id of keptCallIds) usedIds.add(id);
    if (keptAssistant.length > 0) out.push({ role: "assistant", content: keptAssistant });

    // Consume the next user message here, keeping one result per kept call.
    if (next?.role === "user") {
      const seenResultIds = new Set<string>();
      const keptNext = blocksOf(next).filter((b) => {
        if (b.type !== "tool_result") return true;
        const ok = keptCallIds.has(b.tool_use_id) && !seenResultIds.has(b.tool_use_id);
        if (ok) seenResultIds.add(b.tool_use_id);
        return ok;
      });
      if (keptNext.length > 0) out.push({ role: "user", content: keptNext });
      i += 1; // already handled
    }
  }

  return mergeConsecutiveAssistantMessages(out);
}

/**
 * Dropping a whole tool round can leave two assistant messages side by side;
 * join them so the transcript alternates cleanly. (Two user TEXT messages in a
 * row are left alone — each starts its own turn, e.g. a question whose answer
 * failed followed by the next question.)
 */
function mergeConsecutiveAssistantMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (previous?.role === "assistant" && message.role === "assistant") {
      out[out.length - 1] = { role: "assistant", content: [...blocksOf(previous), ...blocksOf(message)] };
    } else {
      out.push(message);
    }
  }
  return out;
}

// ── Step 3: whole user turns only ─────────────────────────────────────────────

/** A user message the person typed (not just tool results) — where a turn starts. */
export function isUserTextMessage(message: TranscriptMessage): boolean {
  return message.role === "user" && blocksOf(message).some((b) => b.type === "text");
}

/** Split a transcript into turns. Anything before the first user text is dropped. */
function groupIntoTurns(messages: TranscriptMessage[]): TranscriptMessage[][] {
  const turns: TranscriptMessage[][] = [];
  for (const message of messages) {
    if (isUserTextMessage(message)) turns.push([message]);
    else turns[turns.length - 1]?.push(message); // no current turn yet → dropped
  }
  return turns;
}

// ── The public entry point ────────────────────────────────────────────────────

/**
 * Turn untrusted client history into a transcript the model APIs will accept.
 *
 * Rules (in order):
 *  1. roles user/assistant only; block types text / tool_use / tool_result only
 *     (thinking and anything else is dropped); tool_use names must be in
 *     `toolNames`; texts and tool results are truncated to HISTORY_LIMITS;
 *  2. every assistant tool_use must be answered by a tool_result with the same
 *     id in the NEXT user message — unpaired calls/results are dropped;
 *  3. the history must start with a user message containing text;
 *  4. only the last `maxUserTurns` user turns are kept;
 *  5. the oldest whole turns are dropped until the JSON is ≤ `maxBytes`
 *     (possibly down to an empty history — better than a rejected request).
 *
 * Output messages always use block arrays (never the string shorthand), so
 * downstream code has one shape to handle.
 */
export function sanitizeHistory(raw: unknown, toolNames: Set<string>): TranscriptMessage[] {
  const coerced = coerceMessages(raw, toolNames);
  const paired = pairToolCalls(coerced);

  let turns = groupIntoTurns(paired).slice(-HISTORY_LIMITS.maxUserTurns);

  // Measure each turn once, then drop from the front. The array's JSON is the
  // sum of the messages plus "[", "]" and a comma between neighbours.
  const turnBytes = turns.map((turn) => turn.reduce((sum, m) => sum + jsonByteLength(m), 0));
  const totalBytes = (): number => {
    const messageCount = turns.reduce((n, turn) => n + turn.length, 0);
    const commas = Math.max(0, messageCount - 1);
    return 2 + commas + turnBytes.reduce((a, b) => a + b, 0);
  };
  while (turns.length > 0 && totalBytes() > HISTORY_LIMITS.maxBytes) {
    turns = turns.slice(1);
    turnBytes.shift();
  }

  return turns.flat();
}

// ── Rebuilding the artifact store ─────────────────────────────────────────────

const RANK_TOOL_NAME = "rank_service_areas";
/** Older rankings than this are rarely referenced; each replay costs a ranking. */
const MAX_REHYDRATE_CALLS = 3;

export interface RehydrateReport {
  /** rank_service_areas calls replayed against the CURRENT network. */
  replayed: number;
  /** Ids that were rebuilt but dropped because they no longer match the history. */
  forgotten: string[];
}

/** id → name pairs from a historical rank_service_areas result (empty if unreadable). */
function areaNamesFromResult(content: string | undefined): Array<[string, string]> {
  if (content === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Truncated (HISTORY_LIMITS) or not JSON: we can't confirm any id from it,
    // so its ids will be forgotten below — the model then re-runs the ranking.
    return [];
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.areas)) return [];
  const pairs: Array<[string, string]> = [];
  for (const area of parsed.areas) {
    if (isPlainObject(area) && typeof area.id === "string" && typeof area.name === "string") {
      pairs.push([area.id.trim().toLowerCase(), area.name]);
    }
  }
  return pairs;
}

/**
 * Rebuild `ctx.artifacts` from the history.
 *
 * Why: `show_area` cites ids like "gap_1" that a previous rank_service_areas
 * call produced. The server used to remember those polygons in memory; now it
 * is stateless, so a follow-up like "shade the second one" would fail with
 * "No areas computed yet". Ranking is deterministic and cached (gaps.ts), so
 * we simply re-run the most recent rankings from their recorded inputs.
 *
 * Safety check: the user may have edited their network since, which can move
 * or rename the area behind an id. Any id whose rebuilt name differs from the
 * name the model was shown (the historical tool_result) — or that the model
 * never saw at all — is forgotten, so show_area rejects it and the model
 * re-ranks instead of shading the wrong place.
 *
 * Replays run oldest → newest because ids repeat across rankings (each call
 * restarts at gap_1): the newest ranking must win, as it did for the model.
 */
export async function rehydrateArtifacts(
  history: TranscriptMessage[],
  ctx: ToolContext,
): Promise<RehydrateReport> {
  // Index the results first: a tool_result always comes after its tool_use.
  const resultContentById = new Map<string, string>();
  for (const message of history) {
    for (const block of blocksOf(message)) {
      if (block.type === "tool_result") resultContentById.set(block.tool_use_id, block.content);
    }
  }

  const calls: Array<{ input: Record<string, unknown>; resultContent: string | undefined }> = [];
  for (const message of history) {
    if (message.role !== "assistant") continue;
    for (const block of blocksOf(message)) {
      if (block.type === "tool_use" && block.name === RANK_TOOL_NAME) {
        calls.push({ input: block.input, resultContent: resultContentById.get(block.id) });
      }
    }
  }

  const recent = calls.slice(-MAX_REHYDRATE_CALLS);
  if (recent.length === 0) return { replayed: 0, forgotten: [] };

  // What the model believes each id is called, newest ranking winning.
  const expectedNames = new Map<string, string>();
  for (const call of recent) {
    try {
      // Sequential on purpose: each replay writes into the same store, and the
      // order decides which ranking an id like "gap_1" ends up pointing at.
      await runReadTool(RANK_TOOL_NAME, call.input, ctx);
    } catch (err) {
      console.warn("[map-assistant] rank_service_areas replay failed:", err);
    }
    for (const [id, name] of areaNamesFromResult(call.resultContent)) expectedNames.set(id, name);
  }

  const forgotten: string[] = [];
  for (const id of ctx.artifacts.knownIds) {
    const rebuilt = ctx.artifacts.get(id);
    const expected = expectedNames.get(id.trim().toLowerCase());
    if (!rebuilt || expected === undefined || expected !== rebuilt.name) {
      ctx.artifacts.forget(id);
      forgotten.push(id);
    }
  }
  return { replayed: recent.length, forgotten };
}
