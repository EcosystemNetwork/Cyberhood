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
  assert.equal(await A.ev('__world3d.ghosts.size'), 1, 'the spectator sees the fighter');
  assert.equal(await B.ev('__world3d.ghosts.size'), 1, 'the fighter sees the spectator');

  // 5. a spectator takes no damage, however hard the fighter swings at them
  assert.equal(await A.ev('__world3d.hp()'), 100);
  for (let i = 0; i < 6; i++) {
    await B.ev(`(() => { const g = __world3d.ghosts.values().next().value; __world3d.tp(g.x, g.z + 0.6); __world3d.P.heading = Math.PI; })(); 1`);
    await B.key('Quote', "'");
    await sleep(400);
  }
  assert.equal(await A.ev('__world3d.hp()'), 100, 'spectators cannot be hit');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
