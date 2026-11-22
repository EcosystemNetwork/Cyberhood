import test from 'node:test';
import assert from 'node:assert/strict';
import { SLOT_MS, BLEND_MS, BOX, DISTRICT_RAIN, slotRain, rainAt, rainPlan, wetSpawn, seeded } from '../game/world3d/weather.js';

// find a slot where `wet` rains and `dry` doesn't
function splitSlot(wet, dry) {
  for (let s = 0; s < 5000; s++) if (slotRain(wet, s) > 0 && slotRain(dry, s) === 0) return s;
  throw new Error('no split slot');
}
// a world: x < 0 is the Woods, x >= 0 is the City
const halves = (x) => (x < 0 ? 'Taproot Woods' : 'Taproot City');

test('the same moment gives the same weather on every machine', () => {
  const ms = Date.UTC(2026, 10, 21, 12, 3);
  for (const d of Object.keys(DISTRICT_RAIN)) assert.equal(rainAt(d, ms), rainAt(d, ms));
});

test('no district and indoors-style nulls stay dry', () => {
  assert.equal(rainAt(null, 0), 0);
  assert.equal(rainAt(undefined, 123456), 0);
});

test('rain is 0 or between a drizzle and a downpour', () => {
  for (let s = 0; s < 2000; s++) {
    const r = slotRain('Taproot Woods', s);
    assert.ok(r === 0 || (r >= 0.35 && r <= 1), `slot ${s}: ${r}`);
  }
});

test('the wettest district rains most often, and about as often as its chance', () => {
  const share = (d) => { let n = 0; for (let s = 0; s < 20000; s++) if (slotRain(d, s) > 0) n++; return n / 20000; };
  const woods = share('Taproot Woods'), city = share('Taproot City');
  assert.ok(woods > city);
  assert.ok(Math.abs(woods - DISTRICT_RAIN['Taproot Woods']) < 0.03, `woods ${woods}`);
  assert.ok(Math.abs(city - DISTRICT_RAIN['Taproot City']) < 0.03, `city ${city}`);
});

test('fronts are shared: whenever the dry City rains, the Woods rains too', () => {
  for (let s = 0; s < 5000; s++) if (slotRain('Taproot City', s) > 0) assert.ok(slotRain('Taproot Woods', s) > 0, `slot ${s}`);
});

test('a storm eases in over the last stretch of a slot instead of switching on', () => {
  let s = 0;
  while (!(slotRain('Taproot Woods', s) === 0 && slotRain('Taproot Woods', s + 1) > 0)) s++;
  const end = (s + 1) * SLOT_MS;
  assert.equal(rainAt('Taproot Woods', end - BLEND_MS - 1), 0);
  const mid = rainAt('Taproot Woods', end - BLEND_MS / 2);
  assert.ok(mid > 0 && mid < slotRain('Taproot Woods', s + 1));
  assert.ok(Math.abs(rainAt('Taproot Woods', end - 1) - slotRain('Taproot Woods', s + 1)) < 0.01);
});

test('standing in rain: the whole box rains, no masking', () => {
  const ms = splitSlot('Taproot Woods', 'Taproot City') * SLOT_MS;
  const p = rainPlan(-10, 0, halves, ms);
  assert.equal(p.local, true);
  assert.ok(p.amount > 0);
});

test('standing in the dry City next to a wet Woods: you still see the rain over there', () => {
  const ms = splitSlot('Taproot Woods', 'Taproot City') * SLOT_MS;
  const p = rainPlan(10, 0, halves, ms);
  assert.equal(p.local, false);
  assert.equal(p.amount, rainAt('Taproot Woods', ms));
});

test('far from any rain the box stays dry', () => {
  const ms = splitSlot('Taproot Woods', 'Taproot City') * SLOT_MS;
  assert.deepEqual(rainPlan(BOX.hx * 3, 0, halves, ms), { amount: 0, local: false });
});

test('seen from the dry side, every drop spawns over the wet side', () => {
  const ms = splitSlot('Taproot Woods', 'Taproot City') * SLOT_MS, rand = seeded(1);
  let hits = 0;
  for (let i = 0; i < 500; i++) {
    const s = wetSpawn(rand, 10, 0, halves, ms);
    if (!s) continue;
    hits++;
    assert.ok(s.x < 0, `drop at ${s.x}`);
    assert.ok(Math.abs(s.x - 10) <= BOX.hx && Math.abs(s.z) <= BOX.hz);
  }
  assert.ok(hits > 400);
});

test('the seeded random repeats', () => {
  const a = seeded(42), b = seeded(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});
