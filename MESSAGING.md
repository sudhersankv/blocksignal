# BlockSignal messaging: the one source of truth for wording

Every page (map, Start here, help, README, pitch) uses these exact phrases. Plain words first, tech second.

## One-liner
**BlockSignal shows where people in San Francisco are missing help, block by block.**

## The problem (say it in this order)
1. San Francisco's 311 line gets thousands of encampment reports a month.
2. Those reports show where people **complain**. They don't show where people **lack help**.
3. Help, like Pit Stop restrooms, is often far away or **closed**, especially at night.
4. So outreach vans and city resources follow the loudest complaints, not the biggest gaps.

## Problem statement (quote exactly)
> Outreach teams and the Mayor's Office can't easily see which blocks have many reports **and** no open help nearby, right now.

## What BlockSignal does (3 steps, always these verbs)
1. **Combine:** live 311 encampment reports + Pit Stop locations and opening hours.
2. **Score:** every block gets a **Gap score**.
3. **Act:** ask **Outreach Compass**, our AI analyst, a plain question. It answers with ranked blocks, van routes and memos, and it shows its numbers.

## Key terms (use these words, nothing else)
| Term | Say this | Don't say |
|---|---|---|
| **Block** | "a block": a map square about 330 m wide (2–3 city blocks) | cell, tile, grid, geotile (in UI copy) |
| **Gap score** | "Gap score (0–100): how underserved a block is right now. Higher = more reports, more recent, and farther from open help. 100 = the most underserved block in the city today." | need score, risk, severity, heat |
| **Open help** | "a Pit Stop that is open at the time you picked" | services, resources (vague) |
| **Service gap** | "many reports + no open help nearby" | desert, hotspot (hotspot = only many reports) |
| **Outreach Compass** | "our AI analyst" | chatbot, bot, the agent (in UI copy) |
| **Report** | "a 311 encampment report" | case, complaint, ticket |

## District names (always "D# · Name", never a bare number)
SF supervisor districts have numbers, not official names, so we label them by their main neighborhoods (2022 lines):
| # | Label |
|---|---|
| 1 | D1 · Richmond |
| 2 | D2 · Marina & Pacific Heights |
| 3 | D3 · North Beach & Chinatown |
| 4 | D4 · Sunset |
| 5 | D5 · Tenderloin & Western Addition |
| 6 | D6 · SoMa & Mission Bay |
| 7 | D7 · West of Twin Peaks |
| 8 | D8 · Castro & Noe Valley |
| 9 | D9 · Mission & Bernal Heights |
| 10 | D10 · Bayview & Potrero Hill |
| 11 | D11 · Excelsior & Ocean View |
First mention on a page: "District 6 (SoMa & Mission Bay)". After that: "D6 · SoMa & Mission Bay" or "D6 SoMa".

## Who it helps, and what they gain (one line each)
- **Mayor's Office / HSOC:** Know which blocks to prioritize this week, and where a mobile Pit Stop would reach the most people. *Gain: the same budget closes more gaps.*
- **Outreach charities:** Plan tonight's van route in seconds, knowing which Pit Stops are closed. *Gain: reach more people per shift.*
- **Residents and advocates:** See service gaps with evidence, not anecdotes.
- *Coming next:* **Shop Opener** finds what a block is missing for small businesses.

## Built with (plain words → tech)
- **Mistral** reads messy Pit Stop hours and crew notes into clean data *(structured outputs)*, runs the Outreach Compass analyst *(function calling)*, and searches notes by meaning *(mistral-embed)*.
- **Elastic** stores every report on the map *(geo_point)*, finds where reports cluster *(geotile aggregations)*, measures distance to open help *(geo_distance)*, searches notes by meaning *(semantic_text)*, tracks weekly trends *(ES|QL)*, and runs the same analyst in Kibana *(Agent Builder, shareable over MCP)*.

## Guardrails (always this line)
Block-level only · No individuals · No photos · For services, not enforcement · 311 under-reports some areas, so treat gaps as signals.

## Style rules
- Short sentences. 8th-grade reading level. Active voice.
- Lead with the human outcome, then the number, then the tech.
- Every number has a unit and a time window ("37 reports in the last 30 days", "1.6 km", "open at 9 PM").
- No game words in the main UI (quest, mission, cast, player). One small pixel accent is fine.
