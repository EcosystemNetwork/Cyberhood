// The walking pet's brain (game/world3d/petbrain.js), on a fake map with fake time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPetBrain, TUNE } from '../game/world3d/petbrain.js';

function world({ wall } = {}) {
  const P = { x: 10, z: 10, heading: 0 };
  const monsters = [], drops = [], got = [];
  const g = { position: { set(x, y, z) { Object.assign(this, { x, y, z }); } }, rotation: {}, scale: {}, removeFromParent() { g.gone = true; } };
  // `wall`: a solid line x = wall.x for z in [wall.z0, wall.z1]
  const free = (x, z) => !(wall && Math.abs(x - wall.x) < 0.4 && z > wall.z0 && z < wall.z1);
  const brain = createPetBrain({ player: P, free, monsters: () => monsters, drops: () => drops, collect: (d) => { d.taken = 1; got.push(d); },
    makePet: () => g, isFlyer: () => false });
  const pet = { id: 1, kind: 'mosskit' };
  const run = (secs, each) => { for (let t = 0; t < secs; t += 0.05) { each && each(); brain.tick(0.05, pet); } };
  const dist = () => Math.hypot(brain.state.x - P.x, brain.state.z - P.z);
  return { P, monsters, drops, got, brain, run, dist, g };
}

test('follows you as you walk, a little behind', () => {
  const w = world();
  w.run(0.5);
  w.run(4, () => { w.P.z += 4 * 0.05; }); // walking +z at 4 tiles a second
  assert.equal(w.brain.state.mode, 'follow');
  assert.ok(w.dist() < 3, `close behind (${w.dist().toFixed(2)})`);
  assert.ok(w.brain.state.z < w.P.z, 'behind you');
});

test('idles near you when you stop: wanders, never strays', () => {
  const w = world();
  w.run(5);
  assert.equal(w.brain.state.mode, 'idle');
  let far = 0;
  w.run(10, () => { far = Math.max(far, w.dist()); });
  assert.ok(far < TUNE.idleWander + 1.5, `stayed near (${far.toFixed(2)})`);
});

test('fetches loot near you, ignores loot far away', () => {
  const w = world();
  w.run(2);
  w.drops.push({ x: 13, z: 12, ready: true }, { x: 30, z: 30, ready: true });
  w.run(4);
  assert.equal(w.got.length, 1);
  assert.equal(w.got[0].x, 13);
  assert.equal(w.brain.state.grabbed, 1);
});

test('wary of a monster near you: tucks in on your far side', () => {
  const w = world();
  w.run(2);
  w.monsters.push({ x: 13, z: 10, hp: 30, dead: false });
  w.run(3);
  assert.equal(w.brain.state.mode, 'wary');
  assert.ok(w.brain.state.x < w.P.x, 'on the side away from the monster');
  // and it won't fetch from under the monster's nose... until it's gone
  w.drops.push({ x: 12.5, z: 10.5, ready: true });
  w.run(1);
  assert.equal(w.got.length, 0);
  w.monsters[0].dead = true;
  w.run(3);
  assert.equal(w.got.length, 1);
});

test('runs back past the leash, warps when far', () => {
  const w = world();
  w.run(2);
  w.P.z += TUNE.leash + 3; // you dashed off
  w.brain.tick(0.05, { id: 1, kind: 'mosskit' });
  assert.equal(w.brain.state.mode, 'return');
  w.run(3);
  assert.ok(w.dist() < TUNE.leash, 'back within the leash');
  w.P.z += TUNE.warp + 10; // you went through a gate, far away
  w.run(0.1);
  assert.ok(w.dist() < 2, `warped to you (${w.dist().toFixed(2)})`);
});

test('walks around a wall, and warps if it is truly stuck', () => {
  const w = world({ wall: { x: 12, z0: 6, z1: 14 } });
  w.run(1);
  w.P.x = 16; // you're on the far side of a short wall
  w.run(6);
  assert.ok(w.dist() < 3, `got round it (${w.dist().toFixed(2)})`);
  const box = world({ wall: { x: 12, z0: -1e9, z1: 1e9 } }); // an endless wall: no way round
  box.run(1);
  box.P.x = 15;
  box.run(6);
  assert.ok(box.dist() < 2.5, `stuck, so it warped (${box.dist().toFixed(2)})`);
});

test('goes away when no pet is out', () => {
  const w = world();
  w.run(0.5);
  w.brain.tick(0.05, null);
  assert.equal(w.brain.state, null);
  assert.ok(w.g.gone);
});
