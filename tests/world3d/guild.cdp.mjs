// The Guild (guild.js / guildview.js) in the 3D world: recruit at the tavern, companions idling at
// Hero Hall, an expedition out and back, training and summoning. Offline rolls (test session).
//   node game-dev-server.js; node tests/world3d/guild.cdp.mjs
import assert from 'node:assert/strict';
import { launch, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
const load = async (p, url) => {
  await p.go(url);
  await p.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d && __world3d.guild()) { clearInterval(t); r(1); } }, 200); })`);
  await sleep(1500);
};
try {
  const A = await player('Guildy');
  await A.ev(`localStorage.removeItem('taproot_field'); 1`);
  await load(A, `${BASE}/game/world3d/?area=city&hour=13&nomp=1&farmfast=1`);
  const click = (sel) => A.ev(`(() => { const b = document.querySelector('#shopList ${sel}'); if (!b || b.disabled) return false; b.click(); return true; })()`);
  const G = () => A.ev('JSON.parse(JSON.stringify(__world3d.field().guild))');

  // walk up to the tavern: F recruits
  const spot = await A.ev(`(() => { const o = __world3d.placed.find((o) => o.name === 'Glowcap Tavern'); return [o.tx + o.w / 2, o.ty + o.h / 2]; })()`);
  await A.ev(`__world3d.field().gold = 1000; 1`);
  await A.ev(`__world3d.openGuild('recruit'); 1`);
  for (let i = 0; i < 4; i++) assert.ok(await click('[data-act="g_recruit"]'), 'recruit button works');
  let g = await G();
  assert.equal(g.heroes.length, 4);
  assert.equal(await A.ev('__world3d.field().gold'), 1000 - 4 * 80);
  assert.ok(spot);

  // companions appear in front of Hero Hall
  await A.ev(`document.getElementById('shopClose').click(); 1`);
  const hall = await A.ev(`(() => { const o = __world3d.placed.find((o) => o.name === 'Hero Hall'); return [o.tx + o.w / 2, o.ty + o.h + 3]; })()`);
  await A.ev(`__world3d.tp(${hall[0]}, ${hall[1] + 4}, 0); __world3d.cam(9, 0.5); 1`);
  await sleep(2500);
  assert.equal(await A.ev('__world3d.guild().views.size'), 4, 'four companions idle at Hero Hall');
  await A.shot('guild-hall.png');

  // send two on a mine expedition: they leave the city
  await A.ev(`__world3d.openGuild('quest'); 1`);
  await click(`[data-act="g_where"][data-id="mine"]`);
  await click(`[data-act="g_sel"][data-id="${g.heroes[0].id}"]`);
  await click(`[data-act="g_sel"][data-id="${g.heroes[1].id}"]`);
  assert.ok(await click('[data-act="g_quest"]'), 'send button works');
  g = await G();
  assert.equal(g.quests.length, 1);
  await A.shot('guild-panel.png');
  await sleep(500);
  assert.equal(await A.ev('__world3d.guild().views.size'), 2, 'the two on the expedition left the hall');

  // back after 6 x 1 s (farmfast minutes), collect
  await sleep(Math.max(0, g.quests[0].end - Date.now()) + 800);
  assert.ok(await click('[data-act="g_claim"]'), 'collect button works');
  g = await G();
  assert.equal(g.quests.length, 0);
  assert.equal(g.log[0].k, 'quest');
  assert.ok(g.heroes[0].xp > 0);

  // train: enough XP, pick STR
  await A.ev(`__world3d.field().guild.heroes[2].xp = 500; 1`);
  await A.ev(`__world3d.guild().setTab('roster'); 1`);
  assert.ok(await click(`[data-act="g_pick_train"][data-id="${g.heroes[2].id}"]`));
  assert.ok(await click(`[data-act="g_train"][data-x="str"]`));
  assert.equal((await G()).heroes[2].lv, 2);

  // summon with dew
  await A.ev(`__world3d.field().bag.root_dew = 5; __world3d.guild().setTab('summon'); 1`);
  await click(`[data-act="g_sel"][data-id="${g.heroes[2].id}"]`);
  await click(`[data-act="g_sel"][data-id="${g.heroes[3].id}"]`);
  assert.ok(await click('[data-act="g_summon"]'), 'summon button works');
  g = await G();
  assert.equal(g.heroes.length, 5);
  assert.equal(g.heroes[4].gen, 1);
  await A.shot('guild-summon.png');

  // a companion at your side: bring one into the fields and it kills a slime by itself
  await A.ev(`__world3d.guild().setTab('roster'); 1`);
  const ally = g.heroes[3].id;
  assert.ok(await click(`[data-act="g_follow"][data-id="${ally}"]`), 'bring button works');
  assert.equal((await G()).follow, ally);
  // a pet for it: hatch an egg, give it the pet
  await A.ev(`__world3d.field().bag.pet_egg = 1; __world3d.guild().setTab('pets'); 1`);
  assert.ok(await click('[data-act="g_hatch"]'), 'hatch button works');
  const pet = (await G()).pets[0];
  assert.ok(pet, 'a pet hatched');
  assert.ok(await click(`[data-act="g_petfor"][data-id="${pet.id}"]`));
  assert.ok(await click(`[data-act="g_pet"][data-x="${ally}"]`), 'give button works');
  assert.equal((await G()).pets[0].hero, ally);
  await load(A, `${BASE}/game/world3d/?area=fields&hour=13&nomp=1&farmfast=1`);
  await A.ev('__world3d.monsters.forEach((m) => { m.dead = true; }); 1');
  await A.ev(`__world3d.tp(120, 101, 0); __world3d.cam(9, 0.5); 1`);
  await sleep(1500);
  assert.ok(await A.ev(`[...__world3d.guild().views.values()].some((v) => v.side)`), 'the companion came along');
  assert.ok(await A.ev(`[...__world3d.guild().views.values()].some((v) => v.side && v.pet)`), 'with its pet');
  const i = await A.ev(`__world3d.spawn('slime', 121.5, 102)`);
  await sleep(2500);
  await A.ev(`__world3d.cam(6, 0.45); __world3d.tp(120, 99.5, Math.PI * 0.85); 1`);
  await sleep(1500);
  await A.shot('guild-ally.png');
  await A.ev(`__world3d.monsters[${i}].hp = 6; 1`); // one hit: headless Chrome renders a frame or two a second
  let dead = false;
  for (let t = 0; t < 80 && !dead; t++) {
    await sleep(500);
    dead = await A.ev(`__world3d.monsters[${i}].dead || __world3d.monsters[${i}].hp <= 0`);
  }
  assert.ok(dead, 'the companion killed the slime');
  await load(A, `${BASE}/game/world3d/?area=city&hour=13&nomp=1&farmfast=1`);

  // the guild is saved with the field: still there after a reload
  await load(A, `${BASE}/game/world3d/?area=city&hour=13&nomp=1&farmfast=1`);
  assert.equal((await G()).heroes.length, 5);
  console.log('guild: ok');
} finally { kill(); }
