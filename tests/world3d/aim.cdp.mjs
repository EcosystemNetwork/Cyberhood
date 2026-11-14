// Third-person ranged aim: aimPoint() reports where a caster shot would stop, on the
// line castBall actually uses (the player's heading), and the #aimRing marker follows it.
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red');
  await A.ev(`localStorage.removeItem('taproot3d_fp'); 1`); // third person, not first
  await A.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  assert.ok(await ready(A));
  await sleep(1500);

  // the local server always hands the player the Inferno Staff, so a caster is in hand
  assert.ok(await A.ev('!!(__world3d.hero().caster || __world3d.hero().casterL)'), 'a caster is equipped');

  // 1. the aim point sits on the heading line, running forward
  // tp's third argument is the camera yaw; the camera sits behind the player, so heading + PI
  await A.ev('__world3d.tp(18, 24, Math.PI); __world3d.P.heading = 0; 1');
  await sleep(400);
  const a = JSON.parse(await A.ev('JSON.stringify(__world3d.aimPoint())'));
  assert.ok(a, 'aim point exists with a caster equipped');
  assert.ok(Math.abs(a.x - 18) < 0.3, `stays on the heading line in x (got ${a.x})`);
  assert.ok(a.z > 24, `runs forward along +z (got ${a.z})`);

  // 2. turning the player turns the aim point
  // (near the east wall, so the wall is well inside the staff's range)
  await A.ev('__world3d.tp(32, 22, Math.PI / 2 + Math.PI); __world3d.P.heading = Math.PI / 2; 1');
  await sleep(400);
  const b = JSON.parse(await A.ev('JSON.stringify(__world3d.aimPoint())'));
  assert.ok(b.x > 32.5, `swings with the player (got ${b.x})`);

  // 3. the pit wall stops it short of the staff's full range
  assert.ok(b.dist < 5, `stops at the arena wall (got ${b.dist})`);
  assert.equal(b.hit, 'wall');

  // 4. the marker is on screen in third person
  assert.equal(await A.ev(`!document.getElementById('aimRing').hidden`), true, 'ring is shown');

  // 5. no caster, no ring
  await A.ev('__world3d.hero().caster = null; __world3d.hero().casterL = null; 1');
  await sleep(300);
  assert.equal(await A.ev('__world3d.aimPoint()'), null, 'no aim point without a caster');
  assert.equal(await A.ev(`document.getElementById('aimRing').hidden`), true, 'ring is hidden');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
