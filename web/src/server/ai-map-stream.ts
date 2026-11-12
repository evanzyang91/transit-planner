import "server-only";

/**
 * THE agent loop behind Ask AI (POST /api/ai/chat with mapTools: true).
 *
 * One loop, any provider. The loop decides WHAT happens (which tools run, what
 * text the user sees, when the turn is over); a small per-provider "stepper"
 * (anthropic.ts / gemini.ts) only knows HOW to make one model call ("step") and
 * stream it back in a neutral shape. Before this split, Anthropic and Gemini
 * each had their own copy of the loop, and they drifted (Gemini had no
 * tracing, no captions and text-only memory).
 *
 * What one turn looks like:
 *   user message → step 1 (model may write text and/or call tools)
 *                → run the tools → step 2 → … until the model answers.
 *
 * READ tools run on the server and return data to the model. WRITE tools are
 * resolved on the server (geometry looked up, inputs validated) and then sent
 * to the browser as `tool_call` events; data-changing ones only OPEN a confirm
 * UI there. Everything the browser receives is a MapChatEvent from the shared
 * contract in ~/lib/map-assistant-protocol.ts.
 *
 * The loop is transport-agnostic on purpose: tools are plain JSON-schema
 * definitions and the transcript is provider-neutral, so a different agent
 * runtime (e.g. the Python agents in ../transit-agents, over MCP) could drive
 * the same tools later without changing this contract.
 */

import type { LangfuseAgent } from "@langfuse/tracing";

import {
  HISTORY_LIMITS,
  isAnnotationToolName,
  isAppActionName,
  toolLabel,
  type ClientToolName,
  type MapChatEvent,
  type TranscriptBlock,
  type TranscriptMessage,
} from "~/lib/map-assistant-protocol";
import { blocksOf, isPlainObject, pairToolCalls, truncateText } from "./map-data/history";
import {
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  resolveWriteTool,
  runReadTool,
  type ToolContext,
} from "./map-data/tools";

// ── Tunables ──────────────────────────────────────────────────────────────────

/** Model calls with tools allowed per turn (the closing call is extra). */
export const MAX_TOOL_LOOPS = 8;
/**
 * Output budget per step. Claude Haiku 5.5 thinks by default and thinking
 * counts toward max_tokens, so this leaves room for thinking + a short reply
 * + tool arguments (a 2-sentence caption alone would fit in 300).
 */
export const STEP_MAX_TOKENS = 2048;
/** The closing call only describes what was drawn, so it gets a smaller cap. */
export const CLOSING_MAX_TOKENS = 1024;
/** text_reset notes are shown as one dim progress line. */
const NOTE_MAX_CHARS = 200;

export const REFUSAL_REPLY = "Sorry — I can't help with that request.";
export const CUT_SHORT_NOTE = "(Reply cut short.)";
export const OUT_OF_STEPS_REPLY =
  "I ran out of steps before finishing — try asking about a smaller area or one thing at a time.";
const EMPTY_REPLY_AFTER_DRAWING = "Done — it's on the map.";
const EMPTY_REPLY = "I don't have an answer for that — could you rephrase the question?";

/**
 * Sent with the closing call (see below). It lives in the USER side of the
 * conversation — a text block after the tool results — instead of the system
 * prompt, for two reasons:
 *  • the system prompt is cached; editing it for one call would throw away
 *    the cache for the whole conversation;
 *  • Claude's thinking blocks are only valid while everything before them is
 *    unchanged — editing `system` mid-turn would make the API reject them (400).
 * The main prompt says "DRAW what you mention" (map-data/prompt.ts, rule (a));
 * with no tools on this call that rule would gag the model, so this note lifts
 * it for this one call. (It used to cite an older "only say what you drew"
 * rule, which the 2026-11 prompt no longer has.)
 */
export const CLOSING_DIRECTIVE = `<system-reminder>
The map actions above have ALREADY been carried out and the user can see them. You have no tools for this reply, so do not try to draw anything else — and the "DRAW what you mention" rule is satisfied, because everything referenced above is already on the map.
In 1-3 short sentences, tell the user what is now on the map and what it shows, answering the question they actually asked. If a result says a dialog or card was only OPENED, say that it is waiting for them — never that it is done.
</system-reminder>`;

// ── The stepper contract (implemented in anthropic.ts and gemini.ts) ─────────

