// Robinhood Chain end to end: the real game API (dev server, mock database) against the real
// contracts on an in-process EVM. Link a wallet with Sign-In with Ethereum, withdraw gold and
// gear (the server debits and signs; the player claims on-chain), deposit back (the chain sync
// credits the account), refunds of claims that expired unused, and wallet sign-in.
//   node --test tests/chain-bridge.test.mjs
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
import { KIND, RESOURCES } from '../game/lib/chain.js';
import { itemTokenId } from '../supabase/functions/game/wallet.js';
import { grant } from './helpers/grant.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 23000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = 'game.test';
const SYNC_KEY = 'test-sync-key';
const dir = mkdtempSync(join(tmpdir(), 'taproot-chain-'));
const built = compile();
const admin = '0x' + 'a1'.repeat(20);
const signerKey = generatePrivateKey();
const signer = privateKeyToAccount(signerKey);
let chain, rpc, at, server;

test.before(async () => {
  chain = await MiniChain.create();
  at = await deployAll(chain, built, { admin, signer: signer.address, resources: RESOURCES });
  rpc = await chain.serve();
  server = spawn(process.execPath, [join(ROOT, 'game-dev-server.js')], {
    // always the local mock database; local-testing perks off; rate limits counted for real
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'db.json'), SUPABASE_URL: BASE, SUPABASE_SERVICE_KEY: 'local-mock-key',
      GAME_DEV: '0', MOCK_RATE_LIMITS: '1',
      CHAIN_ID: '46630', CHAIN_RPC: rpc.url, CHAIN_BRIDGE: at.bridge, CHAIN_SIGNER_KEY: signerKey,
      CHAIN_SYNC_KEY: SYNC_KEY, CHAIN_CONFIRMATIONS: '0', CHAIN_SIWE_DOMAINS: DOMAIN,
      CHAIN_LINK_LOCK_HOURS: '0', // the wait after linking has its own test (chain-limits.test.mjs)
    },
    stdio: process.env.DEBUG_CHAIN ? 'inherit' : 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/game/'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('dev server did not start');
});
test.after(() => { server.kill(); rpc.close(); rmSync(dir, { recursive: true, force: true }); });

const GETS = ['me', 'state', 'chain', 'wallet'];
async function api(action, key, body, headers = {}) {
  const get = GETS.includes(action);
  const res = await fetch(`${BASE}/api/game/${action}`, {
    method: get ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}), ...headers },
    body: get ? undefined : JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json() };
}
const sync = () => api('chainsync', null, {}, { 'x-chain-sync-key': SYNC_KEY });
const CHESTS = ['wreck', 'lonely', 'gull', 'doubloon'].map((id) => ({ t: 'chest', id })); // 120 gold
const KNIGHT = { name: 'Hero', cls: 'knight', skin: 1, hs: 'short', hc: 0 };

async function account() {
  const username = 'w' + Math.random().toString(36).slice(2, 10);
  // each from its own address: sign-ups are rate-limited per IP for real here
  const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const r = await api('signup', null, { username, password: 'hunter2hunter2' }, { 'x-forwarded-for': ip });
  assert.equal(r.status, 200);
  return { username, key: r.data.key };
}
// The message a wallet signs (what game/lib/wallet.js builds), for `purpose` = link | login.
async function siwe(wallet, purpose, key, over = {}) {
  const n = await api(purpose === 'link' ? 'linknonce' : 'loginnonce', key, {});
  assert.equal(n.status, 200);
  const message = createSiweMessage({
    domain: DOMAIN, address: wallet.address, statement: n.data.statement, uri: `https://${DOMAIN}/game/`,
    version: '1', chainId: n.data.chainId, nonce: n.data.nonce, issuedAt: new Date(), ...over,
  });
  return { message, signature: await wallet.signMessage({ message }) };
}
const claim = (v, from) => chain.send({
  from, to: at.bridge, abi: built.GameBridge.abi, functionName: 'claim',
  args: [{ ...v.claim, id: BigInt(v.claim.id), amount: BigInt(v.claim.amount), nonce: BigInt(v.claim.nonce), deadline: BigInt(v.claim.deadline) }, v.signature],
});
const goldOnChain = (a) => chain.read({ to: at.gold, abi: built.GameGold.abi, functionName: 'balanceOf', args: [a] });

test('the API says which chain and bridge it uses', async () => {
  const r = await api('chain');
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, true);
  assert.equal(r.data.chainId, 46630);
  assert.equal(r.data.bridge.toLowerCase(), at.bridge.toLowerCase());
});

