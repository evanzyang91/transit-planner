/**
 * Small inline SVG icons for the Ask AI chat. Inline (not an icon library) to
 * avoid a new dependency. Every icon is decorative (`aria-hidden`): the button
 * around it carries the accessible name via aria-label.
 */

interface IconProps {
  className?: string;
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** The AI mark used across the app (also in the right-click menu). */
export function SparkleIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d="M8 1.5L9.5 6L14 7.5L9.5 9L8 13.5L6.5 9L2 7.5L6.5 6Z" />
    </svg>
  );
}

/** Pencil on a square — "start a new conversation". */
export function NewChatIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} {...STROKE}>
      <path d="M7.5 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V8.5" />
      <path d="M12.1 1.9a1.3 1.3 0 0 1 1.9 1.9L8.4 9.4 6 10l.6-2.4z" />
    </svg>
  );
}

export function ExpandIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} {...STROKE}>
      <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
    </svg>
  );
}

export function CollapseIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} {...STROKE}>
      <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" />
    </svg>
  );
}

export function CloseIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} {...STROKE}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function SendIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} {...STROKE} strokeWidth={2}>
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

export function StopIcon({ className = "h-3 w-3" }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <rect x="2" y="2" width="8" height="8" rx="1.5" />
    </svg>
  );
}

export function MicIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d="M10 1.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z" />
      <path d="M5 9.5a.75.75 0 0 1 1.5 0 3.5 3.5 0 0 0 7 0 .75.75 0 0 1 1.5 0 5 5 0 0 1-4.25 4.95V17h2.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5h2.5v-2.55A5 5 0 0 1 5 9.5z" />
    </svg>
  );
}

export function CheckIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} {...STROKE} strokeWidth={2}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

export function ErrorIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} {...STROKE}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v3.6M8 10.9v.1" strokeWidth={2} />
    </svg>
  );
}

/** A short dash: a step that was cut off when the turn stopped. */
export function DashIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} {...STROKE} strokeWidth={2}>
      <path d="M5 8h6" />
    </svg>
  );
}

/** A spinning arc. `motion-safe:` skips the spin for people who asked the OS for reduced motion. */
export function SpinnerIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={`motion-safe:animate-spin ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="8" cy="8" r="6" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronIcon({ className = "h-3 w-3" }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" className={className} {...STROKE}>
      <path d="M4.5 3l3 3-3 3" />
    </svg>
  );
}

export function RetryIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className} {...STROKE}>
      <path d="M13 8a5 5 0 1 1-1.5-3.55" />
      <path d="M13 2.5v3h-3" />
    </svg>
  );
}

/** Diagonal grip lines for the top-left resize corner. */
export function ResizeGripIcon({ className = "h-3 w-3" }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" className={className} {...STROKE} strokeWidth={1.2}>
      <path d="M2 10 10 2M2 6 6 2" />
    </svg>
  );
}
