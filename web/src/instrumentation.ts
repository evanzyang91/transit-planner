/**
 * Next.js instrumentation hook — runs once per server process, before any
 * request is handled. https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register() {
  // The OTel SDK is Node-only; the edge runtime would fail to load it.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Imported dynamically so edge/browser bundles never pull in Node deps.
  const { registerLangfuseTracing } = await import("./server/tracing");
  registerLangfuseTracing();
}
