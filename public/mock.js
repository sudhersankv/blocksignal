// BlockSignal mock data. Used ONLY when GET /api/status fails (backend not up).
// Shapes follow CONTRACT.md "HTTP API". Everything here is sample data, not real 311 records.
(function () {
  const NB = [
    ["Tenderloin", "6", 37.7840, -122.4140],
    ["South of Market", "6", 37.7790, -122.4060],
    ["Mission", "9", 37.7620, -122.4180],
    ["Civic Center", "6", 37.7795, -122.4170],
    ["Bayview Hunters Point", "10", 37.7300, -122.3910],
    ["Mission Bay", "6", 37.7710, -122.3930],
    ["Hayes Valley", "5", 37.7760, -122.4240],
    ["Potrero Hill", "10", 37.7600, -122.4010],
    ["Chinatown", "3", 37.7940, -122.4070],
    ["Western Addition", "5", 37.7810, -122.4330],
  ];
  const LAT = 0.003, LON = 0.004;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const pitstops = [
    { id: "ps1", name: "Tenderloin Pit Stop: Hyde & Eddy", address: "Hyde St & Eddy St", neighborhood: "Tenderloin", lat: 37.7838, lon: -122.4163, hoursRaw: "Daily 7am to 9pm", hours: { is24h: false, open: "07:00", close: "21:00", days: ["mon","tue","wed","thu","fri","sat","sun"] } },
    { id: "ps2", name: "Civic Center Plaza Pit Stop", address: "Civic Center Plaza", neighborhood: "Civic Center", lat: 37.7793, lon: -122.4180, hoursRaw: "Open 24 hours", hours: { is24h: true, open: "00:00", close: "23:59", days: ["mon","tue","wed","thu","fri","sat","sun"] } },
    { id: "ps3", name: "16th St BART Pit Stop", address: "16th St & Mission St", neighborhood: "Mission", lat: 37.7650, lon: -122.4196, hoursRaw: "Daily 7am to 3pm", hours: { is24h: false, open: "07:00", close: "15:00", days: ["mon","tue","wed","thu","fri","sat","sun"] } },
    { id: "ps4", name: "6th & Jessie Pit Stop", address: "6th St & Jessie St", neighborhood: "South of Market", lat: 37.7811, lon: -122.4090, hoursRaw: "Close Time: 5pm  to Open Time: 9am", hours: { is24h: false, open: "09:00", close: "17:00", days: ["mon","tue","wed","thu","fri"] } },
    { id: "ps5", name: "Bayview Pit Stop: 3rd & Palou", address: "3rd St & Palou Ave", neighborhood: "Bayview Hunters Point", lat: 37.7337, lon: -122.3907, hoursRaw: "Daily 8am to 8pm", hours: { is24h: false, open: "08:00", close: "20:00", days: ["mon","tue","wed","thu","fri","sat","sun"] } },
    { id: "ps6", name: "Hayes Valley Pit Stop", address: "Hayes St & Laguna St", neighborhood: "Hayes Valley", lat: 37.7765, lon: -122.4262, hoursRaw: "Daily 10am to 6pm", hours: { is24h: false, open: "10:00", close: "18:00", days: ["mon","tue","wed","thu","fri","sat","sun"] } },
  ];

  function openAt(p, at) {
    if (!p.hours) return false;
    if (p.hours.is24h) return true;
    const d = at ? new Date(at) : new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    const [oh, om] = p.hours.open.split(":").map(Number);
    const [ch, cm] = p.hours.close.split(":").map(Number);
    return m >= oh * 60 + om && m < ch * 60 + cm;
  }
  function distM(a, b, c, d) {
    const R = 6371000, r = Math.PI / 180;
    const x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
    return Math.round(Math.sqrt(x * x + y * y) * R);
  }

  const cells = [];
  NB.forEach(([name, district, clat, clon], ni) => {
    const n = ni < 2 ? 9 : 5;
    for (let i = 0; i < n; i++) {
      const row = Math.round(clat / LAT) + Math.floor(rnd() * 5) - 2;
      const col = Math.round(clon / LON) + Math.floor(rnd() * 5) - 2;
      const id = `c${row}_${col}`;
      if (cells.find((c) => c.id === id)) continue;
      const s = row * LAT, w = col * LON;
      const lat = s + LAT / 2, lon = w + LON / 2;
      const heat = ni < 2 ? 1 : ni < 5 ? 0.6 : 0.3;
      const count30 = Math.round((8 + rnd() * 60) * heat);
      const count7 = Math.round(count30 * (0.15 + rnd() * 0.2));
      const countPrev7 = Math.round(count30 * (0.15 + rnd() * 0.2));
      let best = null;
      pitstops.forEach((p) => {
        const dm = distM(lat, lon, p.lat, p.lon);
        if (!best || dm < best.distanceM) best = { id: p.id, name: p.name, distanceM: dm, openNow: openAt(p) };
      });
      const share = () => Math.round(count30 * rnd() * 0.3);
      const outcomes = { resolved: share(), services_offered: share(), declined: share(), not_found: share(), medical: Math.round(count30 * rnd() * 0.08), cancelled: Math.round(count30 * rnd() * 0.06), open: Math.round(count30 * rnd() * 0.1), other: 0 };
      outcomes.other = Math.max(0, count30 - Object.values(outcomes).reduce((a, b) => a + b, 0));
      cells.push({ id, lat, lon, bounds: [[s, w], [s + LAT, w + LON]], count7, countPrev7, count30, trend: count7 - countPrev7, gapScore: 0, nearest: best, district, neighborhood: name, outcomes });
    }
  });
  const raw = cells.map((c) => Math.log1p(c.count30) * (1 + c.count7 / Math.max(1, c.count30)) * Math.min((c.nearest ? c.nearest.distanceM : 2000) / 1000, 2) + 0.4 * Math.log1p(c.count30));
  const mx = Math.max(...raw);
  cells.forEach((c, i) => (c.gapScore = Math.round((raw[i] / mx) * 100)));
  cells.sort((a, b) => b.gapScore - a.gapScore);

  const NOTES = [
    ["services_offered", "Team responded, provided service information; client accepted hygiene kit."],
    ["declined", "Outreach offered shelter referral; services declined."],
    ["not_found", "Unable to locate on arrival."],
    ["resolved", "Team responded, area clear."],
    ["medical", "Referred to street medicine team."],
  ];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  window.BS_MOCK = {
    status() {
      return { mistral: true, elastic: { enabled: false, connected: false }, counts: { reports: cells.reduce((a, c) => a + c.count30, 0), pitstops: pitstops.length, cells: cells.length }, asOf: new Date().toISOString(), models: { agent: "mistral-medium-latest", parser: "mistral-small-latest" }, mock: true };
    },
    cells(district) {
      return { cells: district ? cells.filter((c) => c.district === String(district)) : cells.slice() };
    },
    pitstops(at) {
      return { pitstops: pitstops.map((p) => ({ ...p, openNow: openAt(p, at) })) };
    },
    cell(id) {
      const cell = cells.find((c) => c.id === id) || cells[0];
      const reports = Array.from({ length: Math.min(6, cell.count30) }, (_, i) => {
        const [outcome, notes] = NOTES[i % NOTES.length];
        return { requested: new Date(Date.now() - i * 9e6).toISOString(), address: `${100 + i * 20} block, ${cell.neighborhood}`, notes, outcome };
      });
      return { cell, reports };
    },
    briefing(district) {
      const top = cells.filter((c) => !district || c.district === String(district)).slice(0, 5);
      return {
        markdown: `# District ${district || "6"} briefing (sample)\n\n**Backend offline. This memo uses sample data.**\n\n## Worst service gaps\n| Rank | Block | Gap | 7d | Nearest open help |\n|---|---|---|---|---|\n${top.map((c, i) => `| ${i + 1} | ${c.neighborhood} ${c.id} | ${c.gapScore} | ${c.count7} | ${c.nearest ? c.nearest.name + " (" + c.nearest.distanceM + " m)" : "none"} |`).join("\n")}\n\n## Recommendations\n- Extend hours at the nearest Pit Stop to 9pm.\n- Route the hygiene van through the top 3 blocks between 6pm and 9pm.\n- Pilot a mobile Pit Stop at block **${top[0] ? top[0].id : "-"}**.\n`,
      };
    },
    async *chat(body) {
      const d = body.persona === "charity" ? "6" : "6";
      const top = cells.filter((c) => c.district === d).slice(0, body.persona === "charity" ? 4 : 5);
      yield { type: "tool_call", id: "t1", name: "hotspots", args: { district: d, limit: top.length, open_at: body.persona === "charity" ? "18:00" : undefined } };
      await wait(700);
      yield { type: "tool_result", id: "t1", name: "hotspots", summary: `${top.length} blocks ranked by service gap in D${d}`, highlight: { cells: top.map((c) => c.id), pitstops: [] } };
      await wait(500);
      yield { type: "tool_call", id: "t2", name: "nearest_open_help", args: { lat: +top[0].lat.toFixed(4), lon: +top[0].lon.toFixed(4), at: "18:00" } };
      await wait(600);
      yield { type: "tool_result", id: "t2", name: "nearest_open_help", summary: `Nearest open: ${top[0].nearest ? top[0].nearest.name : "none"}`, highlight: { cells: [], pitstops: top[0].nearest ? [top[0].nearest.id] : [] } };
      await wait(500);
      yield { type: "tool_call", id: "t3", name: "search_notes", args: { query: "declined services", district: d } };
      await wait(600);
      yield { type: "tool_result", id: "t3", name: "search_notes", summary: "12 notes match: shelter declined, hygiene kits accepted", highlight: { cells: [], pitstops: [] } };
      await wait(400);
      const rows = top.map((c, i) => `| ${i + 1} | ${c.neighborhood} (${c.id}) | ${c.gapScore} | ${c.count7} | ${c.nearest ? c.nearest.distanceM + " m" : "-"} |`).join("\n");
      yield {
        type: "answer",
        text: `## ${body.persona === "charity" ? "Van route, 6pm to 9pm" : "Worst gaps in D6 this week"}\n\n_Sample answer: the backend is offline._\n\n| # | Block | Gap | 7d | Nearest open help |\n|---|---|---|---|---|\n${rows}\n\n**What to do**\n- Stop 1 first: it has the highest gap and the nearest Pit Stop closes before 6pm.\n- Bring hygiene kits; crew notes show kits are accepted where shelter is declined.\n- Flag block **${top[0].id}** for a mobile Pit Stop pilot.`,
      };
      yield { type: "done" };
    },
  };
})();
