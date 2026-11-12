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

  // Fire-and-forget (no await): server start must not wait for Supabase.
  void warmCensusRaster();
}

/**
 * Start loading the Toronto census raster now, so the first Ask AI question
 * doesn't pay for it (~13k rows; it used to add seconds to the first answer).
 * Requests that arrive meanwhile join the same in-flight fetch.
 */
async function warmCensusRaster(): Promise<void> {
  // `next build` also loads this file; there is nothing to warm there.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    const { getTorontoRaster } = await import("./server/map-data/census");
    await getTorontoRaster();
  } catch (err) {
    // Never let a warm-up problem affect the server — requests fetch on demand.
    console.warn("[instrumentation] census warm-up failed:", err);
  }
}