test('withdrawing needs a linked wallet; linking needs a valid, fresh, single-use signature', async () => {
  const a = await account();
  const w = privateKeyToAccount(generatePrivateKey());
  assert.equal((await api('withdraw', a.key, { kind: 'gold', amount: 1 })).status, 409);

  // signed by a different wallet than the message names
  const bad = await siwe(w, 'link', a.key);
  bad.signature = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: bad.message });
  assert.equal((await api('link', a.key, bad)).status, 401);
  // from another site, or another chain
  assert.equal((await api('link', a.key, await siwe(w, 'link', a.key, { domain: 'evil.test' }))).status, 401);
  assert.equal((await api('link', a.key, await siwe(w, 'link', a.key, { chainId: 1 }))).status, 401);
  // a login nonce can't link
  const login = await siwe(w, 'login', null);
  assert.equal((await api('link', a.key, login)).status, 401);

  const good = await siwe(w, 'link', a.key);
  const r = await api('link', a.key, good);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.wallet, w.address.toLowerCase());
  // replaying the same signature fails (the nonce is spent)
  assert.equal((await api('link', a.key, good)).status, 401);

  // another account can't take the same wallet
  const b = await account();
  assert.equal((await api('link', b.key, await siwe(w, 'link', b.key))).status, 409);
  // a nonce made for one account doesn't work for another
  const forA = await siwe(w, 'link', a.key);
  assert.equal((await api('link', b.key, forA)).status, 401);
});

test('gold: withdraw, claim on-chain, deposit back, and the sync credits the account', async () => {
  const a = await account();
  const w = privateKeyToAccount(generatePrivateKey());
  assert.equal((await api('link', a.key, await siwe(w, 'link', a.key))).status, 200);
  assert.equal((await api('act', a.key, { actions: CHESTS })).status, 200);
  assert.equal((await api('state', a.key)).data.econ.gold, 120);

  assert.equal((await api('withdraw', a.key, { kind: 'gold', amount: 500 })).status, 409); // too much
  const r = await api('withdraw', a.key, { kind: 'gold', amount: 100 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state.econ.gold, 20);
  assert.equal(r.data.voucher.claim.to.toLowerCase(), w.address.toLowerCase());

  // the claim is listed until it's used
  assert.equal((await api('wallet', a.key)).data.pending.length, 1);
  await claim(r.data.voucher, '0x' + 'dd'.repeat(20)); // anyone can pay the gas
  assert.equal(await goldOnChain(w.address), 100n);
  let s = await sync();
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.claimed, 1, JSON.stringify(s.data));
  assert.equal((await api('wallet', a.key)).data.pending.length, 0);

  // deposit 30 back
  await chain.send({ from: w.address, to: at.bridge, abi: built.GameBridge.abi, functionName: 'deposit', args: [KIND.gold, 0n, 30n] });
  s = await sync();
  assert.equal(s.data.deposits, 1, JSON.stringify(s.data));
  assert.equal(s.data.credited, 1);
  assert.equal((await api('state', a.key)).data.econ.gold, 50);
  // running the sync again changes nothing
  s = await sync();
  assert.equal(s.data.deposits + s.data.credited, 0);
  assert.equal((await api('state', a.key)).data.econ.gold, 50);
});

test('gear: withdrawing takes it out of the account and off the character; deposit gives it back', async () => {
  const a = await account();
  const w = privateKeyToAccount(generatePrivateKey());
  assert.equal((await api('link', a.key, await siwe(w, 'link', a.key))).status, 200);
  const saved = await api('save', a.key, { character: KNIGHT });
  const item = saved.data.character.equipment.rhand;
  assert.ok(item, 'the knight starts with a weapon');

  assert.equal((await api('withdraw', a.key, { kind: 'item', item: 'not_an_item' })).status, 400);
  const r = await api('withdraw', a.key, { kind: 'item', item });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(!r.data.inventory.includes(item));
  assert.equal(r.data.character.equipment.rhand, null);
  assert.equal((await api('withdraw', a.key, { kind: 'item', item })).status, 409); // gone

  await claim(r.data.voucher, w.address);
  const id = itemTokenId(item);
  assert.equal(await chain.read({ to: at.items, abi: built.GameItems.abi, functionName: 'balanceOf', args: [w.address, id] }), 1n);

  await chain.send({ from: w.address, to: at.bridge, abi: built.GameBridge.abi, functionName: 'deposit', args: [KIND.item, id, 1n] });
  await sync();
  assert.ok((await api('me', a.key)).data.inventory.includes(item));
});

