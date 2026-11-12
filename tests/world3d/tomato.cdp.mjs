// Spectators throw tomatoes into the pit: the throw is broadcast, it arcs and splats,
// it is rate limited, and it never touches a fighter's HP.
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.ev(`localStorage.removeItem('taproot3d_fp'); 1`);
  await A.go(`${BASE}/game/world3d/?area=stands&from=city&hour=13`);
  await B.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  assert.ok(await ready(A));
  assert.ok(await ready(B));
  await sleep(2500);

  // 1. a throw spawns a tomato, and it clears once it lands
  assert.equal(await A.ev('__world3d.throwTomato(); __world3d.tomatoes.length'), 1);
  await sleep(1400);
  assert.equal(await A.ev('__world3d.tomatoes.length'), 0, 'it lands and clears');

  // 2. the fighter sees the same throw
  await A.ev('__world3d.throwTomato(); 1');
  await sleep(350);
  assert.equal(await B.ev('__world3d.tomatoes.length'), 1, 'the throw is broadcast');
  await sleep(1400);

  // 3. it does nothing to the fighter
  assert.equal(await B.ev('__world3d.hp()'), 100, 'tomatoes never damage');

  // 4. the cooldown stops a machine gun
  assert.equal(await A.ev('__world3d.throwTomato(); __world3d.throwTomato(); __world3d.throwTomato(); __world3d.tomatoes.length'), 1,
    'one throw per cooldown');
  await sleep(1400);

  // 5. a fighter down in the pit has no tomatoes to throw
  const beforeB = await B.ev('__world3d.tomatoes.length');
  assert.equal(await B.ev('__world3d.throwTomato(); __world3d.throwTomato(); __world3d.tomatoes.length'), beforeB,
    'pit players throw nothing');

  // 6. the aim indicator is the lob, not the straight shot: a landing ring inside the pit
  //    with a dotted arc running to it
  await A.ev('__world3d.tp(22, 22 - 18, Math.PI); 1'); // back row, camera behind, looking south into the pit
  await sleep(500);
  const aim = JSON.parse(await A.ev('JSON.stringify(__world3d.aimPoint())'));
  assert.equal(aim.hit, 'tomato', 'the stands aim a lob');
  assert.ok(Math.hypot(aim.x - 22, aim.z - 22) <= 13.01, `lands inside the pit (got ${Math.hypot(aim.x - 22, aim.z - 22)})`);
  assert.ok(await A.ev(`document.querySelectorAll('#aimArc i').length`) > 3, 'the arc is drawn');
  assert.equal(await A.ev(`!document.getElementById('aimRing').hidden`), true, 'the landing ring is shown');
  // and a fighter still gets the straight line
  assert.equal(await B.ev(`(__world3d.aimPoint() || {}).hit !== 'tomato'`), true, 'the pit aims a shot');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
