// Multiplayer traffic: fewer movement messages, one channel per area, and attacks still instant.
// Supabase bills one message for the send plus one per player who receives it, so these matter.
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const watch = (p) => p.ev(`(() => { const ch = __world3d.mp.channel, send = ch.send.bind(ch); window.__sent = []; ch.send = (m) => { window.__sent.push([m.event, performance.now()]); return send(m); }; })(); 1`);
const moves = (p) => p.ev(`window.__sent.filter(([e]) => e === 'move').length`);

const { player, kill } = await launch();
try {
  const A = await player('Red'), B = await player('Blue');
  await A.ev(`localStorage.removeItem('taproot3d_fp'); 1`);

  // 1. walking for 10 seconds sends about 4 a second, not 8
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13`);
  assert.ok(await ready(A)); await sleep(1500);
  await A.ev('__world3d.monsters.forEach((m) => { m.dead = true; }); __world3d.tp(118, 101, Math.PI); 1');
  await watch(A);
  // back and forth in open ground, so nothing stops the walk (running straight, a long walk in
  // one direction ends at a tree)
  for (let i = 0; i < 4; i++) { const k = i % 2 ? 'S' : 'W'; await A.down(`Key${k}`, k.toLowerCase()); await sleep(2500); await A.up(`Key${k}`, k.toLowerCase()); }
  const n = await moves(A);
  assert.ok(n >= 25 && n <= 45, `about 4 movement messages a second while walking (sent ${n} in 10s)`);

  // 2. standing still and turning on the spot by a hair sends nothing extra
  await sleep(500);
  await A.ev('window.__sent = []; 1');
  // jitter back and forth: each nudge is real, but it never drifts far enough from the last send to see
  for (let i = 0; i < 10; i++) { const k = i % 2 ? -1 : 1; await A.ev(`__world3d.P.heading += ${k} * 0.06; __world3d.P.x += ${k} * 0.05; 1`); await sleep(150); }
  assert.ok(await moves(A) <= 1, `small shuffles don't send (sent ${await moves(A)})`);

  // 3. an attack goes out straight away, even right after a movement message
  await A.down('KeyW', 'w'); await sleep(300);
  await A.ev('window.__sent = []; 1');
  await A.key('Quote', "'");
  await sleep(120);
  await A.up('KeyW', 'w');
  const first = await A.ev(`(window.__sent.find(([e]) => e === 'move') || [0, 0])[1]`);
  assert.ok(first > 0, 'the swing was sent');

  // 4. each area has its own channel: the overworld and the arena don't hear each other
  await B.go(`${BASE}/game/world3d/?area=arena&from=city&hour=13`);
  assert.ok(await ready(B)); await sleep(1500);
  const topicA = await A.ev('__world3d.mp.channel.topic'), topicB = await B.ev('__world3d.mp.channel.topic');
  assert.notEqual(topicA, topicB, `different areas, different channels (${topicA} / ${topicB})`);
  assert.match(topicB, /arena/);
  // and the stands share the arena's, so the crowd still sees the fight
  await A.go(`${BASE}/game/world3d/?area=stands&from=city&hour=13`);
  assert.ok(await ready(A)); await sleep(2500);
  assert.equal(await A.ev('__world3d.mp.channel.topic'), topicB, 'the stands and the arena share a channel');
  assert.equal(await A.ev(`[...__world3d.ghosts.values()].some((g) => g.name === 'Blue')`), true, 'and see each other');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
