// Runs the Ask AI map-assistant benchmark as a Langfuse experiment against
// the dataset seeded by dataset.mjs. For each item:
//   1. POST /api/ai/chat (mapTools: true) with a fresh, unique
//      `benchmarkRunId` and parse the SSE stream for `tool_call` events
//      (the only thing a REAL browser session ever sees).
//   2. Poll Langfuse's Observations API for the trace tagged with that
//      benchmarkRunId, to see the READ-tool calls the SSE stream can't show
//      (see ToolContext.benchmarkRunId in web/src/server/map-data/tools.ts —
//      only WRITE tools that actually render reach the client at all).
//   3. Score both against the item's `expectedOutput` invariants.
//
// Usage (from web/, with the dev server already running on localhost:3000):
//   node scripts/ai-benchmark/run.mjs
// Optional: BENCHMARK_BASE_URL=https://your-preview.vercel.app node scripts/ai-benchmark/run.mjs

import { config } from "dotenv";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseClient } from "@langfuse/client";
import { DATASET_NAME } from "./constants.mjs";

config({ path: resolve(process.cwd(), ".env.local") });

const BASE_URL = process.env.BENCHMARK_BASE_URL ?? "http://localhost:3000";

// The app's own tracing needs this same span processor to deliver the
// experiment-run's own bookkeeping trace (see experiments-via-sdk.md) — this
// is a SEPARATE OTel pipeline from the one the app sets up for itself in
// src/instrumentation.ts, because this script runs as its own Node process.
const spanProcessor = new LangfuseSpanProcessor();
const otelSdk = new NodeSDK({ spanProcessors: [spanProcessor] });
otelSdk.start();

const langfuse = new LangfuseClient();

// ── Step 1: call the chat endpoint and parse its SSE stream ─────────────────

/**
 * POSTs one message to /api/ai/chat and resolves once the stream ends.
 * Returns the WRITE tool_call events the client actually saw, the full
 * caption text, and the ids needed to keep a multi-turn conversation going.
 */
