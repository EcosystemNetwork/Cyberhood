import test from 'node:test';
import assert from 'node:assert/strict';
import { ARENA_CENTER, ARENA_RADIUS, STAND_TIERS, standY, standBlocked } from '../game/world3d/arena.js';

const [CX, CZ] = ARENA_CENTER, R = ARENA_RADIUS;
const at = (r, a = 0) => [CX + Math.cos(a) * r, CZ + Math.sin(a) * r];

test('arena constants match the page', () => {
  assert.deepEqual(ARENA_CENTER, [18, 17]);
  assert.equal(ARENA_RADIUS, 14);
  assert.deepEqual(STAND_TIERS.map((t) => t.top), [2.6, 3.8, 5.0]);
});

test('each tier is a step up and the pit floor is zero', () => {
  assert.equal(standY(...at(R - 3)), 0, 'the sand is at ground level');
  assert.equal(standY(...at(R + 1.5)), 2.6);
  assert.equal(standY(...at(R + 3.2)), 3.8);
  assert.equal(standY(...at(R + 4.8)), 5.0);
  assert.equal(standY(...at(R + 9)), 0, 'outside the stands');
});

test('the rail keeps spectators out of the pit and inside the outer edge', () => {
  assert.equal(standBlocked(...at(R - 1)), true, 'cannot walk into the pit');
  assert.equal(standBlocked(...at(R + 3)), false, 'the tiers are walkable');
  assert.equal(standBlocked(...at(R + 8)), true, 'blocked beyond the outer rail');
});

test('the stand gate opens to the north only', () => {
  assert.equal(standBlocked(...at(R + 8, -Math.PI / 2)), false, 'the north gate is open');
  assert.equal(standBlocked(...at(R + 8, Math.PI / 2)), true, 'the south side is not');
});

import { PERIOD_MS, TELL_MS, HAZARD_IDS, HAZARDS, eventAt, eventsNear } from '../game/world3d/arena.js';

test('the gap between events is 60s give or take 1 to 10 seconds', () => {
  for (let n = 0; n < 5000; n++) {
    const gap = eventAt(n + 1).fireMs - eventAt(n).fireMs;
    assert.ok(gap >= 50000 && gap <= 70000, `n=${n} gap ${gap} outside 60s +/- 10s`);
    assert.ok(Math.abs(gap - 60000) >= 1000, `n=${n} gap ${gap} is closer than 1s to exactly 60s`);
  }
});

test('eventAt is pure and lands every hazard inside the pit', () => {
  for (let n = 0; n < 2000; n++) {
    const e = eventAt(n);
    assert.deepEqual(e, eventAt(n), 'same n, same event');
    assert.ok(HAZARD_IDS.includes(e.kind));
    assert.ok(Math.hypot(e.x - CX, e.z - CZ) <= R - 1.5, `n=${n} landed outside the sand`);
  }
});

test('no hazard repeats back to back, and every kind gets used', () => {
  const seen = new Set();
  for (let n = 0; n < 2000; n++) {
    const k = eventAt(n).kind;
    assert.notEqual(k, eventAt(n - 1).kind, `n=${n} repeats ${k}`);
    seen.add(k);
  }
  assert.deepEqual([...seen].sort(), [...HAZARD_IDS].sort());
});

test('eventsNear returns only what is on screen right now, never a backlog', () => {
  const e = eventAt(100);
  assert.deepEqual(eventsNear(e.tellMs + 10).map((x) => x.n), [100], 'visible during the tell');
  assert.deepEqual(eventsNear(e.endMs + 1).map((x) => x.n), [], 'gone once it expires');
  const quiet = eventsNear(e.endMs + 20000);
  assert.ok(quiet.length <= 1, 'returning after a long gap surfaces at most the current event');
});

test('quicksand lives for ten seconds and every hazard is told 2.5s ahead', () => {
  assert.equal(HAZARDS.quicksand.life, 10000);
  for (const k of HAZARD_IDS) assert.equal(HAZARDS[k].tell, TELL_MS);
  const e = eventAt(7);
  assert.equal(e.fireMs - e.tellMs, 2500);
  assert.equal(PERIOD_MS, 60000);
});
