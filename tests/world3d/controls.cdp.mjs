// Third-person controls: you run the way you press, relative to the camera, in a straight line.
// The camera only turns when you turn it (drag, Q/E), and drifts in behind you only while you run
// forward. It used to swing after your facing whenever you moved, so holding A ran you in a curve.
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red');
  await A.ev(`localStorage.removeItem('taproot3d_fp'); localStorage.removeItem('taproot3d_cam'); 1`);
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13&nomp=1`);
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
  await sleep(1500);
  await A.ev('__world3d.monsters.forEach((m) => { m.dead = true; }); 1');
  const state = async () => JSON.parse(await A.ev('JSON.stringify({ x: __world3d.P.x, z: __world3d.P.z, yaw: __world3d.camYaw() })'));
  const hold = async (keys, ms) => { for (const k of keys) await A.down(`Key${k}`, k.toLowerCase()); await sleep(ms); for (const k of keys) await A.up(`Key${k}`, k.toLowerCase()); await sleep(300); };
  const start = () => A.ev('__world3d.tp(120, 104, Math.PI); 1').then(() => sleep(400)); // camera behind, looking +z

  // holding A runs left on screen in a straight line, and the camera holds still
  await start();
  let s0 = await state();
  await hold(['A'], 2000);
  let s1 = await state();
  assert.ok(Math.abs(s1.yaw - s0.yaw) < 0.03, `the camera holds still while you run sideways (turned ${(s1.yaw - s0.yaw).toFixed(3)} rad)`);
  assert.ok(Math.abs(s1.x - s0.x) > 5, `you ran left (${(s1.x - s0.x).toFixed(1)} tiles)`);
  assert.ok(Math.abs(s1.z - s0.z) < 0.3, `in a straight line, not a curve (drifted ${(s1.z - s0.z).toFixed(2)} tiles)`);

  // the same for D, and for S (running toward the camera)
  await start(); s0 = await state(); await hold(['D'], 1500); s1 = await state();
  assert.ok(Math.abs(s1.yaw - s0.yaw) < 0.03 && Math.abs(s1.z - s0.z) < 0.3, 'D runs right, straight, camera still');
  await start(); s0 = await state(); await hold(['S'], 1200); s1 = await state();
  assert.ok(Math.abs(s1.yaw - s0.yaw) < 0.03, 'S runs toward the camera without turning it');

  // Q/E still turn the camera
  await start(); s0 = await state(); await hold(['Q'], 600); s1 = await state();
  assert.ok(Math.abs(s1.yaw - s0.yaw) > 0.5, 'Q turns the camera');

  // a diagonal (W+A) also runs straight, and the camera still holds
  // (kept short: about 6 tiles further on there's scenery that would make it slide)
  await start(); s0 = await state(); await hold(['W', 'A'], 800);
  const mid = await state(); await hold(['W', 'A'], 800); s1 = await state();
  assert.ok(Math.abs(s1.yaw - s0.yaw) < 0.03, 'W+A: the camera holds still');
  const line = Math.abs((mid.x - s0.x) * (s1.z - s0.z) - (mid.z - s0.z) * (s1.x - s0.x)) / Math.hypot(s1.x - s0.x, s1.z - s0.z);
  assert.ok(line < 0.4, `W+A runs a straight diagonal (bent by ${line.toFixed(2)} tiles)`);

  console.log('PASS');
} finally { kill(); }
process.exit(0);
