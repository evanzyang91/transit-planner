/**
 * Pure helpers for the Ask AI conversation that lives in the BROWSER.
 *
 * Since the 2026-11 rework the server is stateless: the browser stores the
 * conversation in localStorage and sends the model-facing part back as
 * `history` with every message (see map-assistant-protocol.ts). This file holds
 * everything about that conversation that doesn't need React or the DOM:
 *
 *  • the stored shape (version 2) — what the chat SHOWS (display messages) and
 *    what the model REMEMBERS (one transcript chunk per turn), kept apart;
 *  • buildRequestHistory — applies HISTORY_LIMITS before sending;
 *  • migrateV1 — converts chats saved by the old client so they're remembered;
 *  • (de)serialisers with a version field, tolerant of damaged data.
 *
 * Why keep display messages and transcript separate? They answer different
 * questions. The display has UI-only things (progress steps, confirm cards,
 * error rows); the transcript has model-only things (tool calls and their raw
 * JSON results) that would be noise on screen.
 *
 * No React, no window, no localStorage in here — so it's easy to unit-test.
 */

import {
  HISTORY_LIMITS,
  parseAppAction,
  type DraftLine,
  type TranscriptBlock,
  type TranscriptMessage,
} from "./map-assistant-protocol";

export const CHAT_STORAGE_KEY = "ask-ai-chat-v2";
/** Written by the old useAnthropic hook. Read once, migrated, then removed. */
export const LEGACY_CHAT_STORAGE_KEY = "ask-ai-chat-v1";
export const CHAT_STORAGE_VERSION = 2;
/**
 * How many turns we keep in localStorage. More than the model gets
 * (HISTORY_LIMITS.maxUserTurns) so scrolling back still works, but bounded so a
 * long-lived chat can't eat the ~5 MB localStorage quota.
 */
export const MAX_STORED_TURNS = 40;

// ── Display model (what the chat panel renders) ──────────────────────────────

/** "stopped" is client-only: a step that was still running when the turn ended early. */
export type StepState = "running" | "done" | "error" | "stopped";

export interface ChatStep {
  id: string;
  /** "status" = a tool step from the server; "note" = narration moved out of the answer. */
  kind: "status" | "note";
  label: string;
  tool?: string;
  state: StepState;
}

/** What happened to a propose_line draft. Saved, so the choice survives a reload. */
export type DraftDecision =
  | { state: "pending" }
  | { state: "added"; routeId: string }
  | { state: "discarded" }
  /** "Add to map" was clicked but the map refused; the user may try again. */
  | { state: "failed"; error: string };

export interface DraftEntry {
  draft: DraftLine;
  decision: DraftDecision;
}

export interface UserChatMessage {
  id: string;
  role: "user";
  /** Shared by the user message, its reply, and the map annotations drawn for it. */
  turnId: string;
  text: string;
  createdAt: number;
}

export type AssistantStatus = "streaming" | "done" | "error" | "stopped";

export interface AssistantChatMessage {
  id: string;
  role: "assistant";
  turnId: string;
  /** The visible answer (markdown). */
  text: string;
  status: AssistantStatus;
  steps: ChatStep[];
  drafts: DraftEntry[];
  error?: { message: string; retryable: boolean };
  createdAt: number;
}

export type ChatMessage = UserChatMessage | AssistantChatMessage;

/** The model-facing transcript of ONE turn, starting with the user's message. */
export interface TurnTranscript {
  turnId: string;
  messages: TranscriptMessage[];
}

/** Exactly what is saved under CHAT_STORAGE_KEY. */
export interface StoredConversation {
  v: typeof CHAT_STORAGE_VERSION;
  savedAt: number;
  messages: ChatMessage[];
  transcript: TurnTranscript[];
}

// ── Small validation helpers ─────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cuts `text` to at most `max` characters, ending with "…" when it was cut.
 * Never splits an emoji in half (📖 Learn: UTF-16 surrogate pairs — characters
 * outside the Basic Multilingual Plane take TWO JavaScript string units).
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1; // leave room for the ellipsis
  const lastKept = text.charCodeAt(end - 1);
  const isHighSurrogate = lastKept >= 0xd800 && lastKept <= 0xdbff;
  if (isHighSurrogate) end -= 1;
  return text.slice(0, end) + "…";
}

