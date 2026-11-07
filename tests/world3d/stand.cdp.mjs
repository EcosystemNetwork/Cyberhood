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
  await A.down('KeyW', 'w'); await sleep(600); await A.up('KeyW', 'w'); await sleep(700);
  [x, y, z] = await st();
  assert.equal(y, 0, 'back on the soil');
  // a two-high stack can't be jumped onto, and you never end up inside it
  await A.ev(`__world3d.tp(${X(7)}, ${Z0 + 1.35}, 0); 1`); await sleep(200);
  await A.key('Space', ' '); await A.down('KeyW', 'w'); await sleep(400); await A.up('KeyW', 'w'); await sleep(1100);
  [x, y, z] = await st();
  assert.ok(y < 2, `not on the stack (y=${y})`);
  assert.equal(await A.ev(`__world3d.solidAt(__world3d.P.x, __world3d.P.z, __world3d.P.y)`), false);
  // the slope is walked up without jumping (camera yaw PI: W moves toward +z, up the slope)
  await A.ev(`__world3d.tp(${X(9)}, ${Z0 - 0.6}, Math.PI); window.__maxY = 0; window.__t = setInterval(() => { __maxY = Math.max(__maxY, __world3d.P.y); }, 16); 1`); await sleep(200);
  await A.down('KeyW', 'w'); await sleep(420); await A.up('KeyW', 'w'); await sleep(200);
  const maxY = await A.ev(`clearInterval(__t); __maxY`);
  assert.ok(maxY > 0.75, `walked up the slope (max y ${maxY})`);
  // teleported into the stack, you're nudged onto its top
  await A.ev(`__world3d.tp(${X(7)}, ${Z0 + 0.5}); 1`); await sleep(200);
  assert.equal(await A.ev(`__world3d.P.y`), 2);
  await A.ev(`__world3d.cam(9, 0.6); 1`); await sleep(500);
  await A.shot('stand.png');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
