// Arena: the Hero Hall door leads in; sword and fireball hits sync; a knockout respawns at the plaza.
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.go(`${BASE}/game/world3d/?area=city&hour=13`);
  assert.ok(await ready(A));
  await A.ev(`__world3d.tp(118.5, 90.5); 1`); await sleep(2500); // the colosseum's red gate
  assert.equal(await A.ev('location.search'), '?area=arena&from=city');
  await B.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  assert.ok(await ready(A)); assert.ok(await ready(B));
  await sleep(2500);
  const hpB = () => B.ev('__world3d.hp()');
  assert.equal(await hpB(), 100);
  for (let i = 0; i < 3; i++) { await B.ev(`__world3d.tp(18, 16); 1`); await A.ev(`__world3d.tp(18, 16.9); __world3d.P.heading = Math.PI; 1`); await A.key('Quote', "'"); await sleep(500); }
  assert.ok((await hpB()) < 100, 'sword hurts');
  for (let i = 0; i < 30 && (await hpB()) > 0; i++) { await B.ev(`__world3d.tp(18, 16); 1`); await A.ev(`__world3d.tp(18, 16.9); __world3d.P.heading = Math.PI; 1`); await A.key('Quote', "'"); await sleep(450); }
  await sleep(400);
  assert.equal(await B.ev(`!document.getElementById('death').hidden`), true);
  assert.equal(await A.ev('__world3d.arena.kills'), 1);
  await sleep(4500);
  assert.equal(await B.ev('location.search'), '?area=city&from=respawn');
  console.log('PASS');
} finally { kill(); }
process.exit(0);