const resOnChain = (id, a) => chain.read({ to: at.resources[id], abi: built.GameResource.abi, functionName: 'balanceOf', args: [a] });
// An account with a linked wallet and 50 Slime Gel in the bag.
async function withGel() {
  const a = await account();
  const w = privateKeyToAccount(generatePrivateKey());
  assert.equal((await api('link', a.key, await siwe(w, 'link', a.key))).status, 200);
  await grant(BASE, a.username, { bag: { slime_gel: 50, health_potion: 3 } });
  assert.equal((await api('state', a.key)).data.econ.bag.slime_gel, 50);
  return { ...a, w };
}

test('resources: withdraw from the bag as their own ERC-20, deposit back', async () => {
  const a = await withGel();
  assert.equal((await api('withdraw', a.key, { kind: 'resource', item: 'slime_gel', amount: 51 })).status, 409);
  assert.equal((await api('withdraw', a.key, { kind: 'resource', item: 'slime_gel', amount: 0 })).status, 400);
  const r = await api('withdraw', a.key, { kind: 'resource', item: 'slime_gel', amount: 20 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state.econ.bag.slime_gel, 30);
  assert.equal(r.data.voucher.claim.kind, KIND.resource);
  await claim(r.data.voucher, a.w.address);
  assert.equal(await resOnChain('slime_gel', a.w.address), 20n);

  await chain.send({ from: a.w.address, to: at.bridge, abi: built.GameBridge.abi, functionName: 'deposit', args: [KIND.resource, BigInt(r.data.voucher.claim.id), 8n] });
  await sync();
  assert.equal((await api('state', a.key)).data.econ.bag.slime_gel, 38);
  assert.equal(await resOnChain('slime_gel', a.w.address), 12n);
});

test('resources: consumables and other bag items stay in the game', async () => {
  const a = await withGel();
  assert.equal((await api('withdraw', a.key, { kind: 'resource', item: 'health_potion', amount: 1 })).status, 400);
  assert.equal((await api('withdraw', a.key, { kind: 'resource', item: 'carrot_seed', amount: 1 })).status, 400);
});

test('resources: a deposit that overflows the bag keeps the rest in the stash', async () => {
  const a = await withGel();
  const r = await api('withdraw', a.key, { kind: 'resource', item: 'slime_gel', amount: 10 });
  await claim(r.data.voucher, a.w.address);
  // fill the bag nearly to the cap (straight in the mock database)
  const row = (await (await fetch(`${BASE}/rest/v1/game_players?username=eq.${a.username}`)).json())[0];
  await fetch(`${BASE}/rest/v1/game_players?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ econ: { ...row.econ, bag: { ...row.econ.bag, slime_gel: 99995 } }, econ_rev: row.econ_rev + 1 }) });
  await chain.send({ from: a.w.address, to: at.bridge, abi: built.GameBridge.abi, functionName: 'deposit', args: [KIND.resource, BigInt(r.data.voucher.claim.id), 10n] });
  await sync();
  assert.equal((await api('state', a.key)).data.econ.bag.slime_gel, 99999);
  assert.equal((await api('wallet', a.key)).data.stash.slime_gel, 6);
  // the stash is withdrawn first
  const again = await api('withdraw', a.key, { kind: 'resource', item: 'slime_gel', amount: 7 });
  assert.equal(again.status, 200);
  assert.equal(again.data.state.econ.bag.slime_gel, 99998);
  assert.equal((await api('wallet', a.key)).data.stash.slime_gel, undefined);
});

test('a claim that expires unused is refunded, once', async () => {
  const a = await account();
  const w = privateKeyToAccount(generatePrivateKey());
  assert.equal((await api('link', a.key, await siwe(w, 'link', a.key))).status, 200);
  await api('act', a.key, { actions: CHESTS });
  const r = await api('withdraw', a.key, { kind: 'gold', amount: 70 });
  assert.equal(r.status, 200);
  assert.equal((await api('unlink', a.key, {})).status, 409); // not while a claim is pending

  // it hasn't expired yet: nothing happens
  let s = await sync();
  assert.equal(s.data.refunded, 0);
  // mark it expired in the mock database (the server's clock can't be moved), and the chain's too
  await fetch(`${BASE}/rest/v1/game_withdrawals?nonce=eq.${r.data.voucher.claim.nonce}`, { method: 'PATCH', body: JSON.stringify({ deadline: 1000 }) });
  s = await sync();
  assert.equal(s.data.refunded, 1);
  assert.equal((await api('state', a.key)).data.econ.gold, 120);
  s = await sync();
  assert.equal(s.data.refunded, 0);
  assert.equal((await api('state', a.key)).data.econ.gold, 120);
});

test('no refund while the chain\'s own clock is still before the deadline', async () => {
  const a = await account();
  const w = privateKeyToAccount(generatePrivateKey());
  assert.equal((await api('link', a.key, await siwe(w, 'link', a.key))).status, 200);
  await api('act', a.key, { actions: CHESTS });
  const r = await api('withdraw', a.key, { kind: 'gold', amount: 25 });
  // expired by the server's clock, but the sequencer's block timestamps trail behind
  const deadline = Math.floor(Date.now() / 1000) - 3600;
  await fetch(`${BASE}/rest/v1/game_withdrawals?nonce=eq.${r.data.voucher.claim.nonce}`, { method: 'PATCH', body: JSON.stringify({ deadline }) });
  const real = chain.time;
  chain.time = BigInt(deadline - 600);
  try {
    assert.equal((await sync()).data.refunded, 0);
    assert.equal((await api('state', a.key)).data.econ.gold, 95);
  } finally { chain.time = real; }
  assert.equal((await sync()).data.refunded, 1);
  assert.equal((await api('state', a.key)).data.econ.gold, 120);
});

test('a claim already used on-chain is never refunded', async () => {
  const a = await account();
  const w = privateKeyToAccount(generatePrivateKey());
  assert.equal((await api('link', a.key, await siwe(w, 'link', a.key))).status, 200);
  await api('act', a.key, { actions: CHESTS });
  const r = await api('withdraw', a.key, { kind: 'gold', amount: 10 });
  await claim(r.data.voucher, w.address);
  // the sync hasn't read the Claimed event (pretend the log was missed), and the deadline passed
  const nonce = r.data.voucher.claim.nonce;
  await fetch(`${BASE}/rest/v1/game_chain_state?key=eq.cursor`, { method: 'PATCH', body: JSON.stringify({ value: { block: String(chain.number) } }) });
  await fetch(`${BASE}/rest/v1/game_withdrawals?nonce=eq.${nonce}`, { method: 'PATCH', body: JSON.stringify({ deadline: 1000 }) });
  const s = await sync();
  assert.equal(s.data.refunded, 0);
  assert.equal((await api('state', a.key)).data.econ.gold, 110);
});

test('deposits from a wallet that is not linked yet wait, then arrive on linking', async () => {
  const a = await account();
  const w = privateKeyToAccount(generatePrivateKey());
  // the wallet gets gold through someone else's claim (b's withdrawal to b's wallet, sent on)
  const b = await account();
  const wb = privateKeyToAccount(generatePrivateKey());
  assert.equal((await api('link', b.key, await siwe(wb, 'link', b.key))).status, 200);
  await api('act', b.key, { actions: CHESTS });
  const r = await api('withdraw', b.key, { kind: 'gold', amount: 40 });
  await claim(r.data.voucher, wb.address);
  await chain.send({ from: wb.address, to: at.gold, abi: built.GameGold.abi, functionName: 'transfer', args: [w.address, 40n] });
  await chain.send({ from: w.address, to: at.bridge, abi: built.GameBridge.abi, functionName: 'deposit', args: [KIND.gold, 0n, 40n] });
  const s = await sync();
  assert.equal(s.data.deposits, 1);
  assert.equal(s.data.credited, 0);

  const l = await api('link', a.key, await siwe(w, 'link', a.key));
  assert.equal(l.status, 200);
  assert.equal(l.data.credited, 1);
  assert.equal((await api('state', a.key)).data.econ.gold, 40);
});

test('a linked wallet can sign in', async () => {
  const a = await account();
  const w = privateKeyToAccount(generatePrivateKey());
  assert.equal((await api('walletlogin', null, await siwe(w, 'login', null))).status, 404); // not linked
  assert.equal((await api('link', a.key, await siwe(w, 'link', a.key))).status, 200);
  const r = await api('walletlogin', null, await siwe(w, 'login', null));
  assert.equal(r.status, 200);
  assert.equal(r.data.username, a.username);
  assert.equal((await api('me', r.data.key)).status, 200);
  // a link nonce can't sign in (signing in replaced the old session, so ask with the new key)
  assert.equal((await api('walletlogin', null, await siwe(w, 'link', r.data.key))).status, 401);
});

test('only the scheduler can run the chain sync', async () => {
  assert.equal((await api('chainsync', null, {})).status, 401);
  assert.equal((await api('chainsync', null, {}, { 'x-chain-sync-key': 'wrong' })).status, 401);
});
