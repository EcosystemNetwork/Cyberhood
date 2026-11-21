// Signed multiplayer messages (game/lib/mpauth.js) with real tickets from the game API's
// mpticket route, over an in-memory stand-in for a Supabase broadcast channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGameApi } from '../supabase/functions/game/api.js';
import { createAuth, supported } from '../game/lib/mpauth.js';

// no database: rate limits let everything through when they can't be counted
const api = makeGameApi({ url: 'http://127.0.0.1:1', serviceKey: 'test-service-key' });
const other = makeGameApi({ url: 'http://127.0.0.1:1', serviceKey: 'some-other-server' });
const origError = console.error;
test.before(() => { console.error = () => {}; });
test.after(() => { console.error = origError; });
const ticketFrom = (h, name) => async (pk) => (await h({ method: 'POST', action: 'mpticket', body: { pk, name } })).body;

// a broadcast bus: every channel on it hears what the others send (not its own: self: false)
function bus() {
  const chans = [];
  return () => {
    const handlers = [];
    const ch = {
      on(type, filter, cb) { handlers.push([filter.event, cb]); return ch; },
      send(m) { for (const c of chans) if (c !== ch) c.deliver(m); return Promise.resolve('ok'); },
      deliver(m) { for (const [ev, cb] of handlers) if (ev === m.event) cb({ type: 'broadcast', event: m.event, payload: m.payload }); },
      raw: (m) => { for (const c of chans) if (c !== ch) c.deliver(m); },
      subscribe() { return ch; },
    };
    chans.push(ch);
    return ch;
  };
}
const settle = () => new Promise((r) => setTimeout(r, 50));
const SENDERS = { move: 'id', chat: 'id', hit: 'by' };

test('this runtime has Ed25519', async () => { assert.equal(await supported(), true); });

test('a guest\'s ticket says so, and keeps its name honest', async () => {
  const r = await api({ method: 'POST', action: 'mpticket', body: { pk: 'A'.repeat(43), name: '<b>Mira</b>' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'bMirab (guest)');
  assert.equal(r.body.guest, true);
  assert.equal((await api({ method: 'POST', action: 'mpticket', body: { pk: 'short' } })).status, 400);
  // the same tab key keeps its session id when the ticket is renewed
  const again = await api({ method: 'POST', action: 'mpticket', body: { pk: 'A'.repeat(43) } });
  assert.equal(again.body.sid, r.body.sid);
});

test('genuine messages arrive; forged, tampered and replayed ones don\'t', async () => {
  const chan = bus();
  const alice = await createAuth(ticketFrom(api, 'Alice'));
  const bob = await createAuth(ticketFrom(api, 'Bob'));
  const a = alice.secure(chan(), SENDERS), b = bob.secure(chan(), SENDERS);
  const raw = chan(); // a stranger with the anon key: can send anything, sign nothing
  const got = [];
  b.on('broadcast', { event: 'move' }, ({ payload }) => got.push(['move', payload]))
    .on('broadcast', { event: 'chat' }, ({ payload }) => got.push(['chat', payload]))
    .on('broadcast', { event: 'hit' }, ({ payload }) => got.push(['hit', payload]));

  await a.send({ type: 'broadcast', event: 'move', payload: { id: alice.sid, name: alice.name, x: 1 } });
  await a.send({ type: 'broadcast', event: 'chat', payload: { id: alice.sid, name: alice.name, msg: 'hi' } });
  await settle();
  assert.deepEqual(got.map(([e, p]) => [e, p.x ?? p.msg]), [['move', 1], ['chat', 'hi']]);
  got.length = 0;

  // speaking as Bob, or under Bob's name, with Alice's own ticket
  await a.send({ type: 'broadcast', event: 'chat', payload: { id: bob.sid, name: alice.name, msg: 'as bob' } });
  await a.send({ type: 'broadcast', event: 'chat', payload: { id: alice.sid, name: 'Bob', msg: 'named bob' } });
  await a.send({ type: 'broadcast', event: 'hit', payload: { to: alice.sid, by: bob.sid, name: alice.name, dmg: 99 } });
  // unsigned, as before tickets
  raw.raw({ type: 'broadcast', event: 'chat', payload: { id: alice.sid, name: alice.name, msg: 'unsigned' } });
  // a real message from Alice, captured, then altered or sent again
  let captured;
  const spy = chan();
  spy.on('broadcast', { event: 'chat' }, (m) => { captured = m.payload; });
  await a.send({ type: 'broadcast', event: 'chat', payload: { id: alice.sid, name: alice.name, msg: 'real' } });
  await settle();
  raw.raw({ type: 'broadcast', event: 'chat', payload: captured });                                     // replay
  raw.raw({ type: 'broadcast', event: 'chat', payload: { ...captured, d: captured.d.replace('real', 'fake') } }); // tamper
  raw.raw({ type: 'broadcast', event: 'move', payload: { ...captured, n: captured.n + 1 } });             // other event, new counter
  await settle();
  assert.deepEqual(got.map(([e, p]) => [e, p.msg]), [['chat', 'real']]);
});

test('a ticket from another server (or made up) is refused', async () => {
  const chan = bus();
  const alice = await createAuth(ticketFrom(api, 'Alice'));
  const mallory = await createAuth(ticketFrom(other, 'Alice'));
  const a = alice.secure(chan(), SENDERS), m = mallory.secure(chan(), SENDERS);
  const got = [];
  a.on('broadcast', { event: 'chat' }, ({ payload }) => got.push(payload.msg));
  await m.send({ type: 'broadcast', event: 'chat', payload: { id: mallory.sid, name: mallory.name, msg: 'hello' } });
  await settle();
  assert.deepEqual(got, []);
});
