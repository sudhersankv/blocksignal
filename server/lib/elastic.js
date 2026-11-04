// BlockSignal: Elasticsearch layer (zero deps, raw fetch).
// Implements the interface in CONTRACT.md. Nothing here throws at import time,
// and every exported function returns an empty/neutral value when ES is disabled.
//
// Showcases: geo_point + geotile_grid/geo_centroid aggs, geo_distance sort,
// ES|QL (POST /_query), semantic_text (Mistral embeddings inference endpoint,
// ELSER fallback), _bulk NDJSON ingest.

const ES_URL = (process.env.ES_URL || '').trim().replace(/\/+$/, '');
const ES_API_KEY = (process.env.ES_API_KEY || '').trim();
const MISTRAL_API_KEY = (process.env.MISTRAL_API_KEY || '').trim();

export const enabled = Boolean(ES_URL && ES_API_KEY);

export const REPORTS_INDEX = 'sf311-encampments';
export const PITSTOPS_INDEX = 'sf-pitstops';
export const INFERENCE_ID = 'mistral-embeddings';
const BULK_CHUNK = 1000;

// null = unknown (not yet checked), true/false once resolved.
let semanticAvailable = null;

// ---------------------------------------------------------------- HTTP helper

class EsError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function es(method, path, body, { ndjson = false, timeoutMs = 30000, allow404 = false } = {}) {
  const headers = { Authorization: `ApiKey ${ES_API_KEY}`, Accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = ndjson ? 'application/x-ndjson' : 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(ES_URL + path, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (allow404 && res.status === 404) return null;
  const text = method === 'HEAD' ? '' : await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
  }
  if (!res.ok) {
    const reason = json?.error?.root_cause?.[0]?.reason || json?.error?.reason || json?.error?.type || text.slice(0, 300) || res.statusText;
    throw new EsError(`ES ${method} ${path.split('?')[0]} -> ${res.status}: ${reason}`, res.status, json);
  }
  return json ?? {};
}

async function exists(path) {
  const res = await fetch(ES_URL + path, {
    method: 'HEAD',
    headers: { Authorization: `ApiKey ${ES_API_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  return res.status === 200;
}

function warn(...args) { console.warn('[elastic]', ...args); }

// ------------------------------------------------------------------- mappings

function reportsMapping(semantic) {
  const properties = {
    id: { type: 'keyword' },
    requested: { type: 'date' },
    status: { type: 'keyword' },
    notes: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 512 } } },
    outcome: { type: 'keyword' },
    address: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 256 } } },
    district: { type: 'keyword' },
    neighborhood: { type: 'keyword' },
    location: { type: 'geo_point' },
  };
  if (semantic === 'mistral') properties.notes_semantic = { type: 'semantic_text', inference_id: INFERENCE_ID };
  else if (semantic === 'default') properties.notes_semantic = { type: 'semantic_text' }; // ELSER default endpoint
  return { mappings: { properties } };
}

function pitstopsMapping() {
  return {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        name: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 256 } } },
        address: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 256 } } },
        neighborhood: { type: 'keyword' },
        location: { type: 'geo_point' },
        hoursRaw: { type: 'text' },
        hours: {
          properties: {
            is24h: { type: 'boolean' },
            open: { type: 'keyword' },
            close: { type: 'keyword' },
            open_min: { type: 'integer' },   // minutes after midnight, for ES|QL "open at" filters
            close_min: { type: 'integer' },
            overnight: { type: 'boolean' },  // close < open (e.g. 9pm -> 5am)
            days: { type: 'keyword' },
          },
        },
      },
    },
  };
}

// ------------------------------------------------------------ setup / schema

async function ensureMistralInference() {
  try {
    const got = await es('GET', `/_inference/text_embedding/${INFERENCE_ID}`, undefined, { allow404: true });
    if (got && (got.endpoints?.length || got.inference_id || got.model_id)) return true;
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) warn('inference lookup failed:', e.message);
  }
  if (!MISTRAL_API_KEY) {
    warn('MISTRAL_API_KEY missing; cannot create Mistral inference endpoint');
    return false;
  }
  try {
    await es('PUT', `/_inference/text_embedding/${INFERENCE_ID}`, {
      service: 'mistral',
      service_settings: { api_key: MISTRAL_API_KEY, model: 'mistral-embed' },
    }, { timeoutMs: 90000 });
    console.log(`[elastic] created inference endpoint ${INFERENCE_ID} (mistral-embed)`);
    return true;
  } catch (e) {
    // 400 "already exists" is fine
    if (/already exists/i.test(e.message)) return true;
    warn('could not create Mistral inference endpoint:', e.message);
    return false;
  }
}

async function createReportsIndex() {
  const attempts = [];
  if (await ensureMistralInference()) attempts.push('mistral');
  attempts.push('default', 'none');
  for (const mode of attempts) {
    try {
      await es('PUT', `/${REPORTS_INDEX}`, reportsMapping(mode), { timeoutMs: 60000 });
      semanticAvailable = mode !== 'none';
      console.log(`[elastic] created ${REPORTS_INDEX} (semantic: ${mode})`);
      return;
    } catch (e) {
      // Serverless can report an error (or time out) after the index was actually created.
      if (/already.exists/i.test(e.message + JSON.stringify(e.body || '')) || (await exists(`/${REPORTS_INDEX}`).catch(() => false))) {
        semanticAvailable = null;
        return;
      }
      warn(`create ${REPORTS_INDEX} with semantic=${mode} failed:`, e.message);
    }
  }
  throw new Error(`could not create ${REPORTS_INDEX}`);
}

async function ensureIndices() {
  if (!(await exists(`/${REPORTS_INDEX}`))) await createReportsIndex();
  if (!(await exists(`/${PITSTOPS_INDEX}`))) {
    try {
      await es('PUT', `/${PITSTOPS_INDEX}`, pitstopsMapping());
      console.log(`[elastic] created ${PITSTOPS_INDEX}`);
    } catch (e) {
      if (!/already.exists/i.test(e.message + JSON.stringify(e.body || '')) && !(await exists(`/${PITSTOPS_INDEX}`).catch(() => false))) throw e;
    }
  }
  await detectSemantic(true);
}

async function detectSemantic(force = false) {
  if (semanticAvailable !== null && !force) return semanticAvailable;
  try {
    const m = await es('GET', `/${REPORTS_INDEX}/_mapping`);
    const props = Object.values(m)[0]?.mappings?.properties || {};
    semanticAvailable = props.notes_semantic?.type === 'semantic_text';
  } catch {
    semanticAvailable = false;
  }
  return semanticAvailable;
}

// --------------------------------------------------------------------- public

export async function ping() {
  if (!enabled) return { connected: false, error: 'ES_URL / ES_API_KEY not set' };
  try {
    const info = await es('GET', '/', undefined, { timeoutMs: 8000 });
    return { connected: true, cluster: info.cluster_name || info.name || 'elasticsearch' };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

function toReportDoc(r, withSemantic) {
  const doc = {
    id: String(r.id),
    requested: r.requested || null,
    status: r.status ?? null,
    notes: r.notes ?? '',
    outcome: r.outcome || 'other',
    address: r.address ?? null,
    district: r.district != null ? String(r.district) : null,
    neighborhood: r.neighborhood ?? null,
  };
  if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) doc.location = { lat: r.lat, lon: r.lon };
  if (withSemantic && doc.notes && doc.notes.trim()) doc.notes_semantic = doc.notes;
  return doc;
}

function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function toPitstopDoc(p) {
  let hours = null;
  if (p.hours) {
    const open_min = hhmmToMin(p.hours.open);
    const close_min = hhmmToMin(p.hours.close);
    hours = {
      is24h: Boolean(p.hours.is24h),
      open: p.hours.open ?? null,
      close: p.hours.close ?? null,
      open_min,
      close_min,
      overnight: open_min != null && close_min != null && close_min < open_min,
      days: Array.isArray(p.hours.days) ? p.hours.days : [],
    };
  }
  const doc = {
    id: String(p.id),
    name: p.name ?? null,
    address: p.address ?? null,
    neighborhood: p.neighborhood ?? null,
    hoursRaw: p.hoursRaw ?? null,
    hours,
  };
  if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) doc.location = { lat: p.lat, lon: p.lon };
  return doc;
}

async function bulkIndex(index, docs) {
  let ok = 0;
  let failed = 0;
  let firstError = null;
  for (let i = 0; i < docs.length; i += BULK_CHUNK) {
    const chunk = docs.slice(i, i + BULK_CHUNK);
    const last = i + BULK_CHUNK >= docs.length;
    let body = '';
    for (const d of chunk) {
      body += JSON.stringify({ index: { _index: index, _id: d.id } }) + '\n' + JSON.stringify(d) + '\n';
    }
    // semantic_text runs inference during indexing, so allow a generous timeout.
    const res = await es('POST', `/_bulk${last ? '?refresh=wait_for' : ''}`, body, { ndjson: true, timeoutMs: 300000 });
    for (const item of res.items || []) {
      const r = item.index || item.create || item.update;
      if (r && r.status >= 200 && r.status < 300) ok++;
      else {
        failed++;
        if (!firstError) firstError = r?.error;
      }
    }
  }
  return { ok, failed, firstError };
}

// Drops both indices (used by `npm run ingest -- --reset`). Not part of the backend contract.
export async function resetIndices() {
  if (!enabled) return;
  for (const idx of [REPORTS_INDEX, PITSTOPS_INDEX]) {
    try { await es('DELETE', `/${idx}`, undefined, { allow404: true }); } catch (e) { warn(`delete ${idx}:`, e.message); }
  }
  semanticAvailable = null;
}

// Never throws: on failure returns zero counts plus an `error` string.
export async function ingest(reports = [], pitstops = []) {
  if (!enabled) return { reports: 0, pitstops: 0 };
  try {
    return await ingestUnsafe(reports, pitstops);
  } catch (e) {
    warn('ingest failed:', e.message);
    return { reports: 0, pitstops: 0, error: e.message };
  }
}

export function semanticEnabled() {
  return Boolean(semanticAvailable);
}

async function ingestUnsafe(reports, pitstops) {
  await ensureIndices();

  let withSemantic = Boolean(semanticAvailable);
  let reportDocs = reports.map((r) => toReportDoc(r, withSemantic));
  let rRes = await bulkIndex(REPORTS_INDEX, reportDocs);

  // If inference failed (bad key, quota, model not deployed), reindex without the semantic field
  // so lexical search, geo and ES|QL still work.
  if (withSemantic && rRes.failed > 0 && /inference|semantic|model|embedding/i.test(JSON.stringify(rRes.firstError || ''))) {
    warn(`semantic inference failed for ${rRes.failed} docs (${rRes.firstError?.reason || rRes.firstError?.type}); retrying without notes_semantic`);
    withSemantic = false;
    reportDocs = reports.map((r) => toReportDoc(r, false));
    const retry = await bulkIndex(REPORTS_INDEX, reportDocs);
    rRes = { ok: retry.ok, failed: retry.failed, firstError: retry.firstError };
  }
  if (rRes.failed) warn(`${rRes.failed} report docs failed:`, JSON.stringify(rRes.firstError).slice(0, 300));

  const pRes = await bulkIndex(PITSTOPS_INDEX, pitstops.map(toPitstopDoc));
  if (pRes.failed) warn(`${pRes.failed} pitstop docs failed:`, JSON.stringify(pRes.firstError).slice(0, 300));

  return { reports: rRes.ok, pitstops: pRes.ok };
}

function districtFilter(district) {
  if (district == null || district === '') return [];
  return [{ term: { district: String(district).replace(/\.0+$/, '') } }];
}

export async function hotspots({ district, days = 7, precision = 17, limit = 20 } = {}) {
  if (!enabled) return [];
  try {
    const p = Math.max(0, Math.min(29, Math.round(Number(precision) || 17)));
    const d = Math.max(1, Math.round(Number(days) || 7));
    const res = await es('POST', `/${REPORTS_INDEX}/_search`, {
      size: 0,
      query: {
        bool: {
          filter: [
            ...districtFilter(district),
            { range: { requested: { gte: `now-${d}d/d` } } },
            { exists: { field: 'location' } },
          ],
        },
      },
      aggs: {
        tiles: {
          geotile_grid: { field: 'location', precision: p, size: Math.max(1, Number(limit) || 20) },
          aggs: { centroid: { geo_centroid: { field: 'location' } } },
        },
      },
    });
    return (res.aggregations?.tiles?.buckets || []).map((b) => ({
      tile: b.key,
      lat: b.centroid?.location?.lat ?? null,
      lon: b.centroid?.location?.lon ?? null,
      count: b.doc_count,
    }));
  } catch (e) {
    warn('hotspots failed:', e.message);
    return [];
  }
}

export async function searchNotes({ query, district, limit = 10 } = {}) {
  if (!enabled || !query) return [];
  const size = Math.max(1, Math.min(100, Number(limit) || 10));
  const filter = districtFilter(district);
  const run = (must) => es('POST', `/${REPORTS_INDEX}/_search`, {
    size,
    _source: ['id', 'address', 'district', 'neighborhood', 'notes', 'outcome', 'requested'],
    query: { bool: { must, filter } },
  });
  let res;
  try {
    if (await detectSemantic()) {
      try {
        res = await run([{ semantic: { field: 'notes_semantic', query: String(query) } }]);
      } catch (e) {
        warn('semantic query failed, falling back to match:', e.message);
      }
    }
    if (!res) res = await run([{ match: { notes: { query: String(query), operator: 'or', fuzziness: 'AUTO' } } }]);
  } catch (e) {
    warn('searchNotes failed:', e.message);
    return [];
  }
  return (res.hits?.hits || []).map((h) => ({
    id: h._source?.id ?? h._id,
    address: h._source?.address ?? null,
    district: h._source?.district ?? null,
    neighborhood: h._source?.neighborhood ?? null,
    notes: h._source?.notes ?? '',
    outcome: h._source?.outcome ?? null,
    requested: h._source?.requested ?? null,
    score: h._score ?? 0,
  }));
}

function esqlRows(res) {
  const cols = (res.columns || []).map((c) => c.name);
  return (res.values || []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

export async function trendByNeighborhood({ district } = {}) {
  if (!enabled) return [];
  const hasDistrict = district != null && district !== '';
  const query = [
    `FROM ${REPORTS_INDEX}`,
    `| WHERE requested >= NOW() - 14 days AND neighborhood IS NOT NULL${hasDistrict ? ' AND district == ?' : ''}`,
    '| EVAL is_last7 = CASE(requested >= NOW() - 7 days, 1, 0), is_prev7 = CASE(requested < NOW() - 7 days, 1, 0)',
    '| STATS last7 = SUM(is_last7), prev7 = SUM(is_prev7) BY neighborhood',
    '| EVAL delta = last7 - prev7',
    '| SORT delta DESC, last7 DESC',
    '| LIMIT 100',
  ].join('\n');
  try {
    const body = { query };
    if (hasDistrict) body.params = [String(district).replace(/\.0+$/, '')];
    const res = await es('POST', '/_query?format=json', body);
    return esqlRows(res).map((r) => ({
      neighborhood: r.neighborhood,
      last7: Number(r.last7) || 0,
      prev7: Number(r.prev7) || 0,
      delta: Number(r.delta) || 0,
    }));
  } catch (e) {
    warn('trendByNeighborhood failed:', e.message);
    return [];
  }
}

export async function nearestPitStops({ lat, lon, limit = 3 } = {}) {
  if (!enabled) return [];
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return [];
  try {
    const res = await es('POST', `/${PITSTOPS_INDEX}/_search`, {
      size: Math.max(1, Math.min(50, Number(limit) || 3)),
      _source: ['id', 'name'],
      query: { bool: { filter: [{ exists: { field: 'location' } }] } },
      sort: [{ _geo_distance: { location: { lat: la, lon: lo }, order: 'asc', unit: 'm', distance_type: 'arc' } }],
    });
    return (res.hits?.hits || []).map((h) => ({
      id: h._source?.id ?? h._id,
      name: h._source?.name ?? null,
      distanceM: Math.round(h.sort?.[0] ?? 0),
    }));
  } catch (e) {
    warn('nearestPitStops failed:', e.message);
    return [];
  }
}
