// The Guild's rules (game/world3d/guild.js) through applyAction, as the server runs them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newEcon, normEcon, applyAction, publicEcon } from '../game/world3d/economy.js';
import { RECRUIT_GOLD, STAMINA_MAX, levelXp, CLASSES, EXPEDITIONS } from '../game/world3d/guild.js';

let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
const MIN = 1000;
const run = (s, a, now) => applyAction(s, a, { now, minute: MIN, rand, isGear: () => false });

test('recruit, quest, claim, train, summon', () => {
  const s = { econ: newEcon(), owned: [], farm: null };
  s.econ.gold = 1000;
  let now = 1e9;
  assert.equal(run(s, { t: 'g_recruit' }, now), '');
  assert.equal(run(s, { t: 'g_recruit' }, now), '');
  assert.equal(s.econ.gold, 1000 - 2 * RECRUIT_GOLD);
  const [a, b] = s.econ.guild.heroes;
  assert.ok(CLASSES[a.cls] && a.lv === 1 && a.gen === 0);

  assert.equal(run(s, { t: 'g_quest', where: 'mine', party: [a.id], n: 6 }, now), 'bad attempts');
  assert.equal(run(s, { t: 'g_quest', where: 'mine', party: [a.id], n: 5 }, now), '');
  assert.equal(run(s, { t: 'g_quest', where: 'docks', party: [a.id], n: 1 }, now), 'hero busy');
  const q = s.econ.guild.quests[0];
  assert.equal(run(s, { t: 'g_claim', quest: q.id }, q.end - 1), 'not back yet');
  now = q.end;
  assert.equal(run(s, { t: 'g_claim', quest: q.id }, now), '');
  assert.equal(s.econ.guild.quests.length, 0);
  assert.ok(a.xp > 0 && s.econ.guild.log[0].k === 'quest');
  // 25 stamina spent: none left, and it comes back over time
  assert.equal(run(s, { t: 'g_quest', where: 'mine', party: [a.id], n: 1 }, now), 'too tired');
  assert.equal(run(s, { t: 'g_quest', where: 'mine', party: [a.id], n: 1 }, now + STAMINA_MAX * 20 * MIN), '');

  b.xp = levelXp(1);
  const str = b.stats.str;
  assert.equal(run(s, { t: 'g_train', hero: b.id, stat: 'str' }, now), '');
  assert.equal(b.lv, 2);
  assert.ok(b.stats.str >= str + 2);

  assert.equal(run(s, { t: 'g_summon', a: b.id, b: b.id }, now), 'bad parents');
  s.econ.guild.quests = [];
  assert.equal(run(s, { t: 'g_summon', a: a.id, b: b.id }, now), 'not enough dew');
  s.econ.bag.root_dew = 3;
  assert.equal(run(s, { t: 'g_summon', a: a.id, b: b.id }, now), '');
  const kid = s.econ.guild.heroes.at(-1);
  assert.equal(kid.gen, 1);
  assert.deepEqual(kid.parents, [a.id, b.id]);
  assert.equal(run(s, { t: 'g_summon', a: a.id, b: b.id }, now), 'still resting');

  // survives a save round trip and shows in the public state
  const back = normEcon(JSON.parse(JSON.stringify(s.econ)));
  assert.equal(back.guild.heroes.length, 3);
  assert.equal(publicEcon(back).guild.heroes.length, 3);
});

test('expedition loot is sellable bag stuff', () => {
  for (const X of Object.values(EXPEDITIONS)) for (const [id] of X.loot) assert.ok(id, id);
  const s = { econ: newEcon(), owned: [], farm: null };
  assert.equal(run(s, { t: 'g_recruit' }, 0), 'not enough gold');
});
