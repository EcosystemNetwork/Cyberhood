// Old Fenn's liquidity pools: the rules (game/world3d/pools.js), then the API end to end against
// the dev server's mock database.
//   node --test tests/pools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../game/world3d/pools.js';
import { RESOURCES } from '../game/lib/chain.js';
import { grant } from './helpers/grant.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const econ = (gold, bag = {}) => ({ gold, bag: { ...bag }, lp: {} });
const k = (p) => BigInt(p.gold) * BigInt(p.res);

/* ---------- rules ---------- */

test('every pool is an on-chain resource', () => {
  for (const id of L.POOL_IDS) assert.ok(RESOURCES[id], `${id} has a pool but no token in game/lib/chain.js`);
});

test('the first deposit sets the price and locks MIN_SHARES to Old Fenn', () => {
  const e = econ(1000, { carrot: 500 }), p = L.newPool(), out = {};
  assert.equal(L.poolAction(e, p, { t: 'add', id: 'carrot', gold: 900, res: 300 }, out), '');
  assert.deepEqual([p.gold, p.res, p.shares], [900, 300, 519]); // floor(sqrt(900 * 300))
  assert.equal(e.lp.carrot, 519 - L.MIN_SHARES);
  assert.deepEqual([e.gold, e.bag.carrot], [100, 200]);
  assert.equal(L.priceOf(p), 3);
  assert.equal(out.shares, 519 - L.MIN_SHARES);
});

test('a first deposit too small to lock MIN_SHARES is refused', () => {
  const e = econ(100, { carrot: 100 }), p = L.newPool();
  assert.equal(L.poolAction(e, p, { t: 'add', id: 'carrot', gold: 10, res: 10 }, {}), 'too small');
  assert.deepEqual(p, L.newPool());
  assert.equal(e.gold, 100);
});

test('swaps follow x * y = k with a fee that stays in the pool', () => {
  const p = { gold: 3000, res: 1000, shares: 1732 };
  const e = econ(500, {});
  const before = k(p);
  assert.equal(L.quote(p, 'buy', 300), 90); // 300*0.997*1000 / (3000 + 300*0.997) = 90.66
  assert.equal(L.poolAction(e, p, { t: 'swap', id: 'carrot', side: 'buy', n: 300, min: 90 }), '');
  assert.deepEqual([e.gold, e.bag.carrot, p.gold, p.res], [200, 90, 3300, 910]);
  assert.ok(k(p) > before, 'the pool only grows');
  const mid = k(p);
  assert.equal(L.poolAction(e, p, { t: 'swap', id: 'carrot', side: 'sell', n: 90 }), '');
  assert.ok(e.gold < 500, 'a round trip costs the fee');
  assert.ok(k(p) > mid);
});

test('a swap that would pay less than `min` is refused (the price moved)', () => {
  const p = { gold: 3000, res: 1000, shares: 1732 }, e = econ(500);
  assert.equal(L.poolAction(e, p, { t: 'swap', id: 'carrot', side: 'buy', n: 300, min: 91 }), 'price moved');
  assert.deepEqual(p, { gold: 3000, res: 1000, shares: 1732 });
  assert.equal(e.gold, 500);
});

test('swaps need what they spend, an open pool, and a sane amount', () => {
  const p = { gold: 3000, res: 1000, shares: 1732 };
  assert.equal(L.poolAction(econ(10), p, { t: 'swap', id: 'carrot', side: 'buy', n: 300 }), 'not enough gold');
  assert.equal(L.poolAction(econ(0, { carrot: 1 }), p, { t: 'swap', id: 'carrot', side: 'sell', n: 2 }), 'not enough');
  assert.equal(L.poolAction(econ(500), L.newPool(), { t: 'swap', id: 'carrot', side: 'buy', n: 3 }), 'pool empty');
  for (const n of [0, -5, 1.5, 2e9, '10']) assert.equal(L.poolAction(econ(5e9), p, { t: 'swap', id: 'carrot', side: 'buy', n }), 'bad amount');
  assert.equal(L.poolAction(econ(500), p, { t: 'swap', id: 'carrot', side: 'buy', n: 1 }), 'too small');
  assert.equal(L.poolAction(econ(500), p, { t: 'swap', id: 'iron_sword', side: 'buy', n: 10 }), 'no such pool');
  assert.equal(L.poolAction(econ(500, { carrot: 99990 }), p, { t: 'swap', id: 'carrot', side: 'buy', n: 300 }), 'bag full');
});

