// The colosseum in the overworld: wherever the game drops you — the default spawn, or coming
// back out of either arena gate — you can stand there and walk away; and its gates still work.
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const canMove = (p) => p.ev(`(() => {
  const x = __world3d.P.x, z = __world3d.P.z;
  const open = [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].filter(([dx, dz]) => __world3d.free(x + dx, z + dz)).length;
  return __world3d.free(x, z) && open >= 2;
})()`);

const { player, kill } = await launch();
try {
  const A = await player('Red');
  for (const url of [
    `${BASE}/game/world3d/?hour=13`,                       // default spawn
    `${BASE}/game/world3d/?area=fields&hour=13`,           // the fields directly
    `${BASE}/game/world3d/?area=city&from=arena&hour=13`,  // back out of the fighters' gate
    `${BASE}/game/world3d/?area=city&from=stands&hour=13`, // back out of the crowd's gate
  ]) {
    await A.go(url);
    assert.ok(await ready(A), `boots: ${url}`);
    await sleep(1200);
    const at = await A.ev('JSON.stringify([+__world3d.P.x.toFixed(1), +__world3d.P.z.toFixed(1)])');
    assert.equal(await canMove(A), true, `can move after arriving at ${url} (${at})`);
  }

  // both gates lead where they say
  await A.go(`${BASE}/game/world3d/?area=city&from=arena&hour=13`);
  assert.ok(await ready(A)); await sleep(1000);
  const gates = JSON.parse(await A.ev(`JSON.stringify(__world3d.colosseum())`));
  await A.ev(`__world3d.tp(${gates.arena[0]}, ${gates.arena[1]}); 1`); await sleep(2500);
  assert.equal(await A.ev('location.search'), '?area=arena&from=city', 'the red gate leads to the sand');
  await A.go(`${BASE}/game/world3d/?area=city&from=arena&hour=13`);
  assert.ok(await ready(A)); await sleep(1000);
  await A.ev(`__world3d.tp(${gates.stands[0]}, ${gates.stands[1]}); 1`); await sleep(2500);
  assert.equal(await A.ev('location.search'), '?area=stands&from=city', 'the blue gate leads to the seats');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