/** Size of `value` as UTF-8 JSON — the same thing the server measures against maxBytes. */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// ── Transcript sanitising ────────────────────────────────────────────────────

/**
 * Returns a clean copy of one transcript block, or null if it isn't one of the
 * three provider-neutral block types. Anything else — notably Claude "thinking"
 * blocks — is dropped on purpose: thinking from EARLIER turns must never be
 * sent back to the model.
 */
export function sanitizeTranscriptBlock(raw: unknown): TranscriptBlock | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "text": {
      if (typeof raw.text !== "string" || raw.text.trim() === "") return null; // the API rejects empty text blocks
      return { type: "text", text: truncateText(raw.text, HISTORY_LIMITS.maxTextChars) };
    }
    case "tool_use": {
      if (typeof raw.id !== "string" || typeof raw.name !== "string" || !isRecord(raw.input)) return null;
      return { type: "tool_use", id: raw.id, name: raw.name, input: raw.input };
    }
    case "tool_result": {
      if (typeof raw.tool_use_id !== "string") return null;
      // Content should be a string; tolerate a JSON value by stringifying it.
      const content = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content ?? "");
      const block: TranscriptBlock = {
        type: "tool_result",
        tool_use_id: raw.tool_use_id,
        content: truncateText(content, HISTORY_LIMITS.maxToolResultChars),
      };
      if (raw.is_error === true) block.is_error = true;
      return block;
    }
    default:
      return null;
  }
}

/** Clean copy of one message, or null if it is malformed or ends up empty. */
export function sanitizeTranscriptMessage(raw: unknown): TranscriptMessage | null {
  if (!isRecord(raw)) return null;
  if (raw.role !== "user" && raw.role !== "assistant") return null;
  if (typeof raw.content === "string") {
    if (raw.content.trim() === "") return null;
    return { role: raw.role, content: truncateText(raw.content, HISTORY_LIMITS.maxTextChars) };
  }
  if (!Array.isArray(raw.content)) return null;
  const blocks: TranscriptBlock[] = [];
  for (const item of raw.content) {
    const block = sanitizeTranscriptBlock(item);
    if (block) blocks.push(block);
  }
  return blocks.length > 0 ? { role: raw.role, content: blocks } : null;
}

export function sanitizeTranscript(raw: unknown): TranscriptMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptMessage[] = [];
  for (const item of raw) {
    const message = sanitizeTranscriptMessage(item);
    if (message) out.push(message);
  }
  return out;
}

function blocksOf(message: TranscriptMessage): TranscriptBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

/** A user message the person typed (not just tool results) — where a "turn" starts. */
function isUserTextMessage(message: TranscriptMessage): boolean {
  return message.role === "user" && blocksOf(message).some((b) => b.type === "text");
}

/**
 * Makes every tool_use have its tool_result in the NEXT message, and every
 * tool_result have its tool_use in the PREVIOUS one, by dropping the strays.
 * The Anthropic API rejects a request with an unpaired block (400), which
 * would break every later message in the chat — so a damaged turn (cut off
 * mid-tool, trimmed, or hand-edited storage) is repaired instead.
 */
export function repairToolPairs(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    let blocks = blocksOf(message);

    if (message.role === "assistant") {
      const next = messages[i + 1];
      const answeredIds = new Set<string>();
      if (next?.role === "user") {
        for (const b of blocksOf(next)) if (b.type === "tool_result") answeredIds.add(b.tool_use_id);
      }
      blocks = blocks.filter((b) => b.type !== "tool_use" || answeredIds.has(b.id));
    } else {
      const previous = out[out.length - 1]; // already repaired
      const askedIds = new Set<string>();
      if (previous?.role === "assistant") {
        for (const b of blocksOf(previous)) if (b.type === "tool_use") askedIds.add(b.id);
      }
      blocks = blocks.filter((b) => b.type !== "tool_result" || askedIds.has(b.tool_use_id));
    }

    if (blocks.length === 0) continue; // nothing left — drop the message
    const unchanged = typeof message.content !== "string" && blocks.length === message.content.length;
    if (typeof message.content === "string" || unchanged) out.push(message);
    else out.push({ role: message.role, content: blocks });
  }
  return out;
}

