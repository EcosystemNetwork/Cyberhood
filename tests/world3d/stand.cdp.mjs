// Task 3: standing on, jumping onto and bumping into blocks on plot 1.
import assert from 'node:assert/strict';
import { launch, ready, sleep, AVENUES } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.go(AVENUES);
  assert.ok(await ready(A));
  const p = await A.ev(`(() => { const q = __world3d.plots.find((x) => x.id === 1); return { i0: q.i0, j0: q.j0, sign: q.sign }; })()`);
  await A.ev(`__world3d.tp(${p.sign.x}, ${p.sign.z + 0.7}, Math.PI); 1`); await sleep(600);
  await A.key('KeyF', 'f'); await sleep(300);
  // a cube at (5,5), a two-high stack at (7,5), a roof slope at (9,5) rising toward +z
  await A.ev(`(async () => { const { Voxels, pack } = await import('/game/world3d/blocks.js'); const v = new Voxels(24, 24);
    v.set(5, 5, 0, 'stone'); v.set(7, 5, 0, 'stone'); v.set(7, 5, 1, 'stone'); v.set(9, 5, 0, 'roof', 0);
    __world3d.setBlocks(1, pack(v)); return 1; })()`);
  const X = (i) => p.i0 + i + 0.5, Z0 = p.j0 + 5; // the blocks' row starts at Z0 (near edge toward -z) and ends at Z0 + 1
  const st = () => A.ev(`[__world3d.P.x, __world3d.P.y, __world3d.P.z]`);
  // Hold W until cond (a page expression) holds, or ms runs out. A fixed hold covers a different
  // distance at every frame rate, and a slow headless GPU can stop the hero short of the mark.
  const walkUntil = async (cond, ms = 4000) => {
    await A.down('KeyW', 'w');
    await A.ev(`new Promise((r) => { const t0 = performance.now(), t = setInterval(() => { if ((${cond}) || performance.now() - t0 > ${ms}) { clearInterval(t); r(1); } }, 16); })`);
    await A.up('KeyW', 'w');
  };
  // walking north (camera yaw 0: W moves toward -z) into the stack stops at its +z face
  await A.ev(`__world3d.tp(${X(7)}, ${Z0 + 3}, 0); 1`); await sleep(200);
  await A.down('KeyW', 'w'); await sleep(1000); await A.up('KeyW', 'w'); await sleep(100);
  let [x, y, z] = await st();
  assert.ok(z > Z0 + 1.15, `stopped at the stack (z=${z})`);
  assert.equal(y, 0);
  // jump while walking onto the single cube
  await A.ev(`__world3d.tp(${X(5)}, ${Z0 + 1.35}, 0); 1`); await sleep(200);
  await A.key('Space', ' '); await A.down('KeyW', 'w'); await sleep(250); await A.up('KeyW', 'w'); await sleep(900);
  [x, y, z] = await st();
  assert.equal(y, 1, `on top of the cube (y=${y}, z=${z})`);
  // Blue sees Red standing up there
  await B.go(AVENUES);
  assert.ok(await ready(B)); await sleep(2500);
  const gy = await B.ev(`__world3d.ghosts.get(${JSON.stringify(await A.ev('__world3d.mp.id'))}).y`);
  assert.ok(Math.abs(gy - 1) < 0.05, `ghost y ${gy}`);
  // walking off the edge lands back on the soil
  await walkUntil(`__world3d.P.z < ${Z0 - 0.5}`); await sleep(700);
  [x, y, z] = await st();
  assert.equal(y, 0, 'back on the soil');
  // a two-high stack is too tall to jump onto, but pushing into it mid-jump catches the edge
  // and climbs up (parkour.js); you never end up inside it
  await A.ev(`__world3d.tp(${X(7)}, ${Z0 + 1.35}, 0); 1`); await sleep(200);
  await A.key('Space', ' '); await A.down('KeyW', 'w'); await sleep(400); await A.up('KeyW', 'w');
  await A.ev(`new Promise((r) => { const t0 = performance.now(), t = setInterval(() => { const P = __world3d.P; if ((!__world3d.parkour().climb && P.y === __world3d.groundAt(P.x, P.z, P.y)) || performance.now() - t0 > 5000) { clearInterval(t); r(1); } }, 16); })`);
  [x, y, z] = await st();
  assert.equal(y, 2, `climbed onto the stack (y=${y})`);
  await A.ev(`__world3d.tp(${X(7)}, ${Z0 + 1.35}, 0); __world3d.P.y = 0; 1`); await sleep(300);
  assert.equal(await A.ev(`__world3d.solidAt(__world3d.P.x, __world3d.P.z, __world3d.P.y)`), false);
  // the slope is walked up without jumping (camera yaw PI: W moves toward +z, up the slope)
  await A.ev(`__world3d.tp(${X(9)}, ${Z0 - 0.6}, Math.PI); window.__maxY = 0; window.__t = setInterval(() => { __maxY = Math.max(__maxY, __world3d.P.y); }, 16); 1`); await sleep(200);
  await walkUntil(`__world3d.P.z > ${Z0 + 1.3}`); await sleep(200); // over the top and off its far side
  const maxY = await A.ev(`clearInterval(__t); __maxY`);
  assert.ok(maxY > 0.75, `walked up the slope (max y ${maxY})`);
  // teleported into the stack, you're nudged onto its top
  await A.ev(`__world3d.tp(${X(7)}, ${Z0 + 0.5}); 1`); await sleep(200);
  assert.equal(await A.ev(`__world3d.P.y`), 2);
  // a block floating 2 above the soil: jumping under it bumps your head, it doesn't lift you onto it
  await A.ev(`(async () => { const { unpack, pack } = await import('/game/world3d/blocks.js'); const v = unpack(__world3d.myFarm().blocks, 24, 24);
    v.set(12, 5, 2, 'stone'); for (let k = 0; k < 12; k++) v.set(15, 5, k, 'stone'); __world3d.setBlocks(1, pack(v)); return 1; })()`);
  await A.ev(`__world3d.tp(${X(12)}, ${Z0 + 0.5}); __world3d.P.y = 0; 1`); await sleep(300);
  assert.equal(await A.ev(`__world3d.P.y`), 0);
  await A.key('Space', ' '); await sleep(1000);
  assert.equal(await A.ev(`__world3d.P.y`), 0, 'still on the soil after jumping under a ceiling');
  // standing on top of a 12-high column, the third-person camera still frames the hero
  await A.ev(`__world3d.tp(${X(15)}, ${Z0 + 0.5}, 0); __world3d.cam(6, 0.34); 1`); await sleep(1500);
  assert.equal(await A.ev(`__world3d.P.y`), 12);
  const sy = await A.ev(`(() => { const s = __world3d.toScreen(__world3d.P.x, __world3d.P.y + 0.8, __world3d.P.z); return s && s[1] / innerHeight; })()`);
  assert.ok(sy !== null && sy > 0.25 && sy < 0.85, `hero on screen at height 12 (y=${sy})`);
  await A.ev(`__world3d.cam(9, 0.6); 1`); await sleep(500);
  await A.shot('stand.png');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
