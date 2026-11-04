// "Outreach Compass": Mistral function-calling agent over BlockSignal data.
import { chat, MODELS } from './mistral.js';
import * as data from './data.js';

let es = null;
export function setElastic(mod) { es = mod; }
const esOn = () => Boolean(es?.enabled);

async function tryEs(fn) {
  if (!esOn()) return null;
  try {
    return await Promise.race([fn(es), new Promise((_, rej) => setTimeout(() => rej(new Error('elastic timeout')), 8000))]);
  } catch (e) { console.warn('[agent] elastic call failed, using memory:', e.message); return null; }
}

const normDistrict = d => (d === undefined || d === null || d === '') ? undefined : String(parseInt(String(d).replace(/\D/g, ''), 10) || '') || undefined;

// ---------- tool definitions ----------
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'hotspots',
      description: 'Rank ~330m city blocks (grid cells) by service-gap score: many encampment 311 reports far from any OPEN Pit Stop. Returns counts (7d, prior 7d, 30d), trend, gap score 0-100, nearest pit stop and outcome mix.',
      parameters: {
        type: 'object',
        properties: {
          district: { type: 'string', description: 'Supervisor district number, e.g. "6"' },
          neighborhood: { type: 'string', description: 'Analysis neighborhood, e.g. "Tenderloin", "South of Market", "Mission"' },
          limit: { type: 'integer', description: 'Max cells (default 8)' },
          open_at: { type: 'string', description: 'ISO datetime to evaluate which Pit Stops are open (default now). Use for e.g. tonight 7pm.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nearest_open_help',
      description: 'Nearest Pit Stops (public restrooms/hygiene) to a point, with whether each is open at the given time.',
      parameters: {
        type: 'object',
        properties: { lat: { type: 'number' }, lon: { type: 'number' }, at: { type: 'string', description: 'ISO datetime (default now)' } },
        required: ['lat', 'lon'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: 'Search outreach crew closure notes on 311 encampment cases (e.g. "declined services", "medical", "unable to locate").',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, district: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trend',
      description: 'Encampment reports by neighborhood: last 7 days vs prior 7 days.',
      parameters: { type: 'object', properties: { district: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_pitstop_site',
      description: 'Suggest the block where a new mobile Pit Stop would cover the most 30-day reports that are currently more than 800m from any open Pit Stop.',
      parameters: { type: 'object', properties: { district: { type: 'string' }, at: { type: 'string', description: 'ISO datetime (default now)' } } },
    },
  },
];

const slimCell = c => ({
  id: c.id, lat: c.lat, lon: c.lon, neighborhood: c.neighborhood, district: c.district,
  gapScore: c.gapScore, count7: c.count7, countPrev7: c.countPrev7, count30: c.count30, trend: c.trend,
  nearestOpenM: c.nearestOpenM, nearest: c.nearest,
  sampleAddress: data.reportsInCell(c.id)[0]?.address || '',
  outcomes: Object.fromEntries(Object.entries(c.outcomes).filter(([, v]) => v > 0)),
});

// ---------- tool implementations ----------
const impl = {
  async hotspots({ district, neighborhood, limit = 8, open_at } = {}) {
    district = normDistrict(district);
    limit = Math.min(Math.max(+limit || 8, 1), 15);
    const cells = data.getCells({ district, neighborhood, at: open_at }).slice(0, limit);
    const result = { evaluatedAt: data.laParts(open_at).label + ' PT', cells: cells.map(slimCell), source: 'memory' };
    const tiles = await tryEs(e => e.hotspots({ district, days: 7, precision: 17, limit: 10 }));
    if (tiles?.length) {
      result.source = 'elasticsearch+memory';
      result.esHotspots7d = tiles.map(t => ({ cellId: data.cellIdFor(t.lat, t.lon), count7: t.count, lat: t.lat, lon: t.lon }));
    }
    const psIds = [...new Set(cells.map(c => c.nearest?.id).filter(Boolean))];
    return {
      result,
      summary: `${cells.length} blocks ranked by service gap${district ? ` in D${district}` : ''}${neighborhood ? ` (${neighborhood})` : ''}; top gap ${cells[0]?.gapScore ?? 0}`,
      highlight: { cells: cells.map(c => c.id), pitstops: psIds },
    };
  },

  async nearest_open_help({ lat, lon, at } = {}) {
    lat = +lat; lon = +lon;
    let list = data.nearestPitstops(lat, lon, at, { limit: 4 });
    const esList = await tryEs(e => e.nearestPitStops({ lat, lon, limit: 4 }));
    if (esList?.length) {
      const byId = new Map(data.pitstopsAt(at).map(p => [p.id, p]));
      list = esList.map(x => ({ id: x.id, name: x.name, distanceM: Math.round(x.distanceM), openNow: byId.get(x.id)?.openNow ?? false, hoursRaw: byId.get(x.id)?.hoursRaw || '' }));
    }
    const nOpen = list.filter(p => p.openNow).length;
    return {
      result: { at: data.laParts(at).label + ' PT', pitstops: list, source: esList?.length ? 'elasticsearch' : 'memory' },
      summary: `${list.length} nearest Pit Stops, ${nOpen} open; closest ${list[0] ? `${list[0].name} ${list[0].distanceM}m` : 'n/a'}`,
      highlight: { cells: [data.cellIdFor(lat, lon)], pitstops: list.map(p => p.id) },
    };
  },

  async search_notes({ query, district } = {}) {
    district = normDistrict(district);
    let hits = await tryEs(e => e.searchNotes({ query, district, limit: 10 }));
    const source = hits?.length ? 'elasticsearch' : 'memory';
    if (!hits?.length) hits = data.searchNotesLocal({ query, district, limit: 10 });
    const cellIds = [...new Set(hits.map(h => data.state.reportById.get(String(h.id))).filter(Boolean).map(r => data.cellIdFor(r.lat, r.lon)))];
    const themes = {};
    for (const h of hits) themes[h.outcome] = (themes[h.outcome] || 0) + 1;
    return {
      result: { source, hits: hits.map(h => ({ address: h.address, neighborhood: h.neighborhood, notes: String(h.notes || '').slice(0, 200), outcome: h.outcome, requested: h.requested })), outcomeMix: themes },
      summary: `${hits.length} notes matching "${query}"`,
      highlight: { cells: cellIds, pitstops: [] },
    };
  },

  async trend({ district } = {}) {
    district = normDistrict(district);
    let rows = await tryEs(e => e.trendByNeighborhood({ district }));
    const source = rows?.length ? 'elasticsearch (ES|QL)' : 'memory';
    if (!rows?.length) rows = data.trendByNeighborhood({ district });
    rows = rows.slice(0, 12);
    const top = new Set(rows.slice(0, 3).map(r => r.neighborhood));
    const cells = data.getCells({ district }).filter(c => top.has(c.neighborhood)).slice(0, 8).map(c => c.id);
    const rising = rows.filter(r => r.delta > 0).length;
    return {
      result: { source, neighborhoods: rows },
      summary: `${rows.length} neighborhoods, ${rising} rising week over week`,
      highlight: { cells, pitstops: [] },
    };
  },

  async suggest_pitstop_site({ district, at } = {}) {
    district = normDistrict(district);
    const s = data.suggestPitstopSite({ district, at });
    const c = s.best?.cell;
    return {
      result: {
        at: data.laParts(at).label + ' PT',
        suggestion: c ? { ...slimCell(c), reportsCoveredWithin800m: s.best.covered } : null,
        underservedReports30d: s.underservedTotal, openPitstopsNow: s.openPitstops,
      },
      summary: c ? `Best new site: ${c.neighborhood} block ${c.id}, covers ${s.best.covered} underserved reports` : 'No site found',
      highlight: { cells: c ? [c.id] : [], pitstops: c?.nearest ? [c.nearest.id] : [] },
    };
  },
};

// ---------- prompts ----------
function systemPrompt(persona, selectedCell) {
  const now = data.laParts();
  const nowIso = new Date().toISOString();
  const off = (new Intl.DateTimeFormat('en-US', { timeZone: data.TZ, timeZoneName: 'longOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || 'GMT-08:00').replace('GMT', '') || '+00:00';
  const common = `You are Outreach Compass, the AI agent inside BlockSignal, a San Francisco service-gap map.
Current local time in San Francisco: ${now.label} (America/Los_Angeles, UTC offset ${off}). Current UTC: ${nowIso}.
When the user mentions a local time (e.g. "tonight 6-9pm"), pass open_at/at as a local ISO datetime on TODAY's local date ${now.date} with offset ${off}, e.g. tonight 7pm = ${now.date}T19:00:00${off}. For a time window, evaluate at its midpoint.
Data: SF 311 encampment reports (last 30 days, ${data.state.reports.length} reports) and ${data.state.pitstops.length} Pit Stops (public restrooms with hours). Blocks are ~330m grid cells.
Key insight: 311 reports measure complaints, not need. Need is highest where reports cluster FAR from OPEN help. gapScore (0-100) captures this.
Always call tools to get real numbers before answering; never invent data. Use district/neighborhood filters when the user names one; prefer the neighborhood filter for named neighborhoods.
Supervisor districts (2022 lines). ALWAYS write a district with its name, e.g. "D6 · SoMa & Mission Bay", never a bare number:
D1 Richmond; D2 Marina & Pacific Heights; D3 North Beach & Chinatown; D4 Sunset; D5 Tenderloin & Western Addition; D6 SoMa & Mission Bay; D7 West of Twin Peaks; D8 Castro & Noe Valley; D9 Mission & Bernal Heights; D10 Bayview & Potrero Hill; D11 Excelsior & Ocean View.
Wording: say "block" (not cell/tile), "Gap score", "open help" (a Pit Stop open at the chosen time), and refer to yourself as Outreach Compass.
Guardrails: block-level only. Never identify or describe individuals. This is for routing SERVICES, not enforcement or sweeps; if asked for enforcement targeting, redirect to services. Briefly note that 311 under-reports in some neighborhoods.
Answer in concise markdown (short headers or numbered lists, bold key numbers). Refer to blocks by sample address + neighborhood, include gap score and report counts. Keep it under ~220 words.`;
  const personas = {
    mayor: `Audience: Mayor's Office / HSOC planners. Rank the worst service-gap blocks with numbers (gap score, 7d vs prior 7d, 30d counts, distance to nearest open Pit Stop, outcome mix). Recommend where to place a mobile Pit Stop (use suggest_pitstop_site) and what the city should do this week.`,
    charity: `Audience: an outreach charity planning a van route tonight. Give 3 to 4 stops in driving order (geographically sensible), each with block address, why (gap score, recent reports), and which nearby Pit Stops will be CLOSED at that time. Mention recent note themes (declined / not found / services offered) so the crew knows what to expect. Evaluate open/closed at the time they will be there.`,
  };
  let p = common + '\n\n' + (personas[persona] || personas.charity);
  if (selectedCell) {
    const c = data.getCells().find(x => x.id === selectedCell);
    if (c) p += `\n\nThe user has selected block ${c.id} (${c.neighborhood}, D${c.district}, lat ${c.lat}, lon ${c.lon}, gap ${c.gapScore}, ${c.count30} reports in 30d). Consider it when relevant.`;
  }
  return p;
}

// ---------- loop ----------
export async function runAgent({ messages = [], persona = 'charity', selectedCell }, emit) {
  await data.load();
  const convo = [
    { role: 'system', content: systemPrompt(persona, selectedCell) },
    ...messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content).map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
  ];
  const MAX_ROUNDS = 5;
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS;
    const msg = await chat({ model: MODELS.agent, messages: convo, tools: last ? undefined : TOOLS, temperature: 0.2, timeoutMs: 90000 });
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map(c => c.text || '').join('');
      emit({ type: 'answer', text: text || '_No answer produced._' });
      return;
    }
    convo.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try { args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call.function?.arguments || {}); } catch { }
      emit({ type: 'tool_call', id: call.id, name, args });
      let out;
      try {
        if (!impl[name]) throw new Error(`unknown tool ${name}`);
        out = await impl[name](args);
      } catch (e) {
        out = { result: { error: e.message }, summary: `error: ${e.message}`, highlight: { cells: [], pitstops: [] } };
      }
      emit({ type: 'tool_result', id: call.id, name, summary: out.summary, highlight: out.highlight });
      convo.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(out.result).slice(0, 12000) });
    }
  }
}

