import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRealm, PROTOCOL } from '../server.mjs';
import { makeIssuer } from './tickets.mjs';

const issuer = await makeIssuer();
const ZONES = [{ id: 'town', w: 100, h: 100, start: { x: 50, z: 50 }, spawns: [{ type: 'slime', spot: [52, 50] }] }];
async function start(opts = {}) {
  const realm = createRealm({ port: 0, log: () => {}, serverKey: issuer.key, zones: ZONES, ...opts });
  const port = await realm.listen();
  return { realm, port, url: `ws://127.0.0.1:${port}/play` };
}
function open(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => !w.t || w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].r(m); else inbox.push(m);
  });
  // the next message (of type t, skipping others before it)
  const next = (t) => {
    const i = inbox.findIndex((m) => !t || m.t === t);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((r) => waiters.push({ t, r }));
  };
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  const sendj = (m) => ws.send(JSON.stringify(m));
  return new Promise((r, j) => { ws.on('open', () => r({ ws, next, closed, send: sendj })); ws.on('error', j); });
}
// connect and sign in as a tab; returns the client with its welcome
async function signedIn(url, who = {}) {
  const tab = await issuer.tab(who);
  const c = await open(url);
  const ch = await c.next('challenge');
  c.send({ t: 'hello', v: PROTOCOL, ticket: tab.ticket, sig: await tab.prove(ch.nonce) });
  return { ...c, tab, welcome: await c.next('welcome') };
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

test('a socket gets a challenge, then a welcome for a real ticket', async () => {
  const { realm, url } = await start();
  const c = await signedIn(url, { sid: 's1', name: 'Ana' });
  assert.equal(c.welcome.sid, 's1');
  assert.equal(c.welcome.name, 'Ana');
  assert.deepEqual(c.welcome.zones, ['town']);
  c.send({ t: 'ping', at: 5 });
  assert.equal((await c.next('pong')).at, 5);
  c.ws.close();
  await realm.close();
});

test('a forged, stolen or expired ticket is refused', async () => {
  const { realm, url } = await start();
  const other = await makeIssuer(), forged = await other.tab();
  const good = await issuer.tab(), old = await issuer.tab({ exp: Date.now() - 1000 });
  const cases = [
    async (n) => ({ ticket: forged.ticket, sig: await forged.prove(n) }),   // not the API's key
    async (n) => ({ ticket: good.ticket, sig: await forged.prove(n) }),     // copied ticket, wrong tab key
    async () => ({ ticket: good.ticket, sig: await good.prove('another-socket') }), // replayed hello
    async (n) => ({ ticket: old.ticket, sig: await old.prove(n) }),         // expired
  ];
  for (const make of cases) {
    const c = await open(url);
    const ch = await c.next('challenge');
    c.send({ t: 'hello', v: PROTOCOL, ...(await make(ch.nonce)) });
    assert.deepEqual(await c.next('error'), { t: 'error', code: 'auth' });
    assert.equal(await c.closed, 4004);
  }
  await realm.close();
});

test('nothing but hello and ping works before signing in', async () => {
  const { realm, url } = await start();
  const c = await open(url);
  await c.next('challenge');
  c.send({ t: 'join', zone: 'town' });
  c.send({ t: 'ping', at: 1 });
  assert.equal((await c.next('pong')).at, 1);
  assert.ok(!(await Promise.race([c.next('zone'), new Promise((r) => setTimeout(() => r(null), 150))])));
  c.ws.close();
  await realm.close();
});

test('signing in again elsewhere closes the first socket', async () => {
  const { realm, url } = await start();
  const a = await signedIn(url, { sid: 'same' });
  a.send({ t: 'join', zone: 'town' });
  await a.next('zone');
  const b = await signedIn(url, { sid: 'same' });
  assert.equal(await a.closed, 4009);
  assert.equal(realm.sessions.get('same') !== undefined, true);
  assert.equal(realm.world.get('town').players.size, 0, 'the old socket left the zone');
  b.ws.close();
  await realm.close();
});

test('two players in a zone see each other move, chat, and fight the same slime', async () => {
  const kills = [];
  const { realm, url, port } = await start({ onKill: (k) => kills.push(k) });
  const a = await signedIn(url, { sid: 'a', name: 'Ana' }), b = await signedIn(url, { sid: 'b', name: 'Bo' });
  a.send({ t: 'join', zone: 'town' });
  b.send({ t: 'join', zone: 'town' });
  assert.deepEqual((await a.next('zone')).you, [50, 50, 100]);
  await b.next('zone');
  let s;
  do s = await a.next('s'); while (!(s.e || []).some((e) => e[1] === 'b'));
  assert.ok(s.e.some((e) => e[0] === 'm' && e[2] === 'slime'), 'the slime is in view too');
  b.send({ t: 'move', x: 51, z: 50, face: 1 });
  do s = await a.next('s'); while (!s.u.some((u) => u[0] === 'b' && u[1] === 51));
  b.send({ t: 'move', x: 90, z: 90 });
  assert.deepEqual(await b.next('fix'), { t: 'fix', x: 51, z: 50 });
  b.send({ t: 'say', msg: 'hi Ana' });
  assert.equal((await a.next('say')).msg, 'hi Ana');
  const slime = s.e ? s.e.find((e) => e[0] === 'm')[1] : [...realm.world.get('town').mobs.keys()][0];
  for (let i = 0; i < 3; i++) {
    b.send({ t: 'hit', id: slime, k: 'swing', a: 'h' + i, dmg: 14 });
    await new Promise((r) => setTimeout(r, 330));
  }
  assert.equal((await a.next('die')).id, slime);
  assert.deepEqual(kills.map((k) => k.credits), [['b']]);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.players, 2);
  assert.deepEqual(health.zones.town, { players: 2, mobs: 0 });
  a.ws.close(); b.ws.close();
  await realm.close();
});

