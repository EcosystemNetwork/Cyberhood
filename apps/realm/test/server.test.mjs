import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRealm, PROTOCOL } from '../server.mjs';

async function start() {
  const realm = createRealm({ port: 0, log: () => {} });
  const port = await realm.listen();
  return { realm, port, url: `ws://127.0.0.1:${port}/play` };
}
function open(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : inbox.push(m); });
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r)));
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  return new Promise((r, j) => { ws.on('open', () => r({ ws, next, closed })); ws.on('error', j); });
}

test('health reports the protocol and player count', async () => {
  const { realm, port } = await start();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.protocol, PROTOCOL);
  assert.equal(body.players, 0);
  await realm.close();
});

test('a socket gets a challenge, then a welcome for the right protocol', async () => {
  const { realm, url } = await start();
  const c = await open(url);
  const ch = await c.next();
  assert.equal(ch.t, 'challenge');
  assert.match(ch.nonce, /^[A-Za-z0-9_-]{22}$/);
  c.ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL }));
  assert.equal((await c.next()).t, 'welcome');
  c.ws.send(JSON.stringify({ t: 'ping', at: 5 }));
  assert.equal((await c.next()).at, 5);
  c.ws.close();
  await realm.close();
});

test('an old client is told to update', async () => {
  const { realm, url } = await start();
  const c = await open(url);
  await c.next();
  c.ws.send(JSON.stringify({ t: 'hello', v: 0 }));
  assert.deepEqual(await c.next(), { t: 'error', code: 'update', want: PROTOCOL });
  assert.equal(await c.closed, 4003);
  await realm.close();
});

test('a message flood closes the socket', async () => {
  const { realm, url } = await start();
  const c = await open(url);
  for (let i = 0; i < 80; i++) c.ws.send(JSON.stringify({ t: 'ping' }));
  assert.equal(await c.closed, 4008);
  await realm.close();
});

test('oversized messages are refused', async () => {
  const { realm, url } = await start();
  const c = await open(url);
  c.ws.send('x'.repeat(4096));
  assert.equal(await c.closed, 1009);
  await realm.close();
});

test('draining warns players, refuses new ones and fails the health check', async () => {
  const { realm, port, url } = await start();
  const c = await open(url);
  await c.next();
  const draining = realm.drain('SIGTERM');
  assert.equal((await c.next()).t, 'draining');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 503);
  await assert.rejects(open(url));
  c.ws.close();
  await draining;
});
