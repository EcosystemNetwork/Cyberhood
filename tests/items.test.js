const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game/items.js');

test('a weapon in the left hand counts, the same as in the right', () => {
  const right = G.computeStats('knight', { rhand: 'iron_sword' });
  const left = G.computeStats('knight', { lhand: 'iron_sword' });
  assert.equal(left.atk, right.atk);
  assert.equal(left.atk, G.BASE.knight.atk + G.ITEMS.iron_sword.stats.atk);
});

test('a shield in the right hand counts, the same as in the left', () => {
  const left = G.computeStats('knight', { lhand: 'wooden_shield' });
  const right = G.computeStats('knight', { rhand: 'wooden_shield' });
  assert.deepEqual(right, left);
});

test('power counts hand items in either hand too', () => {
  assert.equal(G.computePower('knight', { lhand: 'iron_sword' }), G.computePower('knight', { rhand: 'iron_sword' }));
});

test('an item only counts in a slot of its own kind: boots in a hand do nothing', () => {
  assert.deepEqual(G.computeStats('knight', { rhand: 'leather_boots' }), G.computeStats('knight', {}));
});
