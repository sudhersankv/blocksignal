/* BlockSignal front end. Vanilla JS + Leaflet 1.9.4. Consumes CONTRACT.md "HTTP API".
   Sections: util / api (with mock fallback) / wordmark+sprites / map / HUD / inspect / compass chat / boot. */
(() => {
  "use strict";

  // ---------------------------------------------------------------- util
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (n == null ? "---" : Number(n).toLocaleString("en-US"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RAMP = ["#FFD800", "#FFAF00", "#FF8205", "#FA500F", "#E10500"];
  function rampColor(g) {
    const t = Math.max(0, Math.min(100, g || 0)) / 100 * (RAMP.length - 1);
    const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i;
    const a = RAMP[i].match(/\w\w/g).map((h) => parseInt(h, 16)), b = RAMP[i + 1].match(/\w\w/g).map((h) => parseInt(h, 16));
    return "#" + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, "0")).join("");
  }
  function distM(a, b, c, d) {
    const R = 6371000, r = Math.PI / 180, dLat = (c - a) * r, dLon = (d - b) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }
  const fmtDist = (m) => (m == null ? "?" : m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m");
  const trendHtml = (t) => (t > 0 ? `<span class="up">&#9650;${t}</span>` : t < 0 ? `<span class="down">&#9660;${-t}</span>` : `<span class="flat">&#9632;0</span>`);

  // ---------------------------------------------------------------- state
  const S = {
    mock: false, persona: "mayor", at: "now", district: "",
    cells: [], cellById: new Map(), allCellById: new Map(), pitstops: [], psById: new Map(),
    selected: null, messages: [], busy: false, sfx: false,
  };
  try { S.persona = localStorage.getItem("bs.persona") || "mayor"; } catch (e) { /* storage blocked */ }

  // ---------------------------------------------------------------- sound (off by default)
  let actx = null;
  function blip(freq = 660, dur = 0.06, type = "square", vol = 0.05) {
    if (!S.sfx) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = vol;
      o.connect(g); g.connect(actx.destination); o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur); o.stop(actx.currentTime + dur + 0.02);
    } catch (e) { /* no audio */ }
  }
  const coin = () => { blip(988, 0.07); setTimeout(() => blip(1319, 0.18), 70); };

  // ---------------------------------------------------------------- api
  async function getJSON(url, opts = {}, timeout = 15000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  const post = (url, body, timeout) => getJSON(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeout);
  const M = () => window.BS_MOCK;
  const api = {
    async status() {
      try { const s = await getJSON("/api/status", {}, 4000); S.mock = false; return s; }
      catch (e) { console.warn("[BlockSignal] /api/status failed, using mock data:", e.message); S.mock = true; return M().status(); }
    },
    cells: (d) => (S.mock ? M().cells(d) : getJSON("/api/cells" + (d ? `?district=${encodeURIComponent(d)}` : ""))),
    pitstops: (at) => (S.mock ? M().pitstops(at) : getJSON("/api/pitstops" + (at ? `?at=${encodeURIComponent(at)}` : ""))),
    cell: (id) => (S.mock ? M().cell(id) : getJSON(`/api/cell/${encodeURIComponent(id)}`)),
    briefing: (district) => (S.mock ? M().briefing(district) : post("/api/briefing", { district }, 90000)),
    async *chat(body) {
      if (S.mock) { yield* M().chat(body); return; }
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok || !r.body) throw new Error(`/api/chat -> HTTP ${r.status}`);
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line) { try { yield JSON.parse(line); } catch (e) { console.warn("bad ndjson line", line); } }
        }
        if (done) break;
      }
      if (buf.trim()) { try { yield JSON.parse(buf.trim()); } catch (e) { /* ignore tail */ } }
    },
  };

  // ---------------------------------------------------------------- pixel wordmark + sprites
  const GLYPH = {
    B: ["11110", "10001", "11110", "10001", "11110"], L: ["10000", "10000", "10000", "10000", "11111"],
    O: ["01110", "10001", "10001", "10001", "01110"], C: ["01111", "10000", "10000", "10000", "01111"],
    K: ["10001", "10010", "11100", "10010", "10001"], S: ["01111", "10000", "01110", "00001", "11110"],
    I: ["11111", "00100", "00100", "00100", "11111"], G: ["01111", "10000", "10011", "10001", "01111"],
    N: ["10001", "11001", "10101", "10011", "10001"], A: ["01110", "10001", "11111", "10001", "10001"],
  };
  function wordmarkSVG() {
    const word = "BLOCKSIGNAL", cols = word.length * 6 - 1;
    let shadow = "", fill = "";
    [...word].forEach((ch, li) => {
      GLYPH[ch].forEach((row, y) => [...row].forEach((bit, x) => {
        if (bit !== "1") return;
        const X = li * 6 + x;
        const c = li < 5 ? rampColor((X / (5 * 6)) * 100) : (y % 2 ? "#38f3ff" : "#9ffaff");
        shadow += `<rect x="${X + 1}" y="${y + 1}" width="1" height="1" fill="${li < 5 ? "#5a1200" : "#7a0a66"}"/>`;
        fill += `<rect x="${X}" y="${y}" width="1" height="1" fill="${c}"/>`;
      }));
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols + 1} 6" shape-rendering="crispEdges" role="img" aria-label="BlockSignal">${shadow}${fill}</svg>`;
  }
  // 10x9 pixel toilet sprite. X = outline, W = body, D = dark
  const TOILET = ["..XXXX....", "..XWWX....", "..XXXX....", "XXXXXXXXX.", "XWWWWWWWX.", ".XWWWWWX..", "..XWWWX...", "...XWX....", "..XXXXX..."];
  function spriteSVG(open) {
    const pal = open ? { X: "#38f3ff", W: "#dffcff" } : { X: "#a3243a", W: "#4a1a22" };
    let out = "";
    TOILET.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) out += `<rect x="${x}" y="${y}" width="1" height="1" fill="${pal[ch]}"/>`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 9" shape-rendering="crispEdges">${out}</svg>`;
  }

  // ---------------------------------------------------------------- map
  let map, cellLayer, psLayer, fxLayer;
  const cellPaths = new Map(), psMarkers = new Map();
  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true, preferCanvas: false, zoomSnap: 0.5 }).setView([37.773, -122.43], 13);
    // CARTO raster basemaps now need an API key, so use OSM tiles and push them to night-teal with a CSS filter.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "base-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    cellLayer = L.layerGroup().addTo(map);
    psLayer = L.layerGroup().addTo(map);
    fxLayer = L.layerGroup().addTo(map);
    window.addEventListener("resize", () => map.invalidateSize());
  }

  function drawCells() {
    cellLayer.clearLayers(); cellPaths.clear();
    const topIds = new Set(S.cells.slice(0, 10).map((c) => c.id));
    // draw low scores first so hot cells sit on top
    [...S.cells].reverse().forEach((c) => {
      const top = topIds.has(c.id), g = c.gapScore || 0;
      const r = L.rectangle(c.bounds, {
        color: top ? "#ff2fd2" : "#000", weight: top ? 3 : 1, opacity: 1,
        fillColor: rampColor(g), fillOpacity: 0.12 + 0.68 * (g / 100),
        className: "cell" + (top ? " top" : "") + (S.selected === c.id ? " sel" : ""),
      });
      r.bindTooltip(`<b>${esc(c.neighborhood || "Block")}</b> GAP ${g} · 7D ${c.count7}`, { className: "pxtip", direction: "top", sticky: true });
      r.on("click", () => { blip(520); openInspect(c.id); });
      r.addTo(cellLayer); cellPaths.set(c.id, r);
    });
  }

  function drawPitstops() {
    psLayer.clearLayers(); psMarkers.clear();
    S.pitstops.forEach((p) => {
      if (p.lat == null || p.lon == null) return;
      const icon = L.divIcon({ className: "sprite " + (p.openNow ? "ps-open" : "ps-closed"), html: spriteSVG(p.openNow), iconSize: [24, 22], iconAnchor: [12, 11] });
      const m = L.marker([p.lat, p.lon], { icon, keyboard: true, title: p.name, zIndexOffset: p.openNow ? 500 : 0 });
      m.bindTooltip(`<b>${esc(p.name)}</b><br>${p.openNow ? "OPEN" : "CLOSED"} · ${esc(p.hoursRaw || "hours unknown")}`, { className: "pxtip", direction: "top", offset: [0, -10] });
      m.addTo(psLayer); psMarkers.set(p.id, m);
    });
  }

  function clearFx() {
    fxLayer.clearLayers();
    $$(".cell.hl").forEach((el) => el.classList.remove("hl"));
    $$(".ps-hl").forEach((el) => el.classList.remove("ps-hl"));
  }
  function applyHighlight(h, { route = false } = {}) {
    if (!h) return;
    const cells = (h.cells || []).map((id) => S.allCellById.get(id) || S.cellById.get(id)).filter(Boolean);
    const pts = (h.pitstops || []).map((id) => S.psById.get(id)).filter(Boolean);
    if (!cells.length && !pts.length) return;
    const latlngs = [];
    if (cells.length) {
      fxLayer.clearLayers();
      cells.forEach((c, i) => {
        // ensure the cell exists on the map even if outside the district filter
        let p = cellPaths.get(c.id);
        if (!p) {
          p = L.rectangle(c.bounds, { color: "#fff", weight: 3, fillColor: rampColor(c.gapScore), fillOpacity: 0.8, className: "cell" }).addTo(fxLayer);
        }
        const el = p.getElement && p.getElement();
        if (el) { el.classList.add("hl"); setTimeout(() => el.classList.remove("hl"), 6000); }
        const ll = [c.lat, c.lon]; latlngs.push(ll);
        L.marker(ll, { icon: L.divIcon({ className: "wp", html: String(i + 1), iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 1000, interactive: false }).addTo(fxLayer);
      });
      if (route && cells.length > 1) {
        L.polyline(latlngs, { color: "#38f3ff", weight: 6, opacity: 0.25, interactive: false }).addTo(fxLayer);
        L.polyline(latlngs, { color: "#ff2fd2", weight: 3, dashArray: "8 8", className: "route", interactive: false }).addTo(fxLayer);
      }
    }
    pts.forEach((p) => {
      const m = psMarkers.get(p.id); latlngs.push([p.lat, p.lon]);
      const el = m && m.getElement();
      if (el) { el.classList.add("ps-hl"); setTimeout(() => el.classList.remove("ps-hl"), 6000); }
    });
    blip(880, 0.05); setTimeout(() => blip(660, 0.05), 60);
    if (latlngs.length === 1) map.flyTo(latlngs[0], Math.max(map.getZoom(), 16), { duration: 0.9 });
    else map.flyToBounds(L.latLngBounds(latlngs).pad(0.35), { duration: 0.9, maxZoom: 16 });
  }

  // ---------------------------------------------------------------- HUD
  function renderStatus(s) {
    $("#sReports").textContent = fmt(s.counts?.reports);
    $("#sPitstops").textContent = fmt(s.counts?.pitstops);
    $("#sCells").textContent = fmt(s.counts?.cells);
    $("#chipMistral").textContent = s.mistral ? "MISTRAL ✓" : "MISTRAL OFF";
    const e = s.elastic || {}, ok = e.enabled && e.connected;
    const ce = $("#chipElastic");
    ce.textContent = ok ? "ELASTIC CONNECTED" : "ELASTIC LOCAL";
    ce.classList.toggle("local", !ok);
    if (e.cluster) ce.title = "Cluster: " + e.cluster;
    const mc = $("#modeChip");
    mc.textContent = S.mock ? "DEMO DATA" : "LIVE";
    mc.className = "chip " + (S.mock ? "chip-mock" : "chip-live");
    mc.title = S.mock ? "Backend at /api is offline. Showing sample data." : `Data as of ${s.asOf || "now"}`;
  }

  function renderLeader() {
    const ol = $("#leader");
    const top = S.cells.slice(0, 10);
    if (!top.length) { ol.innerHTML = `<li class="dim">NO BLOCKS FOR THIS DISTRICT</li>`; return; }
    ol.innerHTML = top.map((c, i) => `
      <li data-id="${esc(c.id)}" tabindex="0" class="${S.selected === c.id ? "sel" : ""}" title="${esc(c.neighborhood)}: gap ${c.gapScore}, ${c.count7} reports in 7 days">
        <span class="rk">${String(i + 1).padStart(2, "0")}</span>
        <span class="nm">${esc(c.neighborhood || c.id)}${c.district ? ` <span class="dim">D${esc(c.district)}</span>` : ""}</span>
        <span class="sc">${c.gapScore}<span class="tr">${trendHtml(c.trend ?? (c.count7 - c.countPrev7))}</span></span>
        <span class="bar"><i style="width:${c.gapScore}%;--full:${c.gapScore ? (10000 / c.gapScore) : 100}%"></i></span>
      </li>`).join("");
    $$("li[data-id]", ol).forEach((li) => {
      const go = () => { const c = S.cellById.get(li.dataset.id); blip(520); openInspect(c.id); map.flyToBounds(c.bounds, { maxZoom: 16, duration: 0.8 }); };
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  function setPersona(p) {
    S.persona = p;
    try { localStorage.setItem("bs.persona", p); } catch (e) { /* ignore */ }
    $$(".player").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.persona === p)));
  }

  function atISO(key) {
    if (key === "now") return null;
    const d = new Date(), h = Number(key);
    d.setMinutes(0, 0, 0); d.setHours(h);
    if (h < 6) d.setDate(d.getDate() + 1); // 2am means tonight, i.e. tomorrow morning
    return d.toISOString();
  }

  async function loadCells() {
    const r = await api.cells(S.district);
    S.cells = (r.cells || []).slice().sort((a, b) => (b.gapScore || 0) - (a.gapScore || 0));
    S.cellById = new Map(S.cells.map((c) => [c.id, c]));
    if (!S.district) S.allCellById = new Map(S.cellById);
    else S.cells.forEach((c) => S.allCellById.set(c.id, c));
    drawCells(); renderLeader();
  }
  async function loadPitstops() {
    const r = await api.pitstops(atISO(S.at));
    S.pitstops = r.pitstops || [];
    S.psById = new Map(S.pitstops.map((p) => [p.id, p]));
    drawPitstops();
    if (S.selected) openInspect(S.selected, { refetch: false });
  }

  // ---------------------------------------------------------------- inspect
  const OUT = [
    ["resolved", "#5dff9b", "RESOLVED"], ["services_offered", "#38f3ff", "SERVICES"], ["declined", "#FFAF00", "DECLINED"],
    ["not_found", "#7d8fa0", "NOT FOUND"], ["medical", "#ff2fd2", "MEDICAL"], ["cancelled", "#3a4a55", "CANCELLED"],
    ["open", "#FA500F", "OPEN"], ["other", "#c9d6dc", "OTHER"],
  ];
  function nearestOpen(c) {
    let best = null;
    S.pitstops.forEach((p) => { if (!p.openNow || p.lat == null) return; const d = distM(c.lat, c.lon, p.lat, p.lon); if (!best || d < best.d) best = { p, d }; });
    return best;
  }
  async function openInspect(id, { refetch = true } = {}) {
    const c = S.allCellById.get(id) || S.cellById.get(id);
    if (!c) return;
    $$(".cell.sel").forEach((el) => el.classList.remove("sel"));
    S.selected = id;
    const el = cellPaths.get(id)?.getElement(); if (el) el.classList.add("sel");
    $$("#leader li").forEach((li) => li.classList.toggle("sel", li.dataset.id === id));
    $("#mapHint").hidden = true;
    const box = $("#inspect"); box.hidden = false;
    const o = c.outcomes || {}, tot = OUT.reduce((a, [k]) => a + (o[k] || 0), 0) || 1;
    const near = nearestOpen(c);
    const when = S.at === "now" ? "NOW" : $(`#timeSeg [data-at="${S.at}"]`).textContent;
    const nearHtml = near
      ? `<div class="near">NEAREST OPEN HELP (${esc(when)})<br><b>${esc(near.p.name)}</b> · ${fmtDist(near.d)}</div>`
      : c.nearest ? `<div class="near closed">NO PIT STOP OPEN ${esc(when)}.<br>Closest: ${esc(c.nearest.name)} · ${fmtDist(c.nearest.distanceM)}</div>`
      : `<div class="near closed">NO PIT STOP DATA</div>`;
    box.innerHTML = `
      <div class="ih">
        <div><h3>INSPECT // ${esc(c.neighborhood || "BLOCK")}</h3><div class="sub">CELL ${esc(c.id)}${c.district ? " · DISTRICT " + esc(c.district) : ""}</div></div>
        <button class="pxbtn small" type="button" id="inspClose" aria-label="Close inspect card">X</button>
      </div>
      <div class="ih"><span class="gapbig">GAP ${c.gapScore}</span><span>7D TREND ${trendHtml(c.trend ?? c.count7 - c.countPrev7)}</span></div>
      <div class="nums">
        <div><b>${c.count7}</b><span>LAST 7D</span></div>
        <div><b>${c.countPrev7}</b><span>PREV 7D</span></div>
        <div><b>${c.count30}</b><span>30 DAYS</span></div>
      </div>
      ${nearHtml}
      <div><div class="lbl" style="margin-bottom:4px">CREW OUTCOMES (30D)</div>
        <div class="mix" role="img" aria-label="Outcome mix">${OUT.filter(([k]) => o[k]).map(([k, col, n]) => `<i style="width:${(o[k] / tot) * 100}%;background:${col}" title="${n}: ${o[k]}"></i>`).join("")}</div>
        <div class="mixkey">${OUT.filter(([k]) => o[k]).map(([k, col, n]) => `<span style="--c:${col}">${n} ${o[k]}</span>`).join("")}</div>
      </div>
      <ul class="notes" id="inspNotes"></ul>
      <button class="pxbtn ask" type="button" id="inspAsk">ASK COMPASS ABOUT THIS BLOCK</button>`;
    $("#inspClose").onclick = closeInspect;
    $("#inspAsk").onclick = () => {
      coin();
      sendChat(`What is happening at the ${c.neighborhood || ""} block ${c.id} and what should ${S.persona === "charity" ? "our outreach team" : "the city"} do there?`, { selectedCell: c.id });
    };
    if (refetch) {
      try {
        const d = await api.cell(id);
        if (S.selected !== id) return;
        const notes = (d.reports || []).filter((r) => r.notes).slice(0, 4);
        $("#inspNotes").innerHTML = notes.length
          ? notes.map((r) => `<li>${esc((r.notes || "").slice(0, 110))} <span class="dim">[${esc(r.outcome || "?")}]</span></li>`).join("")
          : "";
      } catch (e) { $("#inspNotes").innerHTML = `<li class="dim">Crew notes unavailable: ${esc(e.message)}</li>`; }
    }
  }
  function closeInspect() {
    $("#inspect").hidden = true;
    $$(".cell.sel").forEach((el) => el.classList.remove("sel"));
    $$("#leader li.sel").forEach((li) => li.classList.remove("sel"));
    S.selected = null;
  }

  // ---------------------------------------------------------------- markdown (tiny, safe)
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  }
  function md(src) {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    let out = "", i = 0;
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const cellsOf = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      let m;
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { const n = Math.min(3, m[1].length); out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue; }
      if (isRow(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = cellsOf(l); i += 2;
        let body = "";
        while (i < lines.length && isRow(lines[i])) { body += "<tr>" + cellsOf(lines[i]).map((x) => `<td>${inline(x)}</td>`).join("") + "</tr>"; i++; }
        out += `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d/.test(l); let items = "";
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) { items += `<li>${inline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""))}</li>`; i++; }
        out += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`; continue;
      }
      let para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) && !isRow(lines[i])) { para.push(inline(lines[i])); i++; }
      if (!para.length) { para.push(inline(lines[i])); i++; }
      out += `<p>${para.join("<br>")}</p>`;
    }
    return out;
  }

  // ---------------------------------------------------------------- compass chat
  const log = $("#log");
  function logLine(cls, html) {
    const d = document.createElement("div"); d.className = cls; d.innerHTML = html;
    log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
  }
  const argStr = (a) => Object.entries(a || {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");

  async function sendChat(text, extra = {}) {
    text = (text || "").trim();
    if (!text || S.busy) return;
    S.busy = true; $("#sendBtn").disabled = true; $$(".quest").forEach((b) => (b.disabled = true));
    clearFx();
    logLine("you" + (S.persona === "charity" ? " p2" : ""), esc(text));
    S.messages.push({ role: "user", content: text });
    const body = { messages: S.messages.slice(-10), persona: S.persona };
    const sel = extra.selectedCell || S.selected; if (sel) body.selectedCell = sel;
    const route = S.persona === "charity";
    const casts = new Map();
    let thinking = logLine("cast", `&gt; THINKING<span class="cur"></span>`);
    let answered = false;
    try {
      for await (const ev of api.chat(body)) {
        if (thinking) { thinking.remove(); thinking = null; }
        if (ev.type === "tool_call") {
          blip(440, 0.04);
          casts.set(ev.id, logLine("cast", `&gt; CAST ${esc(ev.name)}(${esc(argStr(ev.args))})<span class="cur"></span>`));
        } else if (ev.type === "tool_result") {
          const c = casts.get(ev.id); if (c) c.querySelector(".cur")?.remove();
          logLine("res", esc(ev.summary || `${ev.name} done`));
          applyHighlight(ev.highlight, { route });
        } else if (ev.type === "answer") {
          answered = true; blip(1046, 0.12, "triangle");
          logLine("ans md", md(ev.text));
          S.messages.push({ role: "assistant", content: ev.text });
        } else if (ev.type === "error") {
          logLine("err", "! " + esc(ev.message || "Agent error"));
        } else if (ev.type === "done") break;
      }
      if (!answered) logLine("sys", "Compass returned no answer. Try rephrasing the question.");
    } catch (e) {
      if (thinking) thinking.remove();
      logLine("err", `! Compass could not be reached (${esc(e.message)}). Check that the server is running on :8787.`);
    } finally {
      $$(".cast .cur").forEach((c) => c.remove());
      S.busy = false; $("#sendBtn").disabled = false; $$(".quest").forEach((b) => (b.disabled = false));
    }
  }

  async function openBriefing() {
    const district = S.district || "6";
    const modal = $("#modal"), bodyEl = $("#modalBody");
    $("#modalTitle").textContent = `DISTRICT ${district} BRIEFING`;
    bodyEl.innerHTML = `<p class="blink">COMPILING MEMO...</p>`;
    modal.hidden = false; $("#modalClose").focus(); coin();
    try { const r = await api.briefing(district); bodyEl.innerHTML = md(r.markdown || "_No memo returned._"); }
    catch (e) { bodyEl.innerHTML = `<p class="err">Briefing failed: ${esc(e.message)}. Try again once the server is up.</p>`; }
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    $$(".player").forEach((b) => b.addEventListener("click", () => { setPersona(b.dataset.persona); coin(); }));
    $$("#timeSeg button").forEach((b) => b.addEventListener("click", async () => {
      $$("#timeSeg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
      S.at = b.dataset.at; $("#atLabel").textContent = "AT: " + b.textContent; blip(330);
      try { await loadPitstops(); } catch (e) { console.error(e); }
    }));
    const sel = $("#district");
    for (let d = 1; d <= 11; d++) sel.insertAdjacentHTML("beforeend", `<option value="${d}">DISTRICT ${d}</option>`);
    sel.addEventListener("change", async () => {
      S.district = sel.value; closeInspect(); clearFx();
      try {
        await loadCells();
        if (S.cells.length) map.flyToBounds(L.latLngBounds(S.cells.map((c) => [c.lat, c.lon])).pad(0.1), { duration: 0.8 });
      } catch (e) { console.error(e); }
    });
    $$(".quest").forEach((b) => b.addEventListener("click", () => { setPersona(b.dataset.persona); coin(); sendChat(b.dataset.q); }));
    $("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); const i = $("#chatInput"); const v = i.value; i.value = ""; sendChat(v); });
    $("#briefBtn").addEventListener("click", openBriefing);
    $("#modalClose").addEventListener("click", () => ($("#modal").hidden = true));
    $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") e.currentTarget.hidden = true; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#modal").hidden = true; closeInspect(); } });
    $("#soundBtn").addEventListener("click", (e) => {
      S.sfx = !S.sfx; e.currentTarget.textContent = "SFX: " + (S.sfx ? "ON" : "OFF"); e.currentTarget.setAttribute("aria-pressed", String(S.sfx)); coin();
    });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    const wm = wordmarkSVG();
    $("#wordmark").innerHTML = wm; $("#bootLogo").innerHTML = wm;
    setPersona(S.persona);
    initMap(); wire();

    const fill = $("#bootFill"), line = $("#bootLine"), bootEl = $("#boot");
    let skipped = false;
    const hide = () => { if (bootEl.classList.contains("gone")) return; bootEl.classList.add("gone"); setTimeout(() => { bootEl.hidden = true; map.invalidateSize(); }, 300); };
    const skip = () => { skipped = true; hide(); };
    bootEl.addEventListener("click", skip); window.addEventListener("keydown", skip, { once: true });
    const step = (p, txt) => { fill.style.width = p + "%"; line.textContent = txt; };
    const minTime = sleep(1200);

    step(15, "DIALING 311 UPLINK...");
    const status = await api.status();
    renderStatus(status);
    step(45, S.mock ? "BACKEND OFFLINE. LOADING DEMO CITY..." : "LOADING CITY GRID...");
    try { await loadCells(); } catch (e) { console.error(e); logLine("err", "! Could not load blocks: " + esc(e.message)); }
    step(75, "SPAWNING PIT STOPS...");
    try { await loadPitstops(); } catch (e) { console.error(e); logLine("err", "! Could not load Pit Stops: " + esc(e.message)); }
    step(100, "READY PLAYER ONE");
    if (S.cells.length) map.fitBounds(L.latLngBounds(S.cells.slice(0, 40).map((c) => [c.lat, c.lon])).pad(0.2));
    if (S.mock) logLine("sys", "DEMO MODE: the server is not responding, so the map and Compass use sample data.");
    if (!skipped) { await minTime; await sleep(150); hide(); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
