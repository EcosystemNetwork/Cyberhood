// Arena hazards: telegraphed, damaging only when they commit, dodgeable, arena-only,
// harmless to a fainted player, and running with or without multiplayer.
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const CX = 22, CZ = 22;
const booted = (p) => p.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(true); } }, 200); setTimeout(() => r(false), 25000); })`);

const { player, kill } = await launch();
try {
  const A = await player('Red');
  await A.ev(`localStorage.removeItem('taproot3d_fp'); 1`);
  await A.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  assert.ok(await ready(A));
  await sleep(1500);

  const pick = async (kind, from) => JSON.parse(await A.ev(
    `JSON.stringify((() => { const a = __world3d.arenaMod; for (let n = ${from}; n < ${from} + 500; n++) { const x = a.eventAt(n); if (x.kind === '${kind}') return x; } })())`));

  // 1. the telegraph shows, and does no damage of its own
  const fb = await pick('fireball', 0);
  await A.ev(`__world3d.hazardClock(${fb.tellMs + 200}); 1`);
  await sleep(400);
  assert.equal(await A.ev('__world3d.hazards().length'), 1, 'telegraphed');
  assert.equal(await A.ev('__world3d.hp()'), 100, 'no damage during the tell');

  // 1b. unpinned, the schedule reads Date.now() plus a measured server offset and nothing else
  await A.ev('__world3d.hazardClock(null); 1');
  const drift = await A.ev('Math.abs(__world3d.hazardNow() - (Date.now() + __world3d.clockOffset()))');
  assert.ok(drift < 60, `the clock is Date.now() + offset (drift ${drift})`);
  const off = await A.ev('__world3d.clockOffset()');
  assert.ok(Number.isFinite(off) && Math.abs(off) < 120000, `the offset is a sane correction (${off})`);

  // 2. standing in it when it commits costs HP
  //    (re-pin the tell first: unpinning above dropped the view, and a view built after the
  //    tell has passed is a late join, which deliberately does not hit you)
  await A.ev(`__world3d.tp(${fb.x}, ${fb.z}); __world3d.hazardClock(${fb.tellMs}); 1`);
  await sleep(300);
  await A.ev(`__world3d.hazardClock(${fb.fireMs + 100}); 1`);
  await sleep(500);
  const hurt = await A.ev('__world3d.hp()');
  assert.ok(hurt < 100, `the fireball hurts (hp ${hurt})`);

  // 3. moving out of the next one in time costs nothing
  const fb2 = await pick('fireball', fb.n + 1);
  await A.ev(`__world3d.setHp(100); __world3d.hazardClock(null); 1`);
  await A.ev(`(() => { const a = Math.atan2(${fb2.z} - ${CZ}, ${fb2.x} - ${CX});
    __world3d.tp(${CX} - Math.cos(a) * 9, ${CZ} - Math.sin(a) * 9); })(); 1`);
  await A.ev(`__world3d.hazardClock(${fb2.tellMs}); 1`);
  await sleep(300);
  await A.ev(`__world3d.hazardClock(${fb2.fireMs + 100}); 1`);
  await sleep(500);
  assert.equal(await A.ev('__world3d.hp()'), 100, 'dodged costs nothing');

  // 4. quicksand slows but never damages
  const qs = await pick('quicksand', 0);
  await A.ev(`__world3d.hazardClock(null); __world3d.setHp(100); 1`);
  await A.ev(`__world3d.tp(${qs.x}, ${qs.z}); __world3d.hazardClock(${qs.fireMs + 100}); 1`);
  await sleep(500);
  assert.equal(await A.ev('__world3d.hp()'), 100, 'quicksand never damages');
  assert.ok(await A.ev('__world3d.slowed()') > 0, 'quicksand slows');

  // 5. a fainted player is not knocked out twice
  await A.ev(`__world3d.hazardClock(null); 1`);
  const fb3 = await pick('fireball', fb2.n + 1);
  await A.ev(`__world3d.setHp(1); __world3d.tp(${fb3.x}, ${fb3.z}); 1`);
  await A.ev(`__world3d.hazardClock(${fb3.tellMs}); 1`); // read the tell, then stay put
  await sleep(300);
  await A.ev(`__world3d.hazardClock(${fb3.fireMs + 100}); 1`);
  await sleep(600);
  assert.equal(await A.ev(`!document.getElementById('death').hidden`), true, 'knocked out once');
  const deaths = await A.ev('__world3d.arena.deaths');
  await A.ev(`__world3d.hazardClock(${fb3.fireMs + 300}); 1`);
  await sleep(600);
  assert.equal(await A.ev('__world3d.arena.deaths'), deaths, 'a fainted player is not killed again');

  // 5b. the boulder's telegraphed lane points where the boulder actually rolls
  const bo = await pick('boulder', 0);
  await A.ev(`__world3d.hazardClock(${bo.tellMs + 200}); 1`);
  await sleep(400);
  const lane = JSON.parse(await A.ev(`(() => {
    const m = __world3d.hazards()[0].lane; m.updateMatrixWorld(true);
    const V = m.position.constructor, Q = m.quaternion.constructor;
    const d = new V(0, 1, 0).applyQuaternion(m.getWorldQuaternion(new Q()));
    return JSON.stringify([d.x, d.z]);
  })()`));
  const cross = Math.abs(lane[0] * Math.cos(bo.angle) - lane[1] * Math.sin(bo.angle));
  assert.ok(cross < 0.02, `the lane is parallel to the roll (cross ${cross})`);

  // 5c. spikes you are standing on do not cage you for twelve seconds
  const sp = await pick('spikes', 0);
  await A.ev(`__world3d.hazardClock(null); __world3d.setHp(100); 1`);
  await A.ev(`__world3d.tp(${sp.x}, ${sp.z}); __world3d.hazardClock(${sp.tellMs}); 1`);
  await sleep(300);
  await A.ev(`__world3d.hazardClock(${sp.fireMs + 400}); 1`);
  await sleep(400);
  const was = JSON.parse(await A.ev('JSON.stringify([__world3d.P.x, __world3d.P.z])'));
  for (let i = 0; i < 20; i++) await A.key('KeyW', 'w', 60);
  const now = JSON.parse(await A.ev('JSON.stringify([__world3d.P.x, __world3d.P.z])'));
  assert.ok(Math.hypot(now[0] - was[0], now[1] - was[1]) > 0.8, 'you can walk out of the spikes');

  // 5d. coming back to a tab mid-hazard does not detonate it on you
  await A.ev(`__world3d.hazardClock(null); __world3d.setHp(100); 1`);
  const sp2 = await pick('spikes', sp.n + 1);
  await A.ev(`__world3d.tp(${sp2.x}, ${sp2.z}); 1`);
  await A.ev(`__world3d.hazardClock(${sp2.fireMs + 4000}); 1`); // the tell happened while the tab slept
  await sleep(500);
  assert.equal(await A.ev('__world3d.hp()'), 100, 'a hazard already in progress does not hit you on arrival');

  // 6. hazards never fire outside the arena
  await A.go(`${BASE}/game/world3d/?area=city&hour=13`);
  assert.ok(await booted(A));
  await sleep(1000);
  assert.equal(await A.ev('__world3d.hazards().length'), 0, 'the city has no hazards');

  // 7. with no multiplayer at all, the pit still runs its schedule
  await A.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13&nomp=1`);
  assert.ok(await booted(A));
  await sleep(1000);
  assert.equal(await A.ev('__world3d.mp.live'), false, 'no multiplayer');
  const fb4 = await pick('fireball', 0);
  await A.ev(`__world3d.hazardClock(${fb4.tellMs + 200}); 1`);
  await sleep(400);
  assert.equal(await A.ev('__world3d.hazards().length'), 1, 'hazards run offline');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
