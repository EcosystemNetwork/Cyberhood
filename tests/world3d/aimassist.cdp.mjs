// Auto-aim (on by default, L or the target button toggles it) and the over-the-shoulder view.
import assert from 'node:assert/strict';
import { launch, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red');
  await A.ev(`localStorage.removeItem('taproot3d_fp'); localStorage.removeItem('taproot3d_aim'); 1`);
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13&nomp=1`);
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
  await sleep(1500);
  await A.ev(`__world3d.monsters.forEach((m) => { m.dead = true; }); __world3d.equip('fire_wand', 'rhand'); 1`);
  const O = [120, 104];
  // a goblin `deg` degrees off to the left of where you face (+z), `d` tiles away
  const goblinAt = (deg, d) => A.ev(`__world3d.spawn('goblin', ${O[0]} + Math.sin(${deg} * Math.PI / 180) * ${d}, ${O[1]} + Math.cos(${deg} * Math.PI / 180) * ${d})`);
  const face = () => A.ev(`__world3d.tp(${O[0]}, ${O[1]}, Math.PI); __world3d.P.heading = 0; 1`).then(() => sleep(250));
  const hpOf = (i) => A.ev(`__world3d.monsters[${i}].hp`);
  const shoot = async () => { await A.key('Quote', "'"); await sleep(900); };
  const kill1 = (i) => A.ev(`__world3d.monsters[${i}].dead = true; 1`);

  /* ---------- auto-aim ---------- */
  assert.equal(await A.ev('__world3d.autoAim()'), true, 'auto-aim starts on');

  // roughly facing a target: the shot bends onto it
  await face(); let g = await goblinAt(16, 6); let hp0 = await hpOf(g);
  await shoot();
  assert.ok(await hpOf(g) < hp0, 'auto-aim: a shot aimed near a goblin hits it');
  // and the aim ring sits on it, marked as a target
  const ring = JSON.parse(await A.ev('JSON.stringify(__world3d.aimPoint())'));
  assert.equal(ring.hit, 'monster', 'the aim ring locks onto the goblin');
  await kill1(g);

  // well off to the side: no help
  await face(); g = await goblinAt(70, 6); hp0 = await hpOf(g);
  await shoot();
  assert.equal(await hpOf(g), hp0, 'auto-aim does not reach a goblin 70 degrees off');
  await kill1(g);

  // L turns it off, and then the same near-miss stays a miss; it stays off after a reload
  await A.key('KeyL', 'l'); await sleep(200);
  assert.equal(await A.ev('__world3d.autoAim()'), false, 'L turns auto-aim off');
  await face(); g = await goblinAt(16, 6); hp0 = await hpOf(g);
  await shoot();
  assert.equal(await hpOf(g), hp0, 'with auto-aim off, a near miss misses');
  await kill1(g);
  assert.equal(await A.ev(`localStorage.getItem('taproot3d_aim')`), '0', 'the choice is remembered');
  await A.ev(`document.getElementById('aimBtn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); 1`); await sleep(200);
  assert.equal(await A.ev('__world3d.autoAim()'), true, 'the target button turns it back on');

  // melee too: a swing at a goblin off to one side turns you onto it
  await A.ev(`__world3d.equip('iron_sword', 'rhand'); 1`); await sleep(300);
  await face(); g = await goblinAt(40, 1.3); hp0 = await hpOf(g);
  await shoot();
  assert.ok(await hpOf(g) < hp0, 'auto-aim: a sword swing near a goblin connects');
  await kill1(g);

  /* ---------- over the shoulder ---------- */
  assert.equal(await A.ev('__world3d.view()'), 'third');
  await A.key('KeyV', 'v'); await sleep(400);
  assert.equal(await A.ev('__world3d.view()'), 'shoulder', 'V goes to over-the-shoulder first');
  assert.equal(await A.ev(`!document.getElementById('crosshair').hidden`), true, 'with a crosshair');
  assert.equal(await A.ev(`document.getElementById('aimRing').hidden`), true, 'and no ground ring');
  assert.equal(await A.ev(`__world3d.hero().root.visible`), true, 'you can still see your character');
  // the camera sits behind you and off to the right, and you face where it looks
  await A.ev(`__world3d.tp(${O[0]}, ${O[1]}, 0.6); __world3d.setPitch(0); 1`); await sleep(400);
  const cam = JSON.parse(await A.ev(`JSON.stringify({ x: __world3d.camera.position.x, z: __world3d.camera.position.z, h: __world3d.P.heading })`));
  const fwd = [-Math.sin(0.6), -Math.cos(0.6)], right = [Math.cos(0.6), -Math.sin(0.6)];
  const rel = [cam.x - O[0], cam.z - O[1]];
  assert.ok(rel[0] * fwd[0] + rel[1] * fwd[1] < -1.5, 'the camera is behind you');
  assert.ok(rel[0] * right[0] + rel[1] * right[1] > 0.3, 'and over your right shoulder');
  assert.ok(Math.abs(Math.atan2(Math.sin(cam.h - 0.6 - Math.PI), Math.cos(cam.h - 0.6 - Math.PI))) < 0.05, 'you face where the camera looks');
  // shots go where the crosshair points: aim straight at a goblin with auto-aim off, and hit it
  await A.ev(`__world3d.setAutoAim(false); __world3d.equip('fire_wand', 'rhand'); 1`); await sleep(300);
  await A.ev(`__world3d.tp(${O[0]}, ${O[1]}, Math.PI); __world3d.setPitch(0); 1`); await sleep(400); // looking +z
  g = await goblinAt(0, 7); hp0 = await hpOf(g);
  await shoot();
  assert.ok(await hpOf(g) < hp0, 'over the shoulder: a shot at the crosshair hits what it points at');
  await kill1(g);
  await A.key('KeyV', 'v'); await sleep(300);
  assert.equal(await A.ev('__world3d.view()'), 'first', 'V again: first person');
  await A.key('KeyV', 'v'); await sleep(300);
  assert.equal(await A.ev('__world3d.view()'), 'third', 'and V once more: back to third person');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
