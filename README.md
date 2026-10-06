<div align="center">

# Transit Planner

_Design smarter cities, one route at a time._

![66FE219B-B97C-4352-A529-20B388656D78_1_201_a](https://github.com/user-attachments/assets/88ebaea1-07ac-419e-8425-58b83fd68a3e)

</div>

---

## Overview

Transit Planner is an AI-powered urban transit design tool for city planners. Draw proposed subway, LRT, or bus routes on a live map of Toronto — then watch a council of Claude agents debate your route in real time, stress-testing it for cost, ridership, community impact, and political risk.

No spreadsheets. No guesswork. Just a map, your cursor, and a room of AIs arguing about your decisions.

## Features

- **Interactive map** — draw, edit, and delete transit lines on a live Mapbox map of Toronto's full TTC network
- **AI route generation** — describe a corridor and the AI assistant proposes a route, snapping to real TTC stops
- **AI map assistant** — ask spatial questions ("where are the network gaps?") and get answers drawn directly on the map
- **AI council** — a LangGraph state machine runs five agents through proposal, simulation, critique, and verdict, looping back for revisions when critics contest the route; streams live via SSE
- **Transit simulation** — ridership gravity model, travel time scoring, and equity metrics for any proposed network
- **Population & traffic layers** — PostGIS-backed heatmaps of density, ridership demand, and road congestion
- **Street view** — preview any proposed stop location at street level
- **Timetable view** — schedule visualisation for planned routes
- **Agent voice** — ElevenLabs TTS reads agent quotes aloud during deliberation

## How the Council Works

The council is a **LangGraph state machine** (`web/src/server/council-graph.ts`), not a fixed
script. Eleven nodes, conditional edges, and two cycles — the path taken depends on what the
agents actually say.

```
START → setup → plannerRouter ─┬─→ plannerA ─┐
                               └─→ plannerB ─┴─→ sim → criticRouter ─┬─→ nimby ─┐
                                                                     └─→ pr ────┴─→ tally
                                                                                     │
                        ┌────────────── revise ←──────────────────────── contested? ─┤
                        │                                                            │
                        └─→ plannerRouter                          commission ←──────┘
                                                                        │
                                                              reject ───┴─── approve → END
```

| Node | Agent | Role | Model |
|---|---|---|---|
| `plannerA` | Alex Chen | Ridership Planner — equity and high-density corridors | Sonnet |
| `plannerB` | Jordan Park | Infrastructure Analyst — cost and feasibility | Sonnet |
| `nimby` | Margaret Thompson | Residents' Association chair | Haiku |
| `pr` | Devon Walsh | Communications Director — political risk | Haiku |
| `commission` | Planning Commission | Final verdict with binding modifications | Sonnet |

**Speaking order is decided at runtime.** `plannerRouter` and `criticRouter` pick who goes
first; whoever speaks second routes the graph onward. Nobody has a fixed slot.

**Simulation sits inside the loop.** The `sim` node runs the real ridership and scoring
simulation between proposal and critique, so critics react to numbers rather than prose.

**Revisions are cycles, not extra turns.** If the critics jointly contest two or more stops,
`tally` routes to `revise`, which sends *both* planners back to re-propose independently with
the critic feedback attached. The commission can also reject and push the graph back the same
way. Both loops are bounded by `MAX_REVISIONS = 2` so the graph always terminates.

Agents call the shared grounded tool registry — `rank_service_areas`, `query_population`,
`estimate_ridership`, `describe_location` — which is the same data layer the map assistant
uses, so the council and the UI cannot disagree about the numbers. Planning rules are enforced
in the prompts and in post-processing: 800 m minimum station spacing, no gap over 1500 m
between consecutive stops, and any stop within 800 m of an existing station must justify
itself as a transfer.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Mapping | Mapbox GL, Mapbox GL Draw |
| 3D | Three.js / React Three Fiber |
| AI | Anthropic Claude (Haiku 4.5 + Sonnet 4.6) · Gemini (optional) |
| Agent orchestration | LangGraph (`@langchain/langgraph`) |
| Auth | Auth0 via NextAuth v5 |
| Database | Supabase + PostGIS |
| Voice | ElevenLabs TTS |
| Testing | Vitest |
| LLM tracing | Langfuse |
| Deployment | Docker, Vercel |

## Local Development

### Prerequisites

- Node.js 20+
- [Mapbox](https://account.mapbox.com) public token
- [Anthropic API key](https://console.anthropic.com) for the AI council
- [Supabase](https://supabase.com) project with PostGIS (population and ridership layers)

### Setup

```bash
git clone https://github.com/evanzyang91/transit-planner.git
cd transit-planner
npm install

# Copy and fill in environment variables
cp .env.example web/.env.local

# Start the dev server (from repo root or web/)
npm run dev
```

App runs at `http://localhost:3000`. Navigate to `/map` for the planner.

### Scripts

All commands can be run from the repo root or `web/`:

```bash
npm run dev            # Next.js + Turbopack
npm run build          # Production build
npm test               # Vitest
npm run check          # validate data + test + lint + typecheck
npm run lint           # ESLint
npm run typecheck      # TypeScript
npm run format:write   # Prettier
```

### Tests

```bash
npm test               # 48 tests
npm run test:watch     # watch mode
npm run validate:routes # check generated-routes.json
```

Covers map geometry, stop identity/transfer detection, and gap ranking.

Geometry tests run against a fixture of **real** census coordinates, not generated
ones. An earlier suite of synthetic tests passed while the code was badly broken —
it assumed a regular grid the real data doesn't have. Use real fixtures here.

Route data lives in `generated-routes.json` and isn't typechecked, so
`validate-routes.mjs` checks it instead: unique ids, valid hex colours, every
stop a finite `[lng, lat]` inside Toronto.

### CI

`.github/workflows/ci.yml` runs tests + route validation on every PR. No secrets
needed — tests use dummy env values and make no network calls.

`lint` and `typecheck` aren't gated yet: they report 118 errors / 60 warnings and
3 pre-existing failures. Clear those first, then add them as steps.

Don't blanket-run `eslint --fix` to get there. It rewrites
`(map.getSource(id) as GeoJSONSource)` casts that Mapbox's typings genuinely need
and breaks the build — only about 14 of the errors are safely auto-fixable.

## Environment Variables

Set these in `web/.env.local`:

`web/src/env.js` is the source of truth — it declares and validates every variable
the app reads.

```bash
# Required
NEXT_PUBLIC_MAPBOX_TOKEN=pk.ey...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_service_role_key
ELEVENLABS_KEY=                     # agent voice TTS — schema requires it

# Required for the AI features (council, map assistant)
ANTHROPIC_API_KEY=sk-ant-...

# Auth0 sign-in (read by @auth0/nextjs-auth0)
AUTH0_SECRET=                       # openssl rand -hex 32
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_CLIENT_ID=
AUTH0_CLIENT_SECRET=
APP_BASE_URL=http://localhost:3000

# Optional
NEXT_PUBLIC_MIXPANEL_TOKEN=         # product analytics; omit to disable
GEMINI_API_KEY=                     # alternative AI provider
AI_PROVIDER=anthropic               # "anthropic" (default) or "gemini"
DISCORD_WEBHOOK_URL=                # fallback/general Discord notifications
DISCORD_REGULAR_VISITS_WEBHOOK_URL= # regular visit notifications
DISCORD_REFERRAL_VISITS_WEBHOOK_URL= # referral visit notifications
DISCORD_BUG_REPORTS_WEBHOOK_URL=    # bug report feedback notifications
LANGFUSE_PUBLIC_KEY=                # LLM tracing (https://cloud.langfuse.com)
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
LANGFUSE_TRACING_DEV=false          # "true" to send traces from local dev
```

Tracing is off unless both Langfuse keys are set **and** you're in production or
`LANGFUSE_TRACING_DEV=true`. Traces nest one span per LLM call and per tool call,
with token usage for cost.

## Project Structure

```
transit-planner/
├── web/
│   └── src/
│       ├── app/
│       │   ├── map/                # Main planner page
│       │   ├── timetable/          # Route schedule view
│       │   ├── docs/               # Documentation + AI chat
│       │   └── api/                # API routes (council, simulation, AI, data)
│       ├── server/                 # Council orchestration, AI providers, Supabase
│       │   ├── tracing.ts          # Langfuse setup
│       │   └── map-data/           # Census raster, gap ranking, map tools
│       ├── map/
│       │   ├── transit-data.ts     # Route types + TTC/GO lines
│       │   └── generated-routes.json  # 211 bus/streetcar/subway routes
│       └── lib/                    # Shared utilities
├── can_pop.geojson                 # Canadian population dataset (90MB)
├── Dockerfile.web
├── docker-compose.yml
└── vercel.json
```

## Contributing

PRs are welcome. For anything beyond small fixes, open an issue first.

## License

[MIT](LICENSE)
