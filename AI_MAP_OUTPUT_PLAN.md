# AI map-output redesign — tool-use plan

> **STATUS (2026-07): shipped, then superseded by the grounded-artifact rearchitecture.**
> The tool-use approach below shipped, but freehand `highlight_area` polygons and the
> 16-neighbourhood `find_coverage_gaps` are gone. Current architecture:
> - One shared registry: [web/src/server/map-data/tools.ts](web/src/server/map-data/tools.ts)
>   over a data layer (live network sent per-request, cached census raster, raster gap
>   engine, shared gravity ridership model).
> - Area polygons are **server-computed artifacts**: the model calls
>   `find_coverage_gaps` → cites a `gap id` via `show_area`; it cannot emit polygon
>   coordinates. Corridors are validated + road-snapped server-side; pins validated
>   against inhabited land.
> - The system prompt is server-built per request ([map-data/prompt.ts](web/src/server/map-data/prompt.ts));
>   the client sends its live `routes` instead of a prompt.
> Kept for the history of the design discussion below.

> Goal: kill the wall-of-text AI replies (e.g. "Network Gaps Analysis…" with 5 markdown headers).
> AI should **draw on the map**, not write essays about it.
> One-line summary + a set of map annotations the user can see, click, and toggle off.

---

## TL;DR of the approach

Use **Anthropic's tool-use feature**. Define ~5 concrete "map tools" Claude can call.
Claude's reply ≈ short text summary + N tool calls. Each tool call → one annotation
rendered on the map. The chat shows the summary + a list of annotation chips that
fly the camera / pulse the annotation when clicked.

