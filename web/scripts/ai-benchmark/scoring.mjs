// Judges one finished benchmark item: did the right things happen
// (invariants), and how fast (latency)? Pure functions only — run.mjs wires
// them into Langfuse evaluators, and scoring.test.mjs tests them offline.
//
// The `output` these functions read is what run.mjs's task returns:
//   {
//     text,            final answer of the LAST turn (after any text_reset)
//     turnToolCalls,   one array of client tool_calls per turn ([{ name, args }])
//     traceToolCalls,  tool spans from the last turn's Langfuse trace ([{ name, args }], SERVER names)
//     traceFound,      true / false when a trace was needed; undefined otherwise
//     errors,          strings — anything that went wrong talking to the server
//     turns,           per turn: { message, ok, benchmarkRunId, latency, steps, notes, text }
//     model,           from the first `start` event
//   }
// Outputs from before the 2026-11 rework (no errors / turns / traceFound) still
// score exactly as they used to.

// ── Argument matchers ────────────────────────────────────────────────────────

/**
 * The original, TOP-LEVEL matcher (`argsMatch` in questions.mjs): every key in
 * `expected` must be strictly equal in `actual`; an expected array must match
 * the start of the actual array item by item (so [lng, lat] works).
 * Unchanged from the first version of the benchmark on purpose.
 */
export function argsMatch(actual, expected) {
  return Object.entries(expected).every(([k, v]) => {
    if (Array.isArray(v)) return Array.isArray(actual?.[k]) && v.every((x, i) => x === actual[k][i]);
    return actual?.[k] === v;
  });
}

/**
 * The deep partial matcher (`argsContains` in questions.mjs):
 *   - objects match when every expected key matches (extra actual keys are fine);
 *   - arrays match when every expected item matches SOME actual item, in any
 *     order (so { layers: [{ id: "transitDesert", on: true }] } matches a call
 *     that also switches other layers);
 *   - anything else (string, number, boolean, null) must be strictly equal.
 * Two expected items may match the same actual item — it's "contains", not
 * "pairs up one-to-one".
 *
 * Remember the args were trimmed (conversation.mjs, compactForLog): only the
 * first 30 items of each array are there to match against.
 */
export function containsDeep(actual, expected) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((expectedItem) => actual.some((actualItem) => containsDeep(actualItem, expectedItem)));
  }

  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, expectedValue]) => containsDeep(actual[key], expectedValue));
  }

  return actual === expected;
}

/**
 * The calls named `name` whose args pass every filter that is given.
 * Shared by the client checks (expectToolCalls…) and the trace checks
 * (expectTrace…), so both support argsMatch and argsContains.
 */
export function findCalls(calls, { name, argsMatch: topLevelFilter, argsContains: deepFilter }) {
  return calls.filter((call) => {
    if (call.name !== name) return false;
    if (topLevelFilter && !argsMatch(call.args, topLevelFilter)) return false;
    if (deepFilter && !containsDeep(call.args, deepFilter)) return false;
    return true;
  });
}

/**
 * Readable description of an expectation's arg filters for failure messages.
 * When only argsMatch (or nothing) is given, the wording is exactly what the
 * benchmark always printed, so old failure comments stay comparable.
 */
function describeArgsFilter(expectation) {
  const topLevel = `matching ${JSON.stringify(expectation.argsMatch ?? {})}`;
  if (!expectation.argsContains) return topLevel;
  const deep = `containing ${JSON.stringify(expectation.argsContains)}`;
  return expectation.argsMatch ? `${topLevel} and ${deep}` : deep;
}

function hasArgsFilter(expectation) {
  return Boolean(expectation.argsMatch || expectation.argsContains);
}

// ── Text rules ───────────────────────────────────────────────────────────────

/**
 * mustMatch / mustNotMatch rules are { pattern, flags } strings rather than
 * RegExp literals because dataset items are stored as JSON in Langfuse, and
 * JSON has no RegExp type (JSON.stringify(/x/) gives "{}").
 * Returns null for a rule that isn't a valid regex.
 */
function compileTextRule(rule) {
  try {
    return new RegExp(rule.pattern, rule.flags ?? "");
  } catch {
    return null;
  }
}

