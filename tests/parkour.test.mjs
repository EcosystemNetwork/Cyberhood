// Ledge grabs, climbs and the dodge roll (game/world3d/parkour.js).   node --test tests/parkour.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { findLedge, climbPose, CLIMB_TIME, REACH, ROLL, ROLL_DIST, rollSpeed, rollPose, rollSafe } from '../game/world3d/parkour.js';
import { PLAYER_SPEED, MOVE_SLACK, JITTER } from '../game/world3d/economy.js';

// a world of unit cells: "i,j,k" keys are solid
const world = (cells) => { const s = new Set(cells.map((c) => c.join())); return (x, y, z) => s.has([Math.floor(x), Math.floor(z), Math.floor(y)].join()); };
const stack = (i, j, h) => Array.from({ length: h }, (_, k) => [i, j, k]);

test('a two-high wall is caught mid-jump and climbed onto its top', () => {
  const solid = world(stack(5, 5, 2));
  // touching the wall's +z face (z = 6.2 with a 0.2 deep hitbox), moving toward -z, feet 0.8 up
  const l = findLedge(solid, 5.5, 6.2, 0.8, 0, -1);
  assert.ok(l);
  assert.equal(l.top, 2);
  assert.ok(l.z1 > 5 && l.z1 < 6, `lands on the block (z1=${l.z1})`);
  assert.equal(l.x1, 5.5);
  assert.ok(Math.abs(l.face - Math.atan2(0, -1)) < 1e-9);
  // three high is caught from higher in the jump only
  assert.equal(findLedge(world(stack(5, 5, 3)), 5.5, 6.2, 0.5, 0, -1), null);
  assert.equal(findLedge(world(stack(5, 5, 3)), 5.5, 6.2, 1.0, 0, -1)?.top, 3);
  assert.ok(3 <= 1.0 + REACH);
});

test('too high, too low, no room on top, or a ceiling overhead: no ledge', () => {
  assert.equal(findLedge(world(stack(5, 5, 4)), 5.5, 6.2, 0.8, 0, -1), null, 'four high is out of reach');
  assert.equal(findLedge(world(stack(5, 5, 1)), 5.5, 6.2, 0.8, 0, -1), null, 'a single block is just jumped onto');
  // a block two above the ledge's top leaves only one cell of headroom
  assert.equal(findLedge(world([...stack(5, 5, 2), [5, 5, 3]]), 5.5, 6.2, 0.8, 0, -1), null);
  // a ceiling over your own head
  assert.equal(findLedge(world([...stack(5, 5, 2), [5, 6, 2]]), 5.5, 6.2, 0.8, 0, -1), null);
  assert.equal(findLedge(world(stack(5, 5, 2)), 5.5, 6.2, 0.8, 0, 0), null, 'not moving');
});

test('a diagonal push climbs the face you are against, not the corner', () => {
  const solid = world(stack(7, 5, 2));
  const l = findLedge(solid, 6.72, 5.5, 1, 0.9, 0.3); // against the -x face, pushing mostly +x
  assert.ok(l);
  assert.ok(l.x1 > 7 && l.x1 < 8);
  assert.equal(l.z1, 5.5);
});

test('a climb hangs, pulls up past the edge and steps onto the top', () => {
  const l = findLedge(world(stack(5, 5, 2)), 5.5, 6.2, 0.8, 0, -1);
  const a = climbPose(l, 0), mid = climbPose(l, CLIMB_TIME * 0.55), end = climbPose(l, CLIMB_TIME + 0.01);
  assert.equal(a.y, 0.8);
  assert.equal(a.phase, 'hang');
  assert.equal(mid.phase, 'pull');
  assert.ok(mid.y > l.hangY && mid.y < l.top);
  assert.equal(end.done, true);
  assert.equal(end.y, 2);
  assert.ok(Math.abs(end.z - l.z1) < 1e-9);
  // it never rises above the ledge or moves forward before the feet are up
  for (let t = 0; t < CLIMB_TIME; t += 0.01) {
    const p = climbPose(l, t);
    assert.ok(p.y <= l.top + 1e-9);
    if (p.y < l.top - 1e-9) assert.equal(p.z, l.z0);
  }
});

test('a dodge roll somersaults once, and back-to-back rolls stay inside the sprint check', () => {
  assert.ok(rollSpeed(0) > PLAYER_SPEED, 'a roll starts faster than a sprint');
  assert.ok(rollSpeed(ROLL.time) < PLAYER_SPEED);
  // the distance it covers matches ROLL_DIST
  let d = 0;
  for (let t = 0; t < ROLL.time; t += 0.001) d += rollSpeed(t) * 0.001;
  assert.ok(Math.abs(d - ROLL_DIST) < 0.02, `${d} vs ${ROLL_DIST}`);
  // rolling every cooldown and sprinting in between: within what the server lets through
  const perCycle = ROLL_DIST + (ROLL.cd - ROLL.time) * PLAYER_SPEED;
  assert.ok(perCycle / ROLL.cd <= PLAYER_SPEED * MOVE_SLACK, `${perCycle / ROLL.cd} tiles a second`);
  assert.ok(ROLL_DIST < JITTER * 2 + PLAYER_SPEED * ROLL.time);
  const p0 = rollPose(0), pe = rollPose(ROLL.time);
  assert.equal(p0.spin, 0);
  assert.ok(Math.abs(pe.spin - Math.PI * 2) < 1e-9);
  assert.ok(Math.abs(pe.up) < 1e-9 && Math.abs(pe.back) < 1e-9, 'ends standing where the hips were');
  assert.ok(rollPose(ROLL.time / 2).up > 0.9, 'upside down halfway, hips stay put');
  assert.equal(rollSafe(0.1), true);
  assert.equal(rollSafe(0.4), false);
});
