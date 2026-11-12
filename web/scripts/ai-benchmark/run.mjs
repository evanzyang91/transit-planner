// Runs the Ask AI map-assistant benchmark as a Langfuse experiment against
// the dataset seeded by dataset.mjs (items defined in questions.mjs).
//
// The chat protocol (web/src/lib/map-assistant-protocol.ts) is STATELESS: the
// server keeps no conversation, so for each item this script plays the
// browser's part:
//   1. For every turn, POST /api/ai/chat with
//        { message, mapTools: true, networkRoutes?, ui?, history, benchmarkRunId, provider? }
//      `history` = every message from the earlier turns' {type:"turn"} events
//      (no assistantId / threadId any more), `ui` = the item's MapUiSnapshot
//      ("what the user sees"), benchmarkRunId = a fresh UUID per turn.
//   2. Read the SSE stream (conversation.mjs): start → status / text /
//      text_reset / tool_call (any order, repeated) → turn → done.
//      text_reset wipes the answer text streamed so far (it was mid-step
//      narration). An {type:"error"} event, an HTTP error, a timeout or a
//      missing turn / done event FAILS the item. Errors are recorded, never
//      thrown: the experiment runner silently SKIPS an item whose task throws,
//      so it would vanish from the pass rate instead of counting as a failure.
//   3. Two places a check can look (see questions.mjs):
//        - the client `tool_call` events from step 2 (CLIENT names such as
//          highlight_area, set_map_layers, show_simulation, propose_line);
//        - the Langfuse trace of the LAST turn, for items with expectTrace /
//          forbidTrace. Its root observation is named "map-assistant" and
//          carries metadata.benchmarkRunId; its TOOL children are every tool
//          the server ran, by SERVER name, with arguments. That is the only
//          place READ tools' arguments appear (rank_service_areas,
//          lookup_app_docs, …) — the stream just shows a `status` line.
//   4. Score (scoring.mjs) against the item's `expectedOutput`:
//        - invariants-pass (1/0) per item, pass-rate per run;
//        - latency, measured here from the moment the request is sent:
//          ttfb (first body byte), first status / map action, first answer
//          text, total (until `done`). Printed per turn and as p50/p90 at the
//          end, and stored as numeric Langfuse scores — per item
//          latency-<metric>-ms (last turn) + latency-total-max-ms, per run
//          latency-<metric>-p50-ms / -p90-ms — so runs can be compared.
//
// Usage (from web/, with the dev server already running on localhost:3000 and
// LANGFUSE_TRACING_DEV=true so it sends traces — the trace checks need them):
//   node scripts/ai-benchmark/dataset.mjs   # once after editing questions.mjs
//   node scripts/ai-benchmark/run.mjs
// Optional environment variables:
//   BENCHMARK_BASE_URL=https://your-preview.vercel.app
//   BENCHMARK_PROVIDER=gemini   (default: the server's own default provider;
//                                trace checks need that provider to emit the
//                                "map-assistant" trace too)
//   BENCHMARK_TURN_TIMEOUT_MS=180000   (one turn, including the whole stream)

import { config } from "dotenv";
import { resolve } from "node:path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseClient } from "@langfuse/client";
import { DATASET_NAME } from "./constants.mjs";
import {
  buildRequestBody,
  createTurnRecord,
  readTurnStream,
  resolveTurns,
  runConversation,
} from "./conversation.mjs";
import {
  LATENCY_METRICS,
  itemLatencyScores,
  itemNeedsTrace,
  runLatencyScores,
  scoreItem,
  summarizeLatency,
} from "./scoring.mjs";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE_URL = process.env.BENCHMARK_BASE_URL ?? "http://localhost:3000";
// undefined → let the server pick its default provider (what users get).
const PROVIDER = process.env.BENCHMARK_PROVIDER || undefined;
const KNOWN_PROVIDERS = ["anthropic", "gemini"];
// Generous on purpose: a simulation turn does real work. It only exists so a
// hung server fails one item instead of stalling the whole run forever.
const TURN_TIMEOUT_MS = Number(process.env.BENCHMARK_TURN_TIMEOUT_MS ?? 180_000);

// The app's own tracing needs this same span processor to deliver the
// experiment-run's own bookkeeping trace (see experiments-via-sdk.md) — this
// is a SEPARATE OTel pipeline from the one the app sets up for itself in
// src/instrumentation.ts, because this script runs as its own Node process.
const spanProcessor = new LangfuseSpanProcessor();
const otelSdk = new NodeSDK({ spanProcessors: [spanProcessor] });
otelSdk.start();

const langfuse = new LangfuseClient();

// ── Step 1+2: send one turn and record what the stream says ─────────────────

/** First part of an error response's body — usually {"error": "..."}. */
async function readErrorBody(res) {
  try {
    const body = await res.text();
    return body.slice(0, 300) || "(empty body)";
  } catch {
    return "(body unreadable)";
  }
}

/**
 * POSTs one message to /api/ai/chat and records the whole SSE stream into a
 * TurnRecord (conversation.mjs). Never throws: every failure lands in
 * `record.errors`, which fails the item.
 */