function describeTextRule(rule) {
  return `/${rule.pattern}/${rule.flags ?? ""}`;
}

/** True when the item has checks that can only be answered by the Langfuse trace. */
export function itemNeedsTrace(expectedOutput) {
  return Boolean(expectedOutput?.expectTrace ?? expectedOutput?.forbidTrace);
}

// ── Invariants ───────────────────────────────────────────────────────────────

/**
 * Checks one item's output against its expectedOutput.
 * @returns {string[]} failure messages — empty means the item passed.
 */
export function scoreItem(eo, output) {
  const { turnToolCalls, traceToolCalls, text } = output;
  const failures = [];

  // Anything that went wrong talking to the server comes first: when the
  // stream broke, the checks below are judging half a reply.
  for (const error of output.errors ?? []) {
    failures.push(error);
  }

  // No trace means expectTrace can't pass and forbidTrace would pass for the
  // wrong reason ("nothing forbidden happened" because nothing was seen), so
  // it is a failure of its own. Only an explicit `false` counts: undefined
  // means the lookup was skipped (not needed, or the turn already failed).
  if (itemNeedsTrace(eo) && output.traceFound === false) {
    failures.push(
      "no Langfuse trace found for the last turn's benchmarkRunId, so expectTrace/forbidTrace could not be checked " +
        "(is the server tracing? LANGFUSE_TRACING_DEV=true for a dev server)",
    );
  }

  const clientToolCalls = turnToolCalls[turnToolCalls.length - 1] ?? [];

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

  // Trace checks use SERVER tool names (show_area, rank_service_areas, …).
  for (const exp of eo.expectTrace ?? []) {
    const expectation = { name: exp.tool, argsMatch: exp.argsMatch, argsContains: exp.argsContains };
    if (findCalls(traceToolCalls, expectation).length === 0) {
      failures.push(`expected trace call to ${exp.tool} ${describeArgsFilter(exp)}, not found`);
    }
  }
  for (const forb of eo.forbidTrace ?? []) {
    const expectation = { name: forb.tool, argsMatch: forb.argsMatch, argsContains: forb.argsContains };
    if (findCalls(traceToolCalls, expectation).length > 0) {
      failures.push(`forbidden trace call to ${forb.tool} ${describeArgsFilter(forb)} occurred`);
    }
  }

  // Client checks use CLIENT tool names (highlight_area, set_map_layers, …)
  // and look at the LAST turn only.
  for (const exp of eo.expectToolCalls ?? []) {
    if (findCalls(clientToolCalls, exp).length === 0) {
      failures.push(`expected client tool_call ${exp.name} ${describeArgsFilter(exp)}, not found`);
    }
  }
  for (const forb of eo.forbidToolCalls ?? []) {
    if (findCalls(clientToolCalls, forb).length > 0) {
      const filter = hasArgsFilter(forb) ? ` ${describeArgsFilter(forb)}` : "";
      failures.push(`forbidden client tool_call ${forb.name}${filter} occurred`);
    }
  }
  if (eo.expectToolCallCount) {
    const { name, min } = eo.expectToolCallCount;
    const count = clientToolCalls.filter((c) => c.name === name).length;
    if (count < min) failures.push(`expected >= ${min} ${name} calls, got ${count}`);
  }

  // Text checks look at the final answer of the LAST turn.
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
  for (const rule of eo.textChecks?.mustMatch ?? []) {
    const regex = compileTextRule(rule);
    if (!regex) {
      failures.push(`invalid mustMatch rule ${describeTextRule(rule)} in expectedOutput`);
    } else if (!regex.test(text)) {
      failures.push(`answer does not match ${describeTextRule(rule)}: "${text}"`);
    }
  }
  for (const rule of eo.textChecks?.mustNotMatch ?? []) {
    const regex = compileTextRule(rule);
    if (!regex) {
      failures.push(`invalid mustNotMatch rule ${describeTextRule(rule)} in expectedOutput`);
      continue;
    }
    // exec (not test) so the message can quote the offending words.
    const match = regex.exec(text);
    if (match) {
      failures.push(`answer matches forbidden ${describeTextRule(rule)} ("${match[0]}"): "${text}"`);
    }
  }

  return failures;
}

