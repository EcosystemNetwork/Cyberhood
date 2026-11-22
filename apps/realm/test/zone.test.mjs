import test from 'node:test';
import assert from 'node:assert/strict';
import { Zone } from '../zone.mjs';
import { Grid } from '../grid.mjs';
import * as R from '../rules.mjs';

// a seeded random, so spawns and respawn timers are the same every run
function seeded(s = 1) { return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
const CFG = { id: 'test', w: 200, h: 200, start: { x: 100, z: 100 }, spawns: [] };
function zone(cfg = {}, opts = {}) { return new Zone({ ...CFG, ...cfg }, { rand: seeded(), ...opts }); }
function player(z, sid, at, now = 0) {
  const inbox = [];
  const p = z.addPlayer({ sid, name: sid.toUpperCase() }, (m) => inbox.push(m), now);
  if (at) z.place(p, at.x, at.z);
  return { p, inbox, last: (t) => inbox.filter((m) => m.t === t).at(-1) };
}

test('the grid finds what is near and nothing that is far', () => {
  const g = new Grid(16), a = { x: 5, z: 5 }, b = { x: 30, z: 5 }, c = { x: 150, z: 150 };
  [a, b, c].forEach((e) => g.add(e));
  assert.deepEqual([...g.near(0, 0, 40)].sort((p, q) => p.x - q.x), [a, b]);
  c.x = 10; c.z = 10; g.move(c);
  assert.equal([...g.near(0, 0, 20)].length, 2);
  g.remove(a);
  assert.deepEqual([...g.near(0, 0, 20)], [c]);
});

test('players see only who is in view: enter, update, gone', () => {
  const z = zone();
  const a = player(z, 'a', { x: 100, z: 100 }), b = player(z, 'b', { x: 110, z: 100 }), far = player(z, 'c', { x: 190, z: 190 });
  z.snapshot();
  const s = a.last('s');
  assert.deepEqual(s.e, [['p', 'b', 'B']]);
  assert.equal(s.u.length, 1);
  assert.equal(far.last('s').u.length, 0, 'the far player sees nobody');
  const n = a.inbox.length;
  z.snapshot();
  assert.equal(a.inbox.length, n, 'nothing moved: no snapshot at all');
  z.move('b', { x: 111, z: 100 }, 1000);
  z.snapshot();
  assert.equal(a.last('s').e, undefined, 'names are sent once');
  assert.deepEqual(a.last('s').u.map((x) => x[0]), ['b'], 'only what changed');
  z.place(b.p, 180, 180);
  z.snapshot();
  assert.deepEqual(a.last('s').g, ['b']);
  assert.deepEqual(far.last('s').e, [['p', 'b', 'B']]);
});

test('movement: a sprint is fine, a teleport is corrected, walls stop you', () => {
  const blocked = Array.from({ length: 200 }, (_, zz) => Array.from({ length: 200 }, (_, x) => x === 105 && zz < 150));
  const z = zone({ blocked });
  const { p, inbox } = player(z, 'a', null, 0);
  assert.equal(z.move('a', { x: 101, z: 100 }, 200), '');
  assert.equal(z.move('a', { x: 101, z: 160 }, 400), 'too fast');
  assert.deepEqual(inbox.at(-1), { t: 'fix', x: 101, z: 100 });
  assert.equal(z.move('a', { x: 106, z: 100 }, 5000), 'blocked', 'you cannot step through the wall');
  assert.equal(p.x, 101);
  // the budget refills with time: a steady sprint is never refused
  let x = 101, t = 5000;
  for (let i = 0; i < 50; i++) { t += 100; x -= R.PLAYER_SPEED * 0.1; assert.equal(z.move('a', { x, z: 100 }, t), ''); }
});

test('hits: reach, cooldown, cleave limit and the damage cap', () => {
  const z = zone({ spawns: [{ type: 'king', spot: [100, 101] }, { type: 'slime', spot: [140, 140] }] });
  const king = [...z.mobs.values()].find((m) => m.type === 'king'), slime = [...z.mobs.values()].find((m) => m.type === 'slime');
  player(z, 'a', { x: 100, z: 100 });
  assert.equal(z.hit('a', { id: slime.id, k: 'swing', a: 'a1', dmg: 5 }, 0), 'out of reach');
  assert.equal(z.hit('a', { id: king.id, k: 'swing', a: 'a1', dmg: 9999 }, 0), '');
  assert.equal(king.hp, 200 - R.maxHit('swing', R.DEFAULT_STATS), 'damage is capped by the player\'s stats');
  assert.equal(z.hit('a', { id: king.id, k: 'swing', a: 'a2', dmg: 5 }, 100), 'too fast');
  assert.equal(z.hit('a', { id: king.id, k: 'swing', a: 'a2', dmg: 5 }, 400), '');
  assert.equal(z.hit('a', { id: king.id, k: 'shot', a: 's1', dmg: 5 }, 400), '', 'a shot has its own cooldown');
  assert.equal(z.hit('a', { id: king.id, k: 'shot', a: 's1', dmg: 5 }, 400), 'too many targets');
  assert.equal(z.hit('a', { id: 'nope', k: 'swing', a: 'a3' }, 900), 'no such monster');
  assert.equal(z.hit('a', { id: king.id, k: 'fireball', a: 'a3' }, 900), 'bad hit');
});

test('a kill pays everyone who helped, and the monster comes back', () => {
  const kills = [];
  const z = zone({ spawns: [{ type: 'slime', spot: [100, 101] }] }, { onKill: (k) => kills.push(k) });
  const slime = [...z.mobs.values()][0];
  const a = player(z, 'a', { x: 100, z: 100 }), b = player(z, 'b', { x: 101, z: 100 }), lurker = player(z, 'c', { x: 99, z: 100 });
  z.hit('b', { id: slime.id, k: 'swing', a: 'b1', dmg: 5 }, 0);
  let t = 0;
  while (!slime.dead) { t += 400; z.hit('a', { id: slime.id, k: 'swing', a: 'x' + t, dmg: 99 }, t); }
  assert.equal(kills.length, 1);
  assert.deepEqual(kills[0].credits.sort(), ['a', 'b'], 'the bystander gets nothing');
  assert.equal(kills[0].xp, R.MONSTERS.slime.xp);
  assert.ok(a.inbox.some((m) => m.t === 'die' && m.id === slime.id));
  z.snapshot();
  assert.ok(!lurker.last('s').u.some((u) => u[0] === slime.id), 'a dead monster is out of view');
  z.tick(t); z.tick(t + 20000);
  assert.equal(slime.dead, false);
  assert.equal(slime.hp, R.MONSTERS.slime.hp);
});

test('monsters chase, bite, knock you out, and you wake at the start', () => {
  const z = zone({ spawns: [{ type: 'goblin', spot: [100, 104] }] });
  const gob = [...z.mobs.values()][0];
  const { p, inbox } = player(z, 'a', { x: 100, z: 100 });
  let t = 1;
  z.tick(t);
  for (let i = 0; i < 400 && !inbox.some((m) => m.t === 'ko'); i++) { t += 33; z.tick(t); }
  assert.equal(gob.target, null, 'the goblin forgets a knocked-out player');
  assert.ok(inbox.filter((m) => m.t === 'ouch').length >= Math.ceil(R.PLAYER_HP / R.MONSTERS.goblin.dmg));
  assert.deepEqual([p.x, p.z, p.hp], [100, 100, R.PLAYER_HP]);
});

test('a monster led too far from home gives up and heals', () => {
  const z = zone({ spawns: [{ type: 'slime', spot: [50, 50] }] });
  const slime = [...z.mobs.values()][0];
  const { p } = player(z, 'a', { x: 50, z: 52 });
  z.hit('a', { id: slime.id, k: 'swing', a: 'a1', dmg: 5 }, 0);
  let t = 1;
  z.tick(t);
  // kite it away, faster than it walks
  for (let i = 0; i < 600 && !slime.evade; i++) { t += 33; z.place(p, p.x, Math.min(199, p.z + 0.06)); z.tick(t); }
  assert.equal(slime.evade, true);
  assert.equal(slime.hp, R.MONSTERS.slime.hp);
  assert.equal(slime.target, null);
});

test('chat reaches those nearby, and only so fast', () => {
  const z = zone();
  const a = player(z, 'a', { x: 100, z: 100 }), near = player(z, 'b', { x: 105, z: 100 }), far = player(z, 'c', { x: 190, z: 190 });
  assert.equal(z.say('a', ' hi\u0007 there ', 0), '');
  assert.deepEqual(near.last('say'), { t: 'say', id: 'a', name: 'A', msg: 'hi  there' });
  assert.equal(far.last('say'), undefined);
  for (let i = 0; i < 4; i++) z.say('a', 'x', 10 + i);
  assert.equal(z.say('a', 'spam', 20), 'too fast');
  assert.equal(z.say('a', 'later', 6000), '');
  assert.ok(a.inbox.some((m) => m.t === 'say'));
});

test('a crowded zone still costs little per tick', () => {
  const z = zone({ w: 2000, h: 2000, start: { x: 1000, z: 1000 }, spawns: [{ type: 'slime', count: 500, box: [0, 0, 2000, 2000] }] });
  const rand = seeded(7);
  for (let i = 0; i < 1000; i++) { const { p } = player(z, 'p' + i); z.place(p, rand() * 2000, rand() * 2000); }
  const t0 = performance.now();
  for (let i = 1; i <= 30; i++) { z.tick(i * 33); if (i % 3 === 0) z.snapshot(); }
  const perTick = (performance.now() - t0) / 30;
  assert.ok(perTick < 33, `1000 players + 500 monsters: ${perTick.toFixed(2)} ms a tick`);
});

test('in a crowd, a snapshot holds only the nearest few, and only what moved', () => {
  const z = zone({}, { maxView: 5 });
  const me = player(z, 'me', { x: 100, z: 100 });
  for (let i = 1; i <= 20; i++) player(z, 'p' + i, { x: 100 + i, z: 100 });
  z.snapshot();
  const s = me.last('s');
  assert.deepEqual(s.e.map((e) => e[1]), ['p1', 'p2', 'p3', 'p4', 'p5']);
  // p3 walks off; p6 is now among the nearest five
  z.place(z.players.get('p3'), 100, 150);
  z.snapshot();
  const s2 = me.last('s');
  assert.deepEqual(s2.g, ['p3']);
  assert.deepEqual(s2.e.map((e) => e[1]), ['p6']);
  assert.deepEqual(s2.u.map((u) => u[0]), ['p6'], 'the four who stood still are not resent');
});

test('a packed town (300 players in one spot) still fits the tick budget', () => {
  const z = zone();
  const rand = seeded(3);
  // a send that only measures, like a socket would (the other tests' inboxes keep everything)
  let bytes = 0;
  for (let i = 0; i < 300; i++) { const p = z.addPlayer({ sid: 'q' + i, name: 'Q' + i }, (m) => { bytes += JSON.stringify(m).length; }, 0); z.place(p, 90 + rand() * 20, 90 + rand() * 20); }
  // everyone shuffles about at 30 Hz; the realm sends a third of the snapshots each tick
  const run = (from, ticks) => {
    for (let i = from; i < from + ticks; i++) {
      for (const p of z.players.values()) z.move(p.id, { x: p.x + (rand() - 0.5) * 0.4, z: p.z + (rand() - 0.5) * 0.4 }, i * 33);
      z.tick(i * 33);
      z.snapshot(i % 3, 3);
    }
  };
  run(1, 30); // warm up (1 s)
  bytes = 0;
  const t0 = performance.now();
  run(31, 60); // then measure 2 s
  const perTick = (performance.now() - t0) / 60;
  console.log(`# packed town: ${perTick.toFixed(2)} ms a tick, ${(bytes / 300 / 2 / 1024).toFixed(1)} KB a player a second`);
  // the budget is 33 ms (30 Hz); this is the worst case: everyone in view of everyone, moving every tick
  assert.ok(perTick < 28, `300 players in one spot: ${perTick.toFixed(2)} ms a tick`);
});
