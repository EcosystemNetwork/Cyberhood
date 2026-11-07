// Task 5: walls and roofs fade when you're inside; doors swing open as you walk through.
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
  // a 5 x 5 stone house (i 8..12, j 8..12), walls two high, a door in the south wall at (10, 12), a flat roof at k = 2
  await A.ev(`(async () => { const { Voxels, pack } = await import('/game/world3d/blocks.js'); const v = new Voxels(24, 24);
    for (let i = 8; i <= 12; i++) for (let j = 8; j <= 12; j++) {
      v.set(i, j, 2, 'stone');
      if ((i === 8 || i === 12 || j === 8 || j === 12) && !(i === 10 && j === 12)) { v.set(i, j, 0, 'stone'); v.set(i, j, 1, 'stone'); }
    }
    v.set(10, 12, 0, 'door', 0);
    __world3d.setBlocks(1, pack(v)); return 1; })()`);
  await sleep(800);
  const X = p.i0 + 10.5;
  const hidden = (P) => P.ev(`__world3d.hiddenBlocks.size`);
  await A.ev(`__world3d.tp(${X}, ${p.j0 + 15.5}, 0); 1`); await sleep(600);
  assert.equal(await hidden(A), 0, 'nothing hidden outside');
  // walk north through the door into the house
  await A.down('KeyW', 'w'); await sleep(250);
  let doorSeen = 0;
  for (let t = 0; t < 10; t++) { doorSeen = Math.max(doorSeen, Math.abs(await A.ev(`__world3d.doorAngle(1, 10, 12, 0)`))); await sleep(80); }
  await sleep(300); await A.up('KeyW', 'w'); await sleep(400);
  const [x, y, z] = await A.ev(`[__world3d.P.x, __world3d.P.y, __world3d.P.z]`);
  assert.ok(z > p.j0 + 8.2 && z < p.j0 + 12, `inside the house (z=${z})`);
  assert.equal(await A.ev(`__world3d.solidAt(__world3d.P.x, __world3d.P.z, __world3d.P.y)`), false);
  assert.ok(doorSeen > 0.5, `door swung open (${doorSeen})`);
  // inside: the roof within 4 tiles is hidden, plus the wall between the camera and you (a low camera looks through the wall)
  await A.ev(`__world3d.cam(6, 0.12); 1`); await sleep(500);
  const keys = await A.ev(`[...__world3d.hiddenBlocks]`);
  for (let i = 8; i <= 12; i++) for (let j = 8; j <= 12; j++) assert.ok(keys.includes(`1:${i},${j},2`), `roof ${i},${j} hidden`);
  assert.ok(keys.some((k) => /^1:\d+,12,[01]$/.test(k)), 'some of the south wall is hidden');
  // Blue, outside, sees nothing hidden
  await B.go(AVENUES);
  assert.ok(await ready(B)); await sleep(2000);
  await B.ev(`__world3d.tp(${X}, ${p.j0 + 17}, 0); 1`); await sleep(600);
  assert.equal(await hidden(B), 0);
  await A.shot('indoor.png');
  await B.shot('indoor_outside.png');
  // walk back out: everything comes back
  await A.ev(`__world3d.tp(${X}, ${p.j0 + 10.5}, Math.PI); 1`); await sleep(300);
  await A.down('KeyW', 'w'); await sleep(1100); await A.up('KeyW', 'w'); await sleep(300);
  assert.ok((await A.ev(`__world3d.P.z`)) > p.j0 + 13, 'walked out through the door');
  await A.ev(`__world3d.tp(__world3d.P.x, __world3d.P.z, 0); __world3d.cam(6, 0.34); 1`); await sleep(300); // camera back on the open side
  assert.equal(await hidden(A), 0, 'nothing hidden once outside');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
