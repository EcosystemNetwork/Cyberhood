// The realm server paying out kills (POST realm), through the real API handler against the dev
// server's mock database. Covers the ticket's sealed account and stats, the shared secret,
// paying once per kill id, the kill-rate limits, and accounts that aren't ours.
//   node --test tests/realm-payout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 20000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'realm-test-secret-0123456789';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-realm-'));
let server;

test.before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'game-dev-server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.json'), SUPABASE_URL: BASE,
      SUPABASE_SERVICE_KEY: 'local-mock-key', GAME_DEV: '0', REALM_SECRET: SECRET },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/game/'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('dev server did not start');
});
test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function api(action, { key, body, headers = {}, method } = {}) {
  const get = method === 'GET' || ['me', 'state'].includes(action);
  const res = await fetch(`${BASE}/api/game/${action}`, {
    method: get ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}), ...headers },
    body: get ? undefined : JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json() };
}
const realm = (body, secret = SECRET) => api('realm', { body, headers: { 'x-realm-key': secret } });
const readTicket = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString());
const pk = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

async function player() {
  const username = 'r' + Math.random().toString(36).slice(2, 10);
  const r = await api('signup', { body: { username, password: 'hunter2hunter2' } });
  assert.equal(r.status, 200);
  const t = await api('mpticket', { key: r.data.key, body: { pk: pk(), name: 'Ana' } });
  return { key: r.data.key, ticket: readTicket(t.data.ticket) };
}
const xp = async (p) => (await api('state', { key: p.key })).data.econ.xp;
const kid = () => 'boot.world.' + Math.random().toString(36).slice(2, 10);

test('a signed-in ticket carries a sealed account and attack stats; a guest\'s carries neither', async () => {
  const a = await player(), b = await player();
  assert.equal(typeof a.ticket.u, 'string');
  assert.ok(a.ticket.u !== b.ticket.u);
  assert.ok(!/^\d+$/.test(a.ticket.u) && a.ticket.u.length > 30, 'the account id is not readable');
  assert.deepEqual(a.ticket.st, { atk: 10, mag: 2 });
  const guest = await api('mpticket', { body: { pk: pk(), name: 'Gus' } });
  const g = readTicket(guest.data.ticket);
  assert.equal(g.u, undefined);
  assert.equal(g.st, undefined);
});

test('only the realm can pay out kills', async () => {
  const a = await player();
  const body = { kills: [{ k: kid(), m: 'slime', u: [a.ticket.u] }] };
  assert.equal((await realm(body, 'wrong')).status, 401);
  assert.equal((await api('realm', { body })).status, 401);
  // and a browser can't send the realm's action through act
  const r = await api('act', { key: a.key, body: { actions: [{ t: 'rkill', id: kid(), m: 'slime' }] } });
  assert.deepEqual(r.data.results, ['realm only']);
  assert.equal(await xp(a), 0);
});

test('a group kill pays everyone credited, once, however often the realm retries', async () => {
  const a = await player(), b = await player();
  const k = kid(), body = { kills: [{ k, m: 'goblin', u: [a.ticket.u, b.ticket.u] }] };
  const r = await realm(body);
  assert.equal(r.status, 200);
  assert.equal(r.data.paid.length, 2);
  assert.ok(r.data.paid.every((p) => p.r === '' && p.xp === 15 && p.k === k));
  const again = await realm(body);
  assert.ok(again.data.paid.every((p) => p.r === 'already paid' && p.xp === 0));
  assert.equal(await xp(a), 15);
  assert.equal(await xp(b), 15);
  const st = (await api('state', { key: a.key })).data.econ;
  assert.equal(st.kills, 1);
});

test('the kill-rate limits hold even for the realm', async () => {
  const a = await player();
  const kills = Array.from({ length: 6 }, () => ({ k: kid(), m: 'king', u: [a.ticket.u] }));
  const r = await realm({ kills });
  const why = r.data.paid.map((p) => p.r);
  assert.deepEqual(why.filter((x) => x === '').length, 2, 'King Slime pays twice in a burst, then waits');
  assert.ok(why.slice(2).every((x) => x === 'too fast'));
});

test('accounts that aren\'t sealed by this API are ignored, and bad batches refused', async () => {
  const a = await player();
  const forged = Buffer.from('1234567890').toString('base64url');
  const r = await realm({ kills: [{ k: kid(), m: 'slime', u: [forged, a.ticket.u.slice(0, -2) + 'AA'] }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.paid, []);
  assert.equal((await realm({ kills: 'nope' })).status, 400);
  assert.equal((await realm({ kills: [{ k: 1, m: 'slime', u: [] }] })).status, 400);
  assert.equal((await realm({ kills: Array.from({ length: 201 }, () => ({ k: kid(), m: 'slime', u: [] })) })).status, 400);
});