// ── Building the request history ─────────────────────────────────────────────

/**
 * Turns the stored per-turn transcript into the `history` array for
 * MapChatRequest, applying the SAME caps the server enforces (HISTORY_LIMITS):
 *
 *  1. sanitise every message (truncate long text / tool results, drop unknown
 *     block types such as thinking);
 *  2. regroup into user turns (a turn starts at a user TEXT message — tool
 *     results are role "user" too, but they belong to the turn before);
 *  3. keep only the last `maxUserTurns` turns;
 *  4. drop the oldest whole turns until the JSON fits in `maxBytes`;
 *  5. repair tool_use / tool_result pairing.
 *
 * Whole turns are dropped, never half a turn, so a tool call is never
 * separated from its result.
 */
export function buildRequestHistory(turns: ReadonlyArray<TurnTranscript>): TranscriptMessage[] {
  const flat: TranscriptMessage[] = [];
  for (const turn of turns) flat.push(...sanitizeTranscript(turn.messages));

  // Step 2: regroup. Anything before the first user text message is dropped —
  // a history must start with something the user said.
  const userTurns: TranscriptMessage[][] = [];
  for (const message of flat) {
    if (isUserTextMessage(message)) userTurns.push([message]);
    else userTurns[userTurns.length - 1]?.push(message);
  }

  // Step 3: count cap.
  let kept = userTurns.slice(-HISTORY_LIMITS.maxUserTurns);

  // Step 4: byte cap, oldest first. (If even the newest turn alone is too big,
  // the history ends up empty — better than a request the server rejects.)
  // Measured in block-array form because that's how the server measures it
  // (it expands the "string = one text block" shorthand first) — so the
  // server never has to drop a turn the client decided to keep.
  const sizeAsServerMeasures = (turnsToMeasure: TranscriptMessage[][]) =>
    jsonByteLength(turnsToMeasure.flat().map((m) => ({ role: m.role, content: blocksOf(m) })));
  while (kept.length > 0 && sizeAsServerMeasures(kept) > HISTORY_LIMITS.maxBytes) {
    kept = kept.slice(1);
  }

  // Step 5.
  return repairToolPairs(kept.flat());
}

/**
 * The transcript recorded locally when a turn ends WITHOUT the server's `turn`
 * event: the user pressed Stop, the request failed before the server could
 * send it, or (reason "completed") a server that doesn't send `turn` at all.
 * Text-only, so it is always valid to send back.
 */
export function fallbackTurnTranscript(
  userText: string,
  partialAnswer: string,
  reason: "stopped" | "failed" | "completed",
): TranscriptMessage[] {
  const partial = partialAnswer.trim();
  let assistantText: string;
  if (reason === "completed") {
    assistantText = partial || "(No text reply — the answer was drawn on the map.)";
  } else {
    const marker =
      reason === "stopped" ? "(stopped by the user)" : "(the request failed before the answer was finished)";
    // Keeping the partial answer tells the model what the user already saw;
    // the marker tells it the answer is incomplete.
    assistantText = partial ? `${partial}\n\n${marker}` : marker;
  }
  return [
    { role: "user", content: truncateText(userText, HISTORY_LIMITS.maxTextChars) },
    { role: "assistant", content: truncateText(assistantText, HISTORY_LIMITS.maxTextChars) },
  ];
}

// ── Trimming what we store ───────────────────────────────────────────────────

/** Keeps the most recent `maxTurns` turns of both the display and the transcript. */
export function trimConversation<T extends { messages: ChatMessage[]; transcript: TurnTranscript[] }>(
  conversation: T,
  maxTurns: number,
): T {
  const orderedTurnIds: string[] = [];
  const seen = new Set<string>();
  for (const id of [...conversation.messages.map((m) => m.turnId), ...conversation.transcript.map((t) => t.turnId)]) {
    if (!seen.has(id)) {
      seen.add(id);
      orderedTurnIds.push(id);
    }
  }
  if (orderedTurnIds.length <= maxTurns) return conversation;
  const keep = new Set(orderedTurnIds.slice(-maxTurns));
  return {
    ...conversation,
    messages: conversation.messages.filter((m) => keep.has(m.turnId)),
    transcript: conversation.transcript.filter((t) => keep.has(t.turnId)),
  };
}

