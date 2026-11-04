# BlockSignal: internal contract (shared by backend, elastic, UI)

BlockSignal is the product. "Outreach Compass" is its AI agent feature (the chat agent). Idea: docs-IDEA.md. 311 encampment reports measure complaints, not need.
Need = reports clustered FAR from any OPEN help (Pit Stops). Block-level only, no individuals, no photos.

Runtime: Node 22, ZERO npm deps (use global fetch, node:http, node:fs). ESM. Run: `npm start` (loads .env via --env-file).
Env: MISTRAL_API_KEY, ES_URL (may be empty -> local fallback), ES_API_KEY, PORT=8787.

## Data sources (public, no key; note host is data.sf.gov — data.sfgov.org redirects)
- 311 encampments: https://data.sf.gov/resource/vw6y-z8j6.json  where service_name='Encampment', last 30 days, $limit=50000.
  fields: service_request_id, requested_datetime, status_description, status_notes, address, supervisor_district ("6.0"), analysis_neighborhood, lat, long.
  status_notes look like "unable_to_locate - Agency responded...", "case_resolved - Team responded, provided service information...", "case_cancelled - call PD", "open".
- Pit Stops: https://data.sf.gov/resource/mr6h-cr3u.json  fields: name, address, hours (free text: "Daily 7am to 3pm", "Close Time: 5pm  to Open Time: 9am", "Open 24 hours", sometimes missing), neighborhood, location.coordinates [lon,lat].

## Files / ownership
- server/server.js, server/lib/data.js, server/lib/mistral.js, server/lib/agent.js  -> BACKEND agent
- server/lib/elastic.js, scripts/ingest.js, elastic/*  -> ELASTIC agent
- public/*  -> UI agent

## server/lib/elastic.js interface (ELASTIC agent implements, BACKEND imports)
```js
export const enabled: boolean            // true iff ES_URL && ES_API_KEY
export async function ping(): Promise<{connected:boolean, cluster?:string, error?:string}>
export async function ingest(reports, pitstops): Promise<{reports:number, pitstops:number}>  // reports/pitstops in normalized shape below
export async function hotspots({district, days=7, precision=17, limit=20}): Promise<Array<{tile:string, lat:number, lon:number, count:number}>>  // geotile_grid agg
export async function searchNotes({query, district, limit=10}): Promise<Array<{id, address, district, neighborhood, notes, outcome, requested, score}>> // semantic_text if available, else match
export async function trendByNeighborhood({district}): Promise<Array<{neighborhood, last7, prev7, delta}>> // ES|QL
export async function nearestPitStops({lat, lon, limit=3}): Promise<Array<{id,name,distanceM}>> // geo_distance sort
```
All functions must throw nothing when disabled; callers check `enabled` first. Backend falls back to in-memory equivalents.

Normalized report: `{id, requested (ISO), status, notes, outcome, address, district ("6"), neighborhood, lat, lon}`
outcome ∈ resolved | services_offered | declined | not_found | medical | cancelled | open | other
Normalized pitstop: `{id, name, address, neighborhood, lat, lon, hoursRaw, hours:{is24h, open:"HH:MM", close:"HH:MM", days:["mon",...]}|null}`

## HTTP API (BACKEND implements, UI consumes). Static files served from /public.
- GET /api/status -> `{mistral:true, elastic:{enabled, connected, cluster?}, counts:{reports, pitstops, cells}, asOf, models:{agent, parser}}`
- GET /api/cells?district=6 (optional) -> `{cells:[Cell]}` sorted by gapScore desc
  Cell = `{id, lat, lon, bounds:[[s,w],[n,e]], count7, countPrev7, count30, trend (count7-countPrev7), gapScore (0-100), nearest:{id,name,distanceM,openNow}|null, district, neighborhood, outcomes:{resolved,services_offered,declined,not_found,medical,cancelled,open,other}}`
  grid ≈ 0.003° lat x 0.004° lon (~330m). gapScore = normalized( log1p(count30) * (1 + recent weight) * min(distKmToNearestOPEN,2) ).
- GET /api/pitstops?at=ISO (optional, default now, America/Los_Angeles) -> `{pitstops:[Pitstop & {openNow:boolean}]}`
- GET /api/cell/:id -> `{cell, reports:[{requested, address, notes, outcome}] (latest 25)}`
- POST /api/chat body `{messages:[{role:"user"|"assistant", content}], persona:"mayor"|"charity", selectedCell?:id}`
  Response: `application/x-ndjson`, one JSON per line:
  - `{"type":"tool_call","id","name","args"}`
  - `{"type":"tool_result","id","name","summary":"short human text","highlight":{"cells":[ids],"pitstops":[ids]}}`
  - `{"type":"answer","text":"markdown"}`
  - `{"type":"error","message"}`  then `{"type":"done"}`
- POST /api/briefing body `{district:"6"}` -> `{markdown}` one-page memo (Mistral).

## Agent tools (Mistral function calling, model mistral-medium-latest)
hotspots({district?, neighborhood?, limit?, open_at?}), nearest_open_help({lat, lon, at?}), search_notes({query, district?}),
trend({district?}), suggest_pitstop_site({district?}) -> cell that maximizes reports >800m from any open pit stop.
