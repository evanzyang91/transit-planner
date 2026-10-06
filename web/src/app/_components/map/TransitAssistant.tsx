"use client";

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useAnthropic, mapToolToAnnotation } from "~/app/_components/useAnthropic";
import { useAIAnnotations } from "./AIAnnotationsContext";
import type { Route } from "~/app/map/transit-data";
import { haversineKm } from "~/app/map/geo-utils";
import { POPULATION_CENTERS } from "~/app/map/population-centers";

// Compact markdown renderer for the tiny chat bubbles — responses are meant to
// be one short sentence, so we only style the elements a brief reply might use
// and keep margins minimal. (Mirrors the MD map in ChatPanel.tsx.)
const MD = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-1 last:mb-0">{children}</p>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="my-0.5 list-disc pl-4 space-y-0.5">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="my-0.5 list-decimal pl-4 space-y-0.5">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  code: ({ children }: { children?: React.ReactNode }) => <code className="rounded bg-stone-200/70 px-1 py-px text-[11px]">{children}</code>,
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => <a href={href} className="underline">{children}</a>,
};

// The system prompt is now built SERVER-side (server/map-data/prompt.ts) from
// the live network we send with each message — the old client copy drifted
// from the server's and doubled as an injection vector.

// 📖 Learn: Web Speech API isn't fully standardised — Chrome/Edge/Safari
// expose it as `webkitSpeechRecognition`, the spec'd name is `SpeechRecognition`,
// and Firefox doesn't ship it at all. We feature-detect both and hide the
// button entirely when unsupported instead of showing a broken control.
type SpeechRecognitionConstructor = new () => {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((e: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null;
    onerror: ((e: unknown) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
  };

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Coarse coverage picture from the shipped population centres — used ONLY to
// pick relevant suggestion chips. The AI's own coverage numbers come from the
// server's census raster, not from this.
// 📖 Learn: a centre counts as "served" if ANY stop is within its serviceRadiusKm
// (a coarse catchment model — the same one the Analysis panel's City Coverage uses).
interface CoverageSnapshot {
  topGaps: { name: string; population: number }[];
}

function computeCoverageSnapshot(routes: Route[]): CoverageSnapshot {
  const allStops = routes.flatMap((r) => r.stops.map((s) => s.coords));
  const served = new Set<string>();
  for (const c of POPULATION_CENTERS) {
    if (allStops.some((coord) => haversineKm(coord, [c.lng, c.lat]) <= c.serviceRadiusKm)) {
      served.add(c.id);
    }
  }
  const topGaps = POPULATION_CENTERS
    .filter((c) => !served.has(c.id))
    .sort((a, b) => b.population - a.population)
    .slice(0, 5)
    .map((c) => ({ name: c.name, population: c.population }));

  return { topGaps };
}

interface Props {
  routes: Route[];
  seed?: string | null;
  onSeedConsumed?: () => void;
}

export function TransitAssistant({ routes, seed, onSeedConsumed }: Props) {
  const {
    add,
    clearAll,
    focusAnnotation,
    annotations,
    editing,
    setEditing,
    removeAnnotation,
  } = useAIAnnotations();
  // Coverage feeds only the suggestion chips now; the AI's prompt + numbers
  // are built server-side from the routes we send below.
  const coverage = useMemo(() => computeCoverageSnapshot(routes), [routes]);

  // Trimmed live-network payload sent with every message so the server tools
  // query exactly the network on screen (user-drawn lines included).
  const networkRoutes = useCallback(
    () =>
      routes.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        stops: r.stops.map((s) => ({ name: s.name, coords: s.coords })),
      })),
    [routes],
  );

  const handleToolCall = useCallback(
    ({ name, args, turnId }: { name: string; args: Record<string, unknown>; turnId: string }) => {
      const mapped = mapToolToAnnotation(name, args, turnId);
      if (!mapped) return;
      return add(mapped);
    },
    [add],
  );

  const { messages, isLoading, error, sendMessageStreaming, reset } = useAnthropic(undefined, {
    mapTools: true,
    onToolCall: handleToolCall,
    networkRoutes,
    // Persist the conversation so closing/reopening the panel (or reloading)
    // doesn't wipe it. Cleared via the "New chat" button below.
    persistKey: "ask-ai-chat-v1",
  });

  // Start a fresh conversation: clear chat history AND the map findings it drew.
  const handleNewChat = useCallback(() => {
    reset();
    clearAll();
  }, [reset, clearAll]);

  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  // Whether new content should auto-stick to the bottom. Flips off when the
  // user scrolls up to read history, so streaming tokens don't yank them back
  // down. Re-armed when they scroll back near the bottom (and on send).
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<InstanceType<SpeechRecognitionConstructor> | null>(null);
  const baseInputRef = useRef("");
  const speechSupported = typeof window !== "undefined" && getSpeechRecognitionCtor() !== null;

  useEffect(() => {
    if (seed) {
      setInput(seed);
      inputRef.current?.focus();
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) el.setSelectionRange(seed.length, seed.length);
      });
      onSeedConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  useEffect(() => {
    // Follow new content only if the user is parked near the bottom. Scroll the
    // list's own scrollTop (not scrollIntoView, which can scroll the panel/page
    // and make the header/composer jump).
    if (!stickToBottomRef.current) return;
    const el = messagesRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const msg = input.trim();
    if (!msg || isLoading) return;
    setInput("");
    stickToBottomRef.current = true; // always follow the user's own new message
    // Brevity is enforced by the "draw first, no narration" prompt rules, not by
    // starving the budget — too low a cap cut off the drawing tool calls. This
    // leaves room to shade a gap AND draw a corridor in one turn.
    await sendMessageStreaming(msg, { maxTokens: 600 });
  };

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    baseInputRef.current = input;
    rec.onresult = (e) => {
      let transcript = "";
      const results = e.results as unknown as ArrayLike<{ 0: { transcript: string } }>;
      for (let i = 0; i < results.length; i++) {
        transcript += results[i]![0].transcript;
      }
      const base = baseInputRef.current;
      const joiner = base && !base.endsWith(" ") ? " " : "";
      setInput(base + joiner + transcript);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  }

  // Chips grounded in data we actually have: rank_service_areas (the >1 km
  // threshold) and the real largest-underserved centre from the coverage
  // snapshot. The old "transfer hubs" chip pointed at data no tool exposes.
  const SUGGESTIONS = useMemo(() => {
    const top = coverage.topGaps[0];
    return [
      "Where are the biggest coverage gaps?",
      top ? `How could I better serve ${top.name}?` : "Which areas are over 1 km from any stop?",
      "What share of the population does my network reach?",
    ];
  }, [coverage]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Persisted conversation → offer a way to start over. The chat itself
          survives hide/open + reload via the persistKey above. */}
      {messages.length > 0 && (
        <div className="mb-2 flex shrink-0 items-center justify-between">
          <span className="text-[10px] text-stone-400">Conversation saved</span>
          <button
            type="button"
            onClick={handleNewChat}
            className="text-[10px] font-medium text-stone-500 hover:text-stone-800"
          >
            New chat
          </button>
        </div>
      )}
      {annotations.length > 0 && (
        <div className="mb-2 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-stone-400">
              {annotations.length} map finding{annotations.length === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(!editing)}
                aria-pressed={editing}
                className={`text-[10px] font-medium ${
                  editing
                    ? "text-teal-700"
                    : "text-stone-500 hover:text-stone-800"
                }`}
              >
                {editing ? "Done editing" : "Edit shapes"}
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="text-[10px] font-medium text-teal-600 hover:text-teal-800"
              >
                Clear all
              </button>
            </div>
          </div>
          {editing && (
            <p className="mt-1 text-[10px] leading-snug text-stone-400">
              Drag the dots to reshape. On a shaded area, drag a faint mid-dot to
              add a corner, or double-click a corner to remove it.
            </p>
          )}
        </div>
      )}

      {/* flex-1 + min-h-0 lets this region fill all space between the header
          and the input, so the input stays pinned to the bottom of the panel.
          (Previously a max-h-64 cap reserved a fixed 256px block that left a
          large empty gap above the input.) */}
      <div
        ref={messagesRef}
        onScroll={() => {
          const el = messagesRef.current;
          if (!el) return;
          // Within 40px of the bottom counts as "sticking".
          stickToBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="flex-1 overflow-y-auto space-y-2 min-h-0"
      >
        {messages.length === 0 ? (
          // Empty state: a compact top-aligned stack. The panel auto-sizes to
          // this (see AIChatPanel maxHeight), so there's no empty gap to fill.
          <div className="flex flex-col space-y-1.5">
            <p className="text-[10px] text-stone-400 text-center py-1">
              Ask anything — answers appear on the map
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => { setInput(s); inputRef.current?.focus(); }}
                className="w-full text-left rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-1.5 text-[11px] text-stone-600 hover:bg-white hover:border-stone-200 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          messages.map((m, i) => {
            const turnAnnotations =
              m.role === "assistant" && m.turnId
                ? annotations.filter((a) => a.turnId === m.turnId)
                : [];
            return (
              <div key={i}>
                {/* The server lost this conversation's session and opened a new
                    thread, so the reply below was written without any of the
                    history above it. Saying so beats letting the assistant look
                    like it randomly forgot. */}
                {m.contextReset && (
                  <div className="mb-1.5 mr-6 flex items-center gap-1.5">
                    <div className="h-px flex-1 bg-amber-200" />
                    <p className="text-[9px] text-amber-600 whitespace-nowrap">
                      New conversation — earlier context was lost
                    </p>
                    <div className="h-px flex-1 bg-amber-200" />
                  </div>
                )}
                <div
                  className={`rounded-lg px-2.5 py-2 text-xs leading-relaxed ${
                    m.role === "user"
                      ? "bg-stone-900 text-white ml-6"
                      : "bg-stone-50 border border-stone-100 text-stone-700 mr-6"
                  }`}
                >
                  <p
                    className={`text-[9px] font-semibold mb-0.5 ${
                      m.role === "user" ? "text-stone-400" : "text-teal-500"
                    }`}
                  >
                    {m.role === "user" ? "You" : "Transit Planner"}
                  </p>
                  {/* Assistant replies may contain markdown; user input stays literal. */}
                  {m.role === "assistant" ? (
                    <ReactMarkdown components={MD}>{m.content}</ReactMarkdown>
                  ) : (
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  )}
                </div>
                {turnAnnotations.length > 0 && (
                  // One compact row per finding: coloured dot, single-line
                  // truncated label (full text on hover via title), and a
                  // delete button that fades in on hover. Truncating keeps long
                  // AI labels from blowing the chips up into ugly wrapped pills.
                  <div className="mt-1.5 mr-6 space-y-1">
                    {turnAnnotations.map((ann) => (
                      <div
                        key={ann.id}
                        className="group flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-2 py-1 dark:border-stone-700 dark:bg-stone-800/60"
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: ann.color ?? "#14b8a6" }}
                        />
                        <button
                          type="button"
                          onClick={() => focusAnnotation(ann.id)}
                          title={ann.label}
                          className="min-w-0 flex-1 truncate text-left text-[11px] text-stone-600 hover:text-teal-700 dark:text-stone-300 dark:hover:text-teal-400"
                        >
                          {ann.label}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeAnnotation(ann.id)}
                          aria-label={`Delete ${ann.label}`}
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-stone-300 opacity-0 transition-opacity hover:bg-stone-100 hover:text-rose-600 group-hover:opacity-100 dark:text-stone-500 dark:hover:bg-stone-700"
                        >
                          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-2.5 w-2.5">
                            <path d="M2 2l8 8M10 2l-8 8" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
        {isLoading && (
          <div className="bg-stone-50 border border-stone-100 rounded-lg px-2.5 py-2 mr-6">
            <p className="text-[9px] font-semibold text-teal-500 mb-0.5">Transit Planner</p>
            <div className="flex gap-1 items-center h-4">
              <span className="h-1.5 w-1.5 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="h-1.5 w-1.5 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="h-1.5 w-1.5 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-rose-50 border border-rose-200 px-2.5 py-2 text-xs text-rose-700">{error}</div>
        )}
      </div>

      {/* Composer styled after the Claude Code input: one rounded box with the
          textarea on top and an action row underneath (tools left, send right). */}
      <div className="mt-2 shrink-0 rounded-2xl border border-stone-200 bg-white transition-colors focus-within:border-stone-400">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={listening ? "Listening…" : "Ask about your transit network…"}
          rows={2}
          className="w-full resize-none rounded-t-2xl bg-transparent px-3 pt-2.5 pb-1 text-xs text-stone-700 outline-none placeholder:text-stone-400"
        />
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          {/* Left: tools (mic). Wrapped so the send button stays right-aligned
              even when speech isn't supported and the mic is hidden. */}
          <div className="flex items-center gap-1">
            {speechSupported && (
              <button
                onClick={toggleListening}
                title={listening ? "Stop listening" : "Speak instead of typing"}
                aria-label={listening ? "Stop listening" : "Start voice input"}
                aria-pressed={listening}
                className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                  listening
                    ? "bg-rose-500 text-white animate-pulse"
                    : "text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                }`}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                  <path d="M10 1.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z" />
                  <path d="M5 9.5a.75.75 0 0 1 1.5 0 3.5 3.5 0 0 0 7 0 .75.75 0 0 1 1.5 0 5 5 0 0 1-4.25 4.95V17h2.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5h2.5v-2.55A5 5 0 0 1 5 9.5z" />
                </svg>
              </button>
            )}
          </div>
          {/* Right: send — dark rounded square with an up-arrow, like Claude Code. */}
          <button
            onClick={() => void send()}
            disabled={!input.trim() || isLoading}
            aria-label="Send"
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-stone-900 text-white transition-colors hover:bg-stone-700 disabled:opacity-30"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
