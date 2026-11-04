// BlockSignal ingest: data.sf.gov -> normalized (CONTRACT.md shapes) -> Elasticsearch.
// Usage: npm run ingest            (upsert by id, creates indices if missing)
//        npm run ingest -- --reset (drop + recreate indices first, e.g. after enabling semantic_text)
//        npm run ingest -- --days 30
import { enabled, ping, ingest, resetIndices, semanticEnabled, REPORTS_INDEX, PITSTOPS_INDEX } from '../server/lib/elastic.js';

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const daysIdx = args.indexOf('--days');
const DAYS = daysIdx >= 0 ? Math.max(1, Number(args[daysIdx + 1]) || 30) : 30;

const SR_URL = 'https://data.sf.gov/resource/vw6y-z8j6.json';
const PITSTOP_URL = 'https://data.sf.gov/resource/mr6h-cr3u.json';

// ------------------------------------------------------------------ fetching

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`GET ${url.split('?')[0]} -> ${res.status} ${res.statusText}`);
  return res.json();
}

function floatingTimestamp(d) {
  // SoQL floating timestamps: no timezone suffix
  return d.toISOString().slice(0, 19);
}

async function fetchReports() {
  const since = floatingTimestamp(new Date(Date.now() - DAYS * 864e5));
  const qs = new URLSearchParams({
    $where: `service_name='Encampment' AND requested_datetime > '${since}'`,
    $order: 'requested_datetime DESC',
    $limit: '50000',
  });
  return getJson(`${SR_URL}?${qs}`);
}

async function fetchPitstops() {
  return getJson(`${PITSTOP_URL}?$limit=5000`);
}

// ------------------------------------------------------------- normalization

export function outcomeFromNotes(statusNotes, statusDescription) {
  const n = String(statusNotes || '').trim().toLowerCase();
  if (!n || n === 'open' || n.startsWith('open ')) return String(statusDescription || '').toLowerCase() === 'closed' ? 'other' : 'open';
  // Prefix code, e.g. "case_resolved - Team responded, provided service information..."
  const prefix = n.split(/\s+-\s+|\s*:\s+/)[0];
  if (/medical|ems|ambulance|hospital|5150/.test(n)) return 'medical';
  if (/declin|refus/.test(n)) return 'declined';
  if (/unable_to_locate|not_found|no_encampment|unable to locate|gone on arrival|goa\b|no one|nobody/.test(n)) return 'not_found';
  if (/cancel|duplicate|transferred|call pd/.test(prefix) || /^case_cancel/.test(n)) return 'cancelled';
  if (/provided service|services? (information|offered)|offered|shelter|navigation|referr/.test(n)) return 'services_offered';
  if (/resolved|completed|closed|abated|cleaned/.test(prefix)) return 'resolved';
  return 'other';
}

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) && x !== 0 ? x : NaN;
}

function normDistrict(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/\.0+$/, '').trim();
  return s || null;
}

// SoQL floating timestamps ("2026-10-30T14:05:00.000") are San Francisco local time.
// Convert to a real UTC ISO string so ES date math (now-7d) lines up.
function sfLocalToIso(v) {
  if (!v) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(v)) { const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  const asUtc = new Date(String(v).slice(0, 19) + 'Z');
  if (isNaN(asUtc)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(asUtc).map((x) => [x.type, x.value]));
  const laAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = laAsUtc - asUtc.getTime(); // e.g. -7h or -8h
  return new Date(asUtc.getTime() - offsetMs).toISOString();
}

function normalizeReport(r) {
  const lat = num(r.lat ?? r.point?.coordinates?.[1]);
  const lon = num(r.long ?? r.point?.coordinates?.[0]);
  return {
    id: String(r.service_request_id),
    requested: sfLocalToIso(r.requested_datetime),
    status: r.status_description ?? null,
    notes: r.status_notes ?? '',
    outcome: outcomeFromNotes(r.status_notes, r.status_description),
    address: r.address ?? null,
    district: normDistrict(r.supervisor_district),
    neighborhood: r.analysis_neighborhood ?? r.neighborhoods_sffind_boundaries ?? null,
    lat,
    lon,
  };
}

const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_ALIASES = { mon: 0, monday: 0, tue: 1, tues: 1, tuesday: 1, wed: 2, wednesday: 2, thu: 3, thur: 3, thurs: 3, thursday: 3, fri: 4, friday: 4, sat: 5, saturday: 5, sun: 6, sunday: 6 };

function to24(h, m, ap) {
  let hh = Number(h) % 12;
  if (ap === 'pm') hh += 12;
  if (!ap && Number(h) >= 12) hh = Number(h);
  return `${String(hh).padStart(2, '0')}:${String(Number(m || 0)).padStart(2, '0')}`;
}