test('later deposits match the ratio, and withdrawals pay back a share with fees', () => {
  const p = { gold: 3000, res: 1000, shares: 1732 };
  const e = econ(1000, { carrot: 1000 });
  assert.equal(L.poolAction(e, p, { t: 'add', id: 'carrot', gold: 300, res: 99 }), 'price moved'); // needs 100
  assert.equal(L.poolAction(e, p, { t: 'add', id: 'carrot', gold: 300, res: 150 }), '');
  assert.deepEqual([e.gold, e.bag.carrot, e.lp.carrot], [700, 900, 173]);
  assert.deepEqual([p.gold, p.res, p.shares], [3300, 1100, 1905]);
  // someone trades through the pool: fees accrue
  const t = econ(10000, { carrot: 10000 });
  for (let i = 0; i < 20; i++) { L.poolAction(t, p, { t: 'swap', id: 'carrot', side: 'buy', n: 500 }); L.poolAction(t, p, { t: 'swap', id: 'carrot', side: 'sell', n: 150 }); }
  const v = L.valueOfShares(p, 173);
  assert.equal(L.poolAction(e, p, { t: 'remove', id: 'carrot', shares: 174 }), 'not enough shares');
  assert.equal(L.poolAction(e, p, { t: 'remove', id: 'carrot', shares: 173 }), '');
  assert.equal(e.lp.carrot, undefined);
  assert.deepEqual([e.gold, e.bag.carrot], [700 + v.gold, 900 + v.res]);
});

test('nothing is ever made: gold and resources only move between players and pools', () => {
  const p = L.newPool(), players = [econ(100000, { wheat: 20000 }), econ(50000, { wheat: 5000 }), econ(80000, { wheat: 9000 })];
  const total = () => [players.reduce((s, e) => s + e.gold, 0) + p.gold, players.reduce((s, e) => s + (e.bag.wheat || 0), 0) + p.res];
  const start = total();
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  L.poolAction(players[0], p, { t: 'add', id: 'wheat', gold: 40000, res: 10000 });
  for (let i = 0; i < 2000; i++) {
    const e = players[Math.floor(r() * 3)], n = 1 + Math.floor(r() * 3000), pick = r();
    if (pick < 0.35) L.poolAction(e, p, { t: 'swap', id: 'wheat', side: 'buy', n });
    else if (pick < 0.7) L.poolAction(e, p, { t: 'swap', id: 'wheat', side: 'sell', n: Math.ceil(n / 4) });
    else if (pick < 0.85) L.poolAction(e, p, { t: 'add', id: 'wheat', gold: n, res: n });
    else if (e.lp.wheat) L.poolAction(e, p, { t: 'remove', id: 'wheat', shares: Math.max(1, Math.floor(e.lp.wheat * r())) });
    assert.deepEqual(total(), start);
    assert.ok(p.gold > 0 && p.res > 0 && p.shares >= L.MIN_SHARES);
    assert.equal(players.reduce((s, e) => s + (e.lp.wheat || 0), 0) + L.MIN_SHARES, p.shares);
  }
});

/* ---------- the API ---------- */

const PORT = 20000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-pools-'));
let server;
test.before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'game-dev-server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.json'), SUPABASE_URL: BASE, SUPABASE_SERVICE_KEY: 'local-mock-key', GAME_DEV: '0' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/game/'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('dev server did not start');
});
test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