// ── Serialising (version 2) ──────────────────────────────────────────────────

export function serializeConversation(
  conversation: { messages: ChatMessage[]; transcript: TurnTranscript[] },
  now: number = Date.now(),
): string {
  const stored: StoredConversation = {
    v: CHAT_STORAGE_VERSION,
    savedAt: now,
    messages: conversation.messages,
    transcript: conversation.transcript,
  };
  return JSON.stringify(stored);
}

const STEP_STATES: readonly StepState[] = ["running", "done", "error", "stopped"];
const ASSISTANT_STATUSES: readonly AssistantStatus[] = ["streaming", "done", "error", "stopped"];

function parseStep(raw: unknown): ChatStep | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.label !== "string") return null;
  if (raw.kind !== "status" && raw.kind !== "note") return null;
  if (!STEP_STATES.includes(raw.state as StepState)) return null;
  // A step can't still be running after a reload — nothing is driving it.
  const state = raw.state === "running" ? "stopped" : (raw.state as StepState);
  const step: ChatStep = { id: raw.id, kind: raw.kind, label: raw.label, state };
  if (typeof raw.tool === "string") step.tool = raw.tool;
  return step;
}

function parseDecision(raw: unknown): DraftDecision {
  if (isRecord(raw)) {
    if (raw.state === "added" && typeof raw.routeId === "string") return { state: "added", routeId: raw.routeId };
    if (raw.state === "discarded") return { state: "discarded" };
    if (raw.state === "failed" && typeof raw.error === "string") return { state: "failed", error: raw.error };
  }
  return { state: "pending" };
}

function parseDraftEntry(raw: unknown): DraftEntry | null {
  if (!isRecord(raw) || !isRecord(raw.draft)) return null;
  // Reuse the protocol's own validator, so a stored draft is held to the same
  // rules as one fresh off the wire.
  const action = parseAppAction("propose_line", raw.draft);
  if (action?.name !== "propose_line") return null;
  return { draft: action.args, decision: parseDecision(raw.decision) };
}

function parseChatMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.turnId !== "string" || typeof raw.text !== "string") return null;
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : 0;
  if (raw.role === "user") {
    return { id: raw.id, role: "user", turnId: raw.turnId, text: raw.text, createdAt };
  }
  if (raw.role !== "assistant") return null;

  const savedStatus = ASSISTANT_STATUSES.includes(raw.status as AssistantStatus)
    ? (raw.status as AssistantStatus)
    : "done";
  const message: AssistantChatMessage = {
    id: raw.id,
    role: "assistant",
    turnId: raw.turnId,
    text: raw.text,
    // Saved mid-answer (e.g. the tab closed)? Nothing will finish it now.
    status: savedStatus === "streaming" ? "stopped" : savedStatus,
    steps: Array.isArray(raw.steps) ? raw.steps.map(parseStep).filter((s): s is ChatStep => s !== null) : [],
    drafts: Array.isArray(raw.drafts)
      ? raw.drafts.map(parseDraftEntry).filter((d): d is DraftEntry => d !== null)
      : [],
    createdAt,
  };
  if (isRecord(raw.error) && typeof raw.error.message === "string") {
    message.error = { message: raw.error.message, retryable: raw.error.retryable === true };
  }
  return message;
}

/**
 * Parses what serializeConversation wrote. Returns null for missing data,
 * invalid JSON or another version; damaged individual entries are skipped
 * rather than throwing the whole chat away.
 */
export function deserializeConversation(raw: string | null): StoredConversation | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== CHAT_STORAGE_VERSION) return null;
  if (!Array.isArray(parsed.messages) || !Array.isArray(parsed.transcript)) return null;

  const messages = parsed.messages.map(parseChatMessage).filter((m): m is ChatMessage => m !== null);
  const transcript: TurnTranscript[] = [];
  for (const item of parsed.transcript) {
    if (!isRecord(item) || typeof item.turnId !== "string") continue;
    const turnMessages = sanitizeTranscript(item.messages);
    if (turnMessages.length > 0) transcript.push({ turnId: item.turnId, messages: turnMessages });
  }
  return {
    v: CHAT_STORAGE_VERSION,
    savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    messages,
    transcript,
  };
}

