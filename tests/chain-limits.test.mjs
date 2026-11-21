// Robinhood Chain withdrawal limits, against the real game API (dev server, mock database):
// a newly linked wallet waits before anything can leave, there's a daily cap on what leaves,
// and imported (bound) value never leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { compile } from '../tools/chain/compile.mjs';
import { MiniChain, deployAll } from './helpers/minichain.mjs';
import { RESOURCES } from '../game/lib/chain.js';
import { grant } from './helpers/grant.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 25000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = 'game.test';
const dir = mkdtempSync(join(tmpdir(), 'taproot-limits-'));
const built = compile();
const signerKey = generatePrivateKey();
let chain, rpc, server;

test.before(async () => {
  chain = await MiniChain.create();
  const at = await deployAll(chain, built, { admin: '0x' + 'a1'.repeat(20), signer: privateKeyToAccount(signerKey).address, resources: RESOURCES });
  rpc = await chain.serve();
  server = spawn(process.execPath, [join(ROOT, 'game-dev-server.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'db.json'), SUPABASE_URL: BASE, SUPABASE_SERVICE_KEY: 'local-mock-key',
      GAME_DEV: '0', CHAIN_ID: '46630', CHAIN_RPC: rpc.url, CHAIN_BRIDGE: at.bridge, CHAIN_SIGNER_KEY: signerKey,
      CHAIN_SYNC_KEY: 'k', CHAIN_CONFIRMATIONS: '0', CHAIN_SIWE_DOMAINS: DOMAIN,
      CHAIN_DAILY_VALUE: '100', // CHAIN_LINK_LOCK_HOURS left at its default (72)
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/game/'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('dev server did not start');
});
test.after(() => { server.kill(); rpc.close(); rmSync(dir, { recursive: true, force: true }); });

async function api(action, key, body) {
  const get = ['state', 'wallet'].includes(action);
  const res = await fetch(`${BASE}/api/game/${action}`, {
    method: get ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: get ? undefined : JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json() };
}
// a fresh account with a linked wallet
async function linked() {
  const username = 'l' + Math.random().toString(36).slice(2, 10);
  const { data } = await api('signup', null, { username, password: 'hunter2hunter2' });
  const w = privateKeyToAccount(generatePrivateKey());
  const n = await api('linknonce', data.key, {});
  const message = createSiweMessage({ domain: DOMAIN, address: w.address, statement: n.data.statement, uri: `https://${DOMAIN}/game/`, version: '1', chainId: n.data.chainId, nonce: n.data.nonce, issuedAt: new Date() });
  assert.equal((await api('link', data.key, { message, signature: await w.signMessage({ message }) })).status, 200);
  return { username, key: data.key, wallet: w.address.toLowerCase() };
}
// as if the wallet had been linked `hours` ago
const ageLink = (wallet, hours) => fetch(`${BASE}/rest/v1/game_wallets?address=eq.${wallet}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ linked_at: new Date(Date.now() - hours * 3600000).toISOString() }),
});

test('a newly linked wallet waits 72 hours before anything can leave', async () => {
  const a = await linked();
  await grant(BASE, a.username, { gold: 50 });
  const r = await api('withdraw', a.key, { kind: 'gold', amount: 10 });
  assert.equal(r.status, 423);
  assert.ok(r.data.until > Date.now() + 71 * 3600000);
  assert.equal((await api('state', a.key)).data.econ.gold, 50, 'nothing was taken');
  await ageLink(a.wallet, 73);
  assert.equal((await api('withdraw', a.key, { kind: 'gold', amount: 10 })).status, 200);
});

test('what leaves in a day is capped, in gold worth, across gold and resources', async () => {
  const a = await linked();
  await ageLink(a.wallet, 100);
  await grant(BASE, a.username, { gold: 500, bag: { slime_gel: 50 } });
  assert.equal((await api('withdraw', a.key, { kind: 'gold', amount: 70 })).status, 200);
  // slime gel sells for 3: 11 of them (33) would go past 100
  const over = await api('withdraw', a.key, { kind: 'resource', item: 'slime_gel', amount: 11 });
  assert.equal(over.status, 429);
  assert.match(over.data.error, /30 gold worth left/);
  assert.equal((await api('withdraw', a.key, { kind: 'resource', item: 'slime_gel', amount: 10 })).status, 200);
  assert.equal((await api('withdraw', a.key, { kind: 'gold', amount: 1 })).status, 429);
});

test('imported gold and gear never leave', async () => {
  const a = await linked();
  await ageLink(a.wallet, 100);
  const imp = await api('act', a.key, { actions: [{ t: 'import', field: { gold: 60 }, owned: ['cutlass'] }] });
  assert.deepEqual(imp.data.results, ['']);
  assert.equal((await api('withdraw', a.key, { kind: 'gold', amount: 1 })).status, 409);
  assert.equal((await api('withdraw', a.key, { kind: 'item', item: 'cutlass' })).status, 409);
  // gold earned in play can go
  await api('act', a.key, { actions: [{ t: 'chest', id: 'wreck' }] });
  assert.equal((await api('withdraw', a.key, { kind: 'gold', amount: 40 })).status, 200);
});