async function api(action, key, body) {
  const get = ['state', 'pools'].includes(action);
  const res = await fetch(`${BASE}/api/game/${action}`, {
    method: get ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: get ? undefined : JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json() };
}
// a fresh account with a little gold and 99 slime gel
async function account() {
  const username = 'p' + Math.random().toString(36).slice(2, 10);
  const r = await api('signup', null, { username, password: 'hunter2hunter2' });
  assert.equal(r.status, 200);
  const key = r.data.key;
  await grant(BASE, username, { gold: 2000, bag: { slime_gel: 99 } });
  return { key, econ: (await api('state', key)).data.econ };
}

test('API: pools are listed publicly, all empty at first', async () => {
  const r = await api('pools');
  assert.equal(r.status, 200);
  assert.equal(r.data.pools.length, L.POOL_IDS.length);
  assert.deepEqual(r.data.pools.find((p) => p.id === 'slime_gel'), { id: 'slime_gel', gold: 0, res: 0, shares: 0 });
  assert.equal(r.data.fee, L.FEE_BPS);
});

test('API: provide, swap and withdraw through Old Fenn, saved for both sides', async () => {
  const a = await account(), b = await account();
  const g0 = a.econ.gold;
  let r = await api('pool', a.key, { op: 'add', id: 'slime_gel', gold: 270, res: 90 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.pool, { id: 'slime_gel', gold: 270, res: 90, shares: 155 });
  assert.equal(r.data.state.econ.lp.slime_gel, 155 - L.MIN_SHARES);
  assert.equal(r.data.state.econ.gold, g0 - 270);
  assert.equal(r.data.state.econ.bag.slime_gel, 9);

  r = await api('pool', b.key, { op: 'swap', id: 'slime_gel', side: 'buy', n: 30, min: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const got = r.data.done.res;
  assert.ok(got >= 8 && got <= 10, `bought ${got}`);
  assert.equal(r.data.state.econ.bag.slime_gel, 99 + got);
  assert.equal((await api('state', b.key)).data.econ.gold, b.econ.gold - 30);

  const list = (await api('pools')).data.pools.find((p) => p.id === 'slime_gel');
  assert.deepEqual(list, { id: 'slime_gel', gold: 300, res: 90 - got, shares: 155 });

  r = await api('pool', a.key, { op: 'remove', id: 'slime_gel', shares: 55 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state.econ.lp.slime_gel, undefined);
  assert.ok(r.data.done.gold > 270 * 55 / 155, 'the provider earned from the swap');
});

test('API: refusals leave the account and the pool alone', async () => {
  const a = await account();
  let r = await api('pool', a.key, { op: 'swap', id: 'bat_fang', side: 'buy', n: 10 });
  assert.deepEqual([r.status, r.data.error], [409, 'pool empty']);
  r = await api('pool', a.key, { op: 'add', id: 'slime_gel', gold: 100000, res: 5 });
  assert.equal(r.status, 409);
  r = await api('pool', a.key, { op: 'swap', id: 'slime_gel', side: 'sell', n: 5, min: 1e6 });
  assert.deepEqual([r.status, r.data.error], [409, 'price moved']);
  r = await api('pool', a.key, { op: 'steal', id: 'slime_gel' });
  assert.equal(r.status, 400);
  r = await api('pool', null, { op: 'swap', id: 'slime_gel', side: 'buy', n: 10 });
  assert.equal(r.status, 401);
  const st = (await api('state', a.key)).data.econ;
  assert.deepEqual([st.gold, st.bag.slime_gel, st.lp], [a.econ.gold, 99, {}]);
});

test('API: many swaps at once all land, and nothing is lost', async () => {
  const before = (await api('pools')).data.pools.find((p) => p.id === 'slime_gel');
  const traders = await Promise.all([1, 2, 3, 4, 5].map(account));
  const rs = await Promise.all(traders.map((t) => api('pool', t.key, { op: 'swap', id: 'slime_gel', side: 'sell', n: 3 })));
  for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = (await api('pools')).data.pools.find((p) => p.id === 'slime_gel');
  assert.equal(after.res, before.res + 15);
  assert.equal(before.gold - after.gold, rs.reduce((s, r) => s + r.data.done.gold, 0));
});
