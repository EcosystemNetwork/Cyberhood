// Task 1: the big Avenues plot is back as claimable plot 1; decor crops use the crop models;
// old 8x8 saves are ignored.
import assert from 'node:assert/strict';
import { launch, ready, near, sleep, AVENUES } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red');
  await A.go(AVENUES);
  await A.ev(`localStorage.setItem('taproot_farm_Red', JSON.stringify({ id: 1, owner: 'Red', claimed: 1, crops: { '0,0': { k: 'carrot', t: 1 } }, builds: [], boost: [0, 0], members: [] })); 1`);
  await A.go(AVENUES);
  assert.ok(await ready(A), 'game ready');
  const plots = await A.ev(`__world3d.plots.map((p) => ({ id: p.id, nx: p.nx, nz: p.nz, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, sign: p.sign }))`);
  assert.equal(plots.length, 3, 'three player plots');
  const big = plots.find((p) => p.id === 1);
  assert.deepEqual([big.nx, big.nz], [24, 24], 'plot 1 has 24 x 24 soil');
  const barn = await A.ev(`__world3d.placed.filter((o) => o.key === 'barn').map((o) => [o.tx, o.ty, o.w, o.h])`);
  assert.equal(barn.length, 1, 'one barn');
  const [bx, by, bw, bh] = barn[0];
  assert.ok(bx + bw <= big.x1 || bx > big.x2 || by + bh <= big.y1 || by > big.y2, 'barn is outside plot 1');
  assert.equal(await A.ev(`__world3d.myFarm()`), null, 'old 8x8 save ignored');
  await A.ev(`__world3d.tp(${big.sign.x}, ${big.sign.z + 0.7}, Math.PI); 1`);
  await sleep(700);
  assert.equal(await near(A), 'Press F to claim Plot 1 (free)');
  assert.ok((await A.ev(`__world3d.decorCrops`)) >= 20, 'decor plot has crop models');
  await A.ev(`__world3d.tp(${big.x1 + 12}, ${big.y2 + 6}, Math.PI); __world3d.cam(16, 0.7); 1`);
  await sleep(1200);
  await A.shot('plots_big.png');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
