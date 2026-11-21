// Local dev server — runs the game fully offline.
//
//   node game-dev-server.js      then open http://localhost:8137/game/
//
// It serves the static site, runs the real api/game/[action].js handler, and
// fakes the database with a tiny local mock of the Supabase REST API backed by
// game-local-db.json. No Supabase, no keys, no network — accounts you make here
// live only in that local file (delete it to wipe them).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8137;

// Optionally load .env.local, but default everything to the local mock so it just works.
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
// Point the handler at THIS server's mock DB, with a throwaway key.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || `http://127.0.0.1:${PORT}`;
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'local-mock-key';
// Local testing: every account owns every item (the live site never sets this).
if (process.env.GAME_DEV === undefined) process.env.GAME_DEV = '1';

const gameApi = require('./api/game/[action].js'); // reads the env vars above at require time

/* ---------- mock DB (a local JSON file standing in for Supabase/PostgREST) ---------- */
const DB_FILE = process.env.DB_PATH || path.join(ROOT, 'game-local-db.json');
let rows = [];
let nextId = 1;
let pools = {}; // game_pools (supabase/migrations/20261120_liquidity_pools.sql), by id
try {
  if (fs.existsSync(DB_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    rows = saved.rows || [];
    nextId = saved.nextId || rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
    pools = saved.pools || {};
  }
} catch (e) { /* start empty */ }
const saveDb = () => { try { fs.writeFileSync(DB_FILE, JSON.stringify({ rows, nextId, pools }, null, 2)); } catch (e) {} };
// Robinhood Chain tables and functions (wallets, withdrawals, deposits): api/mock-chain-db.js
const chainMock = require('./api/mock-chain-db.js').makeChainMock(DB_FILE.replace(/\.json$/, '') + '-chain.json', () => rows, saveDb);

// The handler only uses eq., gt. and not.is.null filters, which is all we implement.
const parseFilters = (params) => {
  const out = [];
  for (const [k, v] of params) {
    if (k === 'select') continue;
    const m = /^(eq|gt|not\.is)\.([\s\S]*)$/.exec(v);
    if (m) out.push([k, m[1], m[2]]);
  }
  return out;
};
// Columns added by later migrations default like they do in Postgres, for accounts made before them.
const COLUMN_DEFAULTS = { econ: {}, econ_rev: 0, farm: null, farm_plot: null };
for (const r of rows) for (const [k, v] of Object.entries(COLUMN_DEFAULTS)) if (!(k in r)) r[k] = v;
const matchRow = (row, filters) => filters.every(([f, op, val]) =>
  op === 'eq' ? String(row[f]) === val : op === 'gt' ? String(row[f] ?? '') > val : row[f] !== null && row[f] !== undefined);
// Postgres's unique (farm_plot): one owner per plot.
const plotClash = (row, body) => body.farm_plot != null && rows.some((r) => r !== row && r.farm_plot === body.farm_plot);

function handleMockDb(method, params, raw, respond) {
  const filters = parseFilters(params);
  if (method === 'GET') return respond(200, rows.filter((r) => matchRow(r, filters)));

  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (e) {}

  if (method === 'POST') {
    if (rows.some((r) => r.username === body.username)) return respond(409, { error: 'duplicate key' });
    const row = { id: nextId++, failed_attempts: 0, locked_until: null, character: null, inventory: null, session_hash: null, session_expires: null, ...structuredClone(COLUMN_DEFAULTS), ...body };
    rows.push(row); saveDb();
    return respond(201, [row]);
  }
  if (method === 'PATCH') {
    const updated = [];
    const hit = rows.filter((r) => matchRow(r, filters));
    if (hit.some((r) => plotClash(r, body))) {
      return respond(409, { code: '23505', message: 'duplicate key value violates unique constraint "game_players_farm_plot_key"' });
    }
    for (const r of hit) { Object.assign(r, body); updated.push(r); }
    saveDb();
    return respond(200, updated);
  }
  respond(405, { error: 'method not allowed' });
}

const rateWindows = new Map(); // game_hit() key -> { hits, start }

/* ---------- static files ---------- */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const collectBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => resolve(raw));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const respond = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  // Mock of the game_hit() rate-limit function (supabase/migrations/20261114_auth_rate_limits.sql).
  // Off by default, so local play and the test suites can make as many accounts as they like;
  // MOCK_RATE_LIMITS=1 turns the real counting on.
  if (url.pathname === '/rest/v1/rpc/game_hit') {
    let a = {};
    try { a = JSON.parse((await collectBody(req)) || '{}'); } catch (e) {}
    if (process.env.MOCK_RATE_LIMITS !== '1') return respond(200, true);
    const now = Date.now(), cost = Math.max(0, a.cost ?? 1), w = rateWindows.get(a.k);
    if (!w || now - w.start > a.window_s * 1000) rateWindows.set(a.k, { hits: cost, start: now });
    else w.hits += cost;
    const hits = rateWindows.get(a.k).hits;
    return respond(200, cost > 0 ? hits <= a.max_hits : hits < a.max_hits);
  }

  // Mock of game_trade() (supabase/migrations/20261115_trading.sql): both rows or neither.
  if (url.pathname === '/rest/v1/rpc/game_trade') {
    let a = {};
    try { a = JSON.parse((await collectBody(req)) || '{}'); } catch (e) {}
    const ra = rows.find((r) => r.id === a.a_id), rb = rows.find((r) => r.id === a.b_id);
    if (!ra || !rb || ra === rb || (ra.econ_rev || 0) !== a.a_rev || (rb.econ_rev || 0) !== a.b_rev) return respond(200, false);
    Object.assign(ra, { econ: a.a_econ, econ_rev: a.a_rev + 1 });
    Object.assign(rb, { econ: a.b_econ, econ_rev: a.b_rev + 1 });
    saveDb();
    return respond(200, true);
  }

  // Old Fenn's liquidity pools: the game_pools table (GET only) and game_pool(), which saves the
  // pool and the player together, each compare-and-swap on its rev, or neither.
  if (url.pathname === '/rest/v1/game_pools') {
    const id = /^eq\.(.*)$/.exec(url.searchParams.get('id') || '');
    const list = Object.values(pools).filter((p) => !id || p.id === id[1]);
    return respond(200, list);
  }
  if (url.pathname === '/rest/v1/rpc/game_pool') {
    let a = {};
    try { a = JSON.parse((await collectBody(req)) || '{}'); } catch (e) {}
    const pool = pools[a.pool_id] || { id: a.pool_id, gold: 0, res: 0, shares: 0, rev: 0 };
    const p = rows.find((r) => r.id === a.p_id);
    if (!p || pool.rev !== a.pool_rev || (p.econ_rev || 0) !== a.p_rev) return respond(200, false);
    Object.assign(p, { econ: a.p_econ, econ_rev: a.p_rev + 1 });
    pools[a.pool_id] = { id: a.pool_id, gold: a.pool.gold, res: a.pool.res, shares: a.pool.shares, rev: a.pool_rev + 1 };
    saveDb();
    return respond(200, true);
  }

  if (/^\/rest\/v1\/(rpc\/)?game_(wallets|withdrawals|deposits|chain_state|withdraw|credit|refund)$/.test(url.pathname)) {
    const raw = await collectBody(req);
    if (chainMock(url.pathname, req.method, url.searchParams, raw, req.headers.prefer, respond)) return;
  }

  // Mock Supabase REST endpoint the handler talks to.
  if (url.pathname === '/rest/v1/game_players') {
    const raw = await collectBody(req);
    return handleMockDb(req.method, url.searchParams, raw, respond);
  }

  // The real serverless function, via a Vercel-like (req, res) shim.
  const apiMatch = /^\/api\/game\/([a-z]+)$/.exec(url.pathname);
  if (apiMatch) {
    const raw = await collectBody(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (e) {}
    const shimReq = { method: req.method, headers: req.headers, query: { action: apiMatch[1] }, body };
    const shimRes = {
      _code: 200,
      status(code) { this._code = code; return this; },
      json(obj) { res.writeHead(this._code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); },
    };
    return Promise.resolve(gameApi(shimReq, shimRes)).catch((e) => {
      console.error(e);
      if (!res.headersSent) respond(500, { error: 'Something went wrong' });
    });
  }

  serveStatic(req, res);
});

