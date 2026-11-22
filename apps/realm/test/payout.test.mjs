import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayout } from '../payout.mjs';

// a stand-in for the game API's POST realm
function fakeApi(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, key: init.headers['x-realm-key'], body });
    const r = await answer(body, calls.length);
    return { status: r.status, json: async () => r.data };
  };
  return { calls, fetch };
}
const kill = (k, ...u) => ({ k, m: 'slime', u, to: new Map(u.map((x, i) => [x, 'sid' + i])) });
const payAll = (body) => ({ status: 200, data: { paid: body.kills.flatMap((k) => k.u.map((u) => ({ u, k: k.k, r: '', xp: 5 }))) } });

test('kills go to the API in a batch, and every account hears what it got', async () => {
  const api = fakeApi(payAll), paid = [];
  const p = createPayout({ url: 'https://api.test/game/', secret: 's3', fetch: api.fetch, log: () => {}, onPaid: (x) => paid.push(x) });
  p.add(kill('k1', 'ua', 'ub'));
  p.add(kill('k2', 'ua'));
  p.add(kill('k3')); // a kill only guests helped with: nothing to pay
  await p.flush();
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].url, 'https://api.test/game/realm');
  assert.equal(api.calls[0].key, 's3');
  assert.deepEqual(api.calls[0].body.kills, [{ k: 'k1', m: 'slime', u: ['ua', 'ub'] }, { k: 'k2', m: 'slime', u: ['ua'] }]);
  assert.deepEqual(paid.map((x) => [x.k, x.sid, x.xp]), [['k1', 'sid0', 5], ['k1', 'sid1', 5], ['k2', 'sid0', 5]]);
  assert.equal(p.stats().queued, 0);
  await p.stop(0);
});

test('an API that is down keeps the kills, waits longer each time, then sends them again', async () => {
  let down = true;
  const api = fakeApi((body) => (down ? { status: 503, data: {} } : payAll(body)));
  const p = createPayout({ url: 'https://api.test', secret: 's', fetch: api.fetch, log: () => {} });
  p.add(kill('k1', 'ua'));
  await p.flush();
  await p.flush(); // backing off: no second request yet
  assert.equal(api.calls.length, 1);
  assert.equal(p.stats().queued, 1);
  down = false;
  await p.flush({ force: true });
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls[1].body.kills.map((k) => k.k), ['k1'], 'the same kill id: the API pays it once');
  assert.equal(p.stats().paid, 1);
  await p.stop(0);
});

test('a batch the API refuses is dropped, a full queue turns new kills away, and stop flushes', async () => {
  const api = fakeApi((body, n) => (n === 1 ? { status: 400, data: {} } : payAll(body)));
  const p = createPayout({ url: 'https://api.test', secret: 's', fetch: api.fetch, log: () => {}, maxQueue: 2, batch: 1 });
  p.add(kill('bad', 'ua'));
  await p.flush();
  assert.equal(p.stats().queued, 0);
  p.add(kill('k1', 'ua')); p.add(kill('k2', 'ua')); p.add(kill('k3', 'ua'));
  assert.equal(p.stats().queued, 2);
  assert.equal(p.stats().dropped, 2);
  await p.stop(); // one at a time (batch 1), until the queue is empty
  assert.deepEqual(api.calls.slice(1).map((c) => c.body.kills[0].k), ['k1', 'k2']);
});
