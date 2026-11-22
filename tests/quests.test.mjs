// Quests (game/world3d/quests.js), on their own and through the economy rules the server runs.
//   node --test tests/quests.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTS, MAX_ACTIVE, DAY_MS, newQuests, normQuests, canTake, available, questEvent, questAction, isDone } from '../game/world3d/quests.js';
import { applyAction, newEcon, normEcon, publicEcon, freeGold, BAG_ITEMS, MONSTER_LOOT, BARREL_GOLD, barrelSpot } from '../game/world3d/economy.js';
import { CROPS } from '../game/world3d/farm.js';
import { RECIPES } from '../game/world3d/shops.js';

const T0 = 1_800_000_000_000; // a whole number of days is irrelevant: tests move by DAY_MS
const MIN = 60000;
function player(gold = 0, bag = {}) {
  const s = { econ: { ...newEcon(), gold, bag: { ...bag } }, owned: [], farm: null };
  const ctx = { now: T0, dev: true, isGear: () => false, owner: 'Hero', rand: () => 0.5 };
  const run = (a, dt = 0) => { ctx.now += dt; return applyAction(s, a, ctx); };
  return { s, ctx, run };
}
// kill `n` monsters of a type through the server's own kill path (dev 'kill'), spaced past the rate limits
const kill = (run, m, n) => { for (let i = 0; i < n; i++) assert.equal(run({ t: 'kill', m }, 60000), '', `kill ${m}`); };

test('every quest is well formed: real monsters, recipes, crops, bag items, prerequisites', () => {
  const evs = new Set(['kill', 'craft', 'plant', 'harvest', 'sold', 'barrel', 'recruit']);
  for (const [id, q] of Object.entries(QUESTS)) {
    assert.ok(evs.has(q.goal.ev), id);
    assert.ok(Number.isSafeInteger(q.goal.n) && q.goal.n > 0, id);
    const keys = q.goal.key === '*' ? [] : [].concat(q.goal.key);
    for (const k of keys) {
      if (q.goal.ev === 'kill') assert.ok(MONSTER_LOOT[k], `${id}: ${k}`);
      if (q.goal.ev === 'craft') assert.ok(RECIPES.some((r) => r.id === k), `${id}: ${k}`);
      if (q.goal.ev === 'plant' || q.goal.ev === 'harvest') assert.ok(CROPS[k], `${id}: ${k}`);
    }
    for (const item of Object.keys(q.reward.items || {})) assert.ok(BAG_ITEMS.has(item), `${id} pays ${item}`);
    if (q.after) assert.ok(QUESTS[q.after] && !QUESTS[q.after].daily, `${id} after ${q.after}`);
  }
});

test('the starter road opens one step at a time', () => {
  const q = newQuests();
  assert.ok(available(q, T0).includes('first_steps'));
  assert.equal(canTake(q, 'mushroom_watch', T0), 'not yet');
  assert.equal(canTake(q, 'd_slimes', T0), 'not yet');
  q.done.first_steps = true;
  assert.equal(canTake(q, 'mushroom_watch', T0), '');
  assert.equal(canTake(q, 'd_slimes', T0), '');
});

test('kills only count for quests you have taken, and stop at the goal', () => {
  const { s, run } = player();
  kill(run, 'slime', 2);
  assert.equal(run({ t: 'q_take', id: 'first_steps' }), '');
  assert.equal(s.econ.qlog.on.first_steps, 0, 'kills before taking it do not count');
  kill(run, 'shroom', 2);
  assert.equal(s.econ.qlog.on.first_steps, 0, 'the wrong monster does not count');
  kill(run, 'slime', 5);
  assert.equal(s.econ.qlog.on.first_steps, 3);
});

test('hand in: gold, XP and items once; the starter gold is bound', () => {
  const { s, run } = player(10);
  run({ t: 'q_take', id: 'first_steps' });
  assert.equal(run({ t: 'q_claim', id: 'first_steps' }), 'not finished');
  kill(run, 'slime', 3);
  const xp = s.econ.xp;
  assert.equal(run({ t: 'q_claim', id: 'first_steps' }), '');
  assert.equal(s.econ.gold, 10 + QUESTS.first_steps.reward.gold);
  assert.equal(s.econ.xp, xp + QUESTS.first_steps.reward.xp);
  assert.equal(s.econ.bag.health_potion, 1);
  assert.equal(freeGold(s.econ), 10, 'quest gold can be spent, not traded or withdrawn');
  assert.equal(run({ t: 'q_claim', id: 'first_steps' }), 'not taken');
  assert.equal(run({ t: 'q_take', id: 'first_steps' }), 'already done');
});

