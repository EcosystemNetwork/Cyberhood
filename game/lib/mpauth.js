/* Signed multiplayer messages.

   Players broadcast to each other over Supabase Realtime, which anyone holding the public anon key
   can join and send on. On its own, nothing there proves who said what: a stranger could move,
   chat, hit or "knock out" as anyone. So every message is signed:

   - This tab makes its own Ed25519 key pair and asks the game API for a ticket
     (POST mpticket { pk }). The server signs { s: session id, n: name, g: guest, k: this tab's
     public key, e: expiry } with its own key (supabase/functions/game/api.js makeTicket).
   - Every message carries the ticket, a counter and the tab's signature over the event name,
     the counter and the payload.
   - A receiver checks the ticket against the server's key, the signature against the ticket's
     key, that the counter only goes up (no replays), that the payload's `name` and `from` are the
     ticket's name, and that the field naming the sender (per event: `id` on a move, `by` on a hit)
     is the ticket's session id. Anything else is dropped without a word.

   secure(channel, senders) wraps a Supabase channel so the game's code keeps calling .on(...) and
   .send(...) as before. Plain ES module with WebCrypto, so it also runs in node for the tests. */

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const ALG = { name: 'Ed25519' };
const RENEW_MS = 5 * 60 * 1000; // renew a ticket this long before it runs out

const toB64u = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const supported = async () => {
  try { await subtle.generateKey(ALG, false, ['sign', 'verify']); return true; } catch (e) { return false; }
};

/* getTicket(pk) -> { ticket, key, sid, name, exp }: asks the server (Ledger.mpTicket).
   Returns { sid, name, ready, secure(channel) } once the first ticket is in. */
export async function createAuth(getTicket) {
  const pair = await subtle.generateKey(ALG, true, ['sign', 'verify']);
  const pk = toB64u(await subtle.exportKey('raw', pair.publicKey));
  let me = null, serverKey = null, serverKeyText = '';
  async function renew() {
    const t = await getTicket(pk);
    if (!t || !t.ticket) throw new Error('no multiplayer ticket');
    if (t.key !== serverKeyText) { serverKey = await subtle.importKey('raw', fromB64u(t.key), ALG, false, ['verify']); serverKeyText = t.key; }
    me = t;
    const timer = setTimeout(() => renew().catch(() => {}), Math.max(10000, t.exp - Date.now() - RENEW_MS));
    if (timer && timer.unref) timer.unref(); // node (tests): don't hold the process open
  }
  await renew();
  let seq = 0;
  const tickets = new Map(); // ticket text -> its checked contents (with the sender's key), or null if bad

  async function readTicket(text) {
    if (tickets.has(text)) return tickets.get(text);
    let out = null;
    try {
      const [body, sig] = String(text).split('.');
      const raw = fromB64u(body);
      if (await subtle.verify(ALG, serverKey, fromB64u(sig), raw)) {
        const t = JSON.parse(new TextDecoder().decode(raw));
        out = { ...t, key: await subtle.importKey('raw', fromB64u(t.k), ALG, false, ['verify']) };
      }
    } catch (e) { out = null; }
    if (tickets.size > 500) tickets.clear();
    tickets.set(text, out);
    return out;
  }
  const signed = (event, n, d) => enc.encode(`${event}\n${n}\n${d}`);

  async function seal(event, payload) {
    const n = ++seq, d = JSON.stringify(payload);
    const s = toB64u(await subtle.sign(ALG, pair.privateKey, signed(event, n, d)));
    return { a: me.ticket, n, d, s };
  }
  // the payload if this message is genuine and new, else null. last: sid -> last counter seen
  async function open(event, msg, last, senders) {
    if (!msg || typeof msg.a !== 'string' || typeof msg.d !== 'string' || typeof msg.s !== 'string' || !Number.isSafeInteger(msg.n)) return null;
    const t = await readTicket(msg.a);
    if (!t || !(t.e > Date.now())) return null;
    let ok = false;
    try { ok = await subtle.verify(ALG, t.key, fromB64u(msg.s), signed(event, msg.n, msg.d)); } catch (e) { ok = false; }
    if (!ok || msg.n <= (last.get(t.s) || 0)) return null;
    last.set(t.s, msg.n);
    let p;
    try { p = JSON.parse(msg.d); } catch (e) { return null; }
    if (!p || typeof p !== 'object') return null;
    if (senders[event] && p[senders[event]] !== t.s) return null; // nobody speaks for another player
    if ('name' in p && p.name !== t.n) return null;
    if ('from' in p && p.from !== t.n) return null;
    return p;
  }

  // senders: { event: the payload field that names the sender, e.g. move: 'id', hit: 'by' }
  function secure(channel, senders = {}) {
    const last = new Map();
    let inbox = Promise.resolve(), outbox = Promise.resolve(); // keep messages in order both ways
    const wrapper = new Proxy(channel, {
      get(target, prop) {
        if (prop === 'on') {
          return (type, filter, cb) => {
            if (type !== 'broadcast') { target.on(type, filter, cb); return wrapper; }
            target.on(type, filter, (m) => {
              inbox = inbox.then(async () => {
                const payload = await open(filter.event, m.payload, last, senders);
                if (payload) cb({ ...m, payload });
              }).catch(() => {});
            });
            return wrapper;
          };
        }
        if (prop === 'send') {
          return (m) => {
            if (!m || m.type !== 'broadcast') return target.send(m);
            outbox = outbox.then(async () => target.send({ ...m, payload: await seal(m.event, m.payload) })).catch(() => {});
            return outbox;
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return wrapper;
  }

  return { get sid() { return me.sid; }, get name() { return me.name; }, get guest() { return !!me.guest; }, secure };
}
