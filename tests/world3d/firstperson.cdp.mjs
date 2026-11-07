// Task 6: first person (V) everywhere: camera at the eyes, aim for swords, spells and blocks.
import assert from 'node:assert/strict';
import { launch, ready, sleep, AVENUES, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.go(AVENUES);
  assert.ok(await ready(A));
  await A.ev(`localStorage.removeItem('taproot3d_fp'); 1`);
  const p = await A.ev(`(() => { const q = __world3d.plots.find((x) => x.id === 1); return { i0: q.i0, j0: q.j0, sign: q.sign }; })()`);
  await A.ev(`__world3d.tp(${p.sign.x}, ${p.sign.z + 0.7}, Math.PI); 1`); await sleep(600);
  await A.key('KeyF', 'f'); await sleep(300);
  const X = p.i0 + 12.5, Z = p.j0 + 18.5;
  await A.ev(`__world3d.tp(${X}, ${Z}, 0); 1`); await sleep(400);
  // V switches into first person: hero hidden, camera at the eyes, crosshair shown
  await A.key('KeyV', 'v'); await sleep(400);
  assert.equal(await A.ev(`__world3d.firstPerson()`), true);
  assert.equal(await A.ev(`__world3d.hero().root.visible`), false);
  assert.equal(await A.ev(`getComputedStyle(document.getElementById('crosshair')).display !== 'none'`), true);
  const cam = await A.ev(`__world3d.camera.position.toArray()`);
  const P0 = await A.ev(`[__world3d.P.x, __world3d.P.y, __world3d.P.z]`);
  assert.ok(Math.hypot(cam[0] - P0[0], cam[2] - P0[2]) < 0.05 && Math.abs(cam[1] - (P0[1] + 1.35)) < 0.05, `camera at the eyes ${cam}`);
  // heading follows the view; W walks where you look (yaw 0 looks toward -z)
  assert.ok(Math.abs(Math.sin(await A.ev(`__world3d.P.heading`) - Math.PI)) < 0.01);
  await A.down('KeyW', 'w'); await sleep(400); await A.up('KeyW', 'w'); await sleep(100);
  const P1 = await A.ev(`[__world3d.P.x, __world3d.P.y, __world3d.P.z]`);
  assert.ok(P0[2] - P1[2] > 1 && Math.abs(P1[0] - P0[0]) < 0.1, `walked forward ${P0} -> ${P1}`);
  // fireballs follow the view up and down (the left hand holds the Inferno Staff locally)
  const shoot = async (pitch) => {
    await A.ev(`__world3d.setPitch(${pitch}); window.__fbMax = 0; window.__fbT = setInterval(() => { for (const f of __world3d.fireballs) __fbMax = Math.max(__fbMax, f.dist); }, 10); 1`);
    await A.key('Semicolon', ';'); await sleep(200);
    const dy = await A.ev(`__world3d.fireballs.length ? __world3d.fireballs[__world3d.fireballs.length - 1].dy : null`);
    await sleep(1600);
    return [dy, await A.ev(`clearInterval(__fbT); __fbMax`)];
  };
  const [dyLevel, distLevel] = await shoot(0);
  const [dyDown, distDown] = await shoot(-0.3);
  assert.ok(Math.abs(dyLevel) < 0.01, `level shot dy ${dyLevel}`);
  assert.ok(dyDown < -0.2, `downward shot dy ${dyDown}`);
  assert.ok(distDown < distLevel - 1, `downward shot lands sooner (${distDown} vs ${distLevel})`);
  // building in first person aims at the crosshair
  await A.ev(`__world3d.field().bag.block_stone = 3; __world3d.setPitch(-0.6); 1`);
  await A.key('KeyG', 'g'); await A.key('Digit5', '5'); await sleep(300);
  const aim = await A.ev(`__world3d.aimBlock() && __world3d.aimBlock().place`);
  assert.ok(aim && aim[2] === 0, `aiming at the soil ahead ${aim}`);
  await A.key('KeyF', 'f'); await sleep(200);
  assert.equal(await A.ev(`(async () => { const { unpack } = await import('/game/world3d/blocks.js'); return !!unpack(__world3d.myFarm().blocks, 24, 24).get(${aim[0]}, ${aim[1]}, 0); })()`), true);
  await A.key('Escape'); await sleep(200);
  await A.shot('fp_build.png');
  // a click asks for pointer lock; shops, chat and Esc always give it back, and W still works afterwards
  await A.mouse('mousePressed', 640, 360); await A.mouse('mouseReleased', 640, 360); await sleep(200);
  console.log('pointer lock after click:', await A.ev(`document.pointerLockElement === document.getElementById('scene')`));
  await A.ev(`__world3d.openShop('Seed Shop'); 1`); await sleep(200);
  assert.equal(await A.ev(`document.pointerLockElement`), null, 'shop releases the pointer');
  await A.key('Escape'); await sleep(200);
  await A.mouse('mousePressed', 640, 360); await A.mouse('mouseReleased', 640, 360); await sleep(200);
  await A.key('KeyT', 't'); await sleep(200);
  assert.equal(await A.ev(`document.pointerLockElement`), null, 'chat releases the pointer');
  await A.ev(`document.getElementById('chatIn').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`); await sleep(200);
  const P2 = await A.ev(`__world3d.P.z`);
  await A.down('KeyW', 'w'); await sleep(300); await A.up('KeyW', 'w'); await sleep(100);
  assert.ok(Math.abs((await A.ev(`__world3d.P.z`)) - P2) > 0.5, 'W still moves after shop and chat');
  // V again returns to third person (Chase)
  await A.key('KeyV', 'v'); await sleep(400);
  assert.equal(await A.ev(`__world3d.firstPerson()`), false);
  assert.equal(await A.ev(`__world3d.hero().root.visible`), true);
  // the arena: a first-person sword swing straight at Blue lands
  await A.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  await B.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  assert.ok(await ready(A)); assert.ok(await ready(B)); await sleep(2600);
  await A.key('KeyV', 'v'); await sleep(200);
  for (let i = 0; i < 3; i++) { await B.ev(`__world3d.tp(18, 16); 1`); await A.ev(`__world3d.tp(18, 16.9, 0); __world3d.setPitch(0); 1`); await sleep(100); await A.key('Quote', "'"); await sleep(500); }
  assert.ok((await B.ev(`__world3d.hp()`)) < 100, 'first-person sword hits');
  await A.shot('fp_arena.png');
  await A.key('KeyV', 'v');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
