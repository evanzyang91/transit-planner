import { after, type NextRequest } from "next/server";
import { startObservation, type LangfuseSpan } from "@langfuse/tracing";

import type { MapChatEvent, TranscriptMessage } from "~/lib/map-assistant-protocol";
import { runMapAgentTurn, type MapStepper } from "~/server/ai-map-stream";
import { getProvider, DEFAULT_SYSTEM_PROMPT, type ChatMessage } from "~/server/ai-provider";
import { trackChatMessage } from "~/server/discord";
import { populationServedByNetwork } from "~/server/map-data/census";
import { blocksOf, isPlainObject, rehydrateArtifacts, sanitizeHistory } from "~/server/map-data/history";
import { buildNetwork } from "~/server/map-data/network";
import { buildMapAssistantPrompt, type CoverageContext } from "~/server/map-data/prompt";
import { ArtifactStore, MAP_TOOLS, type ToolContext } from "~/server/map-data/tools";
import { sanitizeUiSnapshot } from "~/server/map-data/ui-snapshot";
import { flushTracing, tracingEnabled } from "~/server/tracing";

export const dynamic = "force-dynamic";

/**
 * POST /api/ai/chat
 *
 * • `mapTools: true` → the Ask AI map assistant (body = MapChatRequest, events
 *   = MapChatEvent, both in ~/lib/map-assistant-protocol.ts). Only fields of
 *   MapChatRequest are read; each one is validated before use.
 * • otherwise → a plain streamed chat (legacy; the app no longer uses it).
 *
 * Both are STATELESS: the browser sends the conversation as `history` every
 * time. The server used to keep it in memory under an assistantId/threadId,
 * which a restart, hot reload or serverless hop wiped ("Unknown thread: …",
 * or the assistant silently forgetting). Those ids are now ignored.
 */

const MAX_MESSAGE_CHARS = 4000;
// Generous: the client's network alone can be ~0.5 MB with every bus route.
// This only stops absurd bodies before JSON.parse spends time on them.
const MAX_BODY_CHARS = 4_000_000;

// Tool names a history may mention — the API rejects tool_use blocks for
// tools that aren't in today's list.
const MAP_TOOL_NAMES = new Set(MAP_TOOLS.map((tool) => tool.name));

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform: proxies / compression must not buffer the stream.
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Same idea for nginx-style proxies, which buffer responses by default.
  "X-Accel-Buffering": "no",
};

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Run `task` after the response has finished streaming. 📖 Learn: Next.js
 * `after()` — the work runs once the user has their answer, and on serverless
 * the function is kept alive until it completes (a plain un-awaited promise
 * could be frozen mid-flight).
 */
function runAfterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    // after() needs a Next.js request scope with waitUntil support. Anywhere
    // else (e.g. a custom server) just start the task now.
    void task().catch((err) => console.error("[ai/chat] background task failed:", err));
  }
}

function clampMaxTokens(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(4096, Math.max(1, Math.round(value)));
}

/** Today's date in Toronto as YYYY-MM-DD — the user's local day, not UTC's. */
function torontoIsoDate(now: Date = new Date()): string {
  // 📖 Learn: Intl.DateTimeFormat formats a moment in any time zone;
  // formatToParts hands back the pieces so we can assemble them ourselves.
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A turn transcript for a turn that failed before the agent loop could record one. */
function interruptedTurn(userMessage: string, reason: string): TranscriptMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: userMessage }] },
    { role: "assistant", content: [{ type: "text", text: `(Reply interrupted: ${reason})` }] },
  ];
}

export async function POST(request: NextRequest) {
  // ── 1. Read and validate the body (untrusted: it comes from the browser) ──
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return jsonError(413, "Request body is too large.");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return jsonError(400, "Request body must be a JSON object.");
    body = parsed;
  } catch {
    return jsonError(400, "Request body must be valid JSON.");
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return jsonError(400, "message is required");
  if (message.length > MAX_MESSAGE_CHARS) {
    return jsonError(400, `message is too long (max ${MAX_MESSAGE_CHARS} characters)`);
  }

  // Ship Langfuse spans once the stream is finished — on success AND on error
  // (a trace of a failed turn is the one you most want). This used to be
  // awaited before closing the stream, which made the user wait for it.
  runAfterResponse(() => flushTracing());

  try {
    return body.mapTools === true
      ? mapChatResponse(request, body, message)
      : plainChatResponse(request, body, message);
  } catch (error) {
    // e.g. a provider whose API key is missing.
    console.error("AI chat API error:", error);
    return jsonError(500, error instanceof Error ? error.message : "Failed to process request");
  }
}

// ── The Ask AI map assistant ──────────────────────────────────────────────────

function mapChatResponse(request: NextRequest, body: Record<string, unknown>, message: string): Response {
  const providerName = typeof body.provider === "string" ? body.provider : undefined;
  // The model is pinned on the server for this surface (the body's `model` and
  // `maxTokens` are ignored), so a client can't pick an expensive one.
  const stepper = getProvider(providerName).createMapStepper({ tools: MAP_TOOLS });
  const benchmarkRunId =
    typeof body.benchmarkRunId === "string" && body.benchmarkRunId.length <= 200 ? body.benchmarkRunId : undefined;

  const host = request.headers.get("host");
  runAfterResponse(() => trackChatMessage(host, { message, model: stepper.model }));

  // Aborted when the user presses Stop, closes the tab, or the network drops.
  // The agent loop passes it to the model SDK and checks it between steps.
  const abort = new AbortController();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: MapChatEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true; // the client went away
        }
      };

      await runMapChatTurn({ body, message, stepper, benchmarkRunId, signal: abort.signal, send });

      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by a cancel — nothing to do
        }
      }
    },
    cancel() {
      // 📖 Learn: ReadableStream cancel() — called when the reader (here: the
      // HTTP response) goes away, e.g. the browser aborted the fetch.
      closed = true;
      abort.abort();
    },
  });

  // Returned straight away: the slow work (census coverage, prompt building,
  // the model) happens inside the stream, after the client has its first byte.
  return new Response(stream, { headers: SSE_HEADERS });
}

