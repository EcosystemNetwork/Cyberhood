// The spectator stands: their own gate, their own area, the arena's room. A spectator
// stands above the sand, cannot walk into the pit, sees the fighters and cannot be hit.
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const CX = 22, CZ = 22, R = 14;
const { player, kill } = await launch();
try {
  const A = await player('Red');
  await A.ev(`localStorage.removeItem('taproot3d_fp'); 1`);

  // 1. the stands are their own area and you arrive in them as a spectator
  await A.go(`${BASE}/game/world3d/?area=stands&from=city&hour=13`);
  assert.ok(await ready(A));
  await sleep(1500);
  assert.equal(await A.ev('__world3d.spectating()'), true);

  // 2. a spectator stands above the sand, not on it
  assert.ok(await A.ev('__world3d.P.y') > 2.5, 'standing on a tier');

  // 3. the rail holds: walking straight at the pit never gets you in
  await A.ev(`__world3d.tp(${CX}, ${CZ - (R + 1.0)}, Math.PI); 1`);
  await sleep(300);
  for (let i = 0; i < 25; i++) { await A.key('KeyW', 'w', 60); }
  const r = await A.ev(`Math.hypot(__world3d.P.x - ${CX}, __world3d.P.z - ${CZ})`);
  assert.ok(r > 14.5, `never entered the pit (radius ${r})`);

  // 4. a fighter in the pit and a spectator in the stands share the arena's room
  const B = await player('Blue');
  await B.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  assert.ok(await ready(B));
  await sleep(2500);
  // by name, not by count: the dev channel may well have a real person on it
  const sees = (p, who) => p.ev(`[...__world3d.ghosts.values()].some((g) => g.name === '${who}')`);
  assert.equal(await sees(A, 'Blue'), true, 'the spectator sees the fighter');
  assert.equal(await sees(B, 'Red'), true, 'the fighter sees the spectator');

  // 5. a spectator takes no damage, however hard the fighter swings at them
  assert.equal(await A.ev('__world3d.hp()'), 100);
  for (let i = 0; i < 6; i++) {
    await B.ev(`(() => { const g = [...__world3d.ghosts.values()].find((q) => q.name === 'Red'); __world3d.tp(g.x, g.z + 0.6); __world3d.P.heading = Math.PI; })(); 1`);
    await B.key('Quote', "'");
    await sleep(400);
  }
  assert.equal(await A.ev('__world3d.hp()'), 100, 'spectators cannot be hit');

  // 6. the crowd watches the hazards happen, and is never touched by them
  const pick = async (kind, from) => JSON.parse(await A.ev(
    `JSON.stringify((() => { const a = __world3d.arenaMod; for (let n = ${from}; n < ${from} + 500; n++) { const x = a.eventAt(n); if (x.kind === '${kind}') return x; } })())`));
  const fb = await pick('fireball', 0);
  await A.ev(`__world3d.hazardClock(${fb.tellMs + 200}); 1`);
  await sleep(400);
  assert.equal(await A.ev('__world3d.hazards().length'), 1, 'the crowd sees what lands in the pit');
  // even standing right where it lands, a spectator takes nothing
  await A.ev(`__world3d.tp(${fb.x}, ${fb.z}); __world3d.hazardClock(${fb.fireMs + 100}); 1`);
  await sleep(500);
  assert.equal(await A.ev('__world3d.hp()'), 100, 'and is never hit by them');

  // 7. walking out the north gate puts you back in the city somewhere you can actually walk
  await A.ev(`__world3d.hazardClock(null); __world3d.tp(22, 4, 0); 1`);
  await sleep(400);
  for (let i = 0; i < 30 && !/area=city/.test(await A.ev('location.search')); i++) await A.key('KeyW', 'w', 60);
  assert.match(await A.ev('location.search'), /area=city&from=stands/, 'the north gate leads to the city');
  assert.ok(await ready(A));
  await sleep(1200);
  const at = JSON.parse(await A.ev('JSON.stringify([__world3d.P.x, __world3d.P.z])'));
  assert.equal(await A.ev(`__world3d.free(__world3d.P.x, __world3d.P.z)`), true,
    `you arrive somewhere you can stand (${at})`);
  const open = await A.ev(`[[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].filter(([dx, dz]) => __world3d.free(__world3d.P.x + dx, __world3d.P.z + dz)).length`);
  assert.ok(open >= 2, `and can walk away from it (${open} of 4 directions open)`);

  // 8. no sub-tile cliffs: collision is per tile, so the floor must be per tile too, or you
  //    stand at the edge of a walkable tile, read a height from off its edge and drop through
  await A.go(`${BASE}/game/world3d/?area=stands&from=city&hour=13`);
  assert.ok(await ready(A));
  await sleep(1200);
  const cliffs = JSON.parse(await A.ev(`JSON.stringify((() => {
    const bad = [];
    for (let x = 1; x < 43; x++) for (let z = 1; z < 43; z++) {
      const cx = x + 0.5, cz = z + 0.5;
      if (!__world3d.free(cx, cz)) continue;
      const mid = __world3d.groundAt(cx, cz, 9);
      for (const [ox, oz] of [[-0.28, -0.2], [0.28, -0.2], [-0.28, 0.2], [0.28, 0.2]]) {
        if (Math.abs(__world3d.groundAt(cx + ox, cz + oz, 9) - mid) > 0.01) { bad.push([cx, cz]); break; }
      }
    }
    return bad.slice(0, 6);
  })())`));
  assert.deepEqual(cliffs, [], 'the floor under a walkable tile is the same all across it');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