// ── Latency ──────────────────────────────────────────────────────────────────

/**
 * The four latency marks the benchmark takes per turn, in milliseconds since
 * the request was sent (conversation.mjs defines exactly when each is taken).
 * `name` becomes part of the Langfuse score name: latency-<name>-ms.
 */
export const LATENCY_METRICS = [
  { key: "ttfbMs", name: "ttfb", label: "first byte" },
  { key: "firstUiEventMs", name: "first-ui", label: "first status / map action" },
  { key: "firstTextMs", name: "first-text", label: "first answer text" },
  { key: "totalMs", name: "total", label: "total (until done)" },
];

/**
 * The p-th percentile of a list of numbers, or undefined for an empty list.
 *
 * 📖 Learn: percentiles / "nearest-rank" method — sort the values; p50 (the
 * median) is the value half of the samples are at or below, p90 the value 90%
 * are at or below. Nearest-rank always returns one of the real samples (no
 * averaging between two), which keeps it easy to check by hand.
 */
export function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length); // 1-based position
  return sorted[Math.max(0, rank - 1)];
}

/**
 * p50 / p90 / max of every metric over the turns that finished cleanly.
 * Failed turns are left out: a turn that errored after 200 ms would make the
 * server look fast.
 *
 * @param {Array<{ok: boolean, latency: object}>} turns
 */
export function summarizeLatency(turns) {
  const okTurns = turns.filter((turn) => turn.ok);
  const metrics = {};
  for (const metric of LATENCY_METRICS) {
    // A metric can be missing for a clean turn too (e.g. a text-only answer
    // has no status or tool_call event), so `n` can differ per metric.
    const values = okTurns.map((turn) => turn.latency[metric.key]).filter((value) => typeof value === "number");
    metrics[metric.key] = {
      n: values.length,
      p50: percentile(values, 50),
      p90: percentile(values, 90),
      max: values.length > 0 ? Math.max(...values) : undefined,
    };
  }
  return { turnCount: turns.length, okTurnCount: okTurns.length, metrics };
}

/**
 * Numeric Langfuse scores for ONE item, so dataset runs can be compared:
 *   latency-<metric>-ms   the LAST turn's value (the turn the checks judge)
 *   latency-total-max-ms  the slowest turn of the item
 * A failing item gets no latency scores: an instant error says nothing about
 * speed, and its invariants-pass = 0 already says what went wrong.
 * (dataType "NUMERIC" is what Langfuse would infer from a number anyway —
 * stated so the intent is visible.)
 */
export function itemLatencyScores(turns) {
  if (turns.length === 0 || turns.some((turn) => !turn.ok)) return [];

  const lastTurn = turns[turns.length - 1];
  const scores = [];
  for (const metric of LATENCY_METRICS) {
    const value = lastTurn.latency[metric.key];
    if (typeof value !== "number") continue;
    scores.push({
      name: `latency-${metric.name}-ms`,
      value,
      dataType: "NUMERIC",
      comment: `${metric.label}, last turn`,
    });
  }

  const totals = turns.map((turn) => turn.latency.totalMs).filter((value) => typeof value === "number");
  if (totals.length > 0) {
    scores.push({
      name: "latency-total-max-ms",
      value: Math.max(...totals),
      dataType: "NUMERIC",
      comment: `slowest of ${totals.length} turn(s)`,
    });
  }
  return scores;
}

/** Run-level Langfuse scores: p50 and p90 of every metric (from summarizeLatency). */
export function runLatencyScores(summary) {
  const scores = [];
  for (const metric of LATENCY_METRICS) {
    const stats = summary.metrics[metric.key];
    if (stats.n === 0) continue;
    scores.push({
      name: `latency-${metric.name}-p50-ms`,
      value: stats.p50,
      dataType: "NUMERIC",
      comment: `median ${metric.label} over ${stats.n} turns without errors`,
    });
    scores.push({
      name: `latency-${metric.name}-p90-ms`,
      value: stats.p90,
      dataType: "NUMERIC",
      comment: `90th percentile ${metric.label} over ${stats.n} turns without errors`,
    });
  }
  return scores;
}
