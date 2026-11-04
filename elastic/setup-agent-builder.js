// Creates (or updates) the BlockSignal Agent Builder tools and the "Outreach Compass" agent in Kibana.
// Zero deps. Usage (from repo root):
//   node --env-file=.env elastic/setup-agent-builder.js
// Needs KIBANA_URL (e.g. https://<deployment>.kb.<region>.cloud.es.io) and ES_API_KEY (or KIBANA_API_KEY).
// Optional: AGENT_CONNECTOR_ID = id of your Mistral connector, to run a smoke-test conversation.
import { readFile } from 'node:fs/promises';

const KIBANA_URL = (process.env.KIBANA_URL || '').trim().replace(/\/+$/, '');
const API_KEY = (process.env.KIBANA_API_KEY || process.env.ES_API_KEY || '').trim();
const CONNECTOR_ID = (process.env.AGENT_CONNECTOR_ID || '').trim();

if (!KIBANA_URL || !API_KEY) {
  console.error('Set KIBANA_URL and ES_API_KEY (or KIBANA_API_KEY) in .env');
  process.exit(1);
}

async function kbn(method, path, body) {
  const res = await fetch(KIBANA_URL + path, {
    method,
    headers: {
      Authorization: `ApiKey ${API_KEY}`,
      'kbn-xsrf': 'true',
      'Content-Type': 'application/json',
      'elastic-api-version': '2023-10-31',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function upsert(kind, obj) {
  // kind: 'tools' | 'agents'
  const created = await kbn('POST', `/api/agent_builder/${kind}`, obj);
  if (created.ok) return 'created';
  if (created.status === 409 || /exist/i.test(JSON.stringify(created.json))) {
    const { id, type, ...rest } = obj; // id and type are immutable on update
    const updated = await kbn('PUT', `/api/agent_builder/${kind}/${encodeURIComponent(id)}`, rest);
    if (updated.ok) return 'updated';
    throw new Error(`update ${kind}/${id} -> ${updated.status} ${JSON.stringify(updated.json).slice(0, 400)}`);
  }
  throw new Error(`create ${kind}/${obj.id} -> ${created.status} ${JSON.stringify(created.json).slice(0, 400)}`);
}

const spec = JSON.parse(await readFile(new URL('./agent-builder-tools.json', import.meta.url), 'utf8'));
let failures = 0;
for (const tool of spec.tools) {
  try {
    console.log(`tool  ${tool.id}: ${await upsert('tools', tool)}`);
  } catch (e) {
    failures++;
    console.error(`tool  ${tool.id}: FAILED ${e.message}`);
  }
}
try {
  console.log(`agent ${spec.agent.id}: ${await upsert('agents', spec.agent)}`);
} catch (e) {
  failures++;
  console.error(`agent ${spec.agent.id}: FAILED ${e.message}`);
}

if (CONNECTOR_ID && !failures) {
  console.log('Smoke test conversation ...');
  const r = await kbn('POST', '/api/agent_builder/converse', {
    agent_id: spec.agent.id,
    connector_id: CONNECTOR_ID,
    input: 'Which 3 blocks in District 6 have the worst service gap this week?',
  });
  console.log(r.ok ? (r.json.response?.message || JSON.stringify(r.json).slice(0, 800)) : `converse -> ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
}

console.log(`\nMCP endpoint: ${KIBANA_URL}/api/agent_builder/mcp`);
process.exit(failures ? 1 : 0);
