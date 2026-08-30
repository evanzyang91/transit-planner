"use client";

import { useState, useCallback, useEffect } from "react";
import { trackEvent } from "~/lib/analytics";
import {
  colorFromArgs,
  labelFromTool,
  toolNameToKind,
} from "~/lib/ai-map-tools-client";
import type { AIAnnotationKind } from "./map/AIAnnotationsContext";

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string;
  turnId?: string;
  annotationIds?: string[];
};

export type AnthropicState = {
  assistantId: string | null;
  threadId: string | null;
  messages: AnthropicMessage[];
  isLoading: boolean;
  error: string | null;
};

type ToolCallHandler = (payload: {
  name: string;
  args: Record<string, unknown>;
  turnId: string;
}) => string | void;

// Shape we persist to localStorage — only the durable bits, never the transient
// isLoading/error flags.
type PersistedState = Pick<AnthropicState, "assistantId" | "threadId" | "messages">;

export function useAnthropic(
  customSystemPrompt?: string,
  options?: {
    mapTools?: boolean;
    onToolCall?: ToolCallHandler;
    // When set, the conversation (messages + server thread IDs) is mirrored to
    // localStorage under this key, so it survives the panel unmounting (hide/open)
    // and page reloads. Omit it and the hook stays purely in-memory as before.
    persistKey?: string;
    // Supplier for the client's LIVE route state, sent with every map-tools
    // message so the server tools query the network the user actually sees
    // (user-drawn lines included) — not the static default snapshot.
    // A function (not a value) so each send reads the freshest routes.
    networkRoutes?: () => unknown;
  },
) {
  const persistKey = options?.persistKey;

  // Lazy initialiser: restore a prior conversation on first mount. The server
  // keeps thread state in-memory for the life of the process, so a restored
  // threadId usually still continues the same Anthropic thread after a reload;
  // worst case (server restarted) the next send starts fresh but the history is
  // still readable here. 📖 Learn: passing a function to useState runs it once,
  // avoiding a localStorage read on every render.
  const [state, setState] = useState<AnthropicState>(() => {
    const base: AnthropicState = {
      assistantId: null,
      threadId: null,
      messages: [],
      isLoading: false,
      error: null,
    };
    if (!persistKey || typeof window === "undefined") return base;
    try {
      const raw = localStorage.getItem(persistKey);
      if (!raw) return base;
      const saved = JSON.parse(raw) as Partial<PersistedState>;
      if (!Array.isArray(saved.messages)) return base;
      return {
        ...base,
        assistantId: saved.assistantId ?? null,
        threadId: saved.threadId ?? null,
        messages: saved.messages,
      };
    } catch {
      return base; // malformed JSON — ignore and start clean
    }
  });

  // Mirror durable state to localStorage whenever it changes.
  useEffect(() => {
    if (!persistKey || typeof window === "undefined") return;
    try {
      const toSave: PersistedState = {
        assistantId: state.assistantId,
        threadId: state.threadId,
        messages: state.messages,
      };
      localStorage.setItem(persistKey, JSON.stringify(toSave));
    } catch {
      /* quota or serialization failure — non-fatal, just skip persisting */
    }
  }, [persistKey, state.assistantId, state.threadId, state.messages]);

  const sendMessageStreaming = useCallback(
    async (
      message: string,
      sendOptions?: {
        model?: string;
        maxTokens?: number;
        onChunk?: (chunk: string) => void;
      },
    ) => {
      const turnId = crypto.randomUUID();
      const annotationIds: string[] = [];

      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
        messages: [...prev.messages, { role: "user", content: message, turnId }],
      }));

      try {
        const provider = localStorage.getItem("aiProvider") ?? "anthropic";
        const mapTools = options?.mapTools ?? false;

        trackEvent("AI Message Sent", {
          message_length: message.length,
          has_custom_system_prompt: Boolean(customSystemPrompt),
          max_tokens: sendOptions?.maxTokens,
          model: sendOptions?.model,
          streaming: true,
          provider,
          map_tools: mapTools,
        });

        const response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            assistantId: state.assistantId,
            threadId: state.threadId,
            // On the map-tools surface the SERVER builds the prompt; a client
            // prompt would be ignored there anyway, so don't send one.
            systemPrompt: mapTools ? undefined : customSystemPrompt,
            model: sendOptions?.model,
            maxTokens: sendOptions?.maxTokens,
            provider,
            mapTools,
            networkRoutes: mapTools ? options?.networkRoutes?.() : undefined,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        let assistantMessage = "";
        let newAssistantId = state.assistantId;
        let newThreadId = state.threadId;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data) as
                | { type: "metadata"; assistantId: string; threadId: string }
                | { type: "content"; text: string }
                | { type: "text"; delta: string }
                | { type: "tool_call"; name: string; args: Record<string, unknown> }
                | { type: "error"; error: string };

              if (parsed.type === "metadata") {
                newAssistantId = parsed.assistantId;
                newThreadId = parsed.threadId;
              } else if (parsed.type === "content") {
                assistantMessage += parsed.text;
                sendOptions?.onChunk?.(parsed.text);
              } else if (parsed.type === "text") {
                assistantMessage += parsed.delta;
                sendOptions?.onChunk?.(parsed.delta);
              } else if (parsed.type === "tool_call") {
                const kind = toolNameToKind(parsed.name);
                if (kind && options?.onToolCall) {
                  const id = options.onToolCall({
                    name: parsed.name,
                    args: parsed.args,
                    turnId,
                  });
                  if (typeof id === "string") annotationIds.push(id);
                }
              } else if (parsed.type === "error") {
                throw new Error(parsed.error);
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }

        setState((prev) => ({
          ...prev,
          assistantId: newAssistantId,
          threadId: newThreadId,
          messages: [
            ...prev.messages,
            {
              role: "assistant",
              content: assistantMessage,
              turnId,
              annotationIds: annotationIds.length > 0 ? annotationIds : undefined,
            },
          ],
          isLoading: false,
        }));

        trackEvent("AI Response Received", {
          message_length: message.length,
          response_length: assistantMessage.length,
          streaming: true,
          provider: "anthropic",
          annotation_count: annotationIds.length,
        });

        return assistantMessage;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        trackEvent("AI Response Failed", {
          message_length: message.length,
          error: errorMessage,
          streaming: true,
          provider: "anthropic",
        });
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }));
        throw error;
      }
    },
    [state.assistantId, state.threadId, customSystemPrompt, options?.mapTools, options?.onToolCall, options?.networkRoutes],
  );

  // (The old non-streaming sendMessage was removed with its only consumer,
  // the anthropic-test demo. TransitMap's route-stats feature calls
  // /api/ai/message directly and doesn't go through this hook.)

  const reset = useCallback(() => {
    setState({
      assistantId: null,
      threadId: null,
      messages: [],
      isLoading: false,
      error: null,
    });
    if (persistKey && typeof window !== "undefined") {
      try { localStorage.removeItem(persistKey); } catch { /* ignore */ }
    }
  }, [persistKey]);

  return {
    ...state,
    sendMessageStreaming,
    reset,
  };
}

/** Client-safe re-exports for tool → annotation mapping. */
export function mapToolToAnnotation(
  name: string,
  args: Record<string, unknown>,
  turnId: string,
): Omit<import("./map/AIAnnotationsContext").AIAnnotation, "id"> | null {
  const kind = toolNameToKind(name) as AIAnnotationKind | null;
  if (!kind) return null;
  return {
    kind,
    args,
    turnId,
    label: labelFromTool(name, args),
    color: colorFromArgs(args),
  };
}
