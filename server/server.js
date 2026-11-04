// BlockSignal HTTP server: static /public + JSON API + NDJSON agent stream. Zero deps.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as data from './lib/data.js';
import { MODELS, hasKey } from './lib/mistral.js';
import { runAgent, briefing, setElastic } from './lib/agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';

// ---------- optional elastic layer ----------
let es = null;
try {
  if (process.env.ES_URL) {
    es = await import('./lib/elastic.js');
    setElastic(es);
  }
} catch (e) {
  console.warn('[elastic] module unavailable, using in-memory fallback:', e.message);
  es = null;
}
const esEnabled = () => Boolean(es?.enabled);
let esStatus = { enabled: false, connected: false };
let esPingAt = 0;
async function elasticStatus() {
  if (!esEnabled()) return { enabled: false, connected: false };
  if (Date.now() - esPingAt < 30000) return esStatus;
  esPingAt = Date.now();
  try {
    const p = await Promise.race([es.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 5000))]);
    esStatus = { enabled: true, connected: Boolean(p?.connected), ...(p?.cluster ? { cluster: p.cluster } : {}), ...(p?.error ? { error: p.error } : {}) };
  } catch (e) { esStatus = { enabled: true, connected: false, error: e.message }; }
  return esStatus;
}

// ---------- boot ----------
const ready = data.load().catch(e => { console.error('[data] load failed:', e.message); throw e; });
ready.then(async () => {
  try { await data.enrich(); } catch (e) { console.warn('[enrich] failed:', e.message); }
  if (esEnabled()) {
    es.ingest(data.state.reports, data.state.pitstops)
      .then(r => console.log(`[elastic] ingested ${r?.reports} reports, ${r?.pitstops} pit stops`))
      .catch(e => console.warn('[elastic] ingest failed:', e.message));
  }
}).catch(() => {});

// ---------- helpers ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.geojson': 'application/geo+json', '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req, max = 1e6) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw new Error('body too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    let f = file;
    const st = await fs.stat(f).catch(() => null);
    if (st?.isDirectory()) f = path.join(f, 'index.html');
    const buf = await fs.readFile(f);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch {
    // SPA-ish fallback for extensionless paths
    if (!path.extname(rel)) {
      try {
        const buf = await fs.readFile(path.join(PUBLIC, 'index.html'));
        res.writeHead(200, { 'Content-Type': TYPES['.html'] });
        return res.end(buf);
      } catch { }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  }
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/health') return sendJson(res, 200, { ok: true });

  await ready;

  if (req.method === 'GET' && p === '/api/status') {
    const cells = data.buildCells();
    return sendJson(res, 200, {
      mistral: hasKey(),
      elastic: await elasticStatus(),
      counts: { reports: data.state.reports.length, pitstops: data.state.pitstops.length, cells: cells.length },
      asOf: data.state.asOf,
      models: { agent: MODELS.agent, parser: MODELS.parser },
      enrichment: data.state.enrichment,
    });
  }
  if (req.method === 'GET' && p === '/api/cells') {
    const cells = data.getCells({ district: url.searchParams.get('district') || undefined, at: url.searchParams.get('at') || undefined });
    return sendJson(res, 200, { cells });
  }
  if (req.method === 'GET' && p === '/api/pitstops') {
    return sendJson(res, 200, { pitstops: data.pitstopsAt(url.searchParams.get('at') || undefined) });
  }
  if (req.method === 'GET' && p.startsWith('/api/cell/')) {
    const out = data.getCell(decodeURIComponent(p.slice('/api/cell/'.length)), url.searchParams.get('at') || undefined);
    return out ? sendJson(res, 200, out) : sendJson(res, 404, { error: 'cell not found' });
  }
  if (req.method === 'POST' && p === '/api/chat') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = ev => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };
    try {
      await runAgent({ messages: body.messages || [], persona: body.persona === 'mayor' ? 'mayor' : 'charity', selectedCell: body.selectedCell }, emit);
    } catch (e) {
      console.warn('[chat] error:', e.message);
      emit({ type: 'error', message: e.message });
    }
    emit({ type: 'done' });
    return res.end();
  }
  if (req.method === 'POST' && p === '/api/briefing') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, await briefing({ district: body.district || '6' }));
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (req.method === 'GET' && p === '/api/blockgap') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 500);
    if (!q) return sendJson(res, 400, { error: 'missing q' });
    try { return sendJson(res, 200, await runBlockgap(q)); }
    catch (e) { return sendJson(res, e.code === 'NO_MODULE' ? 503 : 500, { error: e.message }); }
  }
  return sendJson(res, 404, { error: 'not found' });
}

// ---------- P3 Shop Opener: bridge to Guru's Python blockgap.py ----------
const PY_DIR = path.join(ROOT, 'server', 'py');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
async function runBlockgap(q) {
  const mod = path.join(PY_DIR, 'blockgap.py');
  if (!(await fs.stat(mod).catch(() => null))) {
    throw Object.assign(new Error('Shop Opener engine not installed yet (server/py/blockgap.py missing)'), { code: 'NO_MODULE' });
  }
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    // q is passed as an argv element (no shell), so it can't inject commands.
    execFile(PYTHON, [path.join(PY_DIR, 'blockgap_cli.py'), q], {
      cwd: PY_DIR, timeout: 90000, maxBuffer: 20 * 1024 * 1024, env: process.env,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().trim().split('\n').slice(-3).join(' ')));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('blockgap returned invalid JSON')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`BlockSignal listening on http://${HOST}:${PORT} (mistral: ${hasKey() ? 'on' : 'off'}, elastic: ${esEnabled() ? 'on' : 'off'})`);
});