/** The two halves of the system prompt (buildMapAssistantPrompt). */
export interface MapSystemPrompt {
  /** Byte-identical across requests, so providers can cache it. */
  staticPrompt: string;
  /** Changes per request: network stats, what the user sees, today's date. */
  dynamicContext: string;
}

/** One message of the conversation as the loop holds it during a turn. */
export interface LoopMessage {
  role: "user" | "assistant";
  /** Provider-neutral view — the ONLY part that goes into the stored transcript. */
  blocks: TranscriptBlock[];
  /**
   * The provider's own encoding of this assistant message, sent back VERBATIM
   * on the next call of the SAME turn. Anthropic needs this: its thinking
   * blocks must be passed back unmodified inside a tool loop. Never stored,
   * never sent to the browser (thinking from earlier turns must not be replayed).
   */
  native?: { provider: string; content: unknown };
}

export type MapStepStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface MapStepUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache (cheap + fast). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the cache by this call. */
  cacheCreationTokens?: number;
}

export interface MapStepRequest {
  system: MapSystemPrompt;
  /** History + this turn so far, oldest first. Consecutive same-role messages are allowed. */
  messages: LoopMessage[];
  /** "auto": the model may call tools. "none": it must answer in words (closing call). */
  toolChoice: "auto" | "none";
  maxTokens: number;
  signal?: AbortSignal;
}

/** What a stepper streams while its model call runs. */
export type MapStepEvent =
  | { type: "text_delta"; text: string }
  /** A tool call has STARTED streaming — lets the UI show progress before its arguments arrive. */
  | { type: "tool_use_start"; id: string; name: string };

export interface MapStepResult {
  /** The reply's text and tool_use blocks, in order (thinking is NOT in here). */
  blocks: TranscriptBlock[];
  native?: LoopMessage["native"];
  stopReason: MapStepStopReason;
  usage?: MapStepUsage;
}

export interface MapErrorInfo {
  /** One user-facing sentence, e.g. "The AI service is overloaded — try again in a moment." */
  message: string;
  /** A few words for the "(Reply interrupted: …)" note kept in the transcript. */
  reason?: string;
  /** True when sending the same message again later may well work (429, 5xx, network). */
  retryable: boolean;
}

/**
 * The per-provider adapter. `step` streams ONE model call: it yields events
 * while the model writes, then RETURNS the final blocks.
 * 📖 Learn: async generators — `yield` hands out values one by one, and the
 * value of `return` arrives as the last `next()` result, with `done: true`.
 */
export interface MapStepper {
  readonly provider: string;
  readonly model: string;
  /** Request settings worth recording on each Langfuse generation (e.g. effort). */
  readonly modelParameters?: Record<string, string | number>;
  step(request: MapStepRequest): AsyncGenerator<MapStepEvent, MapStepResult, void>;
  /** Turn a thrown error into a user-facing message (uses the SDK's typed errors). */
  describeError(error: unknown): MapErrorInfo;
}

// ── What the loop emits ───────────────────────────────────────────────────────

/** The subset of MapChatEvent the loop produces (the route adds `start` and `done`). */
export type MapAgentEvent = Extract<
  MapChatEvent,
  { type: "status" | "text" | "text_reset" | "tool_call" | "error" | "turn" }
>;

export interface MapTurnResult {
  /** Same as the `turn` event: this turn's transcript, starting with the user message. */
  messages: TranscriptMessage[];
  /** The answer the user ended up seeing (text since the last text_reset). */
  answerText: string;
  outcome: "answered" | "error" | "aborted";
}

