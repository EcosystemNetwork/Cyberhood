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