test('a ticket can be renewed for the same session only', async () => {
  const { realm, url } = await start();
  const a = await signedIn(url, { sid: 'r1' });
  const fresh = await issuer.tab({ sid: 'r1', exp: Date.now() + 7200_000 });
  const ch = a.welcome && (await Promise.resolve(realm.sessions.get('r1').nonce));
  a.send({ t: 'renew', ticket: fresh.ticket, sig: await fresh.prove(ch) });
  assert.ok((await a.next('renewed')).exp > Date.now() + 3600_000);
  const stranger = await issuer.tab({ sid: 'someone-else' });
  a.send({ t: 'renew', ticket: stranger.ticket, sig: await stranger.prove(ch) });
  assert.equal(await a.closed, 4004);
  await realm.close();
});

test('an old client is told to update', async () => {
  const { realm, url } = await start();
  const c = await open(url);
  await c.next('challenge');
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

test('a kill in the realm is paid to the accounts of those who earned it, and they are told', async () => {
  const added = [];
  // the API's answer, as payout.mjs would pass it on
  const payout = ({ onPaid }) => ({ add: (k) => { added.push(k); onPaid({ u: k.u[0], k: k.k, r: '', xp: 5, m: k.m, sid: k.to.get(k.u[0]) }); }, stats: () => ({}), stop: async () => {} });
  const { realm, url } = await start({ payout });
  const a = await signedIn(url, { sid: 'pa', acct: 'sealed-a', stats: { atk: 30, mag: 0 } }), g = await signedIn(url, { sid: 'pg' });
  a.send({ t: 'join', zone: 'town' }); g.send({ t: 'join', zone: 'town' });
  await a.next('zone'); await g.next('zone');
  const slime = [...realm.world.get('town').mobs.keys()][0];
  g.send({ t: 'hit', id: slime, k: 'swing', a: 'g1', dmg: 5 });
  await g.next('hit');
  a.send({ t: 'hit', id: slime, k: 'swing', a: 'a1', dmg: 99 }); // ATK 30: up to 34 a swing
  await a.next('die');
  assert.equal(added.length, 1);
  assert.equal(added[0].m, 'slime');
  assert.deepEqual(added[0].u, ['sealed-a'], 'the guest helped, but has no account to pay');
  assert.match(added[0].k, /^[0-9a-f]{8}\.town\.1$/);
  assert.equal(added[0].to.get('sealed-a'), 'pa');
  assert.deepEqual(await a.next('reward'), { t: 'reward', m: 'slime', xp: 5 });
  a.ws.close(); g.ws.close();
  await realm.close();
});