export interface RunMapAgentTurnParams {
  stepper: MapStepper;
  system: MapSystemPrompt;
  /** Earlier turns, already cleaned by sanitizeHistory. Never modified. */
  history: TranscriptMessage[];
  userMessage: string;
  ctx: ToolContext;
  /** Aborted when the user presses Stop or disconnects. */
  signal?: AbortSignal;
  /** Langfuse root observation ("map-assistant"). Omit for no tracing. */
  trace?: LangfuseAgent | null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

type ToolUseBlock = Extract<TranscriptBlock, { type: "tool_use" }>;

function isToolUse(block: TranscriptBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

function isClientToolName(name: string): name is ClientToolName {
  return isAnnotationToolName(name) || isAppActionName(name);
}

function statusEvent(id: string, tool: string, state: "running" | "done" | "error"): MapAgentEvent {
  return { type: "status", id, tool, label: toolLabel(tool), state };
}

/** The narration that turned out not to be the answer, as one short dim line. */
function textResetEvent(narration: string): MapAgentEvent {
  // Collapse every run of whitespace (newlines included) into one space.
  const oneLine = narration.replace(/\s+/g, " ").trim();
  return oneLine ? { type: "text_reset", note: truncateText(oneLine, NOTE_MAX_CHARS) } : { type: "text_reset" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What Langfuse records as a generation's input/output: the neutral view only. */
function neutralView(messages: LoopMessage[]): Array<{ role: string; content: TranscriptBlock[] }> {
  return messages.map((m) => ({ role: m.role, content: m.blocks }));
}

function usageDetails(usage: MapStepUsage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  // Langfuse's Anthropic price table uses these key names. Anthropic reports
  // `input_tokens` WITHOUT the cached part, so the three input numbers add up.
  const details: Record<string, number> = { input: usage.inputTokens, output: usage.outputTokens };
  if (usage.cacheReadTokens !== undefined) details.cache_read_input_tokens = usage.cacheReadTokens;
  if (usage.cacheCreationTokens !== undefined) details.cache_creation_input_tokens = usage.cacheCreationTokens;
  return details;
}

function logUsageInDevelopment(model: string, callName: string, usage: MapStepUsage | undefined): void {
  if (process.env.NODE_ENV !== "development" || !usage) return;
  // Lets you confirm prompt caching works without opening Langfuse: from the
  // 2nd call of a turn on, cacheRead should cover most of the prompt.
  console.debug(
    `[map-assistant] ${callName} (${model}) in=${usage.inputTokens} out=${usage.outputTokens}` +
      ` cacheRead=${usage.cacheReadTokens ?? 0} cacheWrite=${usage.cacheCreationTokens ?? 0}`,
  );
}

/** Cap one block for the stored transcript (HISTORY_LIMITS); null drops it. */
function capBlockForTranscript(block: TranscriptBlock): TranscriptBlock | null {
  if (block.type === "text") {
    if (block.text.trim() === "") return null; // the API rejects empty text blocks
    return { type: "text", text: truncateText(block.text, HISTORY_LIMITS.maxTextChars) };
  }
  if (block.type === "tool_result") {
    const capped: TranscriptBlock = {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: truncateText(block.content, HISTORY_LIMITS.maxToolResultChars),
    };
    if (block.is_error) capped.is_error = true;
    return capped;
  }
  return block;
}

/**
 * This turn's transcript for the browser to store: thinking dropped (it only
 * ever lived in `native`), long results truncated, and any tool call without
 * a result removed — so it is always valid to send back next time.
 */
export function buildTurnTranscript(turnMessages: LoopMessage[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const message of turnMessages) {
    const blocks: TranscriptBlock[] = [];
    for (const block of message.blocks) {
      const capped = capBlockForTranscript(block);
      if (capped) blocks.push(capped);
    }
    if (blocks.length > 0) messages.push({ role: message.role, content: blocks });
  }
  return pairToolCalls(messages);
}

// ── Running tools ─────────────────────────────────────────────────────────────

interface ToolOutcome {
  call: ToolUseBlock;
  kind: "read" | "write" | "unknown";
  /** false → the status line shows an error. */
  ok: boolean;
  /** A write the server refused — the model must hear about it and try again. */
  rejected: boolean;
  /** A write whose result the model must read and explain (e.g. run_simulation). */
  hasModelData: boolean;
  /** For the browser: what to draw / which app action to perform. */
  clientEvent?: Extract<MapAgentEvent, { type: "tool_call" }>;
  /** For the model: the tool_result block. */
  resultBlock: Extract<TranscriptBlock, { type: "tool_result" }>;
}

function toolResult(id: string, payload: unknown, isError = false): ToolOutcome["resultBlock"] {
  const block: ToolOutcome["resultBlock"] = {
    type: "tool_result",
    tool_use_id: id,
    // `?? null` because JSON.stringify(undefined) returns undefined, not a string.
    content: JSON.stringify(payload ?? null),
  };
  if (isError) block.is_error = true;
  return block;
}

/**
 * Run ONE tool call. Never throws and never rejects: several of these run at
 * the same time, and a rejected promise nobody is awaiting yet would crash the
 * Node process ("unhandled rejection"). Failures become error tool_results.
 */
async function executeToolCall(
  call: ToolUseBlock,
  ctx: ToolContext,
  trace: LangfuseAgent | null | undefined,
): Promise<ToolOutcome> {
  const kind: ToolOutcome["kind"] = WRITE_TOOL_NAMES.has(call.name)
    ? "write"
    : READ_TOOL_NAMES.has(call.name)
      ? "read"
      : "unknown";

  // One span per tool call: which tool ran, with what arguments, and what came
  // back. The benchmark finds READ calls through these spans, so the name is
  // the model's tool name and the input is the model's own arguments.
  const span = trace?.startObservation(
    call.name,
    { input: call.input, metadata: { kind: kind === "write" ? "write" : "read" } },
    { asType: "tool" },
  );
  const base = { call, kind, rejected: false, hasModelData: false };

  try {
    if (kind === "read") {
      const result = await runReadTool(call.name, call.input, ctx);
      span?.update({ output: result }).end();
      // Read tools report problems as data ({ error: "Census data unavailable…" }).
      const reportedError = isPlainObject(result) && typeof result.error === "string";
      return { ...base, ok: !reportedError, resultBlock: toolResult(call.id, result) };
    }

    if (kind === "write") {
      const resolution = await resolveWriteTool(call.name, call.input, ctx);
      if (resolution.status === "rejected") {
        // The model proposed something the server refused — the most useful
        // thing to spot in a trace.
        span?.update({ output: { error: resolution.error }, level: "WARNING" }).end();
        return {
          ...base,
          ok: false,
          rejected: true,
          resultBlock: toolResult(call.id, { error: resolution.error }, true),
        };
      }
      if (!isClientToolName(resolution.clientName)) {
        // A server bug, not the model's fault: don't let the model believe it drew.
        const error = `Internal error: '${resolution.clientName}' is not an action the map understands.`;
        span?.update({ output: { error }, level: "ERROR" }).end();
        return { ...base, ok: false, rejected: true, resultBlock: toolResult(call.id, { error }, true) };
      }
      const forModel: Record<string, unknown> = { status: "rendered_on_map" };
      // e.g. reset_network: "a dialog is open, nothing is deleted yet".
      if (resolution.modelNote) forModel.note = resolution.modelNote;
      // e.g. run_simulation: the numbers the model has to explain.
      if (resolution.modelData !== undefined) forModel.result = resolution.modelData;
      // Log the SERVER-resolved args — that is what actually reached the map.
      span?.update({ output: { status: "rendered_on_map", resolvedArgs: resolution.clientArgs } }).end();
      return {
        ...base,
        ok: true,
        hasModelData: resolution.modelData !== undefined,
        clientEvent: { type: "tool_call", name: resolution.clientName, args: resolution.clientArgs },
        resultBlock: toolResult(call.id, forModel),
      };
    }

    const error = `Unknown tool '${call.name}'.`;
    span?.update({ output: { error }, level: "ERROR" }).end();
    return { ...base, ok: false, rejected: true, resultBlock: toolResult(call.id, { error }, true) };
  } catch (err) {
    span?.update({ output: { error: errorText(err) }, level: "ERROR" }).end();
    return {
      ...base,
      ok: false,
      rejected: kind !== "read",
      resultBlock: toolResult(call.id, { error: errorText(err) }, true),
    };
  }
}

// ── The loop ──────────────────────────────────────────────────────────────────

/** Thrown inside the loop when the AbortSignal fires between steps. */
class MapTurnAborted extends Error {
  constructor() {
    super("The map assistant turn was stopped.");
    this.name = "MapTurnAborted";
  }
}

/**
 * Run one Ask AI turn. Yields MapChatEvents for the browser and finishes with
 * a `turn` event (also the return value). It does not throw for model or tool
 * failures: those become an `error` event followed by a transcript that ends
 * in "(Reply interrupted: …)", so a failed turn is still remembered.
 *
 * Rules, in the order they come up:
 *  • text streams to the user immediately;
 *  • when a step starts a READ tool after writing text, that text was
 *    narration ("Let me check Scarborough…"), not the answer → `text_reset`;
 *  • all tool calls of a step run at the same time (reads first — see
 *    runStepTools), but their events are sent in the model's order;
 *  • CAPTION ACCEPTANCE: a step that only drew (every call a write, all
 *    rendered) and also wrote text is finished — that text is the caption, and
 *    no extra model call is needed (saves ~1.2 s on most drawing turns);
 *  • a step that only drew but wrote NO text gets one closing call with tools
 *    switched off, so the model says what it drew;
 *  • anything else (reads, rejections, results to explain) → another step.
 */
export async function* runMapAgentTurn(
  params: RunMapAgentTurnParams,
): AsyncGenerator<MapAgentEvent, MapTurnResult, void> {
  const { stepper, system, ctx, signal, trace } = params;

  // History is never changed during the turn. Append-only matters twice:
  // the provider's prompt cache is a prefix match, and Claude rejects thinking
  // blocks whose earlier context was edited.
  const historyMessages: LoopMessage[] = params.history.map((m) => ({ role: m.role, blocks: blocksOf(m) }));
  const turnMessages: LoopMessage[] = [{ role: "user", blocks: [{ type: "text", text: params.userMessage }] }];

  /** Mirrors the browser's answer bubble: all text since the last text_reset. */
  let bubbleText = "";
  /** Text of the step that is streaming right now and not yet recorded. */
  let pendingStepText = "";
  /** Tool calls announced as "running" whose final status hasn't been sent yet. */
  const runningTools = new Map<string, string>();
  let renderedWrites = 0;
  let outcome: MapTurnResult["outcome"] = "answered";

  // ── one model call ──
  async function* runStep(
    callName: string,
    messages: LoopMessage[],
    toolChoice: "auto" | "none",
    maxTokens: number,
  ): AsyncGenerator<MapAgentEvent, { result: MapStepResult; visibleText: string }, void> {
    pendingStepText = "";
    /** This step's text that is still on screen (cleared by a mid-step reset). */
    let visibleText = "";

    const generation = trace?.startObservation(
      callName,
      {
        model: stepper.model,
        input: neutralView(messages),
        modelParameters: { ...stepper.modelParameters, max_tokens: maxTokens, tool_choice: toolChoice },
      },
      { asType: "generation" },
    );
    let generationOpen = generation !== undefined;

    let stepEvents: AsyncGenerator<MapStepEvent, MapStepResult, void> | undefined;
    let stepFinished = false;
    try {
      stepEvents = stepper.step({ system, messages, toolChoice, maxTokens, signal });
      while (true) {
        const next = await stepEvents.next();
        if (next.done) {
          stepFinished = true;
          const result = next.value;
          // usageDetails is what lets Langfuse compute this call's cost.
          generation
            ?.update({
              output: { content: result.blocks, stopReason: result.stopReason },
              usageDetails: usageDetails(result.usage),
            })
            .end();
          generationOpen = false;
          logUsageInDevelopment(stepper.model, callName, result.usage);
          return { result, visibleText };
        }

        const event = next.value;
        if (event.type === "text_delta") {
          if (event.text === "") continue;
          pendingStepText += event.text;
          visibleText += event.text;
          bubbleText += event.text;
          yield { type: "text", delta: event.text };
          continue;
        }

        // tool_use_start. A READ tool means the model is still researching, so
        // whatever it wrote before was narration: take it off the answer bubble.
        // (Text before a WRITE may be the caption, so it stays — see the end of the step.)
        if (READ_TOOL_NAMES.has(event.name) && visibleText.length > 0) {
          yield textResetEvent(visibleText);
          visibleText = "";
          bubbleText = "";
        }
        if (!runningTools.has(event.id)) {
          runningTools.set(event.id, event.name);
          yield statusEvent(event.id, event.name, "running");
        }
      }
    } catch (err) {
      generation?.update({ level: "ERROR", statusMessage: errorText(err) }).end();
      generationOpen = false;
      throw err;
    } finally {
      // Reached early when our own consumer stopped listening: ask the stepper
      // to close the provider's HTTP stream, and end the span (an unended span
      // is never exported). The value passed to return() is never read.
      if (!stepFinished && stepEvents) {
        await stepEvents.return(undefined as unknown as MapStepResult).catch(() => undefined);
      }
      if (generationOpen) generation?.update({ level: "WARNING", statusMessage: "stopped" }).end();
    }
  }

  // ── all tool calls of one step ──
  async function* runStepTools(calls: ToolUseBlock[]): AsyncGenerator<MapAgentEvent, ToolOutcome[], void> {
    // Some providers can't announce a call while it streams; do it now.
    for (const call of calls) {
      if (!runningTools.has(call.id)) {
        runningTools.set(call.id, call.name);
        yield statusEvent(call.id, call.name, "running");
      }
    }

    // Start every call at once, with one exception: WRITES wait until the
    // step's READS are done, because a write may cite what a read in the SAME
    // step computes (rank_service_areas + show_area("gap_1") in one go). Reads
    // take milliseconds, so the wait is small.
    const readByIndex = new Map<number, Promise<ToolOutcome>>();
    calls.forEach((call, index) => {
      if (!WRITE_TOOL_NAMES.has(call.name)) readByIndex.set(index, executeToolCall(call, ctx, trace));
    });
    // 📖 Learn: Promise.all — resolves once every promise in the list has. It
    // can't reject here because executeToolCall never rejects.
    const readsFinished = Promise.all(readByIndex.values());
    const pending: Array<Promise<ToolOutcome>> = calls.map(
      (call, index) => readByIndex.get(index) ?? readsFinished.then(() => executeToolCall(call, ctx, trace)),
    );

    // Report in the model's order, each as soon as it and everything before it is done.
    const outcomes: ToolOutcome[] = [];
    for (let index = 0; index < calls.length; index++) {
      const outcome = await pending[index]!;
      outcomes.push(outcome);
      if (outcome.clientEvent) {
        renderedWrites += 1;
        yield outcome.clientEvent;
      }
      runningTools.delete(outcome.call.id);
      yield statusEvent(outcome.call.id, outcome.call.name, outcome.ok ? "done" : "error");
    }
    return outcomes;
  }

  /** Close progress lines for calls that will never run (cut-off reply, refusal, failure). */
  function* closeRunningTools(): Generator<MapAgentEvent, void, void> {
    for (const [id, name] of runningTools) yield statusEvent(id, name, "error");
    runningTools.clear();
  }

  /** Add `text` to the last assistant message of the turn (or start one). */
  function appendAssistantText(text: string): void {
    const last = turnMessages[turnMessages.length - 1];
    if (last?.role === "assistant") {
      last.blocks = [...last.blocks, { type: "text", text }];
      last.native = undefined; // no longer what the model wrote; the turn is ending anyway
    } else {
      turnMessages.push({ role: "assistant", blocks: [{ type: "text", text }] });
    }
  }

  /** Show `text` as (part of) the answer. Callers record it in the transcript. */
  function* say(text: string): Generator<MapAgentEvent, void, void> {
    bubbleText += text;
    yield { type: "text", delta: text };
  }

  // ── terminal cases (each records how the turn ended) ──

  function* finishWithRefusal(): Generator<MapAgentEvent, void, void> {
    // A refusal can arrive mid-stream; the partial text must not count as an answer.
    if (bubbleText.length > 0) {
      yield { type: "text_reset" };
      bubbleText = "";
    }
    pendingStepText = "";
    yield* closeRunningTools();
    yield* say(REFUSAL_REPLY);
    turnMessages.push({ role: "assistant", blocks: [{ type: "text", text: REFUSAL_REPLY }] });
  }

  function* finishCutShort(result: MapStepResult): Generator<MapAgentEvent, void, void> {
    // The reply hit max_tokens. A tool call at the end may be cut off mid-JSON,
    // so none of this step's tools run; keep its text and say it was cut.
    pendingStepText = "";
    yield* closeRunningTools();
    turnMessages.push({ role: "assistant", blocks: result.blocks.filter((b) => b.type === "text") });
    yield* say(bubbleText.trim() ? ` ${CUT_SHORT_NOTE}` : CUT_SHORT_NOTE);
    appendAssistantText(CUT_SHORT_NOTE);
  }

  function* ensureVisibleAnswer(): Generator<MapAgentEvent, void, void> {
    if (bubbleText.trim()) return;
    if (bubbleText.length > 0) yield { type: "text_reset" }; // only whitespace on screen
    bubbleText = "";
    const fallback = renderedWrites > 0 ? EMPTY_REPLY_AFTER_DRAWING : EMPTY_REPLY;
    yield* say(fallback);
    appendAssistantText(fallback);
  }

  async function* closingCall(): AsyncGenerator<MapAgentEvent, void, void> {
    // Same conversation, plus the directive after the tool results — for this
    // call only. The stored transcript never contains it.
    const toolResults = turnMessages[turnMessages.length - 1]!;
    const closingMessages: LoopMessage[] = [
      ...historyMessages,
      ...turnMessages.slice(0, -1),
      { role: "user", blocks: [...toolResults.blocks, { type: "text", text: CLOSING_DIRECTIVE }] },
    ];
    // tool_choice "none" keeps the tool definitions (the history contains
    // tool_use blocks, which the API checks against them) but forbids calling
    // one, so the model can only answer in words.
    // 📖 Learn: Anthropic tool_choice — "auto" lets the model decide whether to
    // call a tool; "none" forbids calling while keeping the definitions in scope.
    const { result } = yield* runStep("closing-summary", closingMessages, "none", CLOSING_MAX_TOKENS);
    if (signal?.aborted) throw new MapTurnAborted();
    if (result.stopReason === "refusal") {
      yield* finishWithRefusal();
      return;
    }
    if (result.stopReason === "max_tokens") {
      yield* finishCutShort(result);
      return;
    }
    // Tools were switched off, so any tool call here is ignored (and its
    // progress line closed); only the words count.
    yield* closeRunningTools();
    pendingStepText = "";
    turnMessages.push({ role: "assistant", blocks: result.blocks.filter((b) => b.type === "text") });
    yield* ensureVisibleAnswer();
  }

  // ── the turn itself ──
  async function* runTurn(): AsyncGenerator<MapAgentEvent, void, void> {
    for (let loop = 1; loop <= MAX_TOOL_LOOPS; loop++) {
      if (signal?.aborted) throw new MapTurnAborted();

      const { result, visibleText } = yield* runStep(
        `llm-call-${loop}`,
        [...historyMessages, ...turnMessages],
        "auto",
        STEP_MAX_TOKENS,
      );
      // Stop pressed while the model was writing: don't run its tools.
      if (signal?.aborted) throw new MapTurnAborted();

      if (result.stopReason === "refusal") {
        yield* finishWithRefusal();
        return;
      }
      if (result.stopReason === "max_tokens") {
        yield* finishCutShort(result);
        return;
      }

      const calls = result.blocks.filter(isToolUse);
      turnMessages.push({ role: "assistant", blocks: result.blocks, native: result.native });
      pendingStepText = "";

      if (calls.length === 0) {
        // No tools → this step's text IS the answer (already streamed).
        yield* ensureVisibleAnswer();
        return;
      }

      const outcomes = yield* runStepTools(calls);
      turnMessages.push({ role: "user", blocks: outcomes.map((o) => o.resultBlock) });
      if (signal?.aborted) throw new MapTurnAborted();

      // Does the model need to see these results before the user gets an answer?
      const needsAnotherStep = outcomes.some((o) => o.kind !== "write" || o.rejected || o.hasModelData);
      if (!needsAnotherStep) {
        // Caption acceptance: it drew AND wrote its caption in the same step.
        if (visibleText.trim()) return;
        // It drew silently → one closing call for the caption.
        yield* closingCall();
        return;
      }

      // Going round again, so what this step wrote was narration after all.
      if (visibleText.length > 0) {
        yield textResetEvent(visibleText);
        bubbleText = "";
      }
    }

    // Every step called tools until the budget ran out; all their text was
    // narration — don't leave the user with silence.
    yield* say(OUT_OF_STEPS_REPLY);
    turnMessages.push({ role: "assistant", blocks: [{ type: "text", text: OUT_OF_STEPS_REPLY }] });
  }

  try {
    yield* runTurn();
  } catch (err) {
    const aborted = signal?.aborted === true || err instanceof MapTurnAborted;
    let info: MapErrorInfo;
    if (aborted) {
      info = { message: "Stopped.", reason: "stopped", retryable: false };
    } else {
      try {
        info = stepper.describeError(err);
      } catch {
        info = { message: errorText(err), retryable: false };
      }
      console.error("[map-assistant] turn failed:", err);
    }

    yield* closeRunningTools();
    if (!aborted) yield { type: "error", error: info.message, retryable: info.retryable };

    // Remember what the user saw, plus a note that the answer is incomplete.
    // Tool calls of the unfinished step have no results, so buildTurnTranscript
    // drops them; finished steps stay.
    const interrupted: TranscriptBlock[] = [];
    if (pendingStepText.trim()) interrupted.push({ type: "text", text: pendingStepText });
    interrupted.push({ type: "text", text: `(Reply interrupted: ${info.reason ?? info.message})` });
    turnMessages.push({ role: "assistant", blocks: interrupted });
    outcome = aborted ? "aborted" : "error";
  }

  yield* closeRunningTools();
  const messages = buildTurnTranscript(turnMessages);
  yield { type: "turn", messages };
  return { messages, answerText: bubbleText, outcome };
}
