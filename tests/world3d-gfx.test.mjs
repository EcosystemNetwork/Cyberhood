import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, ORDER, FAIR_KEYS, pickPreset, nextPreset, pixelRatio, createGovernor } from '../game/world3d/gfx.js';

test('fairness: presets only touch looks, never what a player reacts to', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.deepEqual(Object.keys(p).sort(), [...FAIR_KEYS].sort(), name);
  }
});

test('presets climb in cost from low to high', () => {
  for (let i = 1; i < ORDER.length; i++) {
    const a = PRESETS[ORDER[i - 1]], b = PRESETS[ORDER[i]];
    assert.ok(b.maxPixelRatio >= a.maxPixelRatio && b.shadowMap >= a.shadowMap && b.rain >= a.rain);
  }
});

test('the defaults are what phones and desktops got before presets', () => {
  assert.equal(pickPreset({ phone: true }), 'low');
  assert.equal(pickPreset({ phone: false }), 'high');
  assert.deepEqual([PRESETS.low.maxPixelRatio, PRESETS.low.shadowMap, PRESETS.low.bloom], [1.25, 1024, false]);
  assert.deepEqual([PRESETS.high.maxPixelRatio, PRESETS.high.shadowMap, PRESETS.high.bloom], [2, 2048, true]);
});

test('the URL beats the saved choice, which beats the default; junk is ignored', () => {
  assert.equal(pickPreset({ url: 'medium', saved: 'low', phone: false }), 'medium');
  assert.equal(pickPreset({ saved: 'low', phone: false }), 'low');
  assert.equal(pickPreset({ url: 'ultra', saved: 'nope', phone: true }), 'low');
});

test('the preset button cycles low, medium, high, low', () => {
  assert.deepEqual([nextPreset('low'), nextPreset('medium'), nextPreset('high')], ['medium', 'high', 'low']);
});

test('pixel ratio is capped by the preset and scaled by the governor', () => {
  assert.equal(pixelRatio('high', 3), 2);
  assert.equal(pixelRatio('low', 3), 1.25);
  assert.equal(pixelRatio('high', 1), 1);
  assert.equal(pixelRatio('high', 2, 0.5), 1);
  assert.equal(pixelRatio('medium', NaN), 1);
});

// play `n` frames of `ms` each through the governor, starting at time t
function play(g, ms, n, t = 0) {
  for (let i = 0; i < n; i++) { t += ms; g.push(ms, t); }
  return t;
}

test('a slow machine steps down, but never below the floor', () => {
  const g = createGovernor({ min: 0.68 });
  play(g, 40, 5000);
  assert.equal(g.scale, 0.68);
});

test('a fast machine stays at full scale', () => {
  const g = createGovernor();
  play(g, 8, 2000);
  assert.equal(g.scale, 1);
});

test('one hitch in a smooth run does not move it', () => {
  const g = createGovernor();
  let t = 0;
  for (let i = 0; i < 400; i++) { const ms = i % 100 === 50 ? 120 : 16.7; t += ms; g.push(ms, t); }
  assert.equal(g.scale, 1);
});

test('it waits out the cooldown between steps', () => {
  const g = createGovernor({ cooldownMs: 2000 });
  const t = play(g, 40, 45);          // one window: one step down
  assert.equal(g.scale, 0.92);
  play(g, 40, 45, t);                 // 1.8 s later, still cooling down
  assert.equal(g.scale, 0.92);
});

test('it climbs back once the slow patch passes', () => {
  const g = createGovernor();
  let t = play(g, 40, 3000);
  assert.ok(g.scale < 1);
  play(g, 8, 6000, t);
  assert.equal(g.scale, 1);
});

test('a hidden tab (huge frames) is ignored', () => {
  const g = createGovernor();
  play(g, 1000, 500);
  assert.equal(g.scale, 1);
});

test('vsync at 60 Hz holds steady at full scale', () => {
  const g = createGovernor();
  play(g, 1000 / 60, 5000);
  assert.equal(g.scale, 1);
});
