/* BlockSignal front end. Vanilla JS + Leaflet 1.9.4. Consumes CONTRACT.md "HTTP API".
   Sections: util / personas / api (with mock fallback) / wordmark / map / HUD / explain (intro, popover, why) /
   inspect / markdown / compass chat / briefing memo / export / boot. */
(() => {
  "use strict";

  // ---------------------------------------------------------------- util
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (n == null ? "---" : Number(n).toLocaleString("en-US"));
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
  // Trend never relies on color alone: arrow + explicit sign + hidden words for screen readers.
  const trendHtml = (t) => (t > 0
    ? `<span class="up"><span aria-hidden="true">&#9650;</span> +${t}<span class="sr-only"> more reports than the week before</span></span>`
    : t < 0 ? `<span class="down"><span aria-hidden="true">&#9660;</span> &minus;${-t}<span class="sr-only"> fewer reports than the week before</span></span>`
    : `<span class="flat"><span aria-hidden="true">&#9632;</span> 0<span class="sr-only"> change from the week before</span></span>`);
  const trendText = (t) => (t > 0 ? `up ${t}` : t < 0 ? `down ${-t}` : "no change");
  const trendOf = (c) => c.trend ?? (c.count7 - c.countPrev7);
  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  };
  const LA_TZ = "America/Los_Angeles";
  function fmtLA(iso, opts) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d)) return null;
    try { return new Intl.DateTimeFormat("en-US", { timeZone: LA_TZ, ...opts }).format(d); } catch (e) { return d.toLocaleString(); }
  }

  // Focus management for dialogs: trap Tab inside, remember the opener, restore on close.
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, summary, [tabindex]:not([tabindex="-1"])';
  function trapFocus(container, e) {
    if (e.key !== "Tab") return;
    const f = $$(FOCUSABLE, container).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }

  // ---------------------------------------------------------------- district names (MESSAGING.md: never a bare number)
  const DISTRICT_NAMES = {
    1: { name: "Richmond", short: "Richmond" },
    2: { name: "Marina & Pacific Heights", short: "Marina" },
    3: { name: "North Beach & Chinatown", short: "North Beach" },
    4: { name: "Sunset", short: "Sunset" },
    5: { name: "Tenderloin & Western Addition", short: "Tenderloin" },
    6: { name: "SoMa & Mission Bay", short: "SoMa" },
    7: { name: "West of Twin Peaks", short: "W. Twin Peaks" },
    8: { name: "Castro & Noe Valley", short: "Castro" },
    9: { name: "Mission & Bernal Heights", short: "Mission" },
    10: { name: "Bayview & Potrero Hill", short: "Bayview" },
    11: { name: "Excelsior & Ocean View", short: "Excelsior" },
  };
  const dName = (d) => DISTRICT_NAMES[Number(d)]?.name || "";
  const dLabel = (d) => (dName(d) ? `D${d} · ${dName(d)}` : `District ${d}`);            // D6 · SoMa & Mission Bay
  const dLong = (d) => (dName(d) ? `District ${d} (${dName(d)})` : `District ${d}`);      // District 6 (SoMa & Mission Bay)
  const dShort = (d) => (DISTRICT_NAMES[Number(d)] ? `D${d} ${DISTRICT_NAMES[Number(d)].short}` : `D${d}`); // D6 SoMa

  // ---------------------------------------------------------------- personas
  // One entry per persona. Adding a 3rd persona = one entry here + one button in index.html (the control grows by itself).
  const PERSONAS = {
    mayor: {
      label: "Mayor's Office",
      help: "You get blocks to prioritize this week and where new help would reach the most people.",
      value: "Know which blocks to prioritize this week, and where a mobile Pit Stop would reach the most people. The same budget closes more gaps.",
      todo: "Candidate for a mobile Pit Stop or extended hours nearby.",
      askWho: "the city",
    },
    charity: {
      label: "Outreach charity",
      help: "You get tonight's best van stops, in order, and which Pit Stops are closed.",
      value: "Plan tonight's van route in seconds, knowing which Pit Stops are closed. Reach more people per shift.",
      todo: "Good stop for tonight's van if it is on your route.",
      askWho: "our outreach team",
    },
  };
  const persona = () => PERSONAS[S.persona] || PERSONAS.mayor;

  // ---------------------------------------------------------------- state
  const S = {
    mock: false, persona: "mayor", at: "now", district: "",
    cells: [], cellById: new Map(), allCellById: new Map(), pitstops: [], psById: new Map(),
    selected: null, messages: [], busy: false, asOf: null,
  };
  S.persona = store.get("bs.persona") || "mayor";
  if (!PERSONAS[S.persona]) S.persona = "mayor";
  const params = new URLSearchParams(location.search);
  if (PERSONAS[params.get("persona")]) S.persona = params.get("persona");
  const deepQ = (params.get("q") || "").trim().slice(0, 500);

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

  // ---------------------------------------------------------------- pixel wordmark (the one big 8-bit accent)
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
        shadow += `<rect x="${X + 1}" y="${y + 1}" width="1" height="1" fill="${rampColor((X / cols) * 100)}"/>`;
        fill += `<rect x="${X}" y="${y}" width="1" height="1" fill="#1E1E1E"/>`;
      }));
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols + 1} 6" shape-rendering="crispEdges" role="img" aria-label="BlockSignal">${shadow}${fill}</svg>`;
  }
  // Pit Stop pin: square, white border, glyph (shape differs from color), label shown on hover/focus or zoom >= 15.
  const pinHTML = (p) => `<span class="pinbox" aria-hidden="true">${p.openNow ? "&#10003;" : "&#10005;"}</span><span class="pl"><b>${p.openNow ? "Open" : "Closed"}</b> · ${esc(p.name)}</span>`;

  // ---------------------------------------------------------------- map
  let map, cellLayer, psLayer, fxLayer;
  const cellPaths = new Map(), psMarkers = new Map();
  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true, preferCanvas: false, zoomSnap: 0.5 }).setView([37.773, -122.43], 13);
    // CARTO raster basemaps now need an API key, so use OSM tiles with a gentle warm CSS filter (.base-tiles).
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "base-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    cellLayer = L.layerGroup().addTo(map);
    psLayer = L.layerGroup().addTo(map);
    const syncZoom = () => map.getContainer().classList.toggle("zoom-labels", map.getZoom() >= 15);
    map.on("zoomend", syncZoom); syncZoom();
    fxLayer = L.layerGroup().addTo(map);
    window.addEventListener("resize", () => map.invalidateSize());
  }

  function drawCells() {
    cellLayer.clearLayers(); cellPaths.clear();
    const topIds = new Set(S.cells.slice(0, 10).map((c) => c.id));
    // draw low scores first so hot blocks sit on top
    [...S.cells].reverse().forEach((c) => {
      const top = topIds.has(c.id), g = c.gapScore || 0;
      const r = L.rectangle(c.bounds, {
        color: "#1E1E1E", weight: top ? 1.5 : 0.5, opacity: top ? 0.9 : 0.25,
        fillColor: rampColor(g), fillOpacity: 0.22 + 0.28 * (g / 100),
        className: "cell" + (top ? " top" : "") + (S.selected === c.id ? " sel" : ""),
      });
      r.bindTooltip(`<b>${esc(c.neighborhood || "Block")}</b>${c.district ? " · " + esc(dShort(c.district)) : ""}<br>Gap score ${g} · ${c.count7} reports in the last 7 days`, { className: "pxtip", direction: "top", sticky: true });
      r.on("click", () => openInspect(c.id));
      r.addTo(cellLayer); cellPaths.set(c.id, r);
    });
  }

  function drawPitstops() {
    psLayer.clearLayers(); psMarkers.clear();
    S.pitstops.forEach((p) => {
      if (p.lat == null || p.lon == null) return;
      const icon = L.divIcon({ className: "pin " + (p.openNow ? "pin-open" : "pin-closed"), html: pinHTML(p), iconSize: [22, 22], iconAnchor: [11, 11] });
      const m = L.marker([p.lat, p.lon], { icon, keyboard: true, title: `${p.name}: ${p.openNow ? "open" : "closed"}`, alt: `${p.name}, ${p.openNow ? "open" : "closed"}`, zIndexOffset: p.openNow ? 500 : 0 });
      m.bindTooltip(`<b>${esc(p.name)}</b><br>${p.openNow ? "Open" : "Closed"} · ${esc(p.hoursRaw || "hours unknown")}`, { className: "pxtip", direction: "top", offset: [0, -12] });
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
        // ensure the block exists on the map even if outside the district filter
        let p = cellPaths.get(c.id);
        if (!p) {
          p = L.rectangle(c.bounds, { color: "#1E1E1E", weight: 3, fillColor: rampColor(c.gapScore), fillOpacity: 0.55, className: "cell" }).addTo(fxLayer);
        }
        const el = p.getElement && p.getElement();
        if (el) { el.classList.add("hl"); setTimeout(() => el.classList.remove("hl"), 6000); }
        const ll = [c.lat, c.lon]; latlngs.push(ll);
        L.marker(ll, { icon: L.divIcon({ className: "wp", html: String(i + 1), iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 1000, interactive: false }).addTo(fxLayer);
      });
      if (route && cells.length > 1) {
        L.polyline(latlngs, { color: "#FFFFFF", weight: 9, opacity: 0.9, interactive: false }).addTo(fxLayer);
        L.polyline(latlngs, { color: "#B83A00", weight: 5, opacity: 1, className: "route", interactive: false }).addTo(fxLayer);
      }
    }
    pts.forEach((p) => {
      const m = psMarkers.get(p.id); latlngs.push([p.lat, p.lon]);
      const el = m && m.getElement();
      if (el) { el.classList.add("ps-hl"); setTimeout(() => el.classList.remove("ps-hl"), 6000); }
    });
    const anim = !reduceMotion();
    if (latlngs.length === 1) map.setView(latlngs[0], Math.max(map.getZoom(), 16), { animate: anim, duration: 0.9 });
    else map.fitBounds(L.latLngBounds(latlngs).pad(0.35), { animate: anim, duration: 0.9, maxZoom: 16 });
  }

  // ---------------------------------------------------------------- HUD
  function renderStatus(s) {
    $("#sReports").textContent = fmt(s.counts?.reports);
    $("#sPitstops").textContent = fmt(s.counts?.pitstops);
    $("#sCells").textContent = fmt(s.counts?.cells);
    const cm = $("#chipMistral");
    cm.textContent = s.mistral ? "Mistral: on" : "Mistral: off";
    cm.classList.toggle("off", !s.mistral);
    const e = s.elastic || {}, ok = e.enabled && e.connected;
    const ce = $("#chipElastic");
    ce.textContent = ok ? "Elastic: connected" : "Elastic: local";
    ce.classList.toggle("off", !ok);
    if (e.cluster) ce.title = "Cluster: " + e.cluster;
    const mc = $("#modeChip");
    mc.textContent = S.mock ? "Demo data" : "Live data";
    mc.className = "chip " + (S.mock ? "chip-mock" : "chip-live");
    mc.title = S.mock ? "Backend at /api is offline. Showing sample data." : `Data as of ${s.asOf || "now"}`;
    S.asOf = s.asOf || null;
    const when = fmtLA(s.asOf, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    $("#fresh").innerHTML = S.mock
      ? `<span class="live-dot demo-dot" aria-hidden="true"></span>Demo · sample data, server offline · last 30 days`
      : `<span class="live-dot" aria-hidden="true"></span>Live · 311 data as of <time datetime="${esc(s.asOf || "")}">${esc(when || "now")}</time> · last 30 days`;
  }

  function renderLeader() {
    const ol = $("#leader");
    const top = S.cells.slice(0, 10);
    if (!top.length) {
      ol.innerHTML = `<li class="empty">No blocks with 311 encampment reports in this district in the last 30 days. Pick another district, or “All of San Francisco”.</li>`;
      return;
    }
    ol.innerHTML = top.map((c, i) => {
      const t = trendOf(c);
      const label = `Rank ${i + 1}: ${c.neighborhood || "Block " + c.id}${c.district ? ", " + dLong(c.district) : ""}. Gap score ${c.gapScore}, ${c.count7} reports in the last 7 days, trend ${trendText(t)}. Show on map and see why.`;
      return `<li><button type="button" class="row" data-id="${esc(c.id)}" aria-pressed="${S.selected === c.id}" aria-label="${esc(label)}">
        <span class="rk${i < 3 ? " top3" : ""}" aria-hidden="true">${i + 1}</span>
        <span class="nm" aria-hidden="true">${esc(c.neighborhood || "Block " + c.id)}${c.district ? `<span class="dchip" title="${esc(dLabel(c.district))}">${esc(dShort(c.district))}</span>` : ""}</span>
        <span class="sc" aria-hidden="true">${c.gapScore}<span class="tr">${trendHtml(t)}</span></span>
        <span class="bar" aria-hidden="true"><i style="width:${c.gapScore}%;--full:${c.gapScore ? (10000 / c.gapScore) : 100}%"></i></span>
      </button></li>`;
    }).join("");
    $$("button[data-id]", ol).forEach((b) => b.addEventListener("click", () => {
      const c = S.cellById.get(b.dataset.id);
      map.fitBounds(c.bounds, { maxZoom: 16, animate: !reduceMotion(), duration: 0.8 });
      openInspect(c.id, { opener: b });
    }));
  }

  function setPersona(p) {
    if (!PERSONAS[p]) return;
    S.persona = p;
    store.set("bs.persona", p);
    $$(".player").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.persona === p)));
    $("#personaHelp").textContent = persona().help;
    $("#introValue").textContent = persona().value;
    if (S.selected && !$("#inspect").hidden) openInspect(S.selected, { refetch: false, focus: false });
  }

  function atISO(key) {
    if (key === "now") return null;
    const d = new Date(), h = Number(key);
    d.setMinutes(0, 0, 0); d.setHours(h);
    if (h < 6) d.setDate(d.getDate() + 1); // 2am means tonight, i.e. tomorrow morning
    return d.toISOString();
  }
  const whenLabel = () => (S.at === "now" ? "now" : "at " + $(`#timeSeg [data-at="${S.at}"]`).textContent);

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
    if (S.selected) openInspect(S.selected, { refetch: false, focus: false });
  }

  // ---------------------------------------------------------------- explain: intro banner + gap score popover
  function setIntro(show, { focus = false } = {}) {
    const intro = $("#intro");
    intro.hidden = !show;
    $(".grid").classList.toggle("no-intro", !show);
    $("#introOpen").setAttribute("aria-expanded", String(show));
    if (!show) store.set("bs.introHidden", "1");
    if (focus && show) { intro.setAttribute("tabindex", "-1"); intro.focus({ preventScroll: false }); }
    if (map) setTimeout(() => map.invalidateSize(), 0);
  }

  let popOpener = null;
  function closePop({ restore = true } = {}) {
    const pop = $("#gapPop"); if (pop.hidden) return;
    pop.hidden = true;
    if (popOpener) popOpener.setAttribute("aria-expanded", "false");
    if (restore && popOpener && document.contains(popOpener)) popOpener.focus();
    popOpener = null;
  }
  function openPop(btn) {
    const pop = $("#gapPop");
    if (!pop.hidden && popOpener === btn) { closePop(); return; }
    closePop({ restore: false });
    popOpener = btn; btn.setAttribute("aria-expanded", "true");
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = Math.min(Math.max(16, r.left - 12), vw - w - 16);
    let top = r.bottom + 8;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 8);
    pop.style.left = left + "px"; pop.style.top = top + "px";
    pop.setAttribute("tabindex", "-1"); pop.focus();
  }

  // "Why this score": the three parts of the Gap score, normalized to 0..1 so they can be compared.
  function whyScore(c) {
    const maxLog = Math.max(1e-9, ...[...S.allCellById.values()].map((x) => Math.log1p(x.count30 || 0)));
    const recent = (c.count7 || 0) / Math.max(1, c.count30 || 0);
    const near = nearestOpen(c);
    const dM = near ? near.d : null;
    const parts = [
      { key: "reports", v: Math.log1p(c.count30 || 0) / maxLog },
      { key: "recent", v: (1 + recent) / 2 },
      { key: "distance", v: Math.min((dM == null ? 2000 : dM) / 1000, 2) / 2 },
    ];
    const dom = parts.reduce((a, b) => (b.v > a.v ? b : a));
    return { parts, dom: dom.key, recent, near };
  }
  function whyHtml(c) {
    const w = whyScore(c), t = trendOf(c), pct = Math.round(w.recent * 100);
    const val = (k) => w.parts.find((p) => p.key === k).v;
    const when = whenLabel();
    const trendWords = t > 0 ? `<span class="up"><span aria-hidden="true">&#9650;</span> ${t} more</span> than the prior week`
      : t < 0 ? `<span class="down"><span aria-hidden="true">&#9660;</span> ${-t} fewer</span> than the prior week` : "same as the prior week";
    const nearTxt = w.near ? `${esc(w.near.p.name)}, ${fmtDist(w.near.d)} away` : `none open ${esc(when)}`;
    const lead = (c.gapScore || 0) >= 50 ? "Scores high mainly because" : "Its score comes mostly from the fact that";
    const verdict = {
      reports: `${lead} of report volume: ${c.count30} 311 encampment reports in the last 30 days.`,
      recent: `${lead} reports are recent: ${c.count7} of ${c.count30} came in the last week.`,
      distance: w.near ? `${lead} help is far: the nearest open Pit Stop is ${fmtDist(w.near.d)} away.` : `${lead} no Pit Stop is open ${when}, so help counts as far away.`,
    }[w.dom];
    const row = (k, name, txt) => `<li class="${w.dom === k ? "dom" : ""}"><span class="wl"><b>${name}</b></span>${txt}<span class="wbar" aria-hidden="true"><i style="width:${Math.round(val(k) * 100)}%"></i></span></li>`;
    return `<section class="why" aria-labelledby="whyTitle">
      <h4 class="sec-lbl" id="whyTitle" style="margin:0">Why this score</h4>
      <ul>
        ${row("reports", "Reports (30 days)", `<span class="num">${c.count30}</span> 311 encampment reports`)}
        ${row("recent", "Recent activity", `<span class="num">${c.count7}</span> in the last week (${pct}% of the month), ${trendWords}`)}
        ${row("distance", "Nearest open help", `${nearTxt} <span class="dim">(closed ones don't count)</span>`)}
      </ul>
      <p class="verdict">${verdict}</p>
      <p class="todo"><b>What to do (${esc(persona().label)}):</b> ${esc(persona().todo)}</p>
    </section>`;
  }

  // ---------------------------------------------------------------- inspect
  const OUT = [
    ["resolved", "#0F7A3D", "Resolved"], ["services_offered", "#1D4ED8", "Services offered"], ["declined", "#FFAF00", "Declined"],
    ["not_found", "#8C8577", "Not found"], ["medical", "#7C3AED", "Medical"], ["cancelled", "#4A4033", "Cancelled"],
    ["open", "#FA500F", "Still open"], ["other", "#E6DCC3", "Other"],
  ];
  function nearestOpen(c) {
    let best = null;
    S.pitstops.forEach((p) => { if (!p.openNow || p.lat == null) return; const d = distM(c.lat, c.lon, p.lat, p.lon); if (!best || d < best.d) best = { p, d }; });
    return best;
  }
  let inspectOpener = null;
  async function openInspect(id, { refetch = true, opener = null, focus = true } = {}) {
    const c = S.allCellById.get(id) || S.cellById.get(id);
    if (!c) return;
    $$(".cell.sel").forEach((el) => el.classList.remove("sel"));
    S.selected = id;
    const el = cellPaths.get(id)?.getElement(); if (el) el.classList.add("sel");
    $$("#leader button[data-id]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === id)));
    $("#mapHint").hidden = true;
    const box = $("#inspect");
    if (focus && (opener || box.hidden)) inspectOpener = opener || (document.activeElement !== document.body ? document.activeElement : null);
    const prevNotes = !refetch && $("#inspNotes") ? $("#inspNotes").innerHTML : "";
    box.hidden = false;
    const o = c.outcomes || {}, tot = OUT.reduce((a, [k]) => a + (o[k] || 0), 0) || 1;
    const near = nearestOpen(c);
    const when = whenLabel();
    const nearHtml = near
      ? `<div class="near"><span class="st ok">&#10003; Open</span> nearest help ${esc(when)}:<br><b>${esc(near.p.name)}</b> · ${fmtDist(near.d)} away</div>`
      : c.nearest ? `<div class="near closed"><span class="st no">&#10005; Closed</span> No Pit Stop is open ${esc(when)}.<br>Closest: ${esc(c.nearest.name)} · ${fmtDist(c.nearest.distanceM)}</div>`
      : `<div class="near closed">No Pit Stop data for this block.</div>`;
    const mixItems = OUT.filter(([k]) => o[k]);
    const mixLabel = "Crew outcomes, last 30 days: " + (mixItems.map(([k, , n]) => `${n} ${o[k]}`).join(", ") || "none");
    box.innerHTML = `
      <div class="ih">
        <div><h3 id="inspTitle">${esc(c.neighborhood || "Block")}</h3><div class="sub">Block ${esc(c.id)}${c.district ? " · " + esc(dLabel(c.district)) : ""}</div></div>
        <button class="btn btn-sm" type="button" id="inspClose" aria-label="Close block details">&#10005;</button>
      </div>
      <div class="ih gaprow">
        <span style="display:inline-flex;align-items:center;gap:8px"><span class="gapbig"><i style="--c:${rampColor(c.gapScore)}" aria-hidden="true"></i>Gap ${c.gapScore}</span>
        <button type="button" class="info-btn" data-pop="gapPop" aria-expanded="false" aria-controls="gapPop" aria-label="What is the gap score?"><span aria-hidden="true">i</span></button></span>
        <span class="trend">7-day trend ${trendHtml(trendOf(c))}</span>
      </div>
      <div class="nums">
        <div><b>${c.count7}</b><span>Last 7 days</span></div>
        <div><b>${c.countPrev7}</b><span>Prior 7 days</span></div>
        <div><b>${c.count30}</b><span>30 days</span></div>
      </div>
      ${whyHtml(c)}
      ${nearHtml}
      <div><div class="sec-lbl">Crew outcomes (30 days)</div>
        <div class="mix" role="img" aria-label="${esc(mixLabel)}">${mixItems.map(([k, col, n]) => `<i style="width:${(o[k] / tot) * 100}%;background:${col}" title="${n}: ${o[k]}"></i>`).join("")}</div>
        <div class="mixkey" aria-hidden="true">${mixItems.map(([k, col, n]) => `<span style="--c:${col}">${n} ${o[k]}</span>`).join("")}</div>
      </div>
      <ul class="notes" id="inspNotes" aria-label="Recent crew notes">${prevNotes}</ul>
      <button class="btn btn-primary" type="button" id="inspAsk">Ask Outreach Compass about this block</button>`;
    if (focus) $("#inspClose").focus({ preventScroll: true });
    $("#inspClose").onclick = closeInspect;
    $("#inspAsk").onclick = () => {
      sendChat(`What is happening at the ${c.neighborhood || ""} block ${c.id} and what should ${persona().askWho} do there?`, { selectedCell: c.id });
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
    const box = $("#inspect"), wasOpen = !box.hidden;
    if (popOpener && box.contains(popOpener)) closePop({ restore: false });
    box.hidden = true;
    $$(".cell.sel").forEach((el) => el.classList.remove("sel"));
    $$("#leader button[aria-pressed='true']").forEach((b) => b.setAttribute("aria-pressed", "false"));
    S.selected = null;
    if (wasOpen && inspectOpener && document.contains(inspectOpener)) inspectOpener.focus();
    inspectOpener = null;
  }

  // ---------------------------------------------------------------- markdown (tiny, safe)
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  }
  const isNum = (x) => /^[-+−]?[\d.,]+\s*(%|m|km|mi)?$/.test(x.trim());
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
        const rows = [];
        while (i < lines.length && isRow(lines[i])) { rows.push(cellsOf(lines[i])); i++; }
        // right-align a column when every non-empty value in it is numeric
        const numCol = head.map((_, k) => rows.length > 0 && rows.every((r) => !r[k] || isNum(r[k])));
        const body = rows.map((r) => "<tr>" + r.map((x, k) => `<td${numCol[k] ? ' class="n"' : ""}>${inline(x)}</td>`).join("") + "</tr>").join("");
        out += `<div class="tbl"><table><thead><tr>${head.map((h, k) => `<th scope="col"${numCol[k] ? ' class="n"' : ""}>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
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
    logLine("you", `<span class="who">You, as ${esc(persona().label)}</span>${esc(text)}`);
    S.messages.push({ role: "user", content: text });
    const body = { messages: S.messages.slice(-10), persona: S.persona };
    const sel = extra.selectedCell || S.selected; if (sel) body.selectedCell = sel;
    const route = S.persona === "charity";
    const steps = new Map();
    let stepsBox = null, stepsList = null;
    let thinking = logLine("thinking", `Outreach Compass is checking the data…<span class="cur" aria-hidden="true"></span>`);
    let answered = false;
    try {
      for await (const ev of api.chat(body)) {
        if (ev.type === "tool_call") {
          if (!stepsBox) {
            stepsBox = document.createElement("div"); stepsBox.className = "steps";
            stepsList = document.createElement("ol"); stepsBox.appendChild(stepsList);
            log.insertBefore(stepsBox, thinking || null);
          }
          const li = document.createElement("li");
          li.innerHTML = `<span class="sk">Checking:</span> ${esc(ev.name)}(${esc(argStr(ev.args))})`;
          stepsList.appendChild(li); steps.set(ev.id, li);
          log.scrollTop = log.scrollHeight;
        } else if (ev.type === "tool_result") {
          const li = steps.get(ev.id);
          if (li) {
            li.querySelector(".sk").textContent = "Checked:";
            li.insertAdjacentHTML("beforeend", `<span class="sres">${esc(ev.summary || "done")}</span>`);
          }
          applyHighlight(ev.highlight, { route });
        } else if (ev.type === "answer") {
          if (thinking) { thinking.remove(); thinking = null; }
          answered = true;
          logLine("ans md", md(ev.text));
          S.messages.push({ role: "assistant", content: ev.text });
        } else if (ev.type === "error") {
          logLine("err", "Error: " + esc(ev.message || "Analyst error"));
        } else if (ev.type === "done") break;
      }
      if (!answered) logLine("sys", "Outreach Compass returned no answer. Try rephrasing the question.");
    } catch (e) {
      logLine("err", `Outreach Compass could not be reached (${esc(e.message)}). Check that the server is running on :8787.`);
    } finally {
      if (thinking) thinking.remove();
      // Collapse the steps under a disclosure once the answer is in (left open if there was no answer).
      if (stepsBox && stepsList.children.length) {
        const det = document.createElement("details"); det.className = "steps"; det.open = !answered;
        const sum = document.createElement("summary");
        sum.textContent = `Show steps (${stepsList.children.length})`;
        det.append(sum, stepsList);
        stepsBox.replaceWith(det);
      }
      S.busy = false; $("#sendBtn").disabled = false; $$(".quest").forEach((b) => (b.disabled = false));
    }
  }

  // ---------------------------------------------------------------- briefing memo
  let modalOpener = null, memoDistrict = null;
  function closeModal() {
    const modal = $("#modal"); if (modal.hidden) return;
    modal.hidden = true;
    if (modalOpener && document.contains(modalOpener)) modalOpener.focus();
    modalOpener = null;
  }
  async function openBriefing() {
    const district = S.district || "6";
    memoDistrict = district;
    const modal = $("#modal"), bodyEl = $("#modalBody");
    modalOpener = document.activeElement;
    $("#modalTitle").textContent = `${dLong(district)} briefing`;
    $("#memoDate").textContent = `${fmtLA(null, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · Prepared for ${persona().label} by Outreach Compass`;
    $("#printBtn").disabled = true; $("#copyBtn").disabled = true;
    bodyEl.innerHTML = `<p class="loading">Compiling the briefing memo. This can take up to a minute…</p>`;
    modal.hidden = false; $("#modalClose").focus();
    try {
      const r = await api.briefing(district);
      if (memoDistrict !== district) return;
      bodyEl.innerHTML = md(r.markdown || "_No memo returned._");
      $("#printBtn").disabled = false; $("#copyBtn").disabled = false;
    } catch (e) { bodyEl.innerHTML = `<p class="err">Briefing failed: ${esc(e.message)}. Try again once the server is up.</p>`; }
  }
  async function copyMemo() {
    const text = [$("#modalTitle").textContent, $("#memoDate").textContent, "", $("#modalBody").innerText.trim(), "", $("#memoSrc").textContent].join("\n");
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
      ta.remove(); $("#copyBtn").focus();
    }
    const b = $("#copyBtn"), msg = ok ? "Memo copied to clipboard." : "Copy failed. Select the text and copy it manually.";
    $("#copyStatus").textContent = msg;
    b.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { b.textContent = "Copy text"; $("#copyStatus").textContent = ""; }, 2500);
  }

  // ---------------------------------------------------------------- export top gaps (CSV)
  function exportCSV() {
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["id", "neighborhood", "district", "district_name", "gapScore", "count30", "count7", "trend", "nearestOpenPitStop", "distanceM"];
    const rows = S.cells.slice(0, 25).map((c) => {
      const n = nearestOpen(c);
      return [c.id, c.neighborhood, c.district, dName(c.district), c.gapScore, c.count30, c.count7, trendOf(c), n ? n.p.name : "", n ? n.d : ""];
    });
    const csv = [head, ...rows].map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `blocksignal-top-gaps-${S.district ? "D" + S.district : "SF"}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    $$(".player").forEach((b) => b.addEventListener("click", () => setPersona(b.dataset.persona)));
    $$("#timeSeg button").forEach((b) => b.addEventListener("click", async () => {
      $$("#timeSeg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      S.at = b.dataset.at;
      try { await loadPitstops(); } catch (e) { console.error(e); }
    }));
    const sel = $("#district");
    for (let d = 1; d <= 11; d++) sel.insertAdjacentHTML("beforeend", `<option value="${d}">${esc(dLabel(d))}</option>`);
    sel.addEventListener("change", async () => {
      S.district = sel.value; closeInspect(); clearFx();
      try {
        await loadCells();
        if (S.cells.length) map.fitBounds(L.latLngBounds(S.cells.map((c) => [c.lat, c.lon])).pad(0.1), { animate: !reduceMotion(), duration: 0.8 });
      } catch (e) { console.error(e); }
    });
    $$(".quest").forEach((b) => b.addEventListener("click", () => { setPersona(b.dataset.persona); sendChat(b.dataset.q); }));
    $("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); const i = $("#chatInput"); const v = i.value; i.value = ""; sendChat(v); });
    $("#briefBtn").addEventListener("click", openBriefing);
    $("#modalClose").addEventListener("click", closeModal);
    $("#printBtn").addEventListener("click", () => window.print());
    $("#copyBtn").addEventListener("click", copyMemo);
    $("#exportBtn").addEventListener("click", exportCSV);
    $("#introOpen").addEventListener("click", () => setIntro($("#intro").hidden, { focus: true }));
    $("#introClose").addEventListener("click", () => { setIntro(false); $("#introOpen").focus(); });
    $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
    $("#modal").addEventListener("keydown", (e) => trapFocus($(".modal-box"), e));
    $("#inspect").addEventListener("keydown", (e) => trapFocus($("#inspect"), e));
    // (i) buttons are rendered in several places (some dynamically), so delegate.
    document.addEventListener("click", (e) => {
      const b = e.target.closest(".info-btn[data-pop]");
      if (b) { e.stopPropagation(); openPop(b); return; }
      const pop = $("#gapPop");
      if (!pop.hidden && !pop.contains(e.target)) closePop({ restore: false });
    });
    $("#gapPopClose").addEventListener("click", () => closePop());
    window.addEventListener("resize", () => closePop({ restore: false }));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("#gapPop").hidden) { closePop(); return; }
      if (!$("#modal").hidden) { closeModal(); return; }
      if (!$("#inspect").hidden) closeInspect();
    });
  }

  // ---------------------------------------------------------------- start (no boot screen: the app is usable immediately)
  async function boot() {
    $("#wordmark").innerHTML = wordmarkSVG();
    setPersona(S.persona);
    setIntro(store.get("bs.introHidden") !== "1");
    initMap(); wire();
    const statusEl = $("#mapStatus");
    const step = (txt) => { statusEl.textContent = txt; };

    step("Loading city data…");
    const status = await api.status();
    renderStatus(status);
    step(S.mock ? "Server offline. Loading demo data…" : "Loading map blocks…");
    try { await loadCells(); } catch (e) { console.error(e); logLine("err", "Could not load blocks: " + esc(e.message)); }
    step("Loading Pit Stops…");
    try { await loadPitstops(); } catch (e) { console.error(e); logLine("err", "Could not load Pit Stops: " + esc(e.message)); }
    if (S.cells.length) map.fitBounds(L.latLngBounds(S.cells.slice(0, 40).map((c) => [c.lat, c.lon])).pad(0.2));
    if (S.mock) logLine("sys", "Demo mode: the server is not responding, so the map and Outreach Compass use sample data.");
    statusEl.hidden = true;
    map.invalidateSize();
    // Deep link: ?q=... pre-fills the question and sends it once the data is loaded.
    if (deepQ) {
      const f = $("#chatForm"); $("#chatInput").value = deepQ;
      if (f.requestSubmit) f.requestSubmit(); else { $("#chatInput").value = ""; sendChat(deepQ); }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
