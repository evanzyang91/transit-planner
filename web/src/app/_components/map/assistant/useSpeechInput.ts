"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// 📖 Learn: the Web Speech API isn't fully standardised — Chrome/Edge/Safari
// expose it as `webkitSpeechRecognition`, the spec'd name is
// `SpeechRecognition`, and Firefox doesn't ship it at all. We feature-detect
// both and hide the mic button when it's unsupported.
type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Voice input for the composer (moved here from the old TransitAssistant).
 * Speech is appended to whatever was already typed when listening started.
 *
 * `supported` is decided in an effect, after mount: the server can't know the
 * browser, so deciding during render could make the server HTML and the first
 * client render disagree (a hydration mismatch).
 */
export function useSpeechInput(setText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  useEffect(() => {
    setSupported(getSpeechRecognitionCtor() !== null);
    // Stop the microphone if the chat unmounts while listening.
    return () => recognitionRef.current?.stop();
  }, []);

  const toggle = useCallback(
    (currentText: string) => {
      if (recognitionRef.current) {
        recognitionRef.current.stop(); // onend resets the state
        return;
      }
      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor) return;
      const recognition = new Ctor();
      recognition.lang = "en-US";
      recognition.continuous = false;
      recognition.interimResults = true; // show words as they are recognised
      const base = currentText;
      recognition.onresult = (event) => {
        // event.results is "array-like" (indexed + length) but not a real array, hence Array.from.
        const transcript = Array.from(event.results, (result) => result[0].transcript).join("");
        const joiner = base && !base.endsWith(" ") ? " " : "";
        setText(base + joiner + transcript);
      };
      recognition.onerror = () => setListening(false);
      recognition.onend = () => {
        setListening(false);
        recognitionRef.current = null;
      };
      recognitionRef.current = recognition;
      setListening(true);
      try {
        recognition.start();
      } catch {
        // e.g. microphone permission denied
        recognitionRef.current = null;
        setListening(false);
      }
    },
    [setText],
  );

  return { supported, listening, toggle };
}
