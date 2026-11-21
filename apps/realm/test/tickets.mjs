// Mints multiplayer tickets the way the game API does (api.js makeTicket), for the tests.
import { helloBytes, toB64u } from '../auth.mjs';

const subtle = globalThis.crypto.subtle;
const ALG = { name: 'Ed25519' };

export async function makeIssuer() {
  const pair = await subtle.generateKey(ALG, true, ['sign', 'verify']);
  const key = toB64u(await subtle.exportKey('raw', pair.publicKey));
  // a tab: its own key pair and a ticket for it. Returns { ticket, prove(nonce) -> sig }
  async function tab({ sid = 'sid' + Math.random().toString(36).slice(2, 8), name = 'Ana', guest = false, exp = Date.now() + 3600_000 } = {}) {
    const own = await subtle.generateKey(ALG, true, ['sign', 'verify']);
    const k = toB64u(await subtle.exportKey('raw', own.publicKey));
    const body = Buffer.from(JSON.stringify({ s: sid, n: name, g: guest ? 1 : 0, k, e: exp }));
    const sig = await subtle.sign(ALG, pair.privateKey, body);
    const ticket = toB64u(body) + '.' + toB64u(sig);
    return { sid, name, ticket, prove: async (nonce) => toB64u(await subtle.sign(ALG, own.privateKey, helloBytes(nonce))) };
  }
  return { key, tab };
}
