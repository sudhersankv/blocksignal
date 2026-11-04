# BlockSignal: 2-minute pitch

Spoken script: about 290 words, which takes about 1:55 at a calm pace. Bold lines are what the speaker says. *Italics* are what's on screen.

## 0:00–0:15 · Hook (the reel)
*Play the reel, 10 seconds max, muted with captions or with sound down: a shop owner talking about encampments outside their store.*

**"Every SF shop owner knows this. The usual answer is to move people along, and they show up one block over. Moving people doesn't fix it. Getting them help does."**

## 0:15–0:40 · Shop Opener (the business side)
*Live map → Who's asking: **Shop opener** → click "I want to open a South Indian coffee shop in the Mission". Pins 1–3 drop.*

**"Say you want to open a coffee shop in the Mission. You can ask in any language. Mistral turns the question into structured JSON. Elasticsearch checks every vacant storefront against 100,000 registered businesses and 311 reports within 300 meters, then Mistral explains the top three."**

*Open one card → point at "Street conditions".*

**"Look at street conditions. You can't fix that block by block. You fix it with help that reaches people. So where is that help missing?"**

## 0:40–1:05 · The gap (the real problem)
*Switch to the **Start here** tab, stat tiles.*

**"311 got 3,445 encampment reports in the last 30 days. Almost half the time, crews arrive and can't find anyone. At 9 PM tonight, only 3 of 16 Pit Stops are open, and 319 of 382 blocks with reports are more than a kilometer from open help. 311 counts complaints. It doesn't show where help is missing. That's the gap."**

## 1:05–1:30 · Mayor's Office uses it
*Live map → **Mayor's Office** → point at Worst gaps → click the #1 block → "Why this score".*

**"For the Mayor's Office, every block gets a Gap score: many reports, rising, and far from open help. Click a block and it tells you why. Then they ask our AI analyst, Outreach Compass:"**

*Click the D6 · SoMa & Mission Bay question → answer + blocks highlight → (optional) "Get a district briefing memo".*

**"…it ranks the five worst blocks and says where a mobile Pit Stop would reach the most people. It also writes a printable briefing memo."**

## 1:30–1:50 · Outreach charity uses it
*Switch to **Outreach charity** → time **9 PM** → click the hygiene-van question → numbered route appears.*

**"A charity running a hygiene van tonight gets its stops in order, and sees which Pit Stops nearby are closed."**

## 1:50–2:00 · Under the hood + guardrails
**"Mistral reads messy hours and crew notes into clean data, and runs the analyst with function calling. Elastic does the geo, the aggregations, semantic search, ES|QL, and the same agent in Kibana Agent Builder over MCP. Block-level only: no people, no photos. It's for services, not enforcement. BlockSignal."**

---

## Before you go on (checklist)
- [ ] Open https://blocksignal.fly.dev **2 minutes early**. It sleeps when idle and the first load is slow.
- [ ] Tabs in order: **reel** → **live map** (intro banner closed with "Hide") → **/start.html** scrolled to the stat tiles → **/help.html#how-it-works** (backup for questions).
- [ ] Run each suggested question once beforehand so you know the timing (the analyst takes ~5–10 s, Shop Opener 10–40 s).
- [ ] **Shop Opener fallback:** if Guru's Elastic keys aren't connected yet, use https://blocksignal.fly.dev/?persona=shop&mockshop=1 (sample data). Say "sample run" if anyone asks.
- [ ] The reel is someone else's video: keep it short and credit the account on screen.
- [ ] Finalist round (3 min): add 30 s in Kibana. Show Agent Builder → Outreach Compass with the Mistral connector, and one ES|QL query from `elastic/esql-queries.md`.

## Wording to stick to (see MESSAGING.md)
"Block", "Gap score", "open help", "Outreach Compass, our AI analyst". Never "the homeless problem". Say "people without shelter" or "encampments". Lead with help, not removal. Judges will hear the guardrails.
