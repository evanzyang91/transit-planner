import "server-only";

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";

import { env } from "~/env.js";

/**
 * Langfuse LLM tracing wiring.
 *
 * WHY THIS SHAPE: Langfuse v5 is built on OpenTelemetry, and OTel allows only
 * ONE global TracerProvider — whichever library registers first wins. Rather
 * than compete for it, we hand Langfuse its own isolated provider via
 * setLangfuseTracerProvider(). Nothing else in the app can then be broken by
 * our tracing, and ours can't be silently swallowed by someone else's.
 *
 * 📖 Learn: OpenTelemetry TracerProvider — the object that creates spans and
 * owns the processors that export them. The documented caveat on isolation is
 * that OTel *context* (trace ids, parent links) is still shared at the runtime
 * level, so our spans may inherit a trace id from an outer span. That affects
 * grouping only, never delivery.
 */

/**
 * Tracing is off unless keys exist AND we're in production or explicitly
 * opted in locally — so a fresh clone with no Langfuse account just works,
 * and local iterations don't pollute the production project.
 */
export const tracingEnabled =
  Boolean(env.LANGFUSE_PUBLIC_KEY) &&
  Boolean(env.LANGFUSE_SECRET_KEY) &&
  (env.NODE_ENV === "production" || env.LANGFUSE_TRACING_DEV === "true");

/** Kept at module scope so route handlers can force a flush before returning. */
let processor: LangfuseSpanProcessor | null = null;

export function registerLangfuseTracing(): void {
  if (!tracingEnabled || processor) return;

  processor = new LangfuseSpanProcessor({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL,
  });

  setLangfuseTracerProvider(new NodeTracerProvider({ spanProcessors: [processor] }));
  console.log("[langfuse] tracing enabled →", env.LANGFUSE_BASE_URL);
}

/**
 * Push buffered spans now.
 *
 * Serverless functions are frozen the instant a response is returned, which
 * kills the background exporter before it ships anything. Every traced route
 * must await this or its traces silently never arrive.
 */
export async function flushTracing(): Promise<void> {
  if (!processor) return;
  try {
    await processor.forceFlush();
  } catch (err) {
    // Never let telemetry break a user-facing request.
    console.error("[langfuse] flush failed:", err);
  }
}