/* ---------- WebSocket presence for multiplayer ---------- */
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ server, path: '/ws/city' });
const clients = new Map(); // playerId -> { id, name, x, y, facing, frame, ws }

function broadcast() {
  const list = [...clients.values()].map(({ ws, ...rest }) => rest);
  const msg = JSON.stringify({ type: 'state', players: list });
  for (const c of clients.values()) { try { c.ws.send(msg); } catch (e) {} }
}

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    if (msg.type === 'join') {
      playerId = msg.id;
      console.log('WS join:', msg.name, '(' + msg.id + ')');
      clients.set(playerId, { id: playerId, name: msg.name, char: msg.char || null, x: 0, y: 0, facing: 'down', frame: 0, ws });
      broadcast();
    } else if (msg.type === 'move' && playerId && clients.has(playerId)) {
      const c = clients.get(playerId);
      c.x = msg.x; c.y = msg.y; c.facing = msg.facing; c.frame = msg.frame;
      broadcast();
    }
  });

  ws.on('close', () => {
    if (playerId && clients.has(playerId)) {
      console.log('WS leave:', playerId);
      clients.delete(playerId);
      const msg = JSON.stringify({ type: 'leave', id: playerId });
      for (const c of clients.values()) { try { c.ws.send(msg); } catch (e) {} }
    }
  });
});

server.listen(PORT, () => console.log(`dev server (static + /api + mock db + ws) on http://localhost:${PORT}/game/  [${rows.length} local account(s)]`));
