# Outreach Compass in Kibana Agent Builder

BlockSignal's agent, **Outreach Compass**, runs inside Kibana Agent Builder. Its tools are ES|QL queries over the
`sf311-encampments` and `sf-pitstops` indices. A Mistral connector drives it, and the Agent Builder MCP server exposes it to other clients.

Prereqs: run `npm run ingest` first so both indices exist. The deployment must be Elastic 9.x or Serverless with Agent Builder
available. In 9.1/9.2 you may need to enable it under **Stack Management > Advanced Settings > Agent Builder**.

## 1. Add Mistral as the LLM (connector)

`elastic/setup-agent-builder.js` does this for you. It creates a native **AI Connector** (`.inference`, provider
`mistral`, task `chat_completion`, model `mistral-medium-latest`) from `MISTRAL_API_KEY`. To do it by hand:

```
POST kbn:/api/actions/connector
{ "name": "Mistral Medium (inference)", "connector_type_id": ".inference",
  "config": { "provider": "mistral", "taskType": "chat_completion", "inferenceId": "mistral-chat-kbn",
              "providerConfig": { "model": "mistral-medium-latest" } },
  "secrets": { "providerSecrets": { "api_key": "<MISTRAL_API_KEY>" } } }
```

Don't use the OpenAI-compatible `.gen-ai` connector with provider "Other" for Mistral. Its tool calls get
`tool_call_id` = tool name, and converse fails with `duplicate tool_call_id` as soon as a tool is called twice (tested).

An agent has no stored LLM. Pick **Mistral Medium (inference)** in the Agent Builder chat's model picker, or pass
`connector_id` to `/api/agent_builder/converse`. You can also make it the default under **Stack Management > Advanced Settings > GenAI default connector**.

## 2. Create the tools + agent

The definitions live in [`agent-builder-tools.json`](./agent-builder-tools.json): 5 ES|QL tools plus 1 index_search tool and the agent.

### Option A: one command (zero deps)

```bash
# .env needs KIBANA_URL=https://<deployment>.kb.<region>.cloud.es.io  (and ES_API_KEY, reused for Kibana)
node --env-file=.env elastic/setup-agent-builder.js
# plus a smoke-test conversation through Mistral:
node --env-file=.env elastic/setup-agent-builder.js --smoke
```

The script upserts each tool (POST, falling back to PUT if it already exists) and the agent, then creates the Mistral connector if it's missing. At the end it prints the MCP URL.

### Option B: Kibana Dev Tools console (`kbn:` prefix)

```
POST kbn:/api/agent_builder/tools
{
  "id": "blocksignal.trend",
  "type": "esql",
  "description": "Week-over-week trend of encampment reports by neighborhood. Pass district as \"\" for the whole city.",
  "tags": ["blocksignal"],
  "configuration": {
    "query": "FROM sf311-encampments | WHERE requested >= NOW() - 14 days AND neighborhood IS NOT NULL AND (?district == \"\" OR district == ?district) | EVAL is_last7 = CASE(requested >= NOW() - 7 days, 1, 0), is_prev7 = CASE(requested < NOW() - 7 days, 1, 0) | STATS last7 = SUM(is_last7), prev7 = SUM(is_prev7) BY neighborhood | EVAL delta = last7 - prev7 | SORT delta DESC | LIMIT 15",
    "params": { "district": { "type": "string", "description": "Supervisor district, e.g. \"6\", or \"\" for all" } }
  }
}
```

Repeat for each object in `tools[]` of the JSON file. Then create the agent by pasting the `agent` object:

```
POST kbn:/api/agent_builder/agents
{ ...the "agent" object from agent-builder-tools.json... }
```

Check what you created:

```
GET kbn:/api/agent_builder/tools
GET kbn:/api/agent_builder/agents/outreach-compass
```

### Option C: curl

```bash
KB=https://<deployment>.kb.<region>.cloud.es.io
H=(-H "Authorization: ApiKey $ES_API_KEY" -H "kbn-xsrf: true" -H "Content-Type: application/json")

# each tool (needs jq)
jq -c '.tools[]' elastic/agent-builder-tools.json | while read -r t; do
  curl -s -X POST "$KB/api/agent_builder/tools" "${H[@]}" -d "$t"; echo
done
# the agent
jq -c '.agent' elastic/agent-builder-tools.json | curl -s -X POST "$KB/api/agent_builder/agents" "${H[@]}" -d @-

# talk to it (connector_id = your Mistral connector)
curl -s -X POST "$KB/api/agent_builder/converse" "${H[@]}" \
  -d '{"agent_id":"outreach-compass","connector_id":"<mistral-connector-id>","input":"We run a hygiene van tonight 6-9pm in the Tenderloin. Where should we stop?"}'
```

## 3. Tools at a glance

| Tool id | Type | Params | What it shows off |
|---|---|---|---|
| `blocksignal.hotspots` | ES\|QL | `district` (string, "" = all), `days` (integer) | geo: `ST_X/ST_Y` grid + `ST_CENTROID_AGG`, outcome mix via `CASE` |
| `blocksignal.nearest_open_help` | ES\|QL | `lat`, `lon` (float), `minute_of_day` (integer) | geo: `ST_DISTANCE`, open-now logic incl. overnight hours |
| `blocksignal.search_notes` | ES\|QL | `query` (string), `district` (string) | `semantic_text` (Mistral `mistral-embed`) via `MATCH` + `_score` |
| `blocksignal.trend` | ES\|QL | `district` (string) | `STATS ... BY` with last7/prev7 via `EVAL CASE` |
| `blocksignal.outcome_mix` | ES\|QL | `days` (integer) | aggregations by district x outcome |
| `blocksignal.search_reports` | index_search | none | built-in search over `sf311-encampments` |

ES|QL tool param types are `string | integer | float | boolean | date | ...` (`keyword`/`text`/`double` are rejected).
Optional parameters are avoided on purpose: they aren't supported on every Agent Builder version. The agent instructions tell the LLM
to pass `""` for "all districts".

If ingest reported `semantic_text on notes: no`, change `notes_semantic` to `notes` in `blocksignal.search_notes`. That gives
lexical BM25 `MATCH` instead. `MATCH` on a `semantic_text` field needs 8.18 / 9.0+.

## 4. Demo prompts

- Mayor's Office: *"Which 5 blocks in District 6 have the worst service gap this week, and where should we put a mobile Pit Stop?"*
- Charity: *"We run a hygiene van tonight 6-9pm in the Tenderloin. Where should we stop?"* (the agent passes `minute_of_day` 1080)
- *"Where are crews noting people declined services, and is it getting worse?"*

## 5. Expose it over MCP (bonus)

Agent Builder ships an MCP server that exposes every Agent Builder tool, including the `blocksignal.*` ones, over streamable HTTP:

```
https://<deployment>.kb.<region>.cloud.es.io/api/agent_builder/mcp
```

Use it from any MCP client, such as Claude Desktop, Cursor, VS Code, or Mistral Le Chat with custom MCP connectors. Use the `mcp-remote` bridge for stdio-only clients:

```json
{
  "mcpServers": {
    "blocksignal-elastic": {
      "command": "npx",
      "args": ["mcp-remote", "https://<deployment>.kb.<region>.cloud.es.io/api/agent_builder/mcp",
               "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "ApiKey <your-kibana-api-key>" }
    }
  }
}
```

Space-scoped deployments use `https://.../s/<space-id>/api/agent_builder/mcp`. For the A2A protocol, the agent card is at
`kbn:/api/agent_builder/a2a/outreach-compass.json`.
