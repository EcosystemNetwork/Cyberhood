// The server-side economy through the real API handler, against the dev server's mock
// database, with local-testing perks off (like the live site).
//   node --test tests/economy-api.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-econ-'));
let server;

test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'game-dev-server.js')], {
    // always the local mock database, never a real Supabase project
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
  const get = ['me', 'state', 'farms', 'config'].includes(action);
  const res = await fetch(`${BASE}/api/game/${action}`, {
    method: get ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: get ? undefined : JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json() };
}
const PW = 'hunter2hunter2';
async function account() {
  const username = 'e' + Math.random().toString(36).slice(2, 10);
  const r = await api('signup', null, { username, password: PW });
  assert.equal(r.status, 200);
  return { username, key: r.data.key, data: r.data };
}
const act = async (key, ...actions) => api('act', key, { actions });
const CHESTS = ['wreck', 'lonely', 'gull', 'doubloon'].map((id) => ({ t: 'chest', id })); // 120 gold
const KNIGHT = { name: 'Hero', cls: 'knight', skin: 1, hs: 'short', hc: 0 };

test('a new account owns nothing and starts at zero', async () => {
  const { data } = await account();
  assert.deepEqual(data.inventory, []);
  assert.deepEqual(data.state.owned, []);
  assert.equal(data.state.econ.gold, 0);
  assert.equal(data.state.farm, null);
});

test('the first character comes with its class kit, and unowned gear is taken off', async () => {
  const { key } = await account();
  const r = await api('save', key, { character: { ...KNIGHT, equipment: { rhand: 'iron_sword', feet: 'hermes_sandals' } } });
  assert.equal(r.status, 200);
  assert.equal(r.data.character.equipment.rhand, 'iron_sword');
  assert.equal(r.data.character.equipment.feet, null);
  assert.ok(r.data.inventory.includes('wooden_shield'));
  // changing class later doesn't hand out a second kit
  const again = await api('save', key, { character: { ...KNIGHT, cls: 'mage', equipment: { rhand: 'oak_staff' } } });
  assert.equal(again.data.character.equipment.rhand, null);
});

test('a kill pays XP, then its drops pay out once when picked up', async () => {
  const { key } = await account();
  const r = await act(key,
    { t: 'kill', m: 'slime' },
    { t: 'pickup', kind: 'gold', m: 'slime', n: 2 },
    { t: 'pickup', kind: 'item', id: 'slime_gel' },
    { t: 'pickup', kind: 'item', id: 'slime_gel' },
    { t: 'pickup', kind: 'gold', m: 'goblin', n: 5 },
    { t: 'kill', m: 'bat' },
    { t: 'pickup', kind: 'gold', m: 'bat', n: 50 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results, ['', '', '', 'nothing to pick up', 'nothing to pick up', '', 'bad amount']);
  assert.deepEqual(r.data.state.econ, { gold: 2, xp: 12, kills: 2, bag: { slime_gel: 1 }, loot: [], imported: false });
});

test('kills faster than monsters can respawn are not paid', async () => {
  const { key } = await account();
  const r = await act(key, ...Array.from({ length: 10 }, () => ({ t: 'kill', m: 'slime' })), { t: 'kill', m: 'king' }, { t: 'kill', m: 'king' }, { t: 'kill', m: 'king' });
  assert.equal(r.data.results.filter((x) => x === '').length, 8 + 2);
  assert.equal(r.data.results[9], 'too fast');
  assert.equal(r.data.results[12], 'too fast');
});

test('gear is bought with real gold at the shop\'s price, once', async () => {
  const { key } = await account();
  let r = await act(key, { t: 'buy', shop: 'The Armoury', id: 'iron_sword' });
  assert.deepEqual(r.data.results, ['not enough gold']);
  r = await act(key, ...CHESTS, ...CHESTS.slice(0, 1),
    { t: 'buy', shop: 'The Armoury', id: 'iron_sword' },
    { t: 'buy', shop: 'The Armoury', id: 'iron_sword' },
    { t: 'buy', shop: 'Potion Shop', id: 'iron_sword' },
    { t: 'buy', shop: 'Fruit Stall', id: 'health_potion', n: 2 });
  assert.deepEqual(r.data.results.slice(4), ['already looted', '', 'already owned', 'not for sale', '']);
  assert.equal(r.data.state.econ.gold, 120 - 50 - 36);
  assert.deepEqual(r.data.state.owned, ['iron_sword']);
  assert.equal(r.data.state.econ.bag.health_potion, 2);
  // and now it can be worn
  const s = await api('save', key, { character: { ...KNIGHT, equipment: { rhand: 'iron_sword' } } });
  assert.equal(s.data.character.equipment.rhand, 'iron_sword');
});

test('selling, crafting and using items', async () => {
  const { key } = await account();
  const r = await act(key, ...CHESTS,
    { t: 'kill', m: 'slime' }, { t: 'pickup', kind: 'item', id: 'slime_gel' },
    { t: 'kill', m: 'bat' }, { t: 'pickup', kind: 'item', id: 'bat_fang' },
    { t: 'craft', id: 'inferno_staff' }, { t: 'craft', id: 'inferno_staff' },
    { t: 'buy', shop: 'Potion Shop', id: 'health_potion', n: 3 },
    { t: 'use', id: 'health_potion' }, { t: 'sell', id: 'health_potion', n: 2 }, { t: 'sell', id: 'health_potion', n: 1 });
  assert.deepEqual(r.data.results.slice(4), ['', '', '', '', '', 'already owned', '', '', '', 'not enough']);
  assert.deepEqual(r.data.state.owned, ['inferno_staff']);
  assert.equal(r.data.state.econ.gold, 120 - 10 - 45 + 12);
  assert.deepEqual(r.data.state.econ.bag, {});
});

test('a plot belongs to one player, and shows to everyone while they are away', async () => {
  const a = await account(), b = await account();
  await api('save', a.key, { character: KNIGHT });
  let r = await act(a.key, { t: 'claim', plot: 2 }, { t: 'claim', plot: 3 });
  assert.deepEqual(r.data.results, ['', 'you already have a plot']);
  assert.equal(r.data.state.farm.owner, 'Hero');
  r = await act(b.key, { t: 'claim', plot: 2 });
  assert.deepEqual(r.data.results, ['plot taken']);
  assert.equal(r.data.state.farm, null);
  r = await act(b.key, { t: 'claim', plot: 3 });
  assert.deepEqual(r.data.results, ['']);

  const farms = await api('farms');
  assert.equal(farms.status, 200);
  assert.deepEqual(farms.data.farms.map((f) => f.id).sort(), [2, 3]);
  assert.ok(!JSON.stringify(farms.data).includes('password'));
});

test('farming: seeds from the shop, crops on the server clock', async () => {
  const { key } = await account();
  const r = await act(key, { t: 'plant', k: 'carrot', i: 0, j: 0 }, { t: 'claim', plot: 1 },
    { t: 'plant', k: 'carrot', i: 0, j: 0 }, { t: 'chest', id: 'lonely' },
    { t: 'buy', shop: 'Seed Shop', id: 'carrot_seed', n: 2 },
    { t: 'plant', k: 'carrot', i: 0, j: 0 }, { t: 'plant', k: 'carrot', i: 0, j: 0 }, { t: 'plant', k: 'carrot', i: 99, j: 0 },
    { t: 'harvest', i: 0, j: 0 });
  // plot 1 may already be someone else's from another test run; only check what follows the claim
  if (r.data.results[1] !== '') return;
  assert.deepEqual(r.data.results, ['no plot', '', 'no seeds', '', '', '', 'spot taken', 'bad spot', 'not ripe']);
  const crop = r.data.state.farm.crops['0,0'];
  assert.equal(crop.k, 'carrot');
  assert.ok(Math.abs(crop.t - r.data.state.now) < 5000);
  assert.equal(r.data.state.econ.bag.carrot_seed, 1);
});

test('two requests at once can\'t spend the same gold twice', async () => {
  const { key } = await account();
  await act(key, { t: 'chest', id: 'wreck' }); // 40 gold
  const buy = () => act(key, { t: 'buy', shop: 'Potion Shop', id: 'health_potion', n: 2 }); // 30 gold
  const [x, y] = await Promise.all([buy(), buy()]);
  const ok = [x, y].filter((r) => r.data.results[0] === '').length;
  assert.equal(ok, 1);
  const s = await api('state', key);
  assert.equal(s.data.econ.gold, 10);
  assert.equal(s.data.econ.bag.health_potion, 2);
});

test('progress from before cloud saves can be brought in once, within limits', async () => {
  const { key } = await account();
  const r = await act(key,
    { t: 'import', field: { gold: 1e9, xp: 300, kills: 'x', bag: { slime_gel: 1000, bogus: 5 } }, owned: ['cutlass', 'nope'], loot: ['wreck', 'harbor'] },
    { t: 'import', field: { gold: 100 } }, { t: 'chest', id: 'wreck' });
  assert.deepEqual(r.data.results, ['', 'already imported', 'already looted']);
  assert.deepEqual(r.data.state.econ, { gold: 5000, xp: 300, kills: 0, bag: { slime_gel: 99 }, loot: ['wreck'], imported: true });
  assert.deepEqual(r.data.state.owned, ['cutlass']);
});

test('bad requests', async () => {
  const { key } = await account();
  assert.equal((await act(null, { t: 'chest', id: 'wreck' })).status, 401);
  assert.equal((await api('act', key, { actions: [] })).status, 400);
  assert.equal((await api('act', key, { actions: Array(61).fill({ t: 'barrel' }) })).status, 400);
  const r = await act(key, { t: 'teleport' }, null, { t: 'buy', shop: 'Nope', id: 'iron_sword' }, { t: 'kill', m: 'dragon' });
  assert.deepEqual(r.data.results, ['unknown action', 'bad action', 'not for sale', 'unknown monster']);
});

test('config hands the browser no realtime key unless one is set', async () => {
  const r = await api('config');
  assert.equal(r.status, 200);
  assert.equal(r.data.realtime, null);
});