async function sendMessage({ message, networkRoutes, ui, history, benchmarkRunId }) {
  const record = createTurnRecord();
  const body = buildRequestBody({ message, networkRoutes, ui, history, benchmarkRunId, provider: PROVIDER });

  // 📖 Learn: performance.now() is a monotonic clock — unlike Date.now() it
  // never jumps when the computer's clock is adjusted, which makes it the
  // right tool for measuring durations.
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);

  try {
    const res = await fetch(`${BASE_URL}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // 📖 Learn: AbortSignal.timeout(ms) cancels the request — including a
      // body that is still streaming — once ms have passed.
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      record.errors.push(`/api/ai/chat returned HTTP ${res.status}: ${await readErrorBody(res)}`);
      return record;
    }
    // Timing marks, events and protocol checks all happen in here.
    await readTurnStream(res.body, record, elapsedMs);
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      record.errors.push(`turn timed out after ${TURN_TIMEOUT_MS / 1000} s`);
    } else {
      record.errors.push(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return record;
}

// ── Step 3: find the matching Langfuse trace and pull its tool spans ────────

/** The Observations API returns io fields as raw JSON strings; keep the raw text if one isn't JSON. */
function parseJsonOrRaw(text) {
  if (typeof text !== "string") return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Polls the Observations API for the "map-assistant" root observation tagged
 * with this benchmarkRunId, then fetches every TOOL observation on that trace.
 * Tracing is async/batched, so the trace may not be queryable the instant the
 * HTTP response finishes — hence the retry loop.
 *
 * @returns {Promise<{found: boolean, calls: Array<{name: string, args: unknown}>}>}
 */
async function fetchTraceToolCalls(benchmarkRunId, { attempts = 16, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { data: roots } = await langfuse.api.observations.getMany({
      name: "map-assistant",
      fields: "core,metadata",
      expandMetadata: "benchmarkRunId",
      // One run alone makes ~20 roots (one per turn) inside the 10-minute
      // window below, so 20 could miss ours; 100 leaves room for concurrent
      // runs and normal dev traffic.
      limit: 100,
      fromStartTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    const root = roots.find((o) => o.metadata?.benchmarkRunId === benchmarkRunId);
    if (root) {
      const { data: spans } = await langfuse.api.observations.getMany({
        traceId: root.traceId,
        type: "TOOL",
        // "name" lives in the `basic` field group, not `core` — omitting it
        // silently made every span's name undefined, so findCalls() never
        // matched anything (confirmed via a manual query: the underlying
        // tool calls were actually correct, only this lookup was broken).
        fields: "core,basic,io",
        limit: 50,
      });
      // The Observations API always returns io fields as raw JSON strings
      // (parseIoAsJson is deprecated/rejected) — parse before matching args.
      return { found: true, calls: spans.map((s) => ({ name: s.name, args: parseJsonOrRaw(s.input) })) };
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.warn(`  (warning) no trace found for benchmarkRunId ${benchmarkRunId} after ${attempts} attempts`);
  return { found: false, calls: [] };
}

// ── Printing ─────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (typeof ms !== "number") return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** One line per finished turn, as it happens (items run 3 at a time, so lines interleave — hence the item id). */
function printTurnLine(itemId, turnIndex, turnCount, record) {
  const { ttfbMs, firstUiEventMs, firstTextMs, totalMs } = record.latency;
  const parts = [
    `ttfb ${formatMs(ttfbMs)}`,
    `first status/action ${formatMs(firstUiEventMs)}`,
    `first text ${formatMs(firstTextMs)}`,
    `total ${formatMs(totalMs)}`,
  ];
  if (record.steps.length > 0) {
    const stepNames = record.steps.map((step) => (step.state === "error" ? `${step.tool} (error)` : step.tool));
    parts.push(`steps: ${stepNames.join(", ")}`);
  }
  if (record.toolCalls.length > 0) {
    parts.push(`map: ${record.toolCalls.map((call) => call.name).join(", ")}`);
  }
  const status = record.errors.length > 0 ? "ERR" : "ok ";
  console.log(`  [${status}] ${itemId} turn ${turnIndex + 1}/${turnCount}: ${parts.join(" | ")}`);
  for (const error of record.errors) {
    console.log(`        error: ${error}`);
  }
}

function printLatencySummary(summary) {
  console.log(
    `\nLatency per turn, measured by this script (${summary.okTurnCount} of ${summary.turnCount} turns ` +
      "finished without an error; the others are left out):",
  );
  console.log(`  ${"".padEnd(28)}${"n".padStart(4)}${"p50".padStart(10)}${"p90".padStart(10)}${"max".padStart(10)}`);
  for (const metric of LATENCY_METRICS) {
    const stats = summary.metrics[metric.key];
    console.log(
      `  ${metric.label.padEnd(28)}${String(stats.n).padStart(4)}` +
        `${formatMs(stats.p50).padStart(10)}${formatMs(stats.p90).padStart(10)}${formatMs(stats.max).padStart(10)}`,
    );
  }
}

// ── The experiment task Langfuse calls once per dataset item ────────────────

const task = async (item) => {
  const expectedOutput = item.expectedOutput ?? {};
  const turns = resolveTurns(item.input);

  // The multi-turn loop (history, one benchmarkRunId per turn, stop at the
  // first failed turn) lives in conversation.mjs so it can be tested offline.
  const conversation = await runConversation(turns, {
    send: sendMessage,
    onTurnDone: (turnIndex, record) => printTurnLine(item.id, turnIndex, turns.length, record),
  });
  const errors = [...conversation.errors];

  // Only the LAST turn's trace is ever scored, and only items that declare
  // expectTrace / forbidTrace need it — skip the lookup otherwise (also when
  // the item already failed) so it isn't slowed down by up to 32 s of polling.
  let traceToolCalls = [];
  let traceFound; // stays undefined when no lookup was attempted
  if (itemNeedsTrace(expectedOutput) && errors.length === 0) {
    try {
      const trace = await fetchTraceToolCalls(conversation.lastBenchmarkRunId);
      traceToolCalls = trace.calls;
      traceFound = trace.found;
    } catch (err) {
      errors.push(`Langfuse trace lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The shape scoring.mjs reads (documented at the top of that file).
  return {
    text: conversation.text,
    turnToolCalls: conversation.turnToolCalls,
    traceToolCalls,
    traceFound,
    errors,
    model: conversation.model,
    turns: conversation.turns,
  };
};

// Evaluator params come as { input, output, expectedOutput, metadata } — this
// is the SDK's own shape (@langfuse/client's EvaluatorParams), not something
// we chose; there's no wrapped "item" the way the task function receives one.
const invariantEvaluator = async ({ output, expectedOutput }) => {
  const failures = scoreItem(expectedOutput ?? {}, output);
  return {
    name: "invariants-pass",
    value: failures.length === 0 ? 1 : 0,
    comment: failures.length === 0 ? "all invariants held" : failures.join("; "),
  };
};

// Separate from the invariants on purpose: "was it right?" and "was it fast?"
// are different questions, and an evaluator may return several scores at once.
const latencyEvaluator = async ({ output }) => itemLatencyScores(output.turns ?? []);

const passRateEvaluator = async ({ itemResults }) => {
  const scores = itemResults.flatMap((r) => r.evaluations).filter((e) => e.name === "invariants-pass");
  const passed = scores.filter((s) => s.value === 1).length;
  return {
    // CreateScoreValue is number | string — no null — so default to 0 rather
    // than an unscored run if somehow no item produced a score.
    name: "pass-rate",
    value: scores.length ? passed / scores.length : 0,
    comment: `${passed}/${scores.length} items passed`,
  };
};

/** Every turn of every item that produced a result, for the run-wide latency stats. */
function allTurns(itemResults) {
  return itemResults.flatMap((r) => r.output?.turns ?? []);
}

const latencySummaryEvaluator = async ({ itemResults }) => runLatencyScores(summarizeLatency(allTurns(itemResults)));

async function main() {
  // Fail fast on bad settings: otherwise every single turn would fail later
  // with a confusing message (e.g. AbortSignal.timeout(NaN) throws).
  if (PROVIDER && !KNOWN_PROVIDERS.includes(PROVIDER)) {
    throw new Error(`BENCHMARK_PROVIDER must be one of ${KNOWN_PROVIDERS.join(", ")} (got "${PROVIDER}")`);
  }
  if (!Number.isInteger(TURN_TIMEOUT_MS) || TURN_TIMEOUT_MS <= 0) {
    throw new Error(
      `BENCHMARK_TURN_TIMEOUT_MS must be a whole number of milliseconds (got "${process.env.BENCHMARK_TURN_TIMEOUT_MS}")`,
    );
  }

  const dataset = await langfuse.dataset.get(DATASET_NAME);
  const result = await dataset.runExperiment({
    name: `ask-ai-benchmark-${new Date().toISOString()}`,
    description: "Regression run of the Ask AI map-assistant benchmark",
    // Stored on the dataset run, so runs against different servers/providers
    // can be told apart when comparing them in Langfuse.
    metadata: { baseUrl: BASE_URL, provider: PROVIDER ?? "server default" },
    task,
    evaluators: [invariantEvaluator, latencyEvaluator],
    runEvaluators: [passRateEvaluator, latencySummaryEvaluator],
    maxConcurrency: 3, // be gentle on the census raster / road-snap calls each turn makes
  });
  console.log(await result.format());

  console.log("\nPer-item detail:");
  for (const r of result.itemResults) {
    const evalResult = r.evaluations.find((e) => e.name === "invariants-pass");
    const mark = evalResult?.value === 1 ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${r.item.id} — ${evalResult?.comment ?? "no evaluation"}`);
  }

  printLatencySummary(summarizeLatency(allTurns(result.itemResults)));

  const models = [...new Set(result.itemResults.map((r) => r.output?.model).filter(Boolean))];
  console.log(`\nModel(s) reported by the server's start events: ${models.length > 0 ? models.join(", ") : "none"}`);

  await spanProcessor.forceFlush();
  await otelSdk.shutdown();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (err) => {
    console.error(err);
    await spanProcessor.forceFlush();
    await otelSdk.shutdown();
    process.exit(1);
  });
}
