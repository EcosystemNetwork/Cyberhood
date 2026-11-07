// Task 4: Builder's Yard, aiming, placing and breaking blocks on plot 1, sharing, draw-call budget.
import assert from 'node:assert/strict';
import { launch, ready, near, sleep, AVENUES } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.go(AVENUES);
  assert.ok(await ready(A));
  const p = await A.ev(`(() => { const q = __world3d.plots.find((x) => x.id === 1); return { i0: q.i0, j0: q.j0, sign: q.sign }; })()`);
  const W = (i, j) => [p.i0 + i + 0.5, p.j0 + j + 0.5];
  await A.ev(`__world3d.tp(${p.sign.x}, ${p.sign.z + 0.7}, Math.PI); 1`); await sleep(600);
  await A.key('KeyF', 'f'); await sleep(300);
  await A.ev(`__world3d.field().gold = 300; __world3d.field().bag.carrot_seed = 1; 1`);
  // buy at the Builder's Yard
  const yard = await A.ev(`__world3d.shopSpots.find((s) => s.name === "Builder's Yard")`);
  assert.ok(yard, "Builder's Yard exists");
  await A.ev(`__world3d.tp(${yard.x}, ${yard.z}); 1`); await sleep(500);
  assert.equal(await near(A), "Press F to shop at Builder's Yard");
  await A.key('KeyF', 'f'); await sleep(400);
  const buy = (id, n) => A.ev(`document.querySelector('#shopList button[data-act=buy][data-id=${id}]${n ? `[data-n="${n}"]` : ':not([data-n])'}').click(); 1`);
  await buy('block_stone', 5); await sleep(100); await buy('block_stone', 5); await sleep(100); await buy('block_roof'); await sleep(100); await buy('block_roof');
  await A.key('Escape'); await sleep(200);
  assert.equal(await A.ev(`__world3d.field().bag.block_stone`), 10);
  assert.equal(await A.ev(`__world3d.field().bag.block_roof`), 2);
  assert.equal(await A.ev(`__world3d.field().gold`), 300 - 20 - 4);
  // a carrot on (12,10) to test that blocks can't go on crops
  const [cx, cz] = W(12, 10);
  await A.ev(`__world3d.tp(${cx}, ${cz - 0.2}); 1`); await sleep(200); await A.key('KeyF', 'f'); await sleep(200);
  assert.equal(await A.ev(`Object.keys(__world3d.myFarm().crops).join()`), '12,10');
  // build mode, stone (plot buildings come first in the bar: 3 of them, then planks, stone ...)
  const [sx, sz] = W(10, 13);
  await A.ev(`__world3d.tp(${sx}, ${sz}, 0); __world3d.cam(7, 0.75); 1`); await sleep(600);
  await A.key('KeyG', 'g'); await A.key('Digit5', '5'); await sleep(200);
  assert.equal(await A.ev(`__world3d.building().k`), 'block:stone');
  const aimAt = async (x, y, z) => { const s = await A.ev(`__world3d.toScreen(${x}, ${y}, ${z})`); assert.ok(s, `on screen ${x},${y},${z}`); await A.mouse('mouseMoved', s[0], s[1], 'none'); await sleep(150); return s; };
  const [tx, tz] = W(10, 10);
  await aimAt(tx, 0.01, tz);
  assert.deepEqual(await A.ev(`__world3d.aimBlock().place`), [10, 10, 0]);
  assert.deepEqual(await A.ev(`__world3d.building().ghost.position.toArray().map((v) => +v.toFixed(2))`), [tx, 0.5, tz]);
  await A.key('KeyF', 'f'); await sleep(200);
  assert.equal(await A.ev(`__world3d.field().bag.block_stone`), 9);
  assert.equal(await A.ev(`__world3d.myFarm().blocks.length`), 4);
  // stack a second one by aiming at the top face, with a short click
  const s = await aimAt(tx, 0.999, tz);
  assert.deepEqual(await A.ev(`__world3d.aimBlock().place`), [10, 10, 1]);
  await A.mouse('mousePressed', s[0], s[1]); await sleep(60); await A.mouse('mouseReleased', s[0], s[1]); await sleep(200);
  assert.equal(await A.ev(`__world3d.field().bag.block_stone`), 8);
  // right-click the top block to break it
  const s2 = await aimAt(tx, 1.999, tz);
  assert.deepEqual(await A.ev(`(() => { const a = __world3d.aimBlock(); return [a.i, a.j, a.k, a.breakable]; })()`), [10, 10, 1, true]);
  await A.mouse('mousePressed', s2[0], s2[1], 'right'); await sleep(60); await A.mouse('mouseReleased', s2[0], s2[1], 'right'); await sleep(200);
  assert.equal(await A.ev(`__world3d.field().bag.block_stone`), 9);
  assert.equal(await A.ev(`__world3d.myFarm().blocks.length`), 4);
  // not on crops
  await aimAt(cx, 0.01, cz);
  assert.match(await near(A), /crops in the way/);
  // not where someone stands
  await B.go(AVENUES);
  assert.ok(await ready(B)); await sleep(2000);
  const [bx, bz] = W(14, 10);
  await B.ev(`__world3d.tp(${bx}, ${bz}); 1`); await sleep(1200);
  await aimAt(bx, 0.01, bz);
  assert.match(await near(A), /someone is standing there/);
  // not above 12
  await A.ev(`(async () => { const { unpack, pack } = await import('/game/world3d/blocks.js'); const v = unpack(__world3d.myFarm().blocks, 24, 24); for (let k = 0; k < 12; k++) v.set(16, 10, k, 'stone'); __world3d.setBlocks(1, pack(v)); return 1; })()`);
  await sleep(700);
  const [hx, hz] = W(16, 10);
  await A.ev(`__world3d.tp(${hx}, ${hz - 4}, 0); __world3d.cam(20, 1.2); 1`); await sleep(900);
  await aimAt(hx, 11.999, hz);
  assert.match(await near(A), /too high/);
  // a roof turned twice
  await A.ev(`__world3d.tp(${sx}, ${sz}, 0); __world3d.cam(7, 0.75); 1`); await sleep(900);
  await A.key('Digit8', '8'); await A.key('KeyR', 'r'); await A.key('KeyR', 'r'); await sleep(100);
  const [rx, rz] = W(8, 10);
  await aimAt(rx, 0.01, rz);
  await A.key('KeyF', 'f'); await sleep(200);
  assert.equal(await A.ev(`(async () => { const { unpack } = await import('/game/world3d/blocks.js'); return unpack(__world3d.myFarm().blocks, 24, 24).get(8, 10, 0).r; })()`), 2);
  // Blue sees the same blocks, and can't build on Red's plot
  await sleep(1500);
  assert.equal(await B.ev(`__world3d.farms.get(1).blocks`), await A.ev(`__world3d.myFarm().blocks`));
  await B.key('KeyG', 'g'); await sleep(200);
  assert.equal(await B.ev(`__world3d.building()`), null);
  await A.shot('build.png');
  // draw calls stay within budget with the plot full of blocks
  await A.key('Escape'); await sleep(200);
  await A.ev(`__world3d.setBlocks(1, ''); 1`); await sleep(800);
  const base = await A.ev(`__world3d.info().calls`);
  await A.ev(`(async () => { const { Voxels, pack, BLOCK_IDS } = await import('/game/world3d/blocks.js'); const v = new Voxels(24, 24);
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) for (let k = 0; k < 12; k++) v.set(i, j, k, BLOCK_IDS[(i + j + k) % 5], 0);
    __world3d.setBlocks(1, pack(v)); return 1; })()`);
  await sleep(1500);
  const full = await A.ev(`__world3d.info().calls`);
  assert.ok(full <= base + 12, `draw calls ${base} -> ${full}`);
  console.log('calls', base, full);
  await A.shot('build_full.png');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
