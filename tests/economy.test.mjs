// The economy rules on their own (game/world3d/economy.js), with a controllable clock.
//   node --test tests/economy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, newEcon, MONSTER_LOOT, SEA_TREASURE, CASTERS } from '../game/world3d/economy.js';
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

// Kill one monster fairly: spawn it, then swing (ATK 10, at most 14 a hit) every 400 ms of game
// time, with the server clock keeping up.
function slay(run, s, m) {
  const id = 'm' + Math.random().toString(36).slice(2, 10);
  run({ t: 'spawn', id, m });
  let why = '';
  for (let n = 0; n < 50 && s.econ.foes[id]; n++) {
    why = run({ t: 'hit', id, k: 'swing', hand: 'R', a: 'a' + n + id, at: (s.t = (s.t || T0) + 400), dmg: 14 }, 400);
  }
  return why;
}

test('kills faster than monsters respawn are not paid, and the limit refills', () => {
  const { s, run } = player();
  for (let i = 0; i < 8; i++) assert.equal(slay(run, s, 'bat'), '');
  s.econ.rl.kill = [0, s.t]; // the bucket is empty now (fighting refilled it a little)
  assert.equal(slay(run, s, 'bat'), 'too fast');
  assert.equal(s.econ.kills, 8);
  run({ t: 'barrel' }, 30000);
  assert.equal(slay(run, s, 'bat'), '');
  assert.equal(s.econ.kills, 9);
});

test('hits: weapon kinds, damage caps, cooldowns and target limits', () => {
  const { s, ctx, run } = player();
  ctx.stats = { atk: 20, mag: 30 };
  ctx.hands = { R: 'thunder_staff', L: 'mirror_shield' };
  run({ t: 'spawn', id: 'king1', m: 'king' });
  run({ t: 'spawn', id: 'king2', m: 'king' });
  run({ t: 'spawn', id: 'king3', m: 'king' });
  const shot = 20 * 0.6 + 30 * 1.4; // 54
  const hit = (o) => run({ t: 'hit', hand: 'R', ...o });
  assert.equal(hit({ id: 'king1', k: 'swing', a: 'a1', at: T0, dmg: 5 }), 'wrong weapon');
  assert.equal(hit({ id: 'king1', k: 'shot', a: 'a1', at: T0, dmg: 999 }), '');
  assert.equal(s.econ.foes.king1.hp, 200 - Math.round(shot + 4));
  assert.equal(hit({ id: 'king2', k: 'shot', a: 'a1', at: T0, dmg: 10 }), 'too many targets'); // one bolt, one target...
  assert.equal(hit({ id: 'king2', k: 'chain', a: 'a1', at: T0, dmg: 999 }), '');               // ...then it jumps
  assert.equal(hit({ id: 'king3', k: 'chain', a: 'a1', at: T0, dmg: 10 }), '');
  assert.equal(hit({ id: 'king3', k: 'chain', a: 'a1', at: T0, dmg: 10 }), 'too many targets'); // only two jumps
  assert.equal(s.econ.foes.king2.hp, 200 - Math.round(shot * 0.6 + 4));
  assert.equal(hit({ id: 'king1', k: 'shot', a: 'a2', at: T0 + 500, dmg: 5 }), 'too fast');      // staff cooldown 0.8 s
  assert.equal(hit({ id: 'king1', k: 'shot', a: 'a2', at: T0 + 800, dmg: 5 }, 800), '');
  assert.equal(hit({ id: 'king1', k: 'aoe', a: 'a2', at: T0 + 800, dmg: 5 }), 'wrong weapon');   // no splash on this staff
  assert.equal(run({ t: 'hit', hand: 'L', id: 'king1', k: 'mirror', a: 'm1', at: T0 + 900, dmg: 5 }), '');
  assert.equal(run({ t: 'area' }), '');
  assert.equal(hit({ id: 'king1', k: 'shot', a: 'a3', at: T0 + 2000, dmg: 5 }, 1200), 'no such monster'); // a new map
});

test('the gladiator can be hit as hard as the arena buffs allow', () => {
  const { s, ctx, run } = player();
  ctx.stats = { atk: 20, mag: 2 };
  run({ t: 'spawn', id: 'glad1', m: 'gladiator' });
  run({ t: 'hit', id: 'glad1', k: 'swing', hand: 'R', a: 'g1', at: T0, dmg: 999 });
  assert.equal(s.econ.foes.glad1.hp, 150 - Math.round(20 * 1.7 + 4));
});

test('barrels are rate limited', () => {
  const { run } = player();
  for (let i = 0; i < 4; i++) assert.equal(run({ t: 'barrel' }), '');
  assert.equal(run({ t: 'barrel' }), 'too fast');
  assert.equal(run({ t: 'barrel' }, 8000), '');
});

test('clubhouse members', () => {
  const { s, run } = player();
  assert.equal(run({ t: 'invite', who: 'pal' }), 'no plot');
  run({ t: 'claim', plot: 2 });
  run({ t: 'invite', who: 'pal' }); run({ t: 'invite', who: 'pal' }); run({ t: 'invite', who: 'bud' });
  run({ t: 'kick', who: 'pal' });
  assert.deepEqual(s.farm.members, ['bud']);
});

test('caster numbers match the weapons in /game/lib/hero3d.js', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../game/lib/hero3d.js', import.meta.url), 'utf8');
  for (const [id, c] of Object.entries(CASTERS)) {
    const at = src.search(new RegExp(`\\b${id}[(:]`));
    assert.ok(at >= 0, id + ' in hero3d.js');
    const cast = /cast: \{([^}]*)\}|\{ color: '[^']+', cd: [^}]*\}/.exec(src.slice(at, at + 1500))[0];
    assert.equal(+/cd: ([\d.]+)/.exec(cast)[1], c.cd, id + ' cooldown');
    assert.equal(+((/aoe: ([\d.]+)/.exec(cast) || [])[1] || 0), c.aoe || 0, id + ' splash');
    assert.equal(+((/chain: (\d+)/.exec(cast) || [])[1] || 0), c.chain || 0, id + ' chain');
    assert.equal(/boomerang: true/.test(cast), !!c.boomerang, id + ' boomerang');
  }
});

test('the tables agree with the rest of the game', () => {
  for (const m of Object.values(MONSTER_LOOT)) assert.ok(m.gold[0] <= m.gold[1]);
  for (const g of Object.values(SEA_TREASURE)) assert.ok(g > 0);
  for (const shop of Object.values(SHOPS)) for (const [, price] of shop.stock) assert.ok(Number.isInteger(price) && price > 0);
});