test('a daily pays free gold, once per UTC day', () => {
  const { s, run, ctx } = player();
  s.econ.qlog.done.first_steps = true;
  assert.equal(run({ t: 'q_take', id: 'd_slimes' }), '');
  kill(run, 'slime', 15);
  const free = freeGold(s.econ);
  assert.equal(run({ t: 'q_claim', id: 'd_slimes' }), '');
  assert.equal(freeGold(s.econ), free + QUESTS.d_slimes.reward.gold);
  assert.equal(run({ t: 'q_take', id: 'd_slimes' }), 'done today');
  ctx.now = (Math.floor(ctx.now / DAY_MS) + 1) * DAY_MS; // past midnight UTC
  assert.equal(isDone(s.econ.qlog, 'd_slimes', ctx.now), false);
  assert.equal(run({ t: 'q_take', id: 'd_slimes' }), '');
});

test('crafting, planting, harvesting, selling and sailing all count', () => {
  const { s, run } = player(500, { slime_gel: 2, spore_cap: 1, carrot_seed: 3, goblin_ear: 20 });
  Object.assign(s.econ.qlog.done, { first_steps: true, green_thumb: true });
  for (const id of ['first_brew', 'first_harvest', 'd_trader', 'sea_legs']) assert.equal(run({ t: 'q_take', id }), '', id);
  assert.equal(run({ t: 'craft', id: 'health_potion' }), '');
  assert.equal(s.econ.qlog.on.first_brew, 1);

  run({ t: 'claim', plot: 2 });
  for (let i = 0; i < 3; i++) assert.equal(run({ t: 'plant', k: 'carrot', i, j: 0 }), '');
  for (let i = 0; i < 3; i++) assert.equal(run({ t: 'harvest', i, j: 0 }, i === 0 ? CROPS.carrot.grow * MIN : 0), '');
  assert.equal(s.econ.qlog.on.first_harvest, 3);

  assert.equal(run({ t: 'sell', id: 'goblin_ear', n: 13 }), ''); // 104 gold
  assert.equal(s.econ.qlog.on.d_trader, 100, 'gold-sold goals cap at the goal');

  for (let slot = 0; slot < 5; slot++) {
    const [x, z] = barrelSpot(slot, 0);
    s.econ.sea.last = [x, z, 0]; // sailing between them is the economy tests' job
    assert.equal(run({ t: 'barrel', slot, at: 1 }, 10000), '', `barrel ${slot}`);
  }
  assert.equal(s.econ.qlog.on.sea_legs, 5);
  assert.equal(BARREL_GOLD > 0, true);
});

test('hiring a companion counts once the Guild says yes', () => {
  const { s, run } = player(10000);
  s.econ.qlog.done.first_steps = true;
  run({ t: 'q_take', id: 'hired_help' });
  assert.equal(run({ t: 'g_recruit' }), '');
  assert.equal(s.econ.qlog.on.hired_help, 1);
});

test('the Hollow quest takes either giant', () => {
  const q = { on: { into_the_hollow: 0 }, done: {} };
  assert.deepEqual(questEvent(q, 'kill', 'spider_queen'), ['into_the_hollow']);
  const r = { on: { into_the_hollow: 0 }, done: {} };
  assert.deepEqual(questEvent(r, 'kill', 'golem_crystal'), ['into_the_hollow']);
});

test('the quest log holds six at most, and dropping one frees a slot', () => {
  const q = newQuests(), e = { gold: 0, xp: 0, bag: {} }, add = (b, k, n) => { b[k] = (b[k] || 0) + n; };
  Object.assign(q.done, { first_steps: true, mushroom_watch: true, goblin_trouble: true, green_thumb: true, first_harvest: true, sea_legs: true });
  const open = available(q, T0);
  assert.ok(open.length > MAX_ACTIVE);
  for (const id of open.slice(0, MAX_ACTIVE)) assert.equal(questAction(q, e, { t: 'q_take', id }, { now: T0 }, add), '');
  assert.equal(questAction(q, e, { t: 'q_take', id: open[MAX_ACTIVE] }, { now: T0 }, add), 'quest log full');
  assert.equal(questAction(q, e, { t: 'q_drop', id: open[0] }, { now: T0 }, add), '');
  assert.equal(questAction(q, e, { t: 'q_take', id: open[MAX_ACTIVE] }, { now: T0 }, add), '');
});

test('saved quest logs are cleaned: unknown quests and bad numbers go, progress caps at the goal', () => {
  const q = normQuests({ on: { first_steps: 99, nope: 1, mushroom_watch: -1, goblin_trouble: 'x' }, done: { sea_legs: true, nope: true, d_slimes: 3.5 } });
  assert.deepEqual(q, { on: { first_steps: 3 }, done: { sea_legs: true } });
  assert.deepEqual(normEcon({ gold: 1 }).qlog, newQuests(), 'older saves get an empty log');
  assert.ok(publicEcon(normEcon({})).qlog, 'the browser sees its quest log');
});

test('unknown quests and actions are refused', () => {
  const { run } = player();
  assert.equal(run({ t: 'q_take', id: 'free_money' }), 'no such quest');
  assert.equal(run({ t: 'q_claim' }), 'no such quest');
  assert.equal(run({ t: 'q_steal', id: 'first_steps' }), 'unknown action');
});
