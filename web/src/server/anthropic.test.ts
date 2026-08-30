import { describe, expect, it } from "vitest";

import { createAnthropicProvider } from "./anthropic";

/**
 * Regression: "Unknown thread: <uuid>".
 *
 * Assistants and threads live in a Map inside the provider closure — process
 * memory. The browser persists its ids in localStorage and keeps sending them,
 * so after a hot reload, a restart, or a hop to another serverless instance the
 * server gets ids it has never seen and getThread() threw.
 *
 * hasSession() lets the route detect that and open a fresh session instead.
 */
describe("provider session tracking", () => {
  it("reports a session it just created", async () => {
    const p = createAnthropicProvider();
    const assistantId = await p.createAssistant("T", "prompt");
    const threadId = await p.createThread(assistantId);
    expect(p.hasSession!(assistantId, threadId)).toBe(true);
  });

  it("reports false for an unknown thread id", async () => {
    const p = createAnthropicProvider();
    const assistantId = await p.createAssistant("T", "prompt");
    expect(p.hasSession!(assistantId, crypto.randomUUID())).toBe(false);
  });

  it("reports false for an unknown assistant id", async () => {
    const p = createAnthropicProvider();
    const assistantId = await p.createAssistant("T", "prompt");
    const threadId = await p.createThread(assistantId);
    expect(p.hasSession!(crypto.randomUUID(), threadId)).toBe(false);
  });

  it("reports false across provider instances — the actual restart case", () => {
    // A new provider is what a hot reload or a fresh lambda produces: same ids
    // from the client, empty stores on the server.
    const before = createAnthropicProvider();
    const after = createAnthropicProvider();
    return (async () => {
      const assistantId = await before.createAssistant("T", "prompt");
      const threadId = await before.createThread(assistantId);
      expect(before.hasSession!(assistantId, threadId)).toBe(true);
      expect(after.hasSession!(assistantId, threadId)).toBe(false);
    })();
  });
});
