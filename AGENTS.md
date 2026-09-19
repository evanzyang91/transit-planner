# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Working in this repo

- The Next.js app is `web/`. Run every npm command from there, not the repo root.
- `npm run check` = `validate-routes && vitest run && next lint && tsc --noEmit`.
  **It does not pass on a clean checkout**: ~38 files carry pre-existing `next lint`
  errors and 4 carry pre-existing `tsc` errors. Judge a change by whether it adds
  errors in the files it touches, not by the exit code. `vitest run` and
  `validate-routes` do pass and should stay passing.
- The repo is not Prettier-formatted (`npm run format:check` fails widely and is
  deliberately absent from `check`). Match the surrounding file, not Prettier.
- One `.env` at the repo root, gitignored. The app reads `ANTHROPIC_API_KEY`
  (`web/src/env.js`); a key stored as `CLAUDE_KEY` will not be picked up.

## Route generation

- `web/src/server/route-metrics.ts` is the single source of truth for what makes a
  route good: cost, coverage, geometry, efficiency. It is pure and I/O-free —
  population is injected via `PopulationSource` — so it is usable from tests, the
  server and scripts alike. Older per-caller cost formulas still exist in
  `council.ts` and `TransitMap.tsx`; do not add a fourth.
- `web/scripts/eval-routes.mjs` drives the **live** council against the golden
  selections and records what it produces. `--list` shows the selections;
  `--recompute` re-scores the recorded baseline without spending API credit.
  It loads the app's TypeScript directly via Node type-stripping plus
  `module.registerHooks` — no build step, no duplicated copy of the metrics.
- Fixtures in `web/src/server/__fixtures__/`: `golden-selections.json` (the
  selections, with polygons from the City's 158-neighbourhood file) and
  `baseline-routes.json` (recorded live council output, scored).
- `web/src/server/AGENTS.MD` says the project is "frontend-only, do not modify
  server-side logic". That is stale and contradicts current work in `src/server`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
