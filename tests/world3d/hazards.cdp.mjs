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

  // 2. standing in it when it commits costs HP
  await A.ev(`__world3d.tp(${fb.x}, ${fb.z}); 1`);
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
  await A.ev(`__world3d.hazardClock(${fb3.fireMs + 100}); 1`);
  await sleep(600);
  assert.equal(await A.ev(`!document.getElementById('death').hidden`), true, 'knocked out once');
  const deaths = await A.ev('__world3d.arena.deaths');
  await A.ev(`__world3d.hazardClock(${fb3.fireMs + 300}); 1`);
  await sleep(600);
  assert.equal(await A.ev('__world3d.arena.deaths'), deaths, 'a fainted player is not killed again');

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
