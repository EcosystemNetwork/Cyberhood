// Farming on plot 1: claim, plant, grow, harvest, build, altar, clubhouse invite (two players).
import assert from 'node:assert/strict';
import { launch, ready, near, sleep, AVENUES } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.go(AVENUES);
  assert.ok(await ready(A));
  const big = await A.ev(`(() => { const p = __world3d.plots.find((q) => q.id === 1); return { i0: p.i0, j0: p.j0, sign: p.sign }; })()`);
  await A.ev(`__world3d.tp(115, 5.9, 0); 1`); await sleep(600);
  assert.equal(await near(A), 'Press F to shop at Seed Shop');
  await A.ev(`__world3d.tp(${big.sign.x}, ${big.sign.z + 0.7}, Math.PI); 1`); await sleep(700);
  assert.equal(await near(A), 'Press F to claim Plot 1 (free)');
  await A.key('KeyF', 'f'); await sleep(400);
  assert.equal(await A.ev(`__world3d.myFarm().id`), 1);
  await A.ev(`Object.assign(__world3d.field().bag, { carrot_seed: 6, wheat_seed: 4, pumpkin_seed: 2, pumpkin: 1 }); __world3d.field().gold = 600; 1`);
  const X = (i) => big.i0 + i + 0.5, Z = (j) => big.j0 + j + 0.3;
  const plantAt = async (i, j, digit) => { await A.ev(`__world3d.tp(${X(i)}, ${Z(j)}); 1`); await A.key(`Digit${digit}`, `${digit}`); await sleep(250); await A.key('KeyF', 'f'); await sleep(150); };
  for (let i = 0; i < 4; i++) await plantAt(i, 7, 1);
  for (let i = 0; i < 4; i++) await plantAt(i, 6, 2);
  for (let i = 0; i < 2; i++) await plantAt(i * 2, 5, 3);
  assert.equal(await A.ev(`Object.keys(__world3d.myFarm().crops).length`), 10);
  // build an altar, a clubhouse and a scarecrow
  await A.ev(`__world3d.tp(${X(4)}, ${big.j0 + 6.5}); __world3d.P.heading = Math.PI / 2; 1`); await sleep(300);
  await A.key('KeyG', 'g'); await sleep(400);
  assert.match(await near(A), /^Press F to build a Growth Altar/);
  await A.key('KeyF', 'f'); await sleep(300);
  await A.ev(`__world3d.tp(${X(2)}, ${big.j0 + 2.5}); __world3d.P.heading = Math.PI / 2; 1`); await A.key('Digit2', '2'); await sleep(400);
  assert.match(await near(A), /^Press F to build a Clubhouse/);
  await A.key('KeyF', 'f'); await sleep(300);
  await A.key('Escape'); await sleep(200);
  const builds = await A.ev(`__world3d.myFarm().builds.map((b) => b.k).join()`);
  assert.equal(builds, 'altar,clubhouse');
  // altar offering, then harvest the carrots
  const alt = await A.ev(`(() => { const b = __world3d.myFarm().builds[0]; return [b.i, b.j]; })()`);
  await A.ev(`__world3d.tp(${big.i0 + alt[0] - 0.4}, ${big.j0 + alt[1] + 1}); 1`); await sleep(400);
  assert.match(await near(A), /^Press F to offer a Pumpkin/);
  await A.key('KeyF', 'f'); await sleep(300);
  await sleep(4000);
  await A.ev(`__world3d.tp(${X(0)}, ${Z(7)}); 1`); await sleep(300);
  assert.equal(await near(A), 'Press F to harvest Carrot');
  await A.key('KeyF', 'f'); await sleep(300);
  assert.equal(await A.ev(`__world3d.field().bag.carrot`), 2);
  // Blue sees the farm and gets into the clubhouse only after an invite
  await B.go(AVENUES);
  assert.ok(await ready(B)); await sleep(2500);
  assert.equal(await B.ev(`__world3d.farms.get(1).owner`), 'Red');
  const club = await A.ev(`(() => { const b = __world3d.myFarm().builds.find((q) => q.k === 'clubhouse'); return [b.i, b.j]; })()`);
  const cx = big.i0 + club[0] + 1.5, cz = big.j0 + club[1] + 1.5 + 2.1;
  await B.ev(`__world3d.tp(${cx}, ${cz}); 1`); await sleep(500);
  assert.equal(await near(B), "Red's Clubhouse · members only");
  await A.ev(`const i = document.getElementById('chatIn'); i.value = '/invite Blue'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1`); await sleep(1200);
  assert.equal(await near(B), "Press F to go into Red's clubhouse");
  await B.key('KeyF', 'f'); await sleep(2500);
  assert.equal(await B.ev('location.search'), '?area=clubhouse&plot=1');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
