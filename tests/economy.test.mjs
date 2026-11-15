// The economy rules on their own (game/world3d/economy.js), with a controllable clock.
//   node --test tests/economy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, newEcon, MONSTER_LOOT, SEA_TREASURE } from '../game/world3d/economy.js';
import { CROPS, BUILDS, ALTAR } from '../game/world3d/farm.js';
import { unpack } from '../game/world3d/blocks.js';
import { SHOPS } from '../game/world3d/shops.js';

const T0 = 1_800_000_000_000;
const MIN = 60000;
function player(gold = 0, bag = {}) {
  const s = { econ: { ...newEcon(), gold, bag: { ...bag } }, owned: [], farm: null };
  const ctx = { now: T0, isGear: (id) => id === 'iron_sword' || id === 'inferno_staff', owner: 'Hero' };
  const run = (a, dt = 0) => { ctx.now += dt; return applyAction(s, a, ctx); };
  return { s, ctx, run };
}

test('crops ripen on the clock, and the altar doubles the speed while it lasts', () => {
  const { s, run } = player(1000, { carrot_seed: 2, pumpkin: 1 });
  assert.equal(run({ t: 'claim', plot: 2 }), '');
  assert.equal(run({ t: 'plant', k: 'carrot', i: 1, j: 1 }), '');
  assert.equal(run({ t: 'harvest', i: 1, j: 1 }, (CROPS.carrot.grow - 1) * MIN), 'not ripe');
  assert.equal(run({ t: 'harvest', i: 1, j: 1 }, MIN), '');
  assert.equal(s.econ.bag.carrot, CROPS.carrot.yield);

  assert.equal(run({ t: 'offer' }), 'no altar');
  assert.equal(run({ t: 'build', k: 'altar', i: 4, j: 4 }), '');
  assert.equal(run({ t: 'offer' }), '');
  assert.equal(run({ t: 'offer' }), 'already boosted');
  assert.equal(run({ t: 'plant', k: 'carrot', i: 0, j: 0 }), '');
  assert.equal(run({ t: 'harvest', i: 0, j: 0 }, (CROPS.carrot.grow / ALTAR.speed) * MIN), '');
});

test('buildings: inside the soil, not on top of things, up to the max, refunded when picked up', () => {
  const { s, run } = player(BUILDS.scarecrow.cost * 6, { carrot_seed: 1 });
  run({ t: 'claim', plot: 3 });
  assert.equal(run({ t: 'build', k: 'clubhouse', i: 6, j: 6 }), 'outside your soil'); // 3 x 3 on 8 x 8
  run({ t: 'plant', k: 'carrot', i: 0, j: 0 });
  assert.equal(run({ t: 'build', k: 'scarecrow', i: 0, j: 0 }), 'something is in the way');
  for (let i = 1; i <= 4; i++) assert.equal(run({ t: 'build', k: 'scarecrow', i, j: 0 }), '');
  assert.equal(run({ t: 'build', k: 'scarecrow', i: 5, j: 0 }), 'at the max');
  assert.equal(run({ t: 'unbuild', i: 1, j: 0 }), '');
  assert.equal(s.econ.gold, BUILDS.scarecrow.cost * 3);
  assert.equal(run({ t: 'build', k: 'altar', i: 0, j: 4 }), 'not enough gold');
});

test('blocks come out of the bag onto the plot, and back when broken', () => {
  const { s, run } = player(0, { block_stone: 2, block_door: 1 });
  run({ t: 'claim', plot: 2 });
  assert.equal(run({ t: 'place', b: 'stone', i: 0, j: 0, k: 0 }), '');
  assert.equal(run({ t: 'place', b: 'stone', i: 0, j: 0, k: 0 }), 'something is already there');
  assert.equal(run({ t: 'place', b: 'stone', i: 0, j: 0, k: 1 }), '');
  assert.equal(run({ t: 'place', b: 'stone', i: 1, j: 0, k: 0 }), 'no blocks');
  assert.equal(run({ t: 'place', b: 'door', i: 9, j: 0, k: 0 }), 'outside your soil');
  assert.equal(run({ t: 'place', b: 'door', i: 2, j: 0, k: 0, r: 1 }), '');
  assert.equal(unpack(s.farm.blocks, 8, 8).count(), 3);
  assert.equal(run({ t: 'break', i: 2, j: 0, k: 1 }), ''); // the top half of the door takes the whole door
  assert.equal(run({ t: 'break', i: 5, j: 5, k: 0 }), 'no block there');
  assert.deepEqual(s.econ.bag, { block_door: 1 });
});

test('rate limits refill over time', () => {
  const { run } = player();
  for (let i = 0; i < 8; i++) assert.equal(run({ t: 'kill', m: 'bat' }), '');
  assert.equal(run({ t: 'kill', m: 'bat' }), 'too fast');
  assert.equal(run({ t: 'kill', m: 'bat' }, 2500), '');
  assert.equal(run({ t: 'barrel' }), '');
});

test('clubhouse members', () => {
  const { s, run } = player();
  assert.equal(run({ t: 'invite', who: 'pal' }), 'no plot');
  run({ t: 'claim', plot: 2 });
  run({ t: 'invite', who: 'pal' }); run({ t: 'invite', who: 'pal' }); run({ t: 'invite', who: 'bud' });
  run({ t: 'kick', who: 'pal' });
  assert.deepEqual(s.farm.members, ['bud']);
});

test('the tables agree with the rest of the game', () => {
  for (const m of Object.values(MONSTER_LOOT)) assert.ok(m.gold[0] <= m.gold[1]);
  for (const g of Object.values(SEA_TREASURE)) assert.ok(g > 0);
  for (const shop of Object.values(SHOPS)) for (const [, price] of shop.stock) assert.ok(Number.isInteger(price) && price > 0);
});
