# Outreach Compass: final idea (stress-tested against the judging rules)

## What the organizers' repo says matters
- Judging: **Novelty, Use of Elastic, Use of Mistral.** The demo must show both, plus who it helps, what it does, how you use it.
- "About ideas, not interfaces": a Kibana, notebook or Dev Tools demo is fine.
- Elastic gets bonus points for: geo, aggregations, ES|QL, `semantic_text`/vector, **Agent Builder (bonus)**, MCP.
- Mistral: function calling, structured outputs, embeddings, vision, OCR, agents.
- Teams of 3 max. A 2-minute pitch at 7:30, and a 3-minute finalist pitch at 8:00.
- Starter repo has a `sf_311_cases.ipynb` ingest notebook that already builds `geo_point`.

## Grilling the earlier ideas
| Idea | Verdict | Why |
|---|---|---|
| Encampment heatmap dashboard | Not novel | The city already has internal versions. A heatmap alone just shows complaint counts. |
| Neon, game-style custom UI | Cut it | Front-end work eats the ~80 min. Judges said ideas over interfaces. **Use Kibana Maps in dark mode for the neon look, for free.** |
| Missions/gamification | Cut it | It's fun, but it doesn't score on any criterion. |
| Charities marking blocks "visited" | Stretch only | There's no real charity data feed. Mention it as roadmap. |
| Mistral vision on 311 photos | Skip | These are photos of unhoused people. Bad optics and a privacy risk. |
| **Service-gap finder plus agent** | **Do this** | Uses geo joins (Elastic's strength) and Mistral structured outputs + agent, and the "complaints ≠ need" insight is new. |

## The idea
**Outreach Compass** is an AI agent in Kibana that tells the Mayor's Office and outreach charities where people are underserved *right now*, and what to do about it.

Key insight (novelty): 311 encampment reports measure *complaints*, not *need*. Need is highest where reports cluster **far from any open help** (Pit Stops, services), and where crew notes say services were offered but declined or people weren't found. Nobody joins those today.

### How each part of the stack earns points
**Elastic**
1. Index `sf311-encampments` (from the starter notebook) and `sf-pitstops` (DataSF `mr6h-cr3u`), both with `geo_point`.
2. `status_notes` → a `semantic_text` field (Mistral embeddings through an inference endpoint) so you can search "declined services", "medical need", "blocking sidewalk".
3. A **geotile/geohash grid aggregation** finds hotspots. Then **geo_distance** to the nearest *open-now* Pit Stop gives a "service gap" score.
4. An ES|QL query ranks blocks by trend: last 7 days vs the prior 7.
5. **Agent Builder** agent "Outreach Compass" with 3 custom tools (`hotspots`, `nearest_open_help`, `search_notes`). It can be exposed through the **MCP server** (bonus).
6. **Kibana Maps** in dark mode is the neon city view: hotspot grid, Pit Stops layer, gap circles.

**Mistral**
1. **Structured outputs:** Pit Stop hours are free text ("Close Time: 5pm to Open Time: 9am"). Mistral parses them into `{open, close, days}` so "open now" queries work. Small, concrete, impressive.
2. **Structured outputs on crew notes:** classify each note into `resolved | services_offered | declined | not_found | medical | other`. That gives an "outcome mix" per block.
3. **Agent brain:** a Mistral model drives the Agent Builder agent (or a Python function-calling loop as fallback; see the repo's `using_mistral_in_elasticsearch.md`).
4. **Briefing:** a one-page memo per supervisor district.

### Two personas, one agent
- **Mayor's Office / HSOC:** "Which 5 blocks in D6 have the worst service gap this week, and what should we do?" The answer ranks blocks with the numbers and suggests where to put a new mobile Pit Stop for the biggest coverage.
- **Charity:** "We run a hygiene van tonight, 6–9pm, in the Tenderloin. Where should we stop?" The answer gives 3 to 4 stops ordered by gap and trend, closed Pit Stops nearby, and recent note themes.

### Guardrails (say these in the pitch)
Block-level only, no individuals, no photos. It's built for routing *services*, not enforcement. Caveat: 311 data under-reports in some neighborhoods.

## Build plan (~80 min, up to 3 people)
| Min | Person A (Elastic) | Person B (Mistral) | Person C (demo) |
|---|---|---|---|
| 0–20 | Run 311 notebook, filter `service_name='Encampment'`, last 90 days. Index Pit Stops. | Hours parser + notes classifier with structured outputs | Kibana Maps: dark mode, hotspot grid + Pit Stops layers |
| 20–45 | Gap query: geotile agg + geo_distance; ES|QL trend | Write classified outcomes back to ES (update by id) | Draft 2-min pitch, screenshot fallback |
| 45–70 | Agent Builder: 3 tools, Mistral connector | District briefing prompt | Rehearse the two persona questions live |
| 70–80 | Freeze. Rehearse. | | |

**Fallback if Agent Builder + Mistral connector is slow to set up:** a 40-line Python Mistral function-calling loop whose tools hit ES. Demo it in a notebook next to Kibana Maps.

## 2-minute pitch outline
1. (15s) "311 gets ~4,000 encampment reports a month. They tell you where people *complain*, not where people *lack help*."
2. (20s) Show the Kibana dark map: hotspots and Pit Stops, with the gaps lighting up.
3. (40s) Live: the charity question → the agent's answer with stops.
4. (25s) Live: the Mayor's Office question → ranked blocks + suggested new Pit Stop spot.
5. (20s) Under the hood: semantic_text + geo agg + geo_distance + ES|QL + Agent Builder; Mistral structured outputs + agent. Guardrails in one line.
