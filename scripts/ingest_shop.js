// Loads the Shop Opener (P3) indices that server/py/blockgap.py reads:
//   vacant-spaces  (DataSF rzkk-54yv, tax year 2024, vacant = YES)
//   sf-businesses  (DataSF g8m3-pdis, open SF locations)
//   sf-311         (DataSF vw6y-z8j6, street-condition services, last N days)
// Usage: node --env-file=.env scripts/ingest_shop.js [--days 30] [--reset]
const ES_URL = process.env.ES_URL?.replace(/\/$/, '');
const ES_API_KEY = process.env.ES_API_KEY;
if (!ES_URL || !ES_API_KEY) { console.error('ES_URL and ES_API_KEY are required'); process.exit(1); }

const args = process.argv.slice(2);
const DAYS = +(args[args.indexOf('--days') + 1] || 0) || 30;
const RESET = args.includes('--reset');
const SODA = 'https://data.sf.gov/resource';

async function es(method, path, body, ndjson = false) {
  const r = await fetch(ES_URL + path, {
    method,
    headers: { Authorization: `ApiKey ${ES_API_KEY}`, 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : (ndjson ? body : JSON.stringify(body)),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok && !(method === 'HEAD')) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return { status: r.status, json };
}

async function soda(id, params) {
  const out = []; const page = 50000;
  for (let offset = 0; ; offset += page) {
    const q = new URLSearchParams({ ...params, $limit: String(page), $offset: String(offset), $order: ':id' });
    const r = await fetch(`${SODA}/${id}.json?${q}`);
    if (!r.ok) throw new Error(`DataSF ${id} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

const point = p => (p?.coordinates?.length === 2 ? { lat: +p.coordinates[1], lon: +p.coordinates[0] } : null);

async function ensureIndex(name, properties) {
  const exists = (await es('HEAD', `/${name}`)).status === 200;
  if (exists && RESET) { await es('DELETE', `/${name}`); }
  if (!exists || RESET) {
    try { await es('PUT', `/${name}`, { mappings: { properties } }); }
    catch (e) { if (!/resource_already_exists/.test(e.message)) throw e; }
  }
}

async function bulk(index, docs) {
  let ok = 0, failed = 0;
  for (let i = 0; i < docs.length; i += 2000) {
    const chunk = docs.slice(i, i + 2000);
    const body = chunk.map(d => JSON.stringify({ index: { _index: index, _id: d._id } }) + '\n' + JSON.stringify({ ...d, _id: undefined })).join('\n') + '\n';
    const { json } = await es('POST', '/_bulk', body, true);
    for (const it of json.items || []) (it.index?.error ? failed++ : ok++);
    if (json.errors && failed && i === 0) console.warn(`[${index}] first error:`, JSON.stringify((json.items.find(x => x.index?.error) || {}).index?.error).slice(0, 300));
  }
  return { ok, failed };
}

// ---------- vacant-spaces ----------
async function vacant() {
  await ensureIndex('vacant-spaces', {
    address: { type: 'keyword', fields: { text: { type: 'text' } } },
    neighborhood: { type: 'keyword' }, district: { type: 'keyword' },
    tax_year: { type: 'keyword' }, location: { type: 'geo_point' },
  });
  const rows = await soda('rzkk-54yv', { $where: "taxyear='2024' AND vacant='YES' AND location_point IS NOT NULL" });
  const docs = rows.map(r => ({
    _id: `${r.parcelnumber || r.block + '-' + r.lot}-${r.taxyear}-${(r.parcelsitusaddress || '').slice(0, 40)}`,
    address: (r.parcelsitusaddress || r.linaddress || '').trim(),
    neighborhood: r.analysis_neighborhood || null,
    district: r.supervisor_district || null,
    tax_year: r.taxyear,
    location: point(r.location_point),
  })).filter(d => d.location && d.neighborhood);
  return { fetched: rows.length, ...(await bulk('vacant-spaces', docs)) };
}

// ---------- sf-businesses ----------
async function businesses() {
  await ensureIndex('sf-businesses', {
    dba_name: { type: 'text', fields: { raw: { type: 'keyword' } } },
    naics: { type: 'keyword' }, naics3: { type: 'keyword' },
    corridor: { type: 'keyword' }, neighborhood: { type: 'keyword' },
    location: { type: 'geo_point' },
  });
  const rows = await soda('g8m3-pdis', {
    $select: 'uniqueid,dba_name,self_reported_naics_code,business_corridor,neighborhoods_analysis_boundaries,location',
    $where: "dba_end_date IS NULL AND location_end_date IS NULL AND location IS NOT NULL AND city='San Francisco'",
  });
  const docs = rows.map(r => {
    const naics = (r.self_reported_naics_code || '').trim() || null;
    return {
      _id: r.uniqueid, dba_name: r.dba_name || '', naics, naics3: naics ? naics.slice(0, 3) : null,
      corridor: r.business_corridor || null, neighborhood: r.neighborhoods_analysis_boundaries || null,
      location: point(r.location),
    };
  }).filter(d => d.location);
  return { fetched: rows.length, ...(await bulk('sf-businesses', docs)) };
}

// ---------- sf-311 ----------
const SERVICES = ['Encampment', 'Encampments', 'Well-Being Check', 'Street and Sidewalk Cleaning', 'Graffiti Public',
  'Graffiti Private', 'Blocked Street and Sidewalk', 'Noise', 'Streetlights', 'Sewer Issues', 'Litter Receptacles'];
async function ops() {
  await ensureIndex('sf-311', {
    service: { type: 'keyword' }, neighborhood: { type: 'keyword' }, district: { type: 'keyword' },
    notes: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 256 } } },
    requested: { type: 'date' }, location: { type: 'geo_point' },
  });
  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 19);
  const list = SERVICES.map(s => `'${s.replace(/'/g, "''")}'`).join(',');
  const rows = await soda('vw6y-z8j6', {
    $select: 'service_request_id,service_name,status_notes,analysis_neighborhood,supervisor_district,requested_datetime,lat,long',
    $where: `requested_datetime > '${since}' AND service_name in (${list}) AND lat IS NOT NULL`,
  });
  const docs = rows.map(r => ({
    _id: r.service_request_id, service: r.service_name, notes: r.status_notes || '',
    neighborhood: r.analysis_neighborhood || null, district: r.supervisor_district ? String(parseInt(r.supervisor_district, 10)) : null,
    requested: r.requested_datetime, location: (+r.lat && +r.long) ? { lat: +r.lat, lon: +r.long } : null,
  })).filter(d => d.location);
  return { fetched: rows.length, ...(await bulk('sf-311', docs)) };
}

const t0 = Date.now();
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
for (const [name, fn] of [['vacant-spaces', vacant], ['sf-businesses', businesses], ['sf-311', ops]].filter(([n]) => !ONLY || n === ONLY)) {
  try { console.log(name, await fn()); } catch (e) { console.error(name, 'FAILED:', e.message); process.exitCode = 1; }
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