async function sendMessage({ message, networkRoutes, assistantId, threadId, benchmarkRunId }) {
  const res = await fetch(`${BASE_URL}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      mapTools: true,
      networkRoutes: networkRoutes ?? [],
      assistantId,
      threadId,
      benchmarkRunId,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`/api/ai/chat returned ${res.status}`);
  }

  const toolCalls = [];
  let text = "";
  let newAssistantId = assistantId;
  let newThreadId = threadId;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice("data: ".length);
      if (payload === "[DONE]") continue;
      const event = JSON.parse(payload);
      if (event.type === "metadata") {
        newAssistantId = event.assistantId;
        newThreadId = event.threadId;
      } else if (event.type === "tool_call") {
        toolCalls.push({ name: event.name, args: event.args });
      } else if (event.type === "text") {
        text += event.delta;
      }
    }
  }

  return { toolCalls, text, assistantId: newAssistantId, threadId: newThreadId };
}

// ── Step 2: find the matching Langfuse trace and pull its tool spans ────────

/**
 * Polls the Observations API for the "map-assistant" root observation tagged
 * with this benchmarkRunId, then fetches every observation on that trace.
 * Tracing is async/batched, so the trace may not be queryable the instant the
 * HTTP response finishes — hence the retry loop.
 */
async function fetchTraceToolCalls(benchmarkRunId, { attempts = 16, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { data: roots } = await langfuse.api.observations.getMany({
      name: "map-assistant",
      fields: "core,metadata",
      expandMetadata: "benchmarkRunId",
      limit: 20,
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
      return spans.map((s) => ({ name: s.name, args: JSON.parse(s.input) }));
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.warn(`  (warning) no trace found for benchmarkRunId ${benchmarkRunId} after ${attempts} attempts`);
  return [];
}

// ── Step 3: score a call's tool calls + text against expectedOutput ─────────

function argsMatch(actual, expected) {
  return Object.entries(expected).every(([k, v]) => {
    if (Array.isArray(v)) return Array.isArray(actual?.[k]) && v.every((x, i) => x === actual[k][i]);
    return actual?.[k] === v;
  });
}

function findCalls(calls, { name, argsMatch: expected }) {
  return calls.filter((c) => c.name === name && (!expected || argsMatch(c.args, expected)));
}

function scoreItem(eo, { turnToolCalls, traceToolCalls, text }) {
  const failures = [];
  const clientToolCalls = turnToolCalls[turnToolCalls.length - 1];

  if (eo.expectArtifactConsistency) {
    // Checks that a LATER turn never substitutes a different artifact id for
    // the one a tool call already used — NOT that it must redraw at all. This
    // assistant draws immediately whenever it names an area (see the system
    // prompt's "anything you mention you MUST draw in the SAME reply" rule),
    // so a first-turn "which is best served" question already draws something;
    // a follow-up like "shade that too" may reasonably skip redrawing rather
    // than repeat itself. What must never happen is drawing something ELSE.
    const { tool } = eo.expectArtifactConsistency;
    const firstCall = turnToolCalls[0]?.find((c) => c.name === tool);
    if (!firstCall) {
      failures.push(`expected turn 1 to call ${tool}, none found`);
    } else {
      const laterCall = turnToolCalls.slice(1).flat().find((c) => c.name === tool);
      if (laterCall && laterCall.args?.areaId !== firstCall.args?.areaId) {
        failures.push(
          `later turn's ${tool} used areaId "${laterCall.args?.areaId}", inconsistent with turn 1's "${firstCall.args?.areaId}"`,
        );
      }
    }
  }

  for (const exp of eo.expectTrace ?? []) {
    if (findCalls(traceToolCalls, { name: exp.tool, argsMatch: exp.argsMatch }).length === 0) {
      failures.push(`expected trace call to ${exp.tool} matching ${JSON.stringify(exp.argsMatch ?? {})}, not found`);
    }
  }
  for (const forb of eo.forbidTrace ?? []) {
    if (findCalls(traceToolCalls, { name: forb.tool, argsMatch: forb.argsMatch }).length > 0) {
      failures.push(`forbidden trace call to ${forb.tool} matching ${JSON.stringify(forb.argsMatch ?? {})} occurred`);
    }
  }
  for (const exp of eo.expectToolCalls ?? []) {
    if (findCalls(clientToolCalls, exp).length === 0) {
      failures.push(`expected client tool_call ${exp.name} matching ${JSON.stringify(exp.argsMatch ?? {})}, not found`);
    }
  }
  for (const forb of eo.forbidToolCalls ?? []) {
    if (findCalls(clientToolCalls, forb).length > 0) {
      failures.push(`forbidden client tool_call ${forb.name} occurred`);
    }
  }
  if (eo.expectToolCallCount) {
    const { name, min } = eo.expectToolCallCount;
    const count = clientToolCalls.filter((c) => c.name === name).length;
    if (count < min) failures.push(`expected >= ${min} ${name} calls, got ${count}`);
  }
  if (eo.textChecks?.forbidQuestionMark && text.includes("?")) {
    failures.push(`caption asked a clarifying question: "${text}"`);
  }
  if (eo.textChecks?.forbidNarration) {
    // The prompt's exact examples of forbidden narration: "I'll shade…", "Let me…".
    const narrationPattern = /\b(I'll|I will|Let me|Now I'll|Now I will)\b/i;
    const match = text.match(narrationPattern);
    if (match) {
      failures.push(`caption narrates intentions ("${match[0]}"), violating "never narrate intentions": "${text}"`);
    }
  }
  if (eo.textChecks?.maxSentences) {
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    if (sentences > eo.textChecks.maxSentences) {
      failures.push(`caption has ${sentences} sentences, expected <= ${eo.textChecks.maxSentences}: "${text}"`);
    }
  }

  return failures;
}

// ── The experiment task Langfuse calls once per dataset item ────────────────

const task = async (item) => {
  let assistantId, threadId;
  const turnToolCalls = []; // one array of client tool_calls per turn — needed to
  // check artifact-id consistency ACROSS turns, not just the final turn's calls.
  let text = "";
  let lastBenchmarkRunId;

  // Only the LAST turn's trace is ever scored (scoreItem reads a single
  // `traceToolCalls`), and only items that actually declare expectTrace /
  // forbidTrace need it at all — skip the lookup otherwise so items that
  // don't need it aren't slowed down or spuriously warned about.
  const needsTrace = Boolean(item.expectedOutput.expectTrace ?? item.expectedOutput.forbidTrace);

  const turns = item.input.turns ?? [{ message: item.input.message, networkRoutes: item.input.networkRoutes }];
  for (const turn of turns) {
    // A fresh id per TURN, not per item — reusing one id across turns would
    // make fetchTraceToolCalls's `.find()` match either turn's trace
    // nondeterministically for items whose expectations target a specific turn.
    lastBenchmarkRunId = randomUUID();
    const result = await sendMessage({ ...turn, assistantId, threadId, benchmarkRunId: lastBenchmarkRunId });
    assistantId = result.assistantId;
    threadId = result.threadId;
    turnToolCalls.push(result.toolCalls);
    text = result.text;
  }

  const traceToolCalls = needsTrace ? await fetchTraceToolCalls(lastBenchmarkRunId) : [];
  return { turnToolCalls, traceToolCalls, text };
};

// Evaluator params come as { input, output, expectedOutput, metadata } — this
// is the SDK's own shape (@langfuse/client's EvaluatorParams), not something
// we chose; there's no wrapped "item" the way the task function receives one.
const invariantEvaluator = async ({ output, expectedOutput }) => {
  const failures = scoreItem(expectedOutput, output);
  return {
    name: "invariants-pass",
    value: failures.length === 0 ? 1 : 0,
    comment: failures.length === 0 ? "all invariants held" : failures.join("; "),
  };
};

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

async function main() {
  const dataset = await langfuse.dataset.get(DATASET_NAME);
  const result = await dataset.runExperiment({
    name: `ask-ai-benchmark-${new Date().toISOString()}`,
    description: "Regression run of the Ask AI map-assistant benchmark",
    task,
    evaluators: [invariantEvaluator],
    runEvaluators: [passRateEvaluator],
    maxConcurrency: 3, // be gentle on the census raster / road-snap calls each turn makes
  });
  console.log(await result.format());

  console.log("\nPer-item detail:");
  for (const r of result.itemResults) {
    const evalResult = r.evaluations.find((e) => e.name === "invariants-pass");
    const mark = evalResult?.value === 1 ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${r.item.id} — ${evalResult?.comment ?? "no evaluation"}`);
  }

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
