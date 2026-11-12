import { describe, expect, it } from "vitest";
import {
  buildRequestHistory,
  CHAT_STORAGE_VERSION,
  deserializeConversation,
  fallbackTurnTranscript,
  jsonByteLength,
  loadStoredConversation,
  migrateV1,
  repairToolPairs,
  serializeConversation,
  trimConversation,
  truncateText,
  V1_EMPTY_REPLY,
  type ChatMessage,
  type TurnTranscript,
} from "./map-assistant-history";
import { HISTORY_LIMITS, type DraftLine, type TranscriptMessage } from "./map-assistant-protocol";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A simple text-only turn. */
function textTurn(n: number, answer = `answer ${n}`): TurnTranscript {
  return {
    turnId: `t${n}`,
    messages: [
      { role: "user", content: `question ${n}` },
      { role: "assistant", content: answer },
    ],
  };
}

/** A turn where the model called a tool before answering (what the server sends). */
function toolTurn(n: number, resultText = '{"population":1234}'): TurnTranscript {
  return {
    turnId: `t${n}`,
    messages: [
      { role: "user", content: `question ${n}` },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: `tu${n}`, name: "query_population", input: { near: "Scarborough" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `tu${n}`, content: resultText }] },
      { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] },
    ],
  };
}

function userTexts(history: TranscriptMessage[]): string[] {
  return history
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string);
}

const DRAFT: DraftLine = {
  draftId: "d1",
  name: "Eglinton East LRT",
  type: "lrt",
  color: "#14b8a6",
  stops: [
    { name: "Kennedy", coords: [-79.264, 43.732] },
    { name: "UTSC", coords: [-79.186, 43.784] },
  ],
  stats: { lengthKm: 9.1, stopCount: 2, avgSpacingKm: 9.1, estCostBillions: 1.2 },
};

// ── buildRequestHistory ──────────────────────────────────────────────────────

describe("buildRequestHistory", () => {
  it("returns an empty history for a new chat", () => {
    expect(buildRequestHistory([])).toEqual([]);
  });

  it("keeps whole turns, oldest first, including tool calls and results", () => {
    const history = buildRequestHistory([textTurn(1), toolTurn(2)]);
    expect(history).toHaveLength(6);
    expect(history[0]).toEqual({ role: "user", content: "question 1" });
    expect(history[3]).toMatchObject({ role: "assistant", content: [{ type: "tool_use", id: "tu2" }] });
  });

  it(`keeps only the last ${HISTORY_LIMITS.maxUserTurns} user turns`, () => {
    const turns = Array.from({ length: 20 }, (_, i) => toolTurn(i + 1));
    const history = buildRequestHistory(turns);
    const questions = userTexts(history);
    expect(questions).toHaveLength(HISTORY_LIMITS.maxUserTurns);
    expect(questions[0]).toBe("question 9"); // 20 - 12 + 1
    expect(questions.at(-1)).toBe("question 20");
  });

  it("counts turns by what the USER typed, not by role (tool results are role user too)", () => {
    // 12 tool turns contain 24 role:"user" messages but only 12 user turns.
    const turns = Array.from({ length: 12 }, (_, i) => toolTurn(i + 1));
    expect(userTexts(buildRequestHistory(turns))).toHaveLength(12);
  });

  it("truncates long text and tool results to the shared limits", () => {
    const longText = "x".repeat(HISTORY_LIMITS.maxTextChars + 500);
    const longResult = "y".repeat(HISTORY_LIMITS.maxToolResultChars + 500);
    const history = buildRequestHistory([textTurn(1, longText), toolTurn(2, longResult)]);
    const answer = history[1]!.content as string;
    expect(answer.length).toBe(HISTORY_LIMITS.maxTextChars);
    expect(answer.endsWith("…")).toBe(true);
    const resultBlock = (history[4]!.content as Array<{ type: string; content?: string }>)[0]!;
    expect(resultBlock.type).toBe("tool_result");
    expect(resultBlock.content!.length).toBe(HISTORY_LIMITS.maxToolResultChars);
  });

  it(`drops the oldest whole turns until the JSON fits in ${HISTORY_LIMITS.maxBytes} bytes`, () => {
    // Each answer ~7.9 KB of 2-byte characters (é) ≈ 15.8 KB per turn in UTF-8.
    const big = "é".repeat(HISTORY_LIMITS.maxTextChars - 100);
    const turns = Array.from({ length: 12 }, (_, i) => textTurn(i + 1, big));
    const history = buildRequestHistory(turns);
    expect(jsonByteLength(history)).toBeLessThanOrEqual(HISTORY_LIMITS.maxBytes);
    const questions = userTexts(history);
    expect(questions.length).toBeLessThan(12);
    expect(questions.at(-1)).toBe("question 12"); // the newest turn always survives first
    expect(history[0]).toEqual({ role: "user", content: questions[0] }); // starts at a turn boundary
  });

  it("drops thinking blocks and unknown block types (never resend old thinking)", () => {
    const turn = {
      turnId: "t1",
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret reasoning", signature: "abc" },
            { type: "redacted_thinking", data: "zzz" },
            { type: "text", text: "visible answer" },
          ],
        },
      ],
    } as unknown as TurnTranscript;
    expect(buildRequestHistory([turn])).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
    ]);
  });

  it("drops leading messages that don't start with something the user said", () => {
    const orphan: TurnTranscript = {
      turnId: "t0",
      messages: [{ role: "assistant", content: "stray reply" }],
    };
    expect(buildRequestHistory([orphan, textTurn(1)])[0]).toEqual({ role: "user", content: "question 1" });
  });

  it("repairs a turn that was cut off between a tool call and its result", () => {
    const cutOff: TurnTranscript = {
      turnId: "t1",
      messages: [
        { role: "user", content: "q1" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "tu1", name: "query_network", input: {} },
          ],
        },
        // no tool_result follows
      ],
    };
    const history = buildRequestHistory([cutOff, textTurn(2)]);
    expect(history[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Let me check." }] });
    expect(JSON.stringify(history)).not.toContain("tool_use");
  });
});

