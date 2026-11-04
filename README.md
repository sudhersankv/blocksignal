# BlockSignal

**311 encampment reports show where people complain. BlockSignal shows where people lack help.**

BlockSignal is an 8-bit, cyberpunk map of San Francisco. It joins live 311 encampment reports with Pit Stop locations and their opening hours. Blocks that get many reports and sit far from any *open* help light up as **service gaps**.

**Outreach Compass** is BlockSignal's AI agent. It answers two kinds of user:
- **P1, Mayor's Office / HSOC:** "Which 5 blocks in D6 have the worst service gap this week, and what should we do?"
- **P2, outreach charity:** "We run a hygiene van tonight, 6 to 9pm, in the Tenderloin. Where should we stop?"

Built for the Mistral × Elastic hackathon. The full idea and judging notes are in [docs-IDEA.md](docs-IDEA.md).

## Sponsor stack

| | What we use |
|---|---|
| **Mistral** | Structured outputs (`json_schema`) turn free-text Pit Stop hours into `{open, close, days}` and sort crew notes into outcomes. Function calling drives the Outreach Compass agent loop. `mistral-embed` powers semantic search. District briefings. |
| **Elastic** | `geo_point` indexes, `geotile_grid` hotspot aggregations, `geo_distance` nearest open help, a `semantic_text` field on crew notes, ES\|QL 7-day trend, and an **Agent Builder** agent that can be exposed over **MCP**. |

## Run it locally

You need Node 22 or newer. There are no npm dependencies.

```sh
cp .env.example .env   # fill in your keys (ask the team in chat, never commit them)
npm start              # http://localhost:8787
npm run ingest         # optional: load 311 + Pit Stops into Elasticsearch
```

`.env` keys:
- `MISTRAL_API_KEY`: from console.mistral.ai
- `ES_URL`: the Elasticsearch endpoint (the `.es.` URL, not the Kibana `.kb.` one)
- `ES_API_KEY`: an Elastic API key
- `KIBANA_URL`: used by `elastic/setup-agent-builder.js`
- `PORT`: defaults to 8787

If `ES_URL` is empty, the app still runs on an in-memory fallback.

## Repo map

```
server/server.js        HTTP server + static files + API routes
server/lib/data.js      Fetch DataSF 311 + Pit Stops, grid cells, gap score, open-now
server/lib/mistral.js   Mistral chat / tools / structured-output client
server/lib/agent.js     Outreach Compass: function-calling loop, NDJSON stream
server/lib/elastic.js   ES layer: ingest, geotile hotspots, semantic search, ES|QL, geo_distance
scripts/ingest.js       npm run ingest
elastic/                Agent Builder tools + agent, ES|QL queries, Kibana Maps steps
public/                 8-bit cyberpunk UI (vanilla JS + Leaflet, no build step)
CONTRACT.md             API contract between server, Elastic layer and UI: read this first
```

## API

See [CONTRACT.md](CONTRACT.md). The short version: `GET /api/status`, `GET /api/cells`, `GET /api/pitstops?at=`, `GET /api/cell/:id`, `POST /api/chat` (an NDJSON stream of tool calls and the answer), and `POST /api/briefing`.

## Deploy (Fly.io)

```sh
fly secrets set MISTRAL_API_KEY=... ES_URL=... ES_API_KEY=...
fly deploy
```

## Guardrails

BlockSignal works at block level only: no individuals and no photos. It is for routing **services**, not enforcement. 311 under-reports in some neighborhoods, so treat gaps as signals, not ground truth.

## Data

- [SF 311 Cases](https://data.sfgov.org/d/vw6y-z8j6) (`service_name = 'Encampment'`)
- [Pit Stop locations](https://data.sfgov.org/d/mr6h-cr3u)
