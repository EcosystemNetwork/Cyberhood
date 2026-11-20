import test from 'node:test';
import assert from 'node:assert/strict';
import { G, TOOLS, PER_DIG, makeDig, strike } from '../game/world3d/fossil.js';

const seeded = (s) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
const flat = (hp) => hp.flat();

test('a fresh wall has tiles of strength 1-4 and fossils that do not overlap', () => {
  for (let s = 1; s < 50; s++) {
    const d = makeDig(seeded(s));
    assert.equal(d.hp.length, G);
    assert.ok(flat(d.hp).every((h) => h >= 1 && h <= 4));
    assert.equal(d.items.length, PER_DIG);
    for (const a of d.items) {
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + 1 < G && a.y + 1 < G);
      for (const b of d.items) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= 2 || Math.abs(a.y - b.y) >= 2);
    }
    assert.equal(new Set(d.items.map((o) => o.kind)).size, PER_DIG);
  }
});

test('a pick hits a plus shape and the hammer the whole 3x3', () => {
  const d = makeDig(seeded(3));
  d.hp = Array.from({ length: G }, () => Array(G).fill(4));
  strike(d, 4, 4, 'pick');
  assert.deepEqual([d.hp[4][4], d.hp[4][5], d.hp[3][4], d.hp[3][3], d.hp[2][4]], [2, 3, 3, 4, 4]);
  strike(d, 4, 4, 'hammer');
  assert.equal(d.hp[3][3], 3); // a corner of the 3x3
  assert.equal(d.hp[4][4], 0);
});

test('swings at the edge stay on the wall, and a dug tile cannot be swung at', () => {
  const d = makeDig(seeded(5));
  d.hp = Array.from({ length: G }, () => Array(G).fill(1));
  assert.ok(strike(d, 0, 0, 'hammer').ok);
  assert.equal(d.hp[0][0], 0);
  const before = d.integrity;
  assert.equal(strike(d, 0, 0, 'pick').ok, false);
  assert.equal(d.integrity, before);
});

test('digging all four tiles of a fossil finds it once', () => {
  const d = makeDig(seeded(7));
  d.hp = Array.from({ length: G }, () => Array(G).fill(1));
  const o = d.items[0];
  let found = [];
  for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) found.push(...strike(d, o.x + a, o.y + b, 'pick').found);
  assert.deepEqual(found, [o.kind]);
  assert.ok(o.got);
});

test('the wall collapses at 0% and then nothing more can be dug', () => {
  const d = makeDig(seeded(9));
  d.hp = Array.from({ length: G }, () => Array(G).fill(4));
  d.integrity = TOOLS.pick.cost;
  const r = strike(d, 1, 1, 'pick');
  assert.ok(r.collapsed && d.over && d.integrity === 0);
  assert.equal(strike(d, 5, 5, 'pick').ok, false);
});

test('a sensible dig finds at least one fossil most of the time', () => {
  let any = 0; const runs = 300;
  for (let s = 1; s <= runs; s++) {
    const d = makeDig(seeded(s * 7919)); let got = 0;
    while (!d.over) { // swing at the weakest tile next to a fossil, else anywhere
      const open = d.items.filter((o) => !o.got).flatMap((o) => [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => [o.x + a, o.y + b])).filter(([x, y]) => d.hp[y][x] > 0);
      const [x, y] = open[0] || [0, 0];
      if (!strike(d, x, y, 'pick').ok) break;
      got = d.items.filter((o) => o.got).length;
    }
    if (got >= 1) any++;
  }
  assert.ok(any / runs > 0.9, `only ${any}/${runs} runs found a fossil`);
});
