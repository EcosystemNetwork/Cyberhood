// Old Fenn's liquidity pools (pools.js / poolview.js) in the 3D world: walk up to him by the
// fountain, F opens the pools; open a pool, swap through it, withdraw. Uses a real account on the
// dev server (pools live on the server), funded by a one-time import.
//   node game-dev-server.js; node tests/world3d/pools.cdp.mjs
import assert from 'node:assert/strict';
import { launch, sleep, near, BASE } from './harness.mjs';
import { RESOURCES } from '../../game/lib/chain.js';

const api = async (action, key, body) => {
  const r = await fetch(`${BASE}/api/game/${action}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

const { player, kill } = await launch();
try {
  const username = 'fenn' + Math.random().toString(36).slice(2, 8);
  const { key } = await api('signup', null, { username, password: 'hunter2hunter2' });
  assert.ok(key, 'signed up');
  // a cheap resource whose pool nobody has opened yet on this server (so the test can run again)
  const empty = new Set((await api('pools')).pools.filter((p) => !p.shares).map((p) => p.id));
  const R = ['moonleaf', 'copper_ore', 'minnow', 'carrot', 'slime_gel', 'spore_cap', 'wheat'].find((id) => empty.has(id));
  assert.ok(R, 'a cheap pool is still empty (wipe the dev server\'s DB)');
  const NAME = RESOURCES[R].name;
  await api('act', key, { actions: [{ t: 'import', field: { gold: 3000, bag: { [R]: 99 } } }] });

  const A = await player('Fenny');
  await A.ev(`localStorage.setItem('taproot_session', ${JSON.stringify(key)}); localStorage.setItem('taproot_owner', ${JSON.stringify(username)}); localStorage.removeItem('taproot_field'); 1`);
  await A.go(`${BASE}/game/world3d/?area=city&hour=13&nomp=1`);
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d && __world3d.pools()) { clearInterval(t); r(1); } }, 200); })`);
  await A.ev('Ledger.load()');
  await sleep(1200);
  assert.equal(await A.ev(`__world3d.field().bag['${R}']`), 99);

  // walk up to Old Fenn: F opens his pools
  const f = await A.ev('__world3d.fenn');
  await A.ev(`__world3d.tp(${f.x}, ${f.z + 1.6}, 0); 1`);
  for (let i = 0; i < 20 && !/Old Fenn/.test(await near(A)); i++) await sleep(250);
  assert.match(await near(A), /Old Fenn's liquidity pools/);
  await A.key('KeyF', 'f');
  await sleep(800);
  assert.equal(await A.ev(`document.getElementById('shopTitle').textContent`), "Old Fenn's Pools");

  const click = (sel) => A.ev(`(() => { const b = document.querySelector('#shopList ${sel}, #shopTabs ${sel}'); if (!b || b.disabled) return false; b.click(); return true; })()`);
  const type = (n, v) => A.ev(`(() => { const i = document.querySelector('#shopList input[data-pool-amt="${n}"]'); i.value = ${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  const waitIdle = () => A.ev(`new Promise((r) => { const t = setInterval(() => { const b = document.querySelector('#shopList [data-act="p_go"]'); if (!b || b.textContent !== '…') { clearInterval(t); r(1); } }, 100); })`);

  // open the pool: 240 gold + 80 of the resource, 3g each
  assert.ok(await click('[data-tab="p_add"]'));
  assert.ok(await click(`[data-act="p_pick"][data-id="${R}"]`));
  await type(1, 240); await type(2, 80);
  assert.match(await A.ev(`document.querySelector('.pool-form').textContent`), /Price: 3\.00g each/);
  assert.ok(await click('[data-act="p_go"]'), 'open-the-pool button works');
  await sleep(300); await waitIdle(); await sleep(300);
  const lp = await A.ev(`__world3d.field().lp['${R}']`);
  assert.equal(lp, Math.floor(Math.sqrt(240 * 80)) - 100);
  assert.equal(await A.ev(`__world3d.field().bag['${R}']`), 19);
  await A.shot('pools-provide.png');

  // swap: buy some with 30 gold
  assert.ok(await click('[data-tab="p_swap"]'));
  assert.ok(await click(`[data-act="p_pick"][data-id="${R}"]`));
  await type(1, 30);
  assert.match(await A.ev(`document.querySelector('.pool-form').textContent`), new RegExp(`You get about 8 ${NAME}`));
  const gold0 = await A.ev('__world3d.field().gold');
  assert.ok(await click('[data-act="p_go"]'), 'buy button works');
  await sleep(300); await waitIdle(); await sleep(300);
  assert.equal(await A.ev('__world3d.field().gold'), gold0 - 30);
  assert.equal(await A.ev(`__world3d.field().bag['${R}']`), 27);
  await A.shot('pools-swap.png');

  // the shares tab: withdraw everything, worth more than went in (the swap's fee)
  assert.ok(await click('[data-tab="p_shares"]'));
  assert.ok(await click(`[data-act="p_pick"][data-id="${R}"]`));
  assert.ok(await click('[data-act="p_max"]'));
  assert.ok(await click('[data-act="p_go"]'), 'withdraw button works');
  await sleep(300); await waitIdle(); await sleep(300);
  assert.equal(await A.ev(`__world3d.field().lp['${R}']`), undefined);
  const pool = (await api('pools')).pools.find((p) => p.id === R);
  assert.equal(pool.shares, 100, 'only the locked shares are left');

  // typing F in an amount box doesn't close the panel
  assert.ok(await click('[data-tab="p_swap"]'));
  assert.ok(await click(`[data-act="p_pick"][data-id="${R}"]`));
  await A.ev(`document.querySelector('#shopList input[data-pool-amt]').focus(); 1`);
  await A.key('KeyF', 'f');
  assert.equal(await A.ev(`document.getElementById('shopPanel').hidden`), false);
  console.log('pools.cdp: ok');
} finally { kill(); }
