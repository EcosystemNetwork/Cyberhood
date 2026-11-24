// Parkour (parkour.js) in the real page: catching a ledge and climbing a two-high wall, not a
// four-high one, the dodge roll (Alt and a double tap), and another player seeing you roll.
import assert from 'node:assert/strict';
import { launch, ready, sleep, AVENUES } from './harness.mjs';

// Multiplayer needs the Supabase Realtime project; without it the solo checks still run.
const loaded = async (p) => (await ready(p, 12000)) || p.ev(`!!window.__world3d`);

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.go(AVENUES);
  assert.ok(await loaded(A));
  const live = await A.ev(`__world3d.mp.live`);
  const p = await A.ev(`(() => { const q = __world3d.plots.find((x) => x.id === 1); return { i0: q.i0, j0: q.j0, sign: q.sign }; })()`);
  await A.ev(`__world3d.tp(${p.sign.x}, ${p.sign.z + 0.7}, Math.PI); 1`); await sleep(600);
  await A.key('KeyF', 'f'); await sleep(300);
  // a two-high wall at (7,5) and a four-high one at (11,5)
  await A.ev(`(async () => { const { Voxels, pack } = await import('/game/world3d/blocks.js'); const v = new Voxels(24, 24);
    for (let k = 0; k < 2; k++) v.set(7, 5, k, 'stone'); for (let k = 0; k < 4; k++) v.set(11, 5, k, 'stone');
    __world3d.setBlocks(1, pack(v)); return 1; })()`);
  const X = (i) => p.i0 + i + 0.5, Z0 = p.j0 + 5;
  const st = () => A.ev(`[__world3d.P.x, __world3d.P.y, __world3d.P.z]`);
  const watch = () => A.ev(`window.__pk = { climb: false, roll: false, dodging: false }; window.__pt = setInterval(() => { const k = __world3d.parkour(); for (const f in __pk) __pk[f] = __pk[f] || k[f]; }, 10); 1`);
  const seen = () => A.ev(`clearInterval(__pt); __pk`);

  // jump at the two-high wall, pushing into it: catch the edge and climb onto the top
  await A.ev(`__world3d.tp(${X(7)}, ${Z0 + 1.35}, 0); __world3d.P.y = 0; 1`); await sleep(300);
  await watch();
  await A.key('Space', ' '); await A.down('KeyW', 'w'); await sleep(330);
  await A.shot('parkour-climb.png');
  await sleep(100); await A.up('KeyW', 'w'); await sleep(900);
  let [x, y, z] = await st();
  assert.equal((await seen()).climb, true, 'caught the ledge');
  assert.equal(y, 2, `on top of the wall (y=${y})`);
  assert.ok(z > Z0 && z < Z0 + 1, `standing over the wall (z=${z})`);
  assert.equal(await A.ev(`__world3d.solidAt(__world3d.P.x, __world3d.P.z, __world3d.P.y)`), false);

  // four high is out of reach
  await A.ev(`__world3d.tp(${X(11)}, ${Z0 + 1.35}, 0); __world3d.P.y = 0; 1`); await sleep(300);
  await watch();
  await A.key('Space', ' '); await A.down('KeyW', 'w'); await sleep(500); await A.up('KeyW', 'w'); await sleep(900);
  [x, y, z] = await st();
  assert.equal((await seen()).climb, false);
  assert.equal(y, 0, `still on the soil (y=${y})`);

  // Alt rolls you about three tiles ahead, with a window where hits miss
  await A.ev(`__world3d.tp(${X(3)}, ${Z0 + 12}, 0); __world3d.P.heading = Math.PI; 1`); await sleep(1500); // nitro refills
  const z0 = (await st())[2];
  await watch();
  await A.key('AltLeft', 'Alt');
  await sleep(150); await A.shot('parkour-roll.png');
  await sleep(500);
  const r = await seen();
  assert.equal(r.roll, true, 'rolled');
  assert.equal(r.dodging, true, 'with dodge frames');
  const moved = Math.abs((await st())[2] - z0);
  assert.ok(moved > 2.4 && moved < 3.6, `rolled ${moved} tiles`);

  // a double tap rolls too; the cooldown stops a third straight away
  await sleep(800);
  await watch();
  await A.key('KeyW', 'w', 30); await A.key('KeyW', 'w', 30);
  await sleep(80);
  assert.equal((await A.ev(`__world3d.parkour()`)).roll, true, 'double-tap W rolled');
  await A.ev(`__world3d.dodge(); 1`);
  await sleep(600);
  assert.equal((await seen()).roll, true);

  // Blue sees Red roll
  if (!live) { console.log('PASS (multiplayer offline here: skipped the ghost check)'); process.exit(0); }
  await B.go(AVENUES);
  assert.ok(await ready(B)); await sleep(2500);
  const id = JSON.stringify(await A.ev('__world3d.mp.id'));
  await B.ev(`window.__gr = false; window.__gt = setInterval(() => { const g = __world3d.ghosts.get(${id}); if (g && g.rollT !== undefined) __gr = true; }, 10); 1`);
  await sleep(800);
  await A.key('AltLeft', 'Alt'); await sleep(900);
  assert.equal(await B.ev(`clearInterval(__gt); __gr`), true, 'the ghost rolled');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
