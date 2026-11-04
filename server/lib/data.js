// Data layer: fetch DataSF 311 encampments + Pit Stops, normalize, cache, grid cells, gap scores.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { structured, hasKey, MODELS } from './mistral.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const HOURS_FILE = path.join(DATA_DIR, 'hours.json');
const OUTCOMES_FILE = path.join(DATA_DIR, 'outcomes.json');
const TTL_MS = 60 * 60 * 1000;

const URL_311 = 'https://data.sf.gov/resource/vw6y-z8j6.json';
const URL_PIT = 'https://data.sf.gov/resource/mr6h-cr3u.json';

export const OUTCOMES = ['resolved', 'services_offered', 'declined', 'not_found', 'medical', 'cancelled', 'open', 'other'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const TZ = 'America/Los_Angeles';
const CELL_LAT = 0.003, CELL_LON = 0.004;

export const state = {
  reports: [], pitstops: [], asOf: null, ready: false,
  reportById: new Map(),
  enrichment: { hours: 'regex', outcomes: 'rules' },
};

// ---------- helpers ----------
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
async function writeJson(file, obj) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj));
}
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// DataSF timestamps are floating local (America/Los_Angeles) times.
function laLocalToISO(str) {
  if (!str) return new Date(0).toISOString();
  if (/(Z|[+-]\d\d:?\d\d)$/.test(str)) return new Date(str).toISOString();
  const asUtc = new Date(str + 'Z');
  if (isNaN(asUtc)) return new Date(0).toISOString();
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(asUtc).find(p => p.type === 'timeZoneName')?.value || 'GMT-8';
  const off = parseInt(tzName.replace('GMT', '') || '-8', 10);
  return new Date(asUtc.getTime() - off * 3600e3).toISOString();
}

// ---------- fetch + normalize ----------
async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`DataSF HTTP ${res.status} for ${url.split('?')[0]}`);
  return res.json();
}

async function fetchReports() {
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19);
  const params = new URLSearchParams({
    $select: 'service_request_id,requested_datetime,status_description,status_notes,address,supervisor_district,analysis_neighborhood,lat,long',
    $where: `service_name='Encampment' AND requested_datetime > '${since}'`,
    $order: 'requested_datetime DESC',
    $limit: '50000',
  });
  const rows = await fetchJson(`${URL_311}?${params}`);
  return rows.map(r => {
    const lat = parseFloat(r.lat), lon = parseFloat(r.long);
    if (!isFinite(lat) || !isFinite(lon) || lat < 37.6 || lat > 37.85 || lon < -122.55 || lon > -122.35) return null;
    return {
      id: String(r.service_request_id),
      requested: laLocalToISO(r.requested_datetime),
      status: r.status_description || '',
      notes: r.status_notes || (r.status_description === 'Open' ? 'open' : ''),
      outcome: null,
      address: (r.address || '').replace(/, SAN FRANCISCO, CA.*$/i, ''),
      district: r.supervisor_district ? String(parseInt(r.supervisor_district, 10)) : '',
      neighborhood: r.analysis_neighborhood || '',
      lat, lon,
    };
  }).filter(Boolean);
}

async function fetchPitstops() {
  const rows = await fetchJson(`${URL_PIT}?$limit=1000`);
  const seen = new Set();
  return rows.map(r => {
    const c = r.location?.coordinates;
    if (!c) return null;
    const base = 'ps-' + slug(r.name || r.address);
    let id = base, k = 2;
    while (seen.has(id)) id = `${base}-${k++}`;
    seen.add(id);
    return {
      id, name: r.name || 'Pit Stop', address: r.address || '', neighborhood: r.neighborhood || '',
      lat: +c[1], lon: +c[0], hoursRaw: r.hours || '', hours: null,
    };
  }).filter(Boolean);
}

