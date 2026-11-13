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

  // both gates can be WALKED into from where you come back out of them — not teleported onto,
  // which is how an earlier version passed this test while nobody could actually get in
  const walkInto = async (gate, expect, from) => {
    await A.go(`${BASE}/game/world3d/?area=city&from=${from}&hour=13`);
    assert.ok(await ready(A)); await sleep(1000);
    const g = JSON.parse(await A.ev(`JSON.stringify(__world3d.colosseum().${gate})`));
    // point the camera so that W walks straight at the gate
    await A.ev(`(() => { const dx = ${g[0]} - __world3d.P.x, dz = ${g[1]} - __world3d.P.z; __world3d.tp(__world3d.P.x, __world3d.P.z, Math.atan2(-dx, -dz)); })(); 1`);
    await sleep(200);
    await A.down('KeyW', 'w');
    for (let i = 0; i < 30 && !(await A.ev('location.search')).includes(expect); i++) await sleep(150);
    await A.up('KeyW', 'w');
    await sleep(1500);
    assert.equal(await A.ev('location.search'), `?${expect}`, `walking into the ${gate} gate from outside it`);
  };
  await walkInto('arena', 'area=arena&from=city', 'arena');
  await walkInto('stands', 'area=stands&from=city', 'stands');
  // and the arena gate is straight down the street: walk east along the road's middle
  await A.go(`${BASE}/game/world3d/?area=city&hour=13`);
  assert.ok(await ready(A)); await sleep(1000);
  await A.ev(`__world3d.tp(138, 70.5, -Math.PI / 2); 1`); await sleep(200);
  await A.down('KeyW', 'w');
  for (let i = 0; i < 40 && !(await A.ev('location.search')).includes('area=arena'); i++) await sleep(150);
  await A.up('KeyW', 'w');
  await sleep(1500);
  assert.equal(await A.ev('location.search'), '?area=arena&from=city', 'straight down the main street takes you in');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
