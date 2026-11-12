// The drop crate: smashing it releases the prize, the first player to touch it claims it,
// nobody else gets it, and it wears off.
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.ev(`localStorage.removeItem('taproot3d_fp'); 1`);
  await A.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  await B.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  assert.ok(await ready(A));
  assert.ok(await ready(B));
  await sleep(2500);

  const pick = async (p, kind, from) => JSON.parse(await p.ev(
    `JSON.stringify((() => { const a = __world3d.arenaMod; for (let n = ${from}; n < ${from} + 500; n++) { const x = a.eventAt(n); if (x.kind === '${kind}') return x; } })())`));
  const c = await pick(A, 'crate', 0);
  const BUFF_MS = await A.ev(`__world3d.arenaMod.BUFFS[__world3d.arenaMod.buffAt(${c.n})].ms`);

  // both clients watch the same crate land
  await A.ev(`__world3d.hazardClock(${c.fireMs + 100}); __world3d.tp(${c.x}, ${c.z + 1.4}); __world3d.P.heading = Math.PI; 1`);
  await B.ev(`__world3d.hazardClock(${c.fireMs + 100}); __world3d.tp(${c.x + 6}, ${c.z}); 1`);
  await sleep(500);
  assert.equal(await A.ev('__world3d.hazards().length'), 1, 'the crate is in the pit');

  // 1. smashing the crate does NOT hand you the buff — it lets the prize out
  for (let i = 0; i < 8; i++) { await A.key('Quote', "'"); await sleep(260); }
  assert.equal(await A.ev('__world3d.buff()'), null, 'smashing is not claiming');
  assert.equal(await A.ev('!!__world3d.hazards()[0].pickup'), true, 'the pickup is out');

  // 2. first to touch it claims it
  await A.ev(`__world3d.tp(${c.x}, ${c.z}); 1`);
  await sleep(700);
  assert.ok(await A.ev('__world3d.buff()'), 'the toucher gets it');

  // 3. the loser does not
  await B.ev(`__world3d.tp(${c.x}, ${c.z}); 1`);
  await sleep(900);
  assert.equal(await B.ev('__world3d.buff()'), null, 'one claim only');

  // 4. it wears off
  await sleep(BUFF_MS + 800);
  assert.equal(await A.ev('__world3d.buff()'), null, 'the buff expires');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