describe("repairToolPairs", () => {
  it("drops a tool_result whose tool_use is missing, and empty messages", () => {
    const repaired = repairToolPairs([
      { role: "user", content: "q" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "{}" }] },
      { role: "assistant", content: "a" },
    ]);
    expect(repaired).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("leaves a well-formed turn untouched (same objects)", () => {
    const turn = toolTurn(1).messages;
    const repaired = repairToolPairs(turn);
    expect(repaired).toEqual(turn);
    expect(repaired[1]).toBe(turn[1]);
  });
});

describe("truncateText", () => {
  it("never cuts an emoji in half", () => {
    const text = "ab🚇cd"; // "🚇" is two UTF-16 units at index 2-3
    const cut = truncateText(text, 4); // would keep "ab" + high surrogate without the guard
    expect(cut).toBe("ab…");
  });
});

describe("fallbackTurnTranscript", () => {
  it("records the user text and the partial answer with a marker", () => {
    expect(fallbackTurnTranscript("q", "Half an answ", "stopped")).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "Half an answ\n\n(stopped by the user)" },
    ]);
  });

  it("uses only the marker when nothing was streamed yet", () => {
    expect(fallbackTurnTranscript("q", "  ", "stopped")[1]).toEqual({
      role: "assistant",
      content: "(stopped by the user)",
    });
  });
});

// ── migrateV1 ────────────────────────────────────────────────────────────────

describe("migrateV1", () => {
  const v1 = {
    assistantId: "asst_1",
    threadId: "thread_1",
    messages: [
      { role: "user", content: "Where are the gaps?", turnId: "turn-a" },
      { role: "assistant", content: "Shaded **3** gaps.", turnId: "turn-a", annotationIds: ["x"] },
      { role: "user", content: "Draw a corridor", turnId: "turn-b" },
      { role: "assistant", content: "", turnId: "turn-b", contextReset: true },
      { role: "user", content: "Did that fail?", turnId: "turn-c" }, // no reply saved
    ],
  };

  it("converts display messages and keeps the turn ids that annotation chips use", () => {
    const migrated = migrateV1(v1, 1000)!;
    expect(migrated.v).toBe(CHAT_STORAGE_VERSION);
    expect(migrated.messages.map((m) => [m.role, m.turnId])).toEqual([
      ["user", "turn-a"],
      ["assistant", "turn-a"],
      ["user", "turn-b"],
      ["assistant", "turn-b"],
      ["user", "turn-c"],
    ]);
    expect(migrated.messages[1]).toMatchObject({ role: "assistant", text: "Shaded **3** gaps.", status: "done" });
  });

  it("builds a text-only transcript so old chats are remembered", () => {
    const migrated = migrateV1(v1)!;
    expect(migrated.transcript).toEqual([
      {
        turnId: "turn-a",
        messages: [
          { role: "user", content: "Where are the gaps?" },
          { role: "assistant", content: "Shaded **3** gaps." },
        ],
      },
      {
        turnId: "turn-b",
        messages: [
          { role: "user", content: "Draw a corridor" },
          { role: "assistant", content: V1_EMPTY_REPLY },
        ],
      },
      {
        turnId: "turn-c",
        messages: [
          { role: "user", content: "Did that fail?" },
          { role: "assistant", content: V1_EMPTY_REPLY },
        ],
      },
    ]);
    // ...and that transcript is valid input for the next request.
    expect(userTexts(buildRequestHistory(migrated.transcript))).toEqual([
      "Where are the gaps?",
      "Draw a corridor",
      "Did that fail?",
    ]);
  });

  it("invents turn ids for very old messages that have none", () => {
    const migrated = migrateV1({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] })!;
    expect(migrated.messages[0]!.turnId).toBe(migrated.messages[1]!.turnId);
  });

  it("returns null for garbage or an empty chat", () => {
    expect(migrateV1(null)).toBeNull();
    expect(migrateV1({ messages: "nope" })).toBeNull();
    expect(migrateV1({ messages: [] })).toBeNull();
    expect(migrateV1({ messages: [{ role: "system", content: "x" }] })).toBeNull();
  });
});