async function runMapChatTurn(args: {
  body: Record<string, unknown>;
  message: string;
  stepper: MapStepper;
  benchmarkRunId: string | undefined;
  signal: AbortSignal;
  send: (event: MapChatEvent) => void;
}): Promise<void> {
  const { body, message, stepper, benchmarkRunId, signal, send } = args;
  send({ type: "start", model: stepper.model });

  // Langfuse trace root for one map-assistant turn. "agent" rather than a plain
  // span: this is an autonomous tool-using loop, and that observation type is
  // what drives Langfuse's Agent Graph. The benchmark (scripts/ai-benchmark)
  // finds it by this exact name + metadata.benchmarkRunId, then reads its tool spans.
  const root = tracingEnabled
    ? startObservation(
        "map-assistant",
        { input: message, ...(benchmarkRunId ? { metadata: { benchmarkRunId } } : {}) },
        { asType: "agent" },
      )
    : null;

  let answerText = "";
  let turnSent = false;
  // A plain span, not a "tool" one — the benchmark counts tool spans as the
  // model's own tool calls. `let` so the error path can close it too.
  let prepare: LangfuseSpan | undefined;
  try {
    // ── 2. Ground the request: the user's live network, what they see, history ──
    prepare = root?.startObservation("prepare-context", { input: { provider: stepper.provider } });

    const network = buildNetwork(body.networkRoutes);
    const ui = sanitizeUiSnapshot(body.ui);
    const history = sanitizeHistory(body.history, MAP_TOOL_NAMES);
    const ctx: ToolContext = { network, artifacts: new ArtifactStore(), ui, signal, benchmarkRunId };

    // Both need the census raster; they share its (cached / in-flight) fetch.
    const [coverage, rehydrated] = await Promise.all([
      populationServedByNetwork(network),
      rehydrateArtifacts(history, ctx),
    ]);
    const coverageContext: CoverageContext | null = coverage
      ? {
          pctPopulationServed: coverage.pct,
          servedPopulation: coverage.servedPopulation,
          totalPopulation: coverage.totalPopulation,
        }
      : null;
    const system = buildMapAssistantPrompt({ network, coverage: coverageContext, ui, today: torontoIsoDate() });

    prepare
      ?.update({
        output: {
          historyMessages: history.length,
          rehydratedRankings: rehydrated.replayed,
          forgottenAreaIds: rehydrated.forgotten,
          coveragePct: coverage?.pct ?? null,
        },
      })
      .end();
    prepare = undefined;

    // ── 3. The agent loop ──
    for await (const event of runMapAgentTurn({
      stepper,
      system,
      history,
      userMessage: message,
      ctx,
      signal,
      trace: root,
    })) {
      // Track the visible answer the same way the browser does, for the trace.
      if (event.type === "text") answerText += event.delta;
      if (event.type === "text_reset") answerText = "";
      if (event.type === "turn") turnSent = true;
      send(event);
    }
  } catch (error) {
    // The loop reports model/tool failures as events itself, so this is a
    // failure while preparing the request (a bug, most likely).
    console.error("[ai/chat] map assistant failed:", error);
    const detail = error instanceof Error ? error.message : String(error);
    prepare?.update({ level: "ERROR", statusMessage: detail }).end();
    send({ type: "error", error: `The server couldn't prepare this request: ${detail}`, retryable: false });
    if (!turnSent) send({ type: "turn", messages: interruptedTurn(message, "server error") });
  } finally {
    send({ type: "done" });
    root?.update({ output: answerText }).end();
  }
}

// ── Plain chat (legacy, unused by the app — kept working) ─────────────────────

/** History → plain text messages (tool calls dropped), neighbours of the same role joined. */
function toPlainChatMessages(history: TranscriptMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of history) {
    const texts: string[] = [];
    for (const block of blocksOf(message)) {
      if (block.type === "text") texts.push(block.text);
    }
    const text = texts.join("\n\n");
    if (!text.trim()) continue;
    const previous = out[out.length - 1];
    if (previous?.role === message.role) previous.content += `\n\n${text}`;
    else out.push({ role: message.role, content: text });
  }
  return out;
}

function plainChatResponse(request: NextRequest, body: Record<string, unknown>, message: string): Response {
  const provider = getProvider(typeof body.provider === "string" ? body.provider : undefined);
  const model = typeof body.model === "string" && body.model ? body.model : "claude-haiku-4-5-20251001";
  const maxTokens = clampMaxTokens(body.maxTokens, 600);
  const system =
    typeof body.systemPrompt === "string" && body.systemPrompt.trim() ? body.systemPrompt : DEFAULT_SYSTEM_PROMPT;

  const host = request.headers.get("host");
  runAfterResponse(() => trackChatMessage(host, { message, model }));

  // An empty tool list drops every tool call from the history: plain chat is text only.
  const messages = toPlainChatMessages(sanitizeHistory(body.history, new Set()));
  const last = messages[messages.length - 1];
  if (last?.role === "user") last.content += `\n\n${message}`;
  else messages.push({ role: "user", content: message });

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        for await (const chunk of provider.streamDirect(system, messages, model, maxTokens)) {
          if (closed) break; // client gone — stop generating
          send(JSON.stringify({ type: "content", text: chunk }));
        }
        send("[DONE]");
      } catch (error) {
        console.error("Streaming error:", error);
        send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "Unknown error" }));
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
