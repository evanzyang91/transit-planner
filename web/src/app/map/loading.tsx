// Instant loading screen for /map.
//
// 📖 Learn: loading.tsx — Next.js automatically wraps page.tsx in a <Suspense>
// boundary and shows this file as its fallback. After clicking "Start Mapping",
// the URL switches to /map and this screen appears while the (large) map
// JavaScript is still downloading, instead of the old page sitting there
// looking frozen. https://nextjs.org/docs/app/api-reference/file-conventions/loading
//
// Deliberately tiny: no "use client", no hooks, no imports. As a Server
// Component it ships zero JavaScript, so it can appear before any of the map's
// own code has arrived.
//
// Colours: plain hex values (not bg-white / bg-stone-*) because globals.css
// force-overrides those classes in dark mode with !important, which would beat
// the `dark:` classes below. The light/dark backgrounds sit close to the Mapbox
// light/dark base maps, so the hand-off to the real map doesn't flash.
// `dark:` keys off the `.dark` class that layout.tsx's inline script sets
// before first paint, so there's no light flash in dark mode either.
export default function MapLoading() {
  return (
    <main className="flex h-screen w-screen items-center justify-center bg-[#f5f5f4] dark:bg-[#1c1c1e] hc:bg-black">
      {/* role="status" = a polite live region, so screen readers announce it. */}
      <div
        role="status"
        className="flex items-center gap-3 rounded-full bg-white/90 px-5 py-3 text-sm font-medium text-zinc-700 shadow-sm ring-1 ring-black/5 dark:bg-zinc-800/90 dark:text-zinc-100 dark:ring-white/10"
      >
        {/* Indigo = app-chrome accent (teal is reserved for AI features).
            Reduced-motion users get a gentle pulse instead of spinning.
            📖 Learn: motion-safe / motion-reduce — https://tailwindcss.com/docs/hover-focus-and-other-states#prefers-reduced-motion */}
        <span
          aria-hidden="true"
          className="h-4 w-4 rounded-full border-2 border-indigo-200 border-t-indigo-600 motion-safe:animate-spin motion-reduce:animate-pulse dark:border-indigo-400/30 dark:border-t-indigo-400"
        />
        Loading map…
      </div>
    </main>
  );
}