// ---------- hours parsing (Mistral structured outputs + regex fallback) ----------
const HOURS_SCHEMA = {
  type: 'object',
  properties: {
    is24h: { type: 'boolean' },
    open: { type: 'string', description: 'HH:MM 24h local time when it opens' },
    close: { type: 'string', description: 'HH:MM 24h local time when it closes (may be earlier than open for overnight)' },
    days: { type: 'array', items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
  },
  required: ['is24h', 'open', 'close', 'days'],
  additionalProperties: false,
};

function to24(t) {
  const m = String(t).trim().toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?/);
  if (!m) return null;
  let h = +m[1]; const min = m[2] || '00'; const ap = m[3];
  if (ap?.startsWith('p') && h < 12) h += 12;
  if (ap?.startsWith('a') && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export function regexHours(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/24\s*(hours|hrs|\/7)/.test(s)) return { is24h: true, open: '00:00', close: '24:00', days: ALL_DAYS };
  // "Close Time: 5pm to Open Time: 9am" -> closed 5pm..9am, i.e. open 9am-5pm
  let m = s.match(/close\s*time:?\s*([\d:]+\s*[ap]m?)\s*to\s*open\s*time:?\s*([\d:]+\s*[ap]m?)/);
  if (m) return { is24h: false, open: to24(m[2]), close: to24(m[1]), days: ALL_DAYS };
  m = s.match(/([\d:]+\s*[ap]m?)\s*(?:to|-|–)\s*([\d:]+\s*[ap]m?)/);
  if (m) {
    let days = ALL_DAYS;
    if (/mon\w*\s*(?:-|to|–)\s*fri/.test(s) || /weekdays/.test(s)) days = ['mon', 'tue', 'wed', 'thu', 'fri'];
    return { is24h: false, open: to24(m[1]), close: to24(m[2]), days };
  }
  return null;
}

function validHours(h) {
  return h && typeof h.is24h === 'boolean' && /^\d\d:\d\d$/.test(h.open) && /^\d\d:\d\d$/.test(h.close) && Array.isArray(h.days) && h.days.length;
}

async function parseHoursMistral(distinct) {
  const cache = (await readJson(HOURS_FILE)) || {};
  const todo = distinct.filter(s => s && !cache[s]);
  if (todo.length && hasKey()) {
    await Promise.all(todo.map(async raw => {
      try {
        const out = await structured({
          model: MODELS.parser,
          name: 'pitstop_hours',
          schema: HOURS_SCHEMA,
          system: 'You parse San Francisco public toilet (Pit Stop) opening-hours text into structured JSON. Use 24h HH:MM. ' +
            '"Daily" means all 7 days. If it says open 24 hours, is24h=true, open "00:00", close "24:00". ' +
            'Text like "Close Time: 5pm to Open Time: 9am" describes the CLOSED period, so the site is open 09:00 to 17:00. ' +
            'For overnight hours (e.g. 6pm to 6am) close is earlier than open.',
          user: `Hours text: ${JSON.stringify(raw)}`,
        });
        if (validHours(out)) cache[raw] = { ...out, source: 'mistral' };
      } catch (e) { console.warn('[hours] mistral parse failed:', e.message); }
    }));
    await writeJson(HOURS_FILE, cache);
  }
  return cache;
}

// ---------- outcome classification ----------
export function ruleOutcome(notes, status) {
  const s = String(notes || '').toLowerCase();
  if (!s || s === 'open' || (status === 'Open' && !s)) return 'open';
  if (/medic|ems|ambulance|hospital|overdos|injur|wound/.test(s)) return 'medical';
  if (/declin|refus|not interested|did not want|rejected/.test(s)) return 'declined';
  if (s.startsWith('unable_to_locate') || /\bgoa\b|gone on arrival|no encampment|area (is )?clear|not found|no indication/.test(s)) return 'not_found';
  if (s.startsWith('case_cancelled') || s.startsWith('case_is_a_duplicate') || /duplicate|cancel/.test(s)) return 'cancelled';
  if (/service|shelter|encouraged|resource|referr|offered|navigation|transport/.test(s)) return 'services_offered';
  if (s.startsWith('case_resolved') || /resolved|cleaned|closed/.test(s)) return 'resolved';
  return 'other';
}

const OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, outcome: { type: 'string', enum: OUTCOMES } },
        required: ['i', 'outcome'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const normNote = s => String(s || '').trim().replace(/\s+/g, ' ');

async function classifyOutcomesMistral(reports) {
  const cache = (await readJson(OUTCOMES_FILE)) || {};
  const freq = new Map();
  for (const r of reports) { const k = normNote(r.notes); if (k) freq.set(k, (freq.get(k) || 0) + 1); }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120).map(e => e[0]);
  const todo = top.filter(k => !cache[k]);
  if (todo.length && hasKey()) {
    const batches = [];
    for (let i = 0; i < todo.length; i += 60) batches.push(todo.slice(i, i + 60));
    await Promise.all(batches.map(async batch => {
      try {
        const list = batch.map((n, i) => `${i}. ${n.slice(0, 220)}`).join('\n');
        const out = await structured({
          model: MODELS.parser,
          name: 'outcome_classification',
          schema: OUTCOME_SCHEMA,
          timeoutMs: 90000,
          system: 'You classify San Francisco 311 encampment case closure notes from outreach crews into one outcome each. Outcomes: ' +
            'resolved (crew handled it / area cleaned / generic resolution), services_offered (services, shelter or resource info offered or accepted, follow-up planned), ' +
            'declined (person refused or declined services), not_found (unable to locate, GOA, area clear, no indication of need), ' +
            'medical (medical/EMS need), cancelled (cancelled, duplicate, redirected to PD/cleaning/private property), open (still open), other. ' +
            'Return one item per input line using its index i.',
          user: list,
        });
        for (const it of out.items || []) if (batch[it.i] && OUTCOMES.includes(it.outcome)) cache[batch[it.i]] = it.outcome;
      } catch (e) { console.warn('[outcomes] mistral classify failed:', e.message); }
    }));
    await writeJson(OUTCOMES_FILE, cache);
  }
  return cache;
}

