import { describe, expect, it } from "vitest";
import { aiAssistantFromHost, matchAiFetcher } from "./ai-assistants";

describe("aiAssistantFromHost", () => {
  it("names ChatGPT from its utm_source value", () => {
    expect(aiAssistantFromHost("chatgpt.com")).toBe("ChatGPT");
  });

  it("ignores case and a leading www.", () => {
    expect(aiAssistantFromHost("WWW.Perplexity.ai")).toBe("Perplexity");
  });

  it("returns null for ordinary sites and missing values", () => {
    expect(aiAssistantFromHost("google.com")).toBeNull();
    expect(aiAssistantFromHost("")).toBeNull();
    expect(aiAssistantFromHost(null)).toBeNull();
  });
});

describe("matchAiFetcher", () => {
  it("classifies a live ChatGPT fetch as user-triggered", () => {
    const ua =
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
    expect(matchAiFetcher(ua)).toMatchObject({
      vendor: "OpenAI",
      kind: "user",
    });
  });

  it("tells OpenAI's training crawler apart from its user fetcher", () => {
    const ua =
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot";
    expect(matchAiFetcher(ua)?.kind).toBe("training");
  });

  it("returns null for a normal browser", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
    expect(matchAiFetcher(ua)).toBeNull();
  });
});
