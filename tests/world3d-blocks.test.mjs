import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, BLOCK_IDS, MAX_H, Voxels, pack, unpack, standHeight, blockedAt, raycast, canPlace } from '../game/world3d/blocks.js';

const free = { crops: new Set(), builds: [], players: [] };

test('starter block set and prices', () => {
  assert.deepEqual(BLOCK_IDS, ['planks', 'stone', 'grass', 'glass', 'roof', 'door']);
  assert.deepEqual(BLOCK_IDS.map((k) => BLOCKS[k].price), [1, 2, 1, 3, 2, 10]);
  assert.equal(MAX_H, 12);
});

test('pack/unpack round-trips a full 24x24x12 plot of mixed types under 32 KB', () => {
  const v = new Voxels(24, 24);
  for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) for (let k = 0; k < 12; k++) v.set(i, j, k, BLOCK_IDS[(i + j + k) % 5], (i + k) % 4);
  const s = pack(v);
  assert.equal(v.count(), 6912);
  assert.ok(s.length < 32 * 1024, `packed ${s.length} chars`);
  const u = unpack(s, 24, 24);
  assert.equal(u.count(), 6912);
  assert.equal(pack(u), s);
  assert.deepEqual(u.get(3, 4, 5), { t: BLOCK_IDS[12 % 5], r: 8 % 4 });
});

test('unpack drops out-of-range and unknown entries', () => {
  const big = new Voxels(24, 24);
  big.set(1, 1, 0, 'stone'); big.set(20, 2, 0, 'stone'); big.set(2, 20, 0, 'planks');
  const u = unpack(pack(big) + '!!zz' + 'zzzz', 8, 8);
  assert.equal(u.count(), 1);
  assert.deepEqual(u.get(1, 1, 0), { t: 'stone', r: 0 });
  assert.equal(unpack('', 8, 8).count(), 0);
  assert.equal(unpack(undefined, 8, 8).count(), 0);
});

test('door occupies two cells and packs once', () => {
  const v = new Voxels(8, 8);
  v.set(2, 2, 0, 'door', 1);
  assert.deepEqual(v.get(2, 2, 1), { t: 'door', r: 1, upper: true });
  assert.equal(pack(v).length, 4);
  const u = unpack(pack(v), 8, 8);
  assert.deepEqual(u.get(2, 2, 1), { t: 'door', r: 1, upper: true });
  u.del(2, 2, 1);
  assert.equal(u.get(2, 2, 0), null, 'deleting either half removes the door');
});

test('standHeight: soil 0, on a cube 1, on two stacked 2, half-way up a slope', () => {
  const v = new Voxels(8, 8);
  v.set(1, 1, 0, 'stone'); v.set(3, 1, 0, 'stone'); v.set(3, 1, 1, 'stone'); v.set(5, 1, 0, 'roof', 0);
  assert.equal(standHeight(v, 0.5, 6.5, 0), 0);
  assert.equal(standHeight(v, 1.5, 1.5, 1), 1);
  assert.equal(standHeight(v, 3.5, 1.5, 2), 2);
  assert.ok(Math.abs(standHeight(v, 5.5, 1.5, 0.6) - 0.5 - 0.2) < 1e-9, 'slope r=0 rises toward +z; the hitbox front corner (z+0.2) sets the height');
});

test('standHeight ignores a block above head', () => {
  const v = new Voxels(8, 8);
  v.set(1, 1, 3, 'stone');
  assert.equal(standHeight(v, 1.5, 1.5, 0), 0);
});

test('blockedAt: cube in front blocks, door never blocks, slope blocks only above its surface', () => {
  const v = new Voxels(8, 8);
  v.set(2, 2, 0, 'stone'); v.set(4, 2, 0, 'door'); v.set(6, 2, 0, 'roof', 0);
  assert.equal(blockedAt(v, 2.5, 2.5, 0), true);
  assert.equal(blockedAt(v, 2.5, 2.5, 1), false, 'standing on top is fine');
  assert.equal(blockedAt(v, 4.5, 2.5, 0), false);
  assert.equal(blockedAt(v, 6.5, 2.1, 0.0), false, 'low end of a slope is walkable');
  assert.equal(blockedAt(v, 6.5, 2.9, 0.0), true, 'high end of a slope blocks from the soil');
  assert.equal(blockedAt(v, 0.5, 0.5, 0), false);
});

test('raycast from above hits the top face with normal (0,1,0)', () => {
  const v = new Voxels(8, 8);
  v.set(3, 3, 0, 'stone');
  const h = raycast(v, 3.5, 5, 3.5, 0, -1, 0, 20);
  assert.deepEqual(h, { i: 3, j: 3, k: 0, nx: 0, ny: 1, nz: 0, soil: false });
});

test('raycast hits a side face with its normal', () => {
  const v = new Voxels(8, 8);
  v.set(3, 3, 0, 'stone');
  const h = raycast(v, 0.5, 0.5, 3.5, 1, 0, 0, 20);
  assert.deepEqual(h, { i: 3, j: 3, k: 0, nx: -1, ny: 0, nz: 0, soil: false });
});

test('raycast hits soil past blocks with k=-1', () => {
  const v = new Voxels(8, 8);
  v.set(3, 3, 0, 'stone');
  const h = raycast(v, 5.5, 4, 5.5, 0, -1, 0, 20);
  assert.deepEqual(h, { i: 5, j: 5, k: -1, nx: 0, ny: 1, nz: 0, soil: true });
});

test('raycast returns null when aiming outside the soil', () => {
  const v = new Voxels(8, 8);
  assert.equal(raycast(v, 10, 4, 10, 0, -1, 0, 20), null);
  assert.equal(raycast(v, 4, 4, 4, 0, 1, 0, 20), null);
});

test('canPlace returns each reason in turn, and empty when free', () => {
  const v = new Voxels(8, 8);
  v.set(1, 1, 0, 'stone');
  assert.equal(canPlace(v, 8, 0, 0, 'stone', free), 'outside your soil');
  assert.equal(canPlace(v, 0, 0, 12, 'stone', free), 'too high');
  assert.equal(canPlace(v, 0, 0, 11, 'door', free), 'too high', 'a door needs two cells');
  assert.equal(canPlace(v, 1, 1, 0, 'stone', free), 'something is already there');
  assert.equal(canPlace(v, 2, 2, 0, 'stone', { ...free, crops: new Set(['2,2']) }), 'crops in the way');
  assert.equal(canPlace(v, 4, 4, 0, 'stone', { ...free, builds: [{ i: 3, j: 3, size: 2 }] }), 'a building is there');
  assert.equal(canPlace(v, 5, 5, 0, 'stone', { ...free, players: [{ x: 5.4, z: 5.6, y: 0 }] }), 'someone is standing there');
  assert.equal(canPlace(v, 5, 5, 3, 'stone', { ...free, players: [{ x: 5.4, z: 5.6, y: 0 }] }), '', 'well above a head is fine');
  assert.equal(canPlace(v, 1, 1, 1, 'stone', free), '');
});

test('raycast passes through cells the caller skips', () => {
  const v = new Voxels(8, 8);
  v.set(3, 3, 2, 'stone');
  const h = raycast(v, 3.5, 6, 3.5, 0, -1, 0, 20, (i, j, k) => k === 2);
  assert.deepEqual(h, { i: 3, j: 3, k: -1, nx: 0, ny: 1, nz: 0, soil: true });
});