// ---------- load ----------
let loading = null;
export function load() { return loading ||= doLoad(); }

async function doLoad() {
  let cache = await readJson(CACHE_FILE);
  if (!cache || !cache.fetchedAt || Date.now() - Date.parse(cache.fetchedAt) > TTL_MS) {
    try {
      const [reports, pitstops] = await Promise.all([fetchReports(), fetchPitstops()]);
      cache = { fetchedAt: new Date().toISOString(), reports, pitstops };
      await writeJson(CACHE_FILE, cache);
      console.log(`[data] fetched ${reports.length} reports, ${pitstops.length} pit stops from DataSF`);
    } catch (e) {
      if (!cache) throw e;
      console.warn('[data] refresh failed, using stale cache:', e.message);
    }
  } else console.log(`[data] using cache from ${cache.fetchedAt}`);

  state.reports = cache.reports;
  state.pitstops = cache.pitstops;
  state.asOf = cache.fetchedAt;
  state.reportById = new Map(state.reports.map(r => [r.id, r]));
  // fast fallbacks first so the API is usable immediately
  for (const p of state.pitstops) p.hours = regexHours(p.hoursRaw);
  for (const r of state.reports) r.outcome = ruleOutcome(r.notes, r.status);
  state.ready = true;
  return state;
}

// Mistral structured-output enrichment (runs after load; updates in place).
export async function enrich() {
  await load();
  const distinctHours = [...new Set(state.pitstops.map(p => p.hoursRaw).filter(Boolean))];
  const [hoursCache, outcomeCache] = await Promise.all([
    parseHoursMistral(distinctHours).catch(e => (console.warn('[hours]', e.message), {})),
    classifyOutcomesMistral(state.reports).catch(e => (console.warn('[outcomes]', e.message), {})),
  ]);
  let h = 0, o = 0;
  for (const p of state.pitstops) {
    const c = hoursCache[p.hoursRaw];
    if (validHours(c)) { p.hours = { is24h: c.is24h, open: c.open, close: c.close, days: c.days }; h++; }
  }
  for (const r of state.reports) {
    const c = outcomeCache[normNote(r.notes)];
    if (c) { r.outcome = c; o++; }
  }
  if (h) state.enrichment.hours = 'mistral';
  if (o) state.enrichment.outcomes = 'mistral';
  state.enrichment.stats = { hoursParsedByMistral: h, reportsClassifiedByMistral: o, totalReports: state.reports.length };
  console.log(`[enrich] hours via mistral: ${h}/${state.pitstops.length}; outcomes via mistral: ${o}/${state.reports.length}`);
  return state.enrichment;
}

