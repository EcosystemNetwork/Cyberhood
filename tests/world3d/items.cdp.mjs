// The seven new items, each checked for what it actually does in play:
// windrunner boots, hermes sandals, ice wand, thunder staff, boomerang, mirror shield, smoke bomb.
import assert from 'node:assert/strict';
import { launch, ready, sleep, calm, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.ev(`localStorage.removeItem('taproot3d_fp'); 1`);

  /* ---------- local dev: you own everything, and a weapon you pick survives a reload ---------- */
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13&nomp=1`);
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
  await sleep(1500);
  const missing = await A.ev(`(() => { const own = JSON.parse(localStorage.getItem('taproot_owned') || '[]'); return Object.keys(GAME.ITEMS).filter((k) => !own.includes(k)); })()`);
  assert.deepEqual(missing, [], 'local dev: every item is owned');
  assert.ok(await A.ev('__world3d.field().bag.smoke_bomb') >= 5, 'local dev: with smoke bombs in the bag');
  await A.ev(`__world3d.equip('ice_wand', 'rhand'); 1`);
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13&nomp=1`);
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
  await sleep(1500);
  assert.equal(await A.ev(`JSON.parse(localStorage.getItem('taproot_character')).equipment.rhand`), 'ice_wand',
    'local dev: the weapon you chose is still in your hand after a reload');
  await A.ev(`(() => { const c = JSON.parse(localStorage.getItem('taproot_character')); c.equipment = {}; localStorage.setItem('taproot_character', JSON.stringify(c)); })(); 1`);

  /* ---------- in the fields: movement items and the weapons against monsters ---------- */
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13&nomp=1`);
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
  await sleep(2500);
  await A.ev('__world3d.monsters.forEach((m) => { m.dead = true; }); 1'); // only the ones the test spawns
  const at = (x, z, yaw = 0) => A.ev(`__world3d.tp(${x}, ${z}, ${yaw}); __world3d.P.heading = ${yaw} + Math.PI; 1`);
  const OPEN = [120, 101]; // open ground in the middle of the fields

  // windrunner boots: sprinting never drains the nitro bar
  await at(OPEN[0], OPEN[1], Math.PI); // camera behind, W walks +z
  await A.down('ShiftLeft', 'Shift'); await A.down('KeyW', 'w'); await sleep(1500);
  await A.up('KeyW', 'w'); await A.up('ShiftLeft', 'Shift');
  assert.ok(await A.ev('__world3d.nitro()') < 0.9, 'ordinary boots: sprinting drains nitro');
  await A.ev(`__world3d.equip('windrunner_boots'); __world3d.setNitro(1); 1`);
  await at(OPEN[0], OPEN[1] - 6, Math.PI);
  await A.down('ShiftLeft', 'Shift'); await A.down('KeyW', 'w'); await sleep(2500);
  await A.up('KeyW', 'w'); await A.up('ShiftLeft', 'Shift');
  assert.ok(await A.ev('__world3d.nitro()') > 0.99, 'windrunner boots: nitro stays full');

  // hermes sandals: one extra jump in the air, and only one
  const airJump = async () => {
    await at(OPEN[0], OPEN[1]); await sleep(300);
    await A.ev('__world3d.jump(); 1');
    for (let i = 0; i < 40 && (await A.ev('__world3d.P.vy')) > 0; i++) await sleep(25); // wait until falling
    await A.ev('__world3d.jump(); 1');
    const vy = await A.ev('__world3d.P.vy');
    await sleep(900);
    return vy;
  };
  assert.ok(await airJump() <= 0, 'ordinary boots: no jump in mid-air');
  await A.ev(`__world3d.equip('hermes_sandals'); 1`);
  assert.ok(await airJump() > 5, 'hermes sandals: a second jump in mid-air');
  await at(OPEN[0], OPEN[1]); await sleep(300);
  await A.ev('__world3d.jump(); 1'); await sleep(120);
  await A.ev('__world3d.jump(); 1');
  for (let i = 0; i < 40 && (await A.ev('__world3d.P.vy')) > 0; i++) await sleep(25);
  await A.ev('__world3d.jump(); 1');
  assert.ok(await A.ev('__world3d.P.vy') <= 0, 'hermes sandals: but not a third');
  await sleep(900);

  // a target a few tiles straight ahead (+z) of the player
  const target = (type, dx, dz) => A.ev(`__world3d.spawn('${type}', ${OPEN[0] + dx}, ${OPEN[1] + dz})`);
  const shoot = async (hand = 'R') => { await A.key(hand === 'R' ? 'Quote' : 'Semicolon', hand === 'R' ? "'" : ';'); };

  // ice wand: the shot hurts and chills
  await A.ev(`__world3d.equip('ice_wand', 'rhand'); 1`);
  await at(OPEN[0], OPEN[1], Math.PI);
  let i = await target('goblin', 0, 3.5);
  const hp0 = await A.ev(`__world3d.monsters[${i}].hp`);
  await shoot(); await sleep(600);
  assert.ok(await A.ev(`__world3d.monsters[${i}].hp`) < hp0, 'ice wand: the bolt hurts');
  assert.ok(await A.ev(`__world3d.monsters[${i}].chill > performance.now()`), 'ice wand: and slows what it hits');
  await A.ev(`__world3d.monsters[${i}].dead = true; 1`);

  // thunder staff: one shot, three targets
  await A.ev(`__world3d.equip('thunder_staff', 'rhand'); 1`); await sleep(400);
  await at(OPEN[0], OPEN[1], Math.PI);
  const trio = [await target('goblin', 0, 4), await target('goblin', 1.6, 5.2), await target('goblin', -1.6, 5.2)];
  const before = await A.ev(`JSON.stringify([${trio}].map((k) => __world3d.monsters[k].hp))`);
  await shoot(); await sleep(700);
  const after = await A.ev(`JSON.stringify([${trio}].map((k) => __world3d.monsters[k].hp))`);
  JSON.parse(after).forEach((h, k) => assert.ok(h < JSON.parse(before)[k], `thunder staff: target ${k + 1} of 3 is struck`));
  await A.ev(`[${trio}].forEach((k) => { __world3d.monsters[k].dead = true; }); 1`);

  // boomerang: flies out, hits on the way, and comes back to your hand
  await A.ev(`__world3d.equip('boomerang', 'rhand'); 1`); await sleep(400);
  await at(OPEN[0], OPEN[1], Math.PI);
  i = await target('king', 0, 4);
  const kingHp = await A.ev(`__world3d.monsters[${i}].hp`);
  await shoot(); await sleep(250);
  assert.equal(await A.ev('__world3d.fireballs.some((f) => f.boom)'), true, 'boomerang: thrown');
  let gotFar = 0, cameBack = false;
  for (let k = 0; k < 60; k++) {
    const d = await A.ev(`(() => { const f = __world3d.fireballs.find((q) => q.boom); return f ? Math.hypot(f.x - __world3d.P.x, f.z - __world3d.P.z) : -1; })()`);
    if (d < 0) { cameBack = true; break; }
    gotFar = Math.max(gotFar, d);
    await sleep(60);
  }
  assert.ok(gotFar > 5, `boomerang: it flies out (${gotFar.toFixed(1)} tiles)`);
  assert.equal(cameBack, true, 'boomerang: and comes back to your hand');
  assert.ok(await A.ev(`__world3d.monsters[${i}].hp`) < kingHp, 'boomerang: it hit what was in the way');
  await A.ev(`__world3d.monsters[${i}].dead = true; 1`);

  /* ---------- in the arena: the PvP side of the ice wand, the mirror shield, the smoke bomb ---------- */
  await A.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  await B.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  assert.ok(await ready(A)); assert.ok(await ready(B));
  await sleep(2500);
  await calm(A); await calm(B);
  const glad = await A.ev(`__world3d.monsters.findIndex((m) => m.type === 'gladiator')`);

  // ice wand on another player: they are slowed, on their own screen
  await A.ev(`__world3d.equip('ice_wand', 'rhand'); 1`); await sleep(400);
  await B.ev(`__world3d.tp(22, 26); 1`);
  await A.ev(`__world3d.tp(22, 22.5, Math.PI); __world3d.P.heading = 0; 1`); await sleep(300);
  await shoot(); await sleep(900);
  assert.ok(await B.ev('__world3d.chilled()') > 0, 'ice wand: the other player is slowed');

  // mirror shield: a well-timed block sends the gladiator's fireball back at him
  await A.ev(`__world3d.equip('mirror_shield', 'lhand'); __world3d.setHp(100); 1`); await sleep(400);
  await A.ev(`(() => { const m = __world3d.monsters[${glad}]; m.dead = false; m.x = 22; m.z = 19.5; m.hp = 150; })(); 1`);
  await A.ev(`__world3d.tp(22, 23, 0); __world3d.P.heading = Math.PI; 1`); await sleep(200);
  await A.ev(`__world3d.foeCast(${glad}); 1`); await sleep(40);
  await shoot('L'); // raise the shield
  await sleep(900);
  assert.equal(await A.ev('__world3d.hp()'), 100, 'mirror shield: a parried fireball does no damage');
  assert.ok(await A.ev(`__world3d.monsters[${glad}].hp`) < 150, 'mirror shield: and goes back to hurt the gladiator');
  // without the block it would have landed
  await A.ev(`__world3d.foeCast(${glad}); 1`); await sleep(900);
  assert.ok(await A.ev('__world3d.hp()') < 100, 'mirror shield: an unparried one still lands');
  await A.ev(`__world3d.monsters[${glad}].dead = true; __world3d.setHp(100); 1`);

  // smoke bomb: gone from the other player's view, and out of reach
  await A.ev(`__world3d.field().bag.smoke_bomb = 1; 1`);
  await A.key('KeyN', 'n'); await sleep(500);
  assert.ok(await A.ev('__world3d.smoked()') > 0, 'smoke bomb: you vanish');
  assert.equal(await A.ev('__world3d.field().bag.smoke_bomb'), 0, 'smoke bomb: it is used up');
  assert.equal(await B.ev(`[...__world3d.ghosts.values()].find((g) => g.name === 'Red').hid`), true, 'smoke bomb: the other player cannot see you');
  await sleep(3000);
  assert.equal(await A.ev('__world3d.smoked()'), 0, 'smoke bomb: it wears off');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