function parseDays(s) {
  if (/daily|every ?day|7 days|everyday/.test(s)) return [...ALL_DAYS];
  const range = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*(?:-|–|to|through|thru)\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*/.exec(s);
  if (range) {
    const a = DAY_ALIASES[range[1]];
    const b = DAY_ALIASES[range[2]];
    const out = [];
    for (let i = a; ; i = (i + 1) % 7) { out.push(ALL_DAYS[i]); if (i === b || out.length > 7) break; }
    return out;
  }
  const listed = [...new Set([...s.matchAll(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*/g)].map((m) => ALL_DAYS[DAY_ALIASES[m[1]]]))];
  return listed.length ? listed : [...ALL_DAYS];
}

// Rule-based hours parser (the backend may refine with Mistral structured outputs).
export function parseHours(raw) {
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).toLowerCase().replace(/\s+/g, ' ').replace(/noon/g, '12pm').replace(/midnight/g, '12am');
  const days = parseDays(s);
  if (/24 ?(hours|hrs|hr|\/7)|24-hour|open 24/.test(s)) return { is24h: true, open: '00:00', close: '23:59', days };
  const timeRe = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/;
  const lab = (label) => {
    const m = new RegExp(`${label}\\s*(?:time)?\\s*:?\\s*` + timeRe.source).exec(s);
    return m ? to24(m[1], m[2], m[3]?.replace(/\./g, '')) : null;
  };
  let open = lab('open');
  let close = lab('close');
  if (!open || !close) {
    const times = [...s.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/g)].map((m) => to24(m[1], m[2], m[3].replace(/\./g, '')));
    if (times.length >= 2) { open = open || times[0]; close = close || times[1]; }
  }
  if (!open || !close) return null;
  return { is24h: false, open, close, days };
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function normalizePitstop(p, i) {
  const coords = p.location?.coordinates || p.point?.coordinates;
  const lat = num(coords?.[1] ?? p.latitude ?? p.location?.latitude);
  const lon = num(coords?.[0] ?? p.longitude ?? p.location?.longitude);
  const hoursRaw = p.hours ?? p.hours_of_operation ?? null;
  return {
    id: String(p.id ?? p.objectid ?? (slug(`${p.name}-${p.address}`) || `pitstop-${i}`)),
    name: p.name ?? p.site_name ?? `Pit Stop ${i + 1}`,
    address: p.address ?? null,
    neighborhood: p.neighborhood ?? p.analysis_neighborhood ?? null,
    lat,
    lon,
    hoursRaw,
    hours: parseHours(hoursRaw),
  };
}

// ---------------------------------------------------------------------- main

async function main() {
  if (!enabled) {
    console.error('ES_URL and ES_API_KEY must be set in .env to ingest into Elasticsearch.');
    process.exit(1);
  }
  const p = await ping();
  if (!p.connected) {
    console.error(`Cannot reach Elasticsearch: ${p.error}`);
    process.exit(1);
  }
  console.log(`Connected to cluster: ${p.cluster}`);

  console.log(`Fetching 311 encampment reports (last ${DAYS} days) and Pit Stops from data.sf.gov ...`);
  const [rawReports, rawPitstops] = await Promise.all([fetchReports(), fetchPitstops()]);

  const reports = rawReports.map(normalizeReport).filter((r) => r.id && r.id !== 'undefined');
  const pitstops = rawPitstops.map(normalizePitstop);
  const dupIds = new Set();
  for (const ps of pitstops) { if (dupIds.has(ps.id)) ps.id = `${ps.id}-${dupIds.size}`; dupIds.add(ps.id); }

  const geoReports = reports.filter((r) => Number.isFinite(r.lat)).length;
  const outcomes = reports.reduce((acc, r) => ((acc[r.outcome] = (acc[r.outcome] || 0) + 1), acc), {});
  console.log(`Fetched ${rawReports.length} reports (${geoReports} with coordinates), ${rawPitstops.length} pit stops (${pitstops.filter((x) => x.hours).length} with parsed hours).`);
  console.log('Outcome mix:', outcomes);

  if (RESET) {
    console.log(`--reset: deleting ${REPORTS_INDEX} and ${PITSTOPS_INDEX}`);
    await resetIndices();
  }

  const t0 = Date.now();
  const res = await ingest(reports, pitstops);
  if (res.error) {
    console.error(`Ingest failed: ${res.error}`);
    process.exit(1);
  }
  console.log(`Indexed ${res.reports} reports -> ${REPORTS_INDEX}, ${res.pitstops} pit stops -> ${PITSTOPS_INDEX} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`semantic_text on notes: ${semanticEnabled() ? 'yes (notes_semantic)' : 'no (match query fallback)'}`);
}

main().catch((e) => {
  console.error('ingest error:', e.message);
  process.exit(1);
});
