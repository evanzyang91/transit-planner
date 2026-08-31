~~Upload any kml, kmz, or shp file for custom data to be overlayed temporarily for comparison purposes.~~ ✓ Done

~~Transit desert finder~~ ✓ Done
~~Composite Transit Access Score per population cell. Runs client-side on popRawData + all routes (existing TTC/GO + user-drawn).~~
~~Algorithm: access_score = (frequency_score × mode_weight × connectivity_bonus) / distance_penalty~~
~~desert_severity = density_normalized × (1 - access_score)~~
~~Toggle: Map Layers → "Transit deserts". Red = high population + poor access.~~
~~Drawing a new route updates the desert map in real time.~~ ✓ Done (implemented in useTransitDesert.ts)

~~More info when GTFS realtime is shown~~ ✓ Done
Vehicle popup now shows: route name (looked up from ROUTES), compass heading from bearing, trip ID (last 2 segments).



A "chat" interface (but this would first require defining what the chat interface would do and what data it would be fed and its goals)

Being able to select models. Important because we need to integrate Gemini.

Full feature parity with jwp nyc Brand New Subway.

"Transit planner works best on desktop. Mobile app coming soon."


Integrate/define CI/CD pipelines

## AI Council v2 — genuine geographic debate

**Migrate off Backboard → direct Anthropic SDK (`@anthropic-ai/sdk`)**
Backboard has no tool use support. Direct SDK unlocks tool calls and is better for the resume.
Drop createAssistant/createThread (Backboard "memory" is just injected text anyway); replace streamMessage with anthropic.messages.stream().

**Two-layer geographic grounding:**
1. Upfront context brief — before debate starts, inject: user's drawn route GeoJSON, real TTC stops within 1km of corridor (from transit-data.ts), population density summary from Supabase, ridership at adjacent stations. Agents should already know this walking in.
2. Agent tool calls (mid-debate, Sonnet agents only) — query_stops_near(lat, lng, radius_m), get_population_density(bbox), get_ridership(stop_id), snap_to_nearest_intersection(lat, lng). Lets agents verify specific claims rather than hallucinate coordinates.

**Route modification not just route proposal**
Agents should be able to propose delta changes (move stop X north 400m, cut stop Y) rather than always generating a full new route from scratch.



EITHER add a WARNING or save EVERYTHING to local storage or auth

We might need to add more disclaimers such as Data used in this product or service is provided with the permission of Metrolinx. Metrolinx makes no representations or warranties of any kind, express or implied, with respect to the Data and assumes no responsibility for the accuracy or currency of the data used in this product or service.



BE ABLE TO TRACK KEY METRICS 
Like how many placed lifetime
How many export lifetime
beyond page views

INTEGRATE LOGGING/MONITORING AND UPTIME PLATFORM


save data to account

give better view options for screenshots like showing station name next to each stop


1. Saving data to an account — Yes, use Supabase
Don't use Auth0 for data storage. Auth0 has user_metadata / app_metadata but it's meant for small identity-adjacent fields (display name, preferences), not structured route data. It has a 16KB limit and no querying capability.

The right pattern: Auth0 handles who you are, Supabase handles your data. You already have both — you just need to link them with the Auth0 user ID (authUser.sub).

Two implementation options:

Option A — Server-side API routes (recommended for now)

Client calls a Next.js API route (e.g. /api/projects/save)
API route reads Auth0 session server-side, then writes to Supabase with the service-role key
Pro: Simple, secure, you already have the server Supabase client
Con: Every save goes through the server
Option B — Supabase RLS + Auth0 JWT

Configure Supabase to trust Auth0 JWTs; client calls Supabase directly
Pro: Scales better, fine-grained row-level security
Con: Non-trivial setup (custom JWKS endpoint, Supabase custom auth)
For a student project, start with Option A. The database schema would look like:


CREATE TABLE user_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,        -- Auth0 sub, e.g. "auth0|abc123"
  name text NOT NULL DEFAULT 'My Project',
  routes jsonb NOT NULL DEFAULT '[]',  -- your Route[] serialized
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX ON user_projects(user_id);
Then a POST /api/projects/save route that reads auth0.getSession() for the sub, writes to Supabase. The frontend calls it on demand or periodically.

📖 Learn: Row Level Security (RLS) in Supabase — if you move to Option B later, this is what enforces "users can only read their own rows" at the database level without server code.


Do actually good exports to png etc. this will require a lot of custom logic and design and can't be vibe coded


UX for initiating the council: being able to select high strain areas in simulation,
or chatbot interface with neighborhood selection more like claude code selecting code

IMPROVE SEO
"fantasy transit map"



We need to make the ai more agentic. it needs to have better understanding of its environment and have more tools to always know the geospatial data; it should be able to actually plot lines which can serve as a better basis for the ai council. and it should be able to run the simulation and then understand whats weak, run the council, have a new network then test it again. it should be very observable as well.

Generate renders with street view + nano banana

## Extended thinking in the AI chat

Not configured anywhere today. All five Anthropic call sites in `web/src/server/anthropic.ts`
(lines 104, 144, 215, 275, 345) pass only model/max_tokens/system/messages — no `thinking`
field, no `output_config`. The "thinking…" string in ChatPanel.tsx:362 is just a pending-state
spinner label, not the API feature.

Two things block it as-is:

**Model.** `/api/ai/chat` defaults to `claude-haiku-4-5-20251001`. Haiku 4.5 predates adaptive
thinking, so it only accepts the older fixed-budget form `thinking: {type: "enabled",
budget_tokens: N}`. Adaptive thinking and the `output_config.effort` dial need 4.6+.
council-graph.ts already uses `claude-sonnet-4-6` for the Sonnet agents — that half could take
`{type: "adaptive"}`, but it has to be set explicitly (omitting `thinking` on 4.6 = no thinking).

**max_tokens too small.** Chat defaults to 600, streamDirect to 1024. On the fixed-budget form
`budget_tokens` has a 1024 minimum and must be strictly less than max_tokens — so at 600 there
is no legal value, and 1024 leaves no room for a visible answer after the reasoning. Raising
max_tokens is a prerequisite, not a tuning step.

Also note the provider is pluggable (`getProvider()` in ai-provider.ts) and gemini.ts is a real
second backend on `@google/generative-ai` with its own reasoning controls — "does chat think?"
depends on which provider the request routes to, so this needs deciding per-surface, not globally.

📖 Learn: adaptive thinking vs. budget_tokens — the older API made you pre-commit a fixed
reasoning budget; 4.6+ lets the model decide per request, with output_config.effort as a coarse
dial. Which era a model belongs to determines which config form you're stuck with.


## Privacy — two open decisions (added 2026-08-31)

Both are deliberately NOT in the privacy policy because neither is live. If
either ships, update `web/src/app/privacy/page.tsx` in the same commit.

- `trackUserSignIn` in `web/src/server/discord.ts` sends name + email to Discord.
  Exported, zero callers. Delete it, or wire it up AND disclose it — Section 2
  currently says profile data goes to the auth provider, not to Discord.
- The 200-char chat preview (`trackChatMessage`, called from
  `api/ai/chat/route.ts`) IS disclosed, but it lands in a channel a person reads
  rather than a metrics dashboard. Decide if it should exist.

Note: the `skip_tracking` localStorage opt-out covers Mixpanel and visit
reporting only. Both flows above are server-side and ignore it.
