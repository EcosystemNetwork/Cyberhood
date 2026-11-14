import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FLOORS, floorMap, SHIFT_1F } from '../game/world3d/mine.js';

const base = JSON.parse(readFileSync(new URL('../game/world/assets/cave/cave_map.json', import.meta.url))).rows;
const open = (rows, x, y) => (rows[y] || '')[x] !== undefined && rows[y][x] !== '#';
// every open tile reachable from (x, y), walking the four directions
function reach(rows, x, y) {
  const seen = new Set([`${x},${y}`]), q = [[x, y]];
  while (q.length) {
    const [cx, cy] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy, k = `${nx},${ny}`;
      if (!seen.has(k) && open(rows, nx, ny)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}
const reaches = (rows, from, to) => reach(rows, from.x, from.y).has(`${to.x},${to.y}`);

test('three floors, with their names and order', () => {
  assert.deepEqual(Object.keys(FLOORS), ['cave', 'cave_b1', 'cave_b2']);
  assert.deepEqual(Object.values(FLOORS).map((f) => f.code), ['1F', 'B1', 'B2']);
  assert.equal(FLOORS.cave_b2.name, 'The Hollow');
});

test('1F is the old cave, unchanged, inside a map half again as big each way', () => {
  const f = floorMap('cave', base);
  assert.equal(f.rows.length, 54);
  assert.ok(f.rows.every((r) => r.length === 72));
  // every tile of the old cave sits at the same place, shifted down by SHIFT_1F rows
  for (let y = 0; y < base.length; y++) for (let x = 0; x < base[0].length; x++) {
    if (base[y][x] !== '#') assert.equal(f.rows[y + SHIFT_1F][x], base[y][x], `old cave tile ${x},${y} moved or changed`);
  }
  // the old way out to the fields still reaches the bottom edge
  assert.ok(open(f.rows, 22, f.rows.length - 1), 'the exit tunnel still meets the bottom edge');
});

test('1F: from where you come in, you can reach the new ladder down', () => {
  const f = floorMap('cave', base);
  assert.ok(f.down && open(f.rows, f.down.x, f.down.y + 1), 'the ladder down has open ground beside it');
  assert.ok(reaches(f.rows, { x: 22, y: 31 + SHIFT_1F }, { x: f.down.x, y: f.down.y + 1 }), 'the old entrance connects to the ladder down');
  assert.ok(f.down.x >= 48 || f.down.y < SHIFT_1F, 'the ladder down is in the new part of the cave');
});

test('B1: the ladder up and the ladder down are far apart, and joined', () => {
  const f = floorMap('cave_b1');
  assert.equal(f.rows.length, 54);
  assert.ok(f.rows.every((r) => r.length === 72));
  assert.ok(reaches(f.rows, { x: f.up.x, y: f.up.y + 1 }, { x: f.down.x, y: f.down.y + 1 }), 'you can walk from one ladder to the other');
  assert.ok(Math.hypot(f.up.x - f.down.x, f.up.y - f.down.y) > 40, 'you have to cross the floor to get down');
});

test('B2: one big round cavern, and the ladder up opens onto it', () => {
  const f = floorMap('cave_b2');
  const all = reach(f.rows, f.up.x, f.up.y + 1); // you arrive on the tile below the ladder
  assert.ok(all.size > 600, `a big cavern (${all.size} tiles)`);
  assert.ok(all.has(`${f.center.x},${f.center.y}`), 'the middle of it is reachable from the ladder');
});

test('the maps are the same every time', () => {
  for (const id of ['cave', 'cave_b1', 'cave_b2']) assert.deepEqual(floorMap(id, base), floorMap(id, base));
});