📖 Learn: [Anthropic tool use docs](https://docs.anthropic.com/en/docs/build-with-claude/tool-use).
This is the same mechanism Claude Code uses for `Read`, `Edit`, `Bash`, etc. — the
LLM emits structured JSON calls that our code executes, then can pass results back.

---

## Why this over JSON-output (approach B)?

| | Tool use (A) | Structured JSON (B) |
|--|--|--|
| Iterative analysis | ✅ Multi-turn: tool result → next tool call | ❌ One-shot |
| Streaming UX | ✅ Annotations appear as the model emits each call | ⚠️ Have to wait for full JSON, or stream-parse |
| Native protocol | ✅ First-class in Anthropic SDK | ❌ We invent + maintain a schema |
| Lift to ship | ⚠️ Bigger: server route changes + tool registry + annotation overlay | ✅ Faster |
| Debuggability | ✅ Tool calls log cleanly | ⚠️ Bad JSON = silent break |

Pick A. Pain is real but front-loaded; once the tools exist, adding more is cheap.

---

## The tool set (v1)

Five tools. Keep small — adding more later is easy, deleting tools the AI relies on is hard.

### 1. `highlight_area`
Shade a polygon on the map with a label. Used for "gap regions", "coverage holes", "demand clusters".
```json
{
  "name": "highlight_area",
  "description": "Shade a region on the map. Use for spatial findings like coverage gaps or demand clusters.",
  "input_schema": {
    "type": "object",
    "properties": {
      "polygon": { "type": "array", "items": { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 } },
      "label":   { "type": "string", "description": "Short label, e.g. 'Midtown north-south gap'" },
      "color":   { "type": "string", "enum": ["red", "amber", "violet", "emerald", "sky"] },
      "severity":{ "type": "string", "enum": ["info", "warning", "critical"] }
    },
    "required": ["polygon", "label", "color"]
  }
}
```

### 2. `draw_corridor`
Draw a proposed line segment between two points. For "I'd propose extending Finch West to…".
```json
{
  "name": "draw_corridor",
  "input_schema": {
    "properties": {
      "from":  { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 },
      "to":    { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 },
      "label": { "type": "string" },
      "mode":  { "type": "string", "enum": ["subway", "lrt", "streetcar", "bus", "rail"] }
    }
  }
}
```

### 3. `drop_pin`
A point with a note. For specific stops, intersections, or "this is the worst overlap".
```json
{
  "name": "drop_pin",
  "input_schema": {
    "properties": {
      "lat":  { "type": "number" },
      "lng":  { "type": "number" },
      "note": { "type": "string" },
      "icon": { "type": "string", "enum": ["warning", "info", "gap", "hub"] }
    }
  }
}
```

### 4. `fly_to`
Camera move. AI uses this to "I'm going to show you …" before highlighting.
```json
{
  "name": "fly_to",
  "input_schema": {
    "properties": {
      "bbox":   { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4 },
      "reason": { "type": "string" }
    }
  }
}
```

### 5. `query_network`  (the only *read* tool)
Lets the AI inspect the current network before annotating. Without this it has to guess.
```json
{
  "name": "query_network",
  "input_schema": {
    "properties": {
      "kind": { "type": "string", "enum": ["stops_in_bbox", "routes_in_bbox", "nearest_stop"] },
      "bbox": { "type": "array", "items": { "type": "number" } },
      "point":{ "type": "array", "items": { "type": "number" } }
    }
  }
}
```
This is what makes the difference between "Midtown has gaps" (hallucinated) and "actually only 2 routes pass through this 4-km² block" (verified).

---

## Architecture

```
┌──────────────────────┐
│ User asks AI a thing │
└──────────┬───────────┘
           │
           v
┌──────────────────────────────────────────────────────┐
│ /api/ai/chat  (Next.js route)                        │
│   • streams from Anthropic with tools=[...] config   │
│   • on tool_use: executes query_network locally,     │
│     returns result, loops back to the model          │
│   • write-tools (highlight, corridor, pin, flyTo)    │
│     forward straight to the client as SSE events     │
└──────────┬───────────────────────────────────────────┘
           │ SSE stream:
           │   {type:"text", delta:"…"}
           │   {type:"tool_call", name:"highlight_area", args:{...}}
           │   {type:"done"}
           v
┌──────────────────────────────────────────────────────┐
│ TransitAssistant (chat panel)                        │
│   • renders the short text summary                   │
│   • emits annotations into a context store           │
└──────────┬───────────────────────────────────────────┘
           │ via React context: AIAnnotationsProvider
           v
┌──────────────────────────────────────────────────────┐
│ TransitMap                                           │
│   • new overlay: ai-annotations                      │
│     • polygons → fill layer                          │
│     • corridors → line layer                         │
│     • pins → symbol layer                            │
│   • new toolbar pill: "AI findings (N)" with toggle  │
└──────────────────────────────────────────────────────┘
```

📖 Learn:
- **SSE (Server-Sent Events)** = one-way stream from server → client. Simpler than WebSockets. Next.js supports it via Response with `text/event-stream`.
- **React context store** = a single source of truth for AI annotations that both the chat panel (writer) and the map (reader) can subscribe to without prop-drilling.

---

## Implementation steps (in order)

### Phase 1 — server tool-call plumbing
1. Add `web/src/server/ai-map-tools.ts`: export the 5 tool definitions above as a single `mapTools` array typed against Anthropic's `Tool[]`.
2. Add `web/src/server/ai-map-tools.handlers.ts`: only `query_network` has a real handler (writes are client-only). Takes `{kind, bbox, point}`, returns matching stops/routes from `transit-data.ts`.
3. Modify `/api/ai/chat` route (find via `grep -r "anthropic.messages" web/src/app/api`):
   - Pass `tools: mapTools` and `tool_choice: { type: "auto" }` to the API call.
   - When the model emits a `tool_use` block:
     - If `query_network` → execute, append `tool_result` to messages, loop.
     - Otherwise (write tool) → forward the tool_call as an SSE event to the client without executing locally.

📖 Learn: **tool_choice** auto vs. required — `auto` lets the model decide whether to call a tool; `required` forces at least one call. We want `auto` so simple "what's a tram?" questions stay text-only.

### Phase 2 — client annotation store
4. Add `web/src/app/_components/map/AIAnnotationsContext.tsx`: provider + `useAIAnnotations()` hook. State shape:
   ```ts
   interface AIAnnotation {
     id: string;          // generated
     kind: "highlight" | "corridor" | "pin" | "flyTo";
     args: unknown;       // tool args
     turnId: string;      // groups annotations from one user turn
   }
   ```
   Methods: `add(annotation)`, `clearTurn(turnId)`, `clearAll()`, `setVisible(bool)`.
5. Wrap the map page with `<AIAnnotationsProvider>` near where `TransitAssistant` already lives.

### Phase 3 — wire the chat panel
6. Edit `useAnthropic.ts` (the hook that streams chat) to parse tool_call SSE events and call `useAIAnnotations().add(...)`.
7. In `TransitAssistant`, after each message render an annotation chip strip: each chip = label + color dot + click → flyTo the annotation's bbox. Add a "Clear annotations" button.

### Phase 4 — render annotations on the map
8. In `TransitMap.tsx`, add a `useAIAnnotations()` subscription. When the list changes, replace the contents of three Mapbox sources:
   - `ai-highlights` → FeatureCollection of polygon features
   - `ai-corridors` → FeatureCollection of line features
   - `ai-pins` → FeatureCollection of point features
9. Add the three matching Mapbox layers above the route layers but below the labels. Color the layers by the annotation's `severity`/`color` field. Pin layer uses `text-field: ['get', 'note']` for an inline callout.

📖 Learn: Mapbox renders **sources** (data) and **layers** (visual styling) separately. Updating a source automatically re-renders every layer that references it. This is why one `setData` call is cheap.

### Phase 5 — toolbar integration
10. Add an "AI findings" toggle to the Layers dropdown (using the same `OverlaySpec` pattern as the rest). Counter badge = annotation count. Pinning it brings the count to the toolbar.
11. When user clicks "Clear annotations" or `clearAll()`, hide the layers (don't delete sources — keep them ready for next turn).

### Phase 6 — prompt engineering
12. Update the system prompt for `/api/ai/chat`:
    ```
    You are a transit planner's spatial assistant. PREFER map annotations over prose.
    For every spatial finding, call highlight_area, draw_corridor, or drop_pin.
    Reserve text for a ONE-SENTENCE summary at the start. Never write more than 3
    sentences of prose. Use query_network to verify any specific claim about
    routes or stops before annotating.
    ```
13. Add a few-shot example in the prompt: question → 1 text sentence + 3 tool calls.

---

## Open questions for later

- **Which surfaces get tool use?** The floating Ask-AI chat for sure. The full Council (`ChatPanel.tsx`) is heavier — probably also yes, but per-agent. Decide once v1 ships.
- **Persisting annotations across sessions?** Probably yes, in `localStorage.t_aiAnnotations`. But TTL them — stale findings from yesterday are confusing.
- **Streaming UX:** while a tool call is mid-stream, do we show a "drawing…" shimmer? Probably yes; keep it subtle (200 ms fade-in on each annotation).
- **Error case:** what if Claude hallucinates a polygon outside the city bbox? Validate args server-side against a city bounding box; drop invalid calls and log them.

---

## Out of scope for v1

- Annotation editing (user dragging Claude's polygon to refine it).
- Persistent annotation comments / threaded discussion.
- Council-wide consensus annotations ("3 agents drew the same gap").

---

## Files touched / created (v1)

```
+ web/src/server/ai-map-tools.ts                          (tool defs)
+ web/src/server/ai-map-tools.handlers.ts                 (query_network impl)
+ web/src/app/_components/map/AIAnnotationsContext.tsx    (store)
~ web/src/app/api/ai/chat/route.ts                        (loop + SSE)
~ web/src/app/_components/useAnthropic.ts                 (parse tool calls)
~ web/src/app/_components/map/TransitAssistant.tsx        (chip strip)
~ web/src/app/_components/TransitMap.tsx                  (annotation layers)
~ web/src/app/_components/map/LayersDropdown.tsx          (no change — uses existing OverlaySpec)
```