// ── Storage round trip ───────────────────────────────────────────────────────

describe("serializeConversation / deserializeConversation", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", turnId: "t1", text: "Draft a line", createdAt: 1 },
    {
      id: "a1",
      role: "assistant",
      turnId: "t1",
      text: "Here's a draft.",
      status: "done",
      steps: [{ id: "s1", kind: "status", tool: "propose_line", label: "Drafting a new line", state: "done" }],
      drafts: [{ draft: DRAFT, decision: { state: "added", routeId: "custom-7" } }],
      createdAt: 2,
    },
  ];

  it("round-trips a conversation with a version field", () => {
    const raw = serializeConversation({ messages, transcript: [textTurn(1)] }, 42);
    expect(JSON.parse(raw)).toMatchObject({ v: 2, savedAt: 42 });
    const restored = deserializeConversation(raw)!;
    expect(restored.messages).toEqual(messages);
    expect(restored.transcript).toEqual([textTurn(1)]);
  });

  it("keeps the confirm-card choice across a reload", () => {
    const restored = deserializeConversation(serializeConversation({ messages, transcript: [] }))!;
    const assistant = restored.messages[1];
    expect(assistant?.role === "assistant" && assistant.drafts[0]?.decision).toEqual({
      state: "added",
      routeId: "custom-7",
    });
  });

  it("marks an answer saved mid-stream as stopped (nothing can finish it after a reload)", () => {
    const streaming: ChatMessage[] = [
      messages[0]!,
      {
        id: "a1",
        role: "assistant",
        turnId: "t1",
        text: "Half",
        status: "streaming",
        steps: [{ id: "s1", kind: "status", label: "Measuring population", state: "running" }],
        drafts: [],
        createdAt: 2,
      },
    ];
    const restored = deserializeConversation(serializeConversation({ messages: streaming, transcript: [] }))!;
    expect(restored.messages[1]).toMatchObject({ status: "stopped", steps: [{ state: "stopped" }] });
  });

  it("rejects other versions and invalid JSON, and skips damaged entries", () => {
    expect(deserializeConversation(null)).toBeNull();
    expect(deserializeConversation("{not json")).toBeNull();
    expect(deserializeConversation(JSON.stringify({ v: 1, messages: [], transcript: [] }))).toBeNull();
    const damaged = JSON.stringify({
      v: 2,
      savedAt: 1,
      messages: [messages[0], { role: "assistant" }, 7],
      transcript: [{ turnId: "t1", messages: [{ role: "user", content: "q" }] }, { nope: true }],
    });
    const restored = deserializeConversation(damaged)!;
    expect(restored.messages).toEqual([messages[0]]);
    expect(restored.transcript).toEqual([{ turnId: "t1", messages: [{ role: "user", content: "q" }] }]);
  });

  it("drops a stored draft that fails the protocol's validation", () => {
    const bad = JSON.stringify({
      v: 2,
      savedAt: 1,
      messages: [{ ...messages[1], drafts: [{ draft: { ...DRAFT, stops: [] }, decision: { state: "pending" } }] }],
      transcript: [],
    });
    const restored = deserializeConversation(bad)!;
    expect(restored.messages[0]).toMatchObject({ role: "assistant", drafts: [] });
  });
});

describe("loadStoredConversation", () => {
  const v1Raw = JSON.stringify({ messages: [{ role: "user", content: "old", turnId: "o" }] });
  const v2Raw = serializeConversation({ messages: [{ id: "u", role: "user", turnId: "n", text: "new", createdAt: 0 }], transcript: [] });

  it("prefers the v2 value when both exist", () => {
    const { conversation, migratedFromV1 } = loadStoredConversation(v2Raw, v1Raw);
    expect(migratedFromV1).toBe(false);
    expect(conversation?.messages[0]?.turnId).toBe("n");
  });

  it("migrates v1 when there is no v2 value", () => {
    const { conversation, migratedFromV1 } = loadStoredConversation(null, v1Raw);
    expect(migratedFromV1).toBe(true);
    expect(conversation?.messages[0]?.turnId).toBe("o");
  });

  it("returns nothing for empty or broken storage", () => {
    expect(loadStoredConversation(null, null)).toEqual({ conversation: null, migratedFromV1: false });
    expect(loadStoredConversation("garbage", "{broken")).toEqual({ conversation: null, migratedFromV1: false });
  });
});

describe("trimConversation", () => {
  it("keeps the newest turns of both the display and the transcript", () => {
    const messages: ChatMessage[] = [1, 2, 3].map((n) => ({
      id: `u${n}`,
      role: "user" as const,
      turnId: `t${n}`,
      text: `q${n}`,
      createdAt: n,
    }));
    const trimmed = trimConversation({ messages, transcript: [textTurn(1), textTurn(2), textTurn(3)] }, 2);
    expect(trimmed.messages.map((m) => m.turnId)).toEqual(["t2", "t3"]);
    expect(trimmed.transcript.map((t) => t.turnId)).toEqual(["t2", "t3"]);
  });
});