// ---------- time / open-now ----------
export function laParts(at) {
  const d = at ? new Date(at) : new Date();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(fmt.formatToParts(isNaN(d) ? new Date() : d).map(p => [p.type, p.value]));
  const day = parts.weekday.toLowerCase().slice(0, 3);
  return { day, minutes: (+parts.hour) * 60 + (+parts.minute), date: `${parts.year}-${parts.month}-${parts.day}`, label: `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` };
}
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function isOpen(p, at) {
  const h = p.hours;
  if (!h) return false; // unknown hours -> don't count as available help
  const { day, minutes } = laParts(at);
  if (h.is24h) return h.days.includes(day);
  const o = toMin(h.open), c = toMin(h.close);
  const prev = DAYS[(DAYS.indexOf(day) + 6) % 7];
  if (c > o) return h.days.includes(day) && minutes >= o && minutes < c;
  // overnight
  return (h.days.includes(day) && minutes >= o) || (h.days.includes(prev) && minutes < c);
}

export function pitstopsAt(at) {
  return state.pitstops.map(p => ({ ...p, openNow: isOpen(p, at) }));
}

export function nearestPitstops(lat, lon, at, { openOnly = false, limit = 3 } = {}) {
  return pitstopsAt(at)
    .filter(p => !openOnly || p.openNow)
    .map(p => ({ id: p.id, name: p.name, address: p.address, hoursRaw: p.hoursRaw, openNow: p.openNow, distanceM: Math.round(haversineM(lat, lon, p.lat, p.lon)) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

// ---------- grid cells ----------
export function cellKey(lat, lon) { return `${Math.floor(lat / CELL_LAT)}_${Math.floor(lon / CELL_LON)}`; }
export function cellIdFor(lat, lon) { return 'c' + cellKey(lat, lon); }

const mode = arr => { const m = new Map(); let best = '', n = 0; for (const x of arr) { if (!x) continue; const c = (m.get(x) || 0) + 1; m.set(x, c); if (c > n) { n = c; best = x; } } return best; };

export function buildCells(at) {
  const now = at ? new Date(at).getTime() : Date.now();
  const d7 = now - 7 * 864e5, d14 = now - 14 * 864e5;
  const groups = new Map();
  for (const r of state.reports) {
    const id = cellIdFor(r.lat, r.lon);
    let g = groups.get(id);
    if (!g) groups.set(id, g = { id, reports: [] });
    g.reports.push(r);
  }
  const ps = pitstopsAt(at);
  const open = ps.filter(p => p.openNow);
  const cells = [];
  for (const g of groups.values()) {
    const [i, j] = g.id.slice(1).split('_').map(Number);
    const s = i * CELL_LAT, w = j * CELL_LON, n = s + CELL_LAT, e = w + CELL_LON;
    const lat = +(s + CELL_LAT / 2).toFixed(6), lon = +(w + CELL_LON / 2).toFixed(6);
    let count7 = 0, countPrev7 = 0;
    const outcomes = Object.fromEntries(OUTCOMES.map(o => [o, 0]));
    for (const r of g.reports) {
      const t = Date.parse(r.requested);
      if (t >= d7) count7++; else if (t >= d14) countPrev7++;
      outcomes[r.outcome || 'other'] = (outcomes[r.outcome || 'other'] || 0) + 1;
    }
    let nearest = null, nearestOpenM = Infinity;
    for (const p of ps) {
      const dm = haversineM(lat, lon, p.lat, p.lon);
      if (!nearest || dm < nearest.distanceM) nearest = { id: p.id, name: p.name, distanceM: Math.round(dm), openNow: p.openNow };
      if (p.openNow && dm < nearestOpenM) nearestOpenM = dm;
    }
    const count30 = g.reports.length;
    const distKm = Math.max(Math.min(nearestOpenM / 1000, 2), 0.05);
    const recent = Math.min(count7 / Math.max(count30, 1), 1);
    const raw = Math.log1p(count30) * (1 + recent) * distKm;
    cells.push({
      id: g.id, lat, lon, bounds: [[+s.toFixed(6), +w.toFixed(6)], [+n.toFixed(6), +e.toFixed(6)]],
      count7, countPrev7, count30, trend: count7 - countPrev7, gapScore: 0, _raw: raw,
      nearest, nearestOpenM: isFinite(nearestOpenM) ? Math.round(nearestOpenM) : null,
      district: mode(g.reports.map(r => r.district)), neighborhood: mode(g.reports.map(r => r.neighborhood)),
      outcomes,
    });
  }
  const max = Math.max(...cells.map(c => c._raw), 1e-9);
  for (const c of cells) { c.gapScore = Math.round((c._raw / max) * 100); delete c._raw; }
  cells.sort((a, b) => b.gapScore - a.gapScore || b.count30 - a.count30);
  return cells;
}

export function getCells({ district, neighborhood, at } = {}) {
  let cells = buildCells(at);
  if (district) cells = cells.filter(c => c.district === String(parseInt(district, 10)));
  if (neighborhood) { const n = neighborhood.toLowerCase(); cells = cells.filter(c => c.neighborhood.toLowerCase().includes(n)); }
  return cells;
}

export function getCell(id, at) {
  const cell = buildCells(at).find(c => c.id === id);
  if (!cell) return null;
  const reports = state.reports
    .filter(r => cellIdFor(r.lat, r.lon) === id)
    .sort((a, b) => b.requested.localeCompare(a.requested))
    .slice(0, 25)
    .map(r => ({ requested: r.requested, address: r.address, notes: r.notes, outcome: r.outcome }));
  return { cell, reports };
}

export function reportsInCell(id) { return state.reports.filter(r => cellIdFor(r.lat, r.lon) === id); }

// ---------- in-memory analytics (fallbacks for elastic) ----------
export function trendByNeighborhood({ district } = {}) {
  const now = Date.now(), d7 = now - 7 * 864e5, d14 = now - 14 * 864e5;
  const m = new Map();
  for (const r of state.reports) {
    if (district && r.district !== String(parseInt(district, 10))) continue;
    const k = r.neighborhood || 'Unknown';
    const t = Date.parse(r.requested);
    const e = m.get(k) || { neighborhood: k, last7: 0, prev7: 0 };
    if (t >= d7) e.last7++; else if (t >= d14) e.prev7++;
    m.set(k, e);
  }
  return [...m.values()].map(e => ({ ...e, delta: e.last7 - e.prev7 })).sort((a, b) => b.last7 - a.last7);
}

export function searchNotesLocal({ query, district, limit = 10 }) {
  const terms = String(query || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const out = [];
  for (const r of state.reports) {
    if (district && r.district !== String(parseInt(district, 10))) continue;
    const text = `${r.notes} ${r.outcome}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (text.includes(t)) score++;
    if (score) out.push({ id: r.id, address: r.address, district: r.district, neighborhood: r.neighborhood, notes: r.notes, outcome: r.outcome, requested: r.requested, score });
  }
  return out.sort((a, b) => b.score - a.score || b.requested.localeCompare(a.requested)).slice(0, limit);
}

// Cell that maximizes reports (30d) within 800m that are >800m from any open pit stop.
export function suggestPitstopSite({ district, at, radiusM = 800 } = {}) {
  const open = pitstopsAt(at).filter(p => p.openNow);
  const dist = district ? String(parseInt(district, 10)) : null;
  const underserved = state.reports.filter(r =>
    (!dist || r.district === dist) && !open.some(p => haversineM(r.lat, r.lon, p.lat, p.lon) <= radiusM));
  const cells = getCells({ district, at }).filter(c => c.count30 > 0);
  let best = null;
  for (const c of cells) {
    let covered = 0;
    for (const r of underserved) if (haversineM(c.lat, c.lon, r.lat, r.lon) <= radiusM) covered++;
    if (!best || covered > best.covered) best = { cell: c, covered };
  }
  return { best, underservedTotal: underserved.length, openPitstops: open.length };
}
