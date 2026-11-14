// Task 7: phone controls: build button, tap twice to place, break toggle, rotate / next, view switch, joystick.
import assert from 'node:assert/strict';
import { launch, ready, sleep, AVENUES } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red', { mobile: true });
  await A.go(AVENUES);
  assert.ok(await ready(A));
  await A.ev(`localStorage.removeItem('taproot3d_fp'); 1`);
  const tap = async (x, y) => { await A.touch('touchStart', [[x, y]]); await sleep(50); await A.touch('touchEnd', []); await sleep(120); };
  const tapEl = async (id) => { const r = await A.ev(`(() => { const b = document.getElementById('${id}').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2, b.width]; })()`); assert.ok(r[2] > 0, `#${id} is visible`); await tap(r[0], r[1]); };
  const p = await A.ev(`(() => { const q = __world3d.plots.find((x) => x.id === 1); return { i0: q.i0, j0: q.j0, sign: q.sign }; })()`);
  await A.ev(`__world3d.tp(${p.sign.x}, ${p.sign.z + 0.7}, Math.PI); 1`); await sleep(700);
  await tapEl('sailBtn'); await sleep(300); // the action button says "Claim"
  assert.equal(await A.ev(`__world3d.myFarm() && __world3d.myFarm().id`), 1);
  await A.ev(`__world3d.field().bag.block_stone = 5; __world3d.tp(${p.i0 + 12.5}, ${p.j0 + 16.5}, 0); __world3d.cam(8, 0.8); 1`); await sleep(800);
  // Build opens build mode; the bar fits the phone screen
  await tapEl('buildBtn'); await sleep(300);
  assert.ok(await A.ev(`!!__world3d.building()`), 'build mode open');
  const fit = await A.ev(`(() => { const b = document.getElementById('buildBar').getBoundingClientRect(); return [b.left, b.right, innerWidth, document.documentElement.scrollWidth]; })()`);
  assert.ok(fit[0] >= 0 && fit[1] <= fit[2] && fit[3] <= fit[2], `build bar fits ${fit}`);
  // Next and Rotate
  const k0 = await A.ev(`__world3d.building().k`);
  await tapEl('nextBtn');
  assert.notEqual(await A.ev(`__world3d.building().k`), k0, 'Next changes the item');
  for (let i = 0; i < 9 && (await A.ev(`__world3d.building().k`)) !== 'block:stone'; i++) await tapEl('nextBtn');
  assert.equal(await A.ev(`__world3d.building().k`), 'block:stone');
  const r0 = await A.ev(`__world3d.building().r`);
  await tapEl('rotBtn');
  assert.equal(await A.ev(`__world3d.building().r`), (r0 + 1) % 4);
  // tap a soil tile: the first tap aims (ghost), the second places
  let spot = null;
  for (let j = 10; j >= 4 && !spot; j--) for (let i = 10; i <= 16 && !spot; i++) {
    const s = await A.ev(`__world3d.toScreen(${p.i0 + i + 0.5}, 0.01, ${p.j0 + j + 0.5})`);
    if (s && s[0] > 230 && s[0] < 340 && s[1] > 260 && s[1] < 520) spot = { i, j, s };
  }
  assert.ok(spot, 'found a soil tile on screen');
  const count = () => A.ev(`(async () => { const { unpack } = await import('/game/world3d/blocks.js'); return unpack(__world3d.myFarm().blocks, 24, 24).count(); })()`);
  await tap(spot.s[0], spot.s[1]);
  assert.deepEqual(await A.ev(`__world3d.aimBlock().place`), [spot.i, spot.j, 0]);
  assert.equal(await A.ev(`__world3d.building().ghost.visible`), true);
  assert.equal(await count(), 0, 'first tap only aims');
  const m0 = await A.ev(`[__world3d.mouse.x, __world3d.mouse.y]`);
  await A.touch('touchStart', [[60, 700]]); await A.touch('touchMove', [[60, 690]]); await A.touch('touchMove', [[62, 700]]); await A.touch('touchEnd', []); await sleep(100);
  assert.deepEqual(await A.ev(`[__world3d.mouse.x, __world3d.mouse.y]`), m0, 'the joystick finger does not move the aim');
  await tap(spot.s[0], spot.s[1]);
  assert.equal(await count(), 1, 'second tap places');
  await A.shot('mobile_build.png');
  // Break: tap the block twice
  await tapEl('breakBtn');
  const top = await A.ev(`__world3d.toScreen(${p.i0 + spot.i + 0.5}, 0.4, ${p.j0 + spot.j + 0.999})`); // its front face, clear of the HUD
  await tap(top[0], top[1]); await tap(top[0], top[1]);
  assert.equal(await count(), 0, 'block broken');
  // the joystick still walks while building
  const z0 = await A.ev(`__world3d.P.z`);
  await A.touch('touchStart', [[80, 640]]); await sleep(50);
  for (let d = 0; d < 6; d++) { await A.touch('touchMove', [[80, 640 - d * 12]]); await sleep(40); }
  await sleep(500); await A.touch('touchEnd', []); await sleep(100);
  assert.ok(Math.abs((await A.ev(`__world3d.P.z`)) - z0) > 0.5, 'joystick moves the player');
  // Done closes build mode; View switches to first person and a right-side drag tilts the view
  await tapEl('buildBtn'); await sleep(200);
  assert.equal(await A.ev(`__world3d.building()`), null);
  await tapEl('viewBtn'); await sleep(200); await tapEl('viewBtn'); await sleep(300); // View cycles third -> shoulder -> first
  assert.equal(await A.ev(`__world3d.firstPerson()`), true);
  const pitch0 = await A.ev(`__world3d.getPitch()`);
  await A.touch('touchStart', [[300, 400]]); await sleep(40);
  for (let d = 1; d <= 6; d++) { await A.touch('touchMove', [[300, 400 + d * 15]]); await sleep(30); }
  await A.touch('touchEnd', []); await sleep(100);
  assert.ok((await A.ev(`__world3d.getPitch()`)) < pitch0 - 0.1, 'dragging down looks down');
  await A.shot('mobile_fp.png');
  await tapEl('viewBtn');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
