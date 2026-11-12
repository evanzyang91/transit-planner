"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

/**
 * Renders the assistant's markdown answer with chat-sized styles.
 *
 * Safety: react-markdown builds React elements from the markdown — it never
 * injects raw HTML (no rehype-raw), and its default urlTransform strips
 * `javascript:` links. Images are rendered as their alt text so a reply can't
 * make the browser fetch arbitrary URLs.
 *
 * No remark-gfm (tables, strikethrough): it isn't installed and we don't add
 * dependencies for this; the prompt asks for short answers and lists.
 */
const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold text-stone-900 dark:text-stone-50">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-teal-600">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-teal-700">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  // Headings stay small — this is a chat bubble, not a document.
  h1: ({ children }) => <h3 className="mb-1 mt-3 text-[13px] font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1 mt-3 text-[13px] font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-2.5 text-[13px] font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 text-[12px] font-semibold uppercase tracking-wide first:mt-0">{children}</h4>,
  // A new tab, so following a link never navigates away from the map (and the plan in it).
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-teal-700 underline decoration-teal-700/40 underline-offset-2 hover:decoration-teal-700 dark:text-teal-300 dark:decoration-teal-300/40"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-teal-300 pl-3 text-stone-600 dark:border-teal-700 dark:text-stone-300">
      {children}
    </blockquote>
  ),
  // Fenced code: the <pre> is the box; the inner <code> drops its inline styling.
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-stone-100 p-2.5 text-[12px] leading-relaxed dark:bg-stone-800 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children, className }) => (
    <code
      className={`rounded bg-stone-100 px-1 py-px font-mono text-[12px] text-stone-800 dark:bg-stone-800 dark:text-stone-100 ${className ?? ""}`}
    >
      {children}
    </code>
  ),
  hr: () => <hr className="my-3 border-stone-200 dark:border-stone-700" />,
  img: ({ alt }) => <span className="italic text-stone-500">{alt ? `[${alt}]` : "[image]"}</span>,
};

/** Memoised: only the streaming message's text changes, so old answers aren't re-parsed. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return <ReactMarkdown components={COMPONENTS}>{text}</ReactMarkdown>;
});