// ── Migrating the old (v1) format ────────────────────────────────────────────

/** Used when a v1 turn has no saved reply text (the model only drew, or the request failed). */
export const V1_EMPTY_REPLY = "(No text reply was saved for this message.)";

/**
 * Converts the old `ask-ai-chat-v1` value — `{ assistantId, threadId,
 * messages: [{ role, content, turnId?, annotationIds?, contextReset? }] }` —
 * into version 2. The model's memory used to live on the server (and was lost
 * on every restart); here each old turn becomes a text-only transcript chunk,
 * so the assistant remembers old chats from now on.
 *
 * `raw` is the already-parsed JSON. Returns null if there is nothing usable.
 */
export function migrateV1(raw: unknown, now: number = Date.now()): StoredConversation | null {
  if (!isRecord(raw) || !Array.isArray(raw.messages)) return null;

  const messages: ChatMessage[] = [];
  const transcript: TurnTranscript[] = [];
  // The turn being collected: the user's text plus any replies to it.
  let current: { turnId: string; userText: string; replies: string[] } | null = null;

  function closeCurrentTurn() {
    if (!current) return;
    const reply = current.replies.join("\n\n").trim();
    transcript.push({
      turnId: current.turnId,
      messages: [
        { role: "user", content: truncateText(current.userText, HISTORY_LIMITS.maxTextChars) },
        { role: "assistant", content: truncateText(reply || V1_EMPTY_REPLY, HISTORY_LIMITS.maxTextChars) },
      ],
    });
    current = null;
  }

  raw.messages.forEach((item: unknown, index: number) => {
    if (!isRecord(item) || typeof item.content !== "string") return;
    const ownTurnId = typeof item.turnId === "string" && item.turnId ? item.turnId : null;

    if (item.role === "user") {
      if (item.content.trim() === "") return;
      closeCurrentTurn();
      // v1 gave the user message and its reply the SAME turnId, and the map
      // annotations carry it too — keeping it keeps their chips attached.
      const turnId = ownTurnId ?? `v1-turn-${index}`;
      messages.push({ id: `v1-${index}`, role: "user", turnId, text: item.content, createdAt: 0 });
      current = { turnId, userText: item.content, replies: [] };
    } else if (item.role === "assistant") {
      const turnId = ownTurnId ?? current?.turnId ?? `v1-turn-${index}`;
      messages.push({
        id: `v1-${index}`,
        role: "assistant",
        turnId,
        text: item.content,
        status: "done",
        steps: [],
        drafts: [],
        createdAt: 0,
      });
      // A reply with no question before it can't be sent back (a history must
      // start with the user), so it's only shown, not remembered.
      if (current) current.replies.push(item.content);
    }
  });
  closeCurrentTurn();

  if (messages.length === 0) return null;
  // Typed explicitly: inside the generic call TypeScript would widen `v: 2` to `number`.
  const migrated: StoredConversation = { v: CHAT_STORAGE_VERSION, savedAt: now, messages, transcript };
  return trimConversation(migrated, MAX_STORED_TURNS);
}

/**
 * Decides what to load given the raw localStorage values of both keys.
 * The v2 value wins; the v1 value is only migrated when there is no v2 one.
 */
export function loadStoredConversation(
  v2Raw: string | null,
  v1Raw: string | null,
): { conversation: StoredConversation | null; migratedFromV1: boolean } {
  const current = deserializeConversation(v2Raw);
  if (current) return { conversation: current, migratedFromV1: false };
  if (v1Raw) {
    try {
      const migrated = migrateV1(JSON.parse(v1Raw));
      if (migrated) return { conversation: migrated, migratedFromV1: true };
    } catch {
      // invalid JSON — nothing to migrate
    }
  }
  return { conversation: null, migratedFromV1: false };
}