// ---------- district briefing ----------
export async function briefing({ district = '6' } = {}) {
  await data.load();
  const d = normDistrict(district) || '6';
  const cells = data.getCells({ district: d });
  const top = cells.slice(0, 8).map(slimCell);
  const trend = (await tryEs(e => e.trendByNeighborhood({ district: d }))) || data.trendByNeighborhood({ district: d });
  const reports = data.state.reports.filter(r => r.district === d);
  const mix = {};
  for (const r of reports) mix[r.outcome] = (mix[r.outcome] || 0) + 1;
  const site = data.suggestPitstopSite({ district: d });
  const ps = data.pitstopsAt().filter(p => cells.some(c => c.nearest?.id === p.id)).map(p => ({ name: p.name, hours: p.hoursRaw, openNow: p.openNow }));
  const facts = {
    district: d, asOf: data.state.asOf, now: data.laParts().label + ' PT',
    reports30d: reports.length, blocksWithReports: cells.length, outcomeMix30d: mix,
    trendByNeighborhood: trend.slice(0, 8), worstGapBlocks: top,
    suggestedMobilePitStop: site.best ? { block: slimCell(site.best.cell), reportsCovered: site.best.covered } : null,
    nearbyPitStops: ps,
  };
  const msg = await chat({
    model: MODELS.agent, temperature: 0.3, timeoutMs: 90000,
    messages: [
      { role: 'system', content: 'You are Outreach Compass (BlockSignal). Write a one-page markdown briefing memo for the Mayor\'s Office / HSOC about one SF supervisor district, using ONLY the provided facts. Sections: Summary (3 bullets), Worst service-gap blocks (table: block address/neighborhood, gap, 7d, prior 7d, 30d, nearest open help), Trend, What crews are finding (outcome mix), Recommendations (incl. mobile Pit Stop site), Caveats (311 measures complaints not need; under-reporting; block-level only, services not enforcement). Under 400 words.' },
      { role: 'user', content: JSON.stringify(facts) },
    ],
  });
  const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map(c => c.text || '').join('');
  return { markdown: text, district: d };
}
