# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- The app lives in `web/`; run `npm run check` (lint + typecheck + tests) and `npm run dev` from `web/`, not the repo root.
- There are two Toronto neighbourhood catalogues — don't let new code pick the wrong one. `web/src/server/map-data/city-neighbourhoods.ts` is the real one: the official 158-entry City dataset, matching every `AREA_NAME` in `web/public/Neighbourhoods - 4326.geojson` (what the UI sends). `web/src/app/map/toronto-neighbourhoods.ts` is a legacy 16-entry hand-drawn downtown-only set kept only as a fallback for old/custom names. Any new code resolving a neighbourhood name should call `cityNeighbourhoodRing`/`cityNeighbourhoodAt` from `city-neighbourhoods.ts` first (see `web/src/server/map-data/tools.ts` and `resolveBriefNeighbourhood` in `web/src/server/council-graph.ts` for the pattern), falling back to the legacy set only if needed.
- Local `web/.env` needs `ANTHROPIC_API_KEY`, `SUPABASE_URL`/`SUPABASE_KEY`, `ELEVENLABS_KEY`, `NEXT_PUBLIC_MAPBOX_TOKEN`, and `AUTH0_*`/`APP_BASE_URL` to run `npm run dev` end-to-end (see `web/src/env.js`). No login is required to use the map/council feature.
- `npm run dev` currently 500s on every page: `web/src/lib/analytics.ts` imports `mixpanel-browser`, which isn't in `web/package.json`. Pre-existing, unrelated to any one feature — install it locally to unblock manual testing, but don't ship the dependency add as a side effect of an unrelated PR.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
