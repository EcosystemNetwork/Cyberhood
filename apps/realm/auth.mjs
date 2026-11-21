/* Who is on this socket.

   The game API already hands every tab a signed multiplayer ticket (POST mpticket, see
   supabase/functions/game/api.js makeTicket): the API's Ed25519 key signs
   { s: session id, n: display name, g: guest, k: the tab's own public key, e: expiry }.
   The realm checks the same ticket, then makes the tab prove it holds the ticket's key by
   signing this socket's random nonce. So a ticket copied off the wire is useless on its own,
   and a hello can't be replayed on another socket.

   The API's public key (the `key` field of every mpticket response) is REALM_TICKET_KEY. */

const subtle = globalThis.crypto.subtle;
const ALG = { name: 'Ed25519' };
const enc = new TextEncoder();

export const fromB64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));
export const toB64u = (bytes) => Buffer.from(bytes).toString('base64url');

// What the tab signs: domain-separated from mpauth's broadcast signatures ("event\nn\npayload").
export const helloBytes = (nonce) => enc.encode(`cyberhood-realm-v1\n${nonce}`);

export const importServerKey = (x) => subtle.importKey('raw', fromB64u(x), ALG, false, ['verify']);

/* -> { sid, name, guest, exp } when `ticket` is the API's and `sig` is the ticket key's
   signature over this socket's nonce; otherwise null. */
export async function checkHello(serverKey, ticket, nonce, sig, now = Date.now()) {
  if (!serverKey || typeof ticket !== 'string' || typeof sig !== 'string' || ticket.length > 1024 || sig.length > 128) return null;
  try {
    const [body, tsig] = ticket.split('.');
    if (!body || !tsig) return null;
    const raw = fromB64u(body);
    if (!(await subtle.verify(ALG, serverKey, fromB64u(tsig), raw))) return null;
    const t = JSON.parse(new TextDecoder().decode(raw));
    if (!t || typeof t.s !== 'string' || typeof t.n !== 'string' || typeof t.k !== 'string' || !(t.e > now)) return null;
    const tab = await subtle.importKey('raw', fromB64u(t.k), ALG, false, ['verify']);
    if (!(await subtle.verify(ALG, tab, fromB64u(sig), helloBytes(nonce)))) return null;
    return { sid: t.s.slice(0, 32), name: t.n.slice(0, 40), guest: !!t.g, exp: t.e };
  } catch {
    return null;
  }
}
