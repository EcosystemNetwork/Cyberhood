// The Robinhood Chain contracts (contracts/src) on an in-process EVM: vouchers signed with the
// shared EIP-712 type from game/lib/chain.js (what the game API signs with) mint on claim, only
// once, only before the deadline and only from the server's signer; deposits burn and report.
//   node --test tests/chain-contracts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { compile } from '../tools/chain/compile.mjs';
import { MiniChain, deployAll } from './helpers/minichain.mjs';
import { CLAIM_TYPES, claimDomain, KIND, RESOURCES } from '../game/lib/chain.js';

const built = compile();
const B = built.GameBridge.abi;
const admin = '0x' + 'a1'.repeat(20);
const alice = '0x' + 'b2'.repeat(20);
const bob = '0x' + 'c3'.repeat(20);
const signer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

let chain, at;
test.before(async () => {
  chain = await MiniChain.create();
  at = await deployAll(chain, built, { admin, signer: signer.address, resources: { copper_ore: RESOURCES.copper_ore, wheat: RESOURCES.wheat } });
});

let nextNonce = 1n;
async function voucher(over = {}, by = signer) {
  const c = { to: alice, kind: KIND.gold, id: 0n, amount: 50n, nonce: nextNonce++, deadline: chain.time + 3600n, ...over };
  const signature = await by.signTypedData({ domain: claimDomain(chain.chainId, at.bridge), types: CLAIM_TYPES, primaryType: 'Claim', message: c });
  return { c, signature };
}
const claim = ({ c, signature }, from = bob) => chain.send({ from, to: at.bridge, abi: B, functionName: 'claim', args: [c, signature] });
const deposit = (from, kind, id, amount) => chain.send({ from, to: at.bridge, abi: B, functionName: 'deposit', args: [kind, id, amount] });
const goldOf = (a) => chain.read({ to: at.gold, abi: built.GameGold.abi, functionName: 'balanceOf', args: [a] });
const itemOf = (a, id) => chain.read({ to: at.items, abi: built.GameItems.abi, functionName: 'balanceOf', args: [a, id] });
const rejects = async (p, name) => { await assert.rejects(p, (e) => e.revert === name || e.message.includes(name)); };

test('a signed gold claim mints to the player, anyone may submit it', async () => {
  const before = await goldOf(alice);
  await claim(await voucher({ amount: 50n }));
  assert.equal(await goldOf(alice), before + 50n);
  assert.equal(await chain.read({ to: at.gold, abi: built.GameGold.abi, functionName: 'decimals' }), 0);
});

test('a voucher works once', async () => {
  const v = await voucher();
  await claim(v);
  await rejects(claim(v), 'NonceUsed');
  assert.equal(await chain.read({ to: at.bridge, abi: B, functionName: 'used', args: [v.c.nonce] }), true);
});

test('only the server signer can sign, and the voucher cannot be altered', async () => {
  await rejects(claim(await voucher({}, stranger)), 'BadSigner');
  const v = await voucher({ amount: 5n });
  await rejects(claim({ ...v, c: { ...v.c, amount: 5000n } }), 'BadSigner');
  await rejects(claim({ ...v, c: { ...v.c, to: bob } }), 'BadSigner');
});

test('an expired voucher is refused', async () => {
  const v = await voucher({ deadline: chain.time + 60n });
  chain.warp(120);
  await rejects(claim(v), 'Expired');
});

test('items: claim mints the ERC-1155 id, deposit burns it and emits Deposited', async () => {
  const id = BigInt(keccak256(toBytes('fire_wand')));
  await claim(await voucher({ kind: KIND.item, id, amount: 1n }));
  assert.equal(await itemOf(alice, id), 1n);
  const n = chain.logs.length;
  await deposit(alice, KIND.item, id, 1n);
  assert.equal(await itemOf(alice, id), 0n);
  // the items contract's TransferSingle (the burn), then the bridge's Deposited
  assert.deepEqual(chain.logs.slice(n).map((l) => l.address.toLowerCase()), [at.items, at.bridge].map((x) => x.toLowerCase()));
  await rejects(deposit(alice, KIND.item, id, 1n), 'ERC1155InsufficientBalance');
});

test('gold deposit burns, and you cannot deposit more than you hold', async () => {
  const have = await goldOf(alice);
  await deposit(alice, KIND.gold, 0n, 10n);
  assert.equal(await goldOf(alice), have - 10n);
  await rejects(deposit(bob, KIND.gold, 0n, 1n), 'ERC20InsufficientBalance');
  await rejects(deposit(alice, KIND.gold, 0n, 0n), 'BadAmount');
});

test('plots: one NFT per plot number, only its owner can deposit it', async () => {
  await claim(await voucher({ kind: KIND.plot, id: 7n, amount: 1n }));
  assert.equal((await chain.read({ to: at.plots, abi: built.FarmPlots.abi, functionName: 'ownerOf', args: [7n] })).toLowerCase(), alice);
  await rejects(claim(await voucher({ kind: KIND.plot, id: 7n, amount: 1n })), 'ERC721InvalidSender');
  await rejects(claim(await voucher({ kind: KIND.plot, id: 8n, amount: 2n })), 'BadAmount');
  await rejects(deposit(bob, KIND.plot, 7n, 1n), 'NotPlotOwner');
  await deposit(alice, KIND.plot, 7n, 1n);
  await assert.rejects(chain.read({ to: at.plots, abi: built.FarmPlots.abi, functionName: 'ownerOf', args: [7n] }), /reverted/); // burned
});

test('tokens can only be minted through the bridge', async () => {
  await rejects(chain.send({ from: alice, to: at.gold, abi: built.GameGold.abi, functionName: 'mint', args: [alice, 1n] }), 'AccessControlUnauthorizedAccount');
  await rejects(chain.send({ from: alice, to: at.items, abi: built.GameItems.abi, functionName: 'mint', args: [alice, 1n, 1n] }), 'AccessControlUnauthorizedAccount');
});

test('pausing stops claims and deposits; only the admin can pause', async () => {
  await rejects(chain.send({ from: alice, to: at.bridge, abi: B, functionName: 'pause' }), 'AccessControlUnauthorizedAccount');
  await chain.send({ from: admin, to: at.bridge, abi: B, functionName: 'pause' });
  await rejects(claim(await voucher()), 'EnforcedPause');
  await rejects(deposit(alice, KIND.gold, 0n, 1n), 'EnforcedPause');
  await chain.send({ from: admin, to: at.bridge, abi: B, functionName: 'unpause' });
  await claim(await voucher());
});

const rid = (id) => BigInt(keccak256(toBytes(id)));
const R = built.GameResource.abi;
const resOf = (id, a) => chain.read({ to: at.resources[id], abi: R, functionName: 'balanceOf', args: [a] });

test('each resource is its own ERC-20 (0 decimals), deployed by the bridge', async () => {
  assert.notEqual(at.resources.copper_ore.toLowerCase(), at.resources.wheat.toLowerCase());
  assert.equal(await chain.read({ to: at.resources.copper_ore, abi: R, functionName: 'symbol' }), 'COPPER');
  assert.equal(await chain.read({ to: at.resources.copper_ore, abi: R, functionName: 'name' }), 'Taproot Copper Ore');
  assert.equal(await chain.read({ to: at.resources.wheat, abi: R, functionName: 'decimals' }), 0);
  assert.equal((await chain.read({ to: at.resources.wheat, abi: R, functionName: 'bridge' })).toLowerCase(), at.bridge.toLowerCase());
});

test('resources: claim mints the right token, deposit burns it', async () => {
  await claim(await voucher({ kind: KIND.resource, id: rid('copper_ore'), amount: 25n }));
  assert.equal(await resOf('copper_ore', alice), 25n);
  assert.equal(await resOf('wheat', alice), 0n);
  // a plain ERC-20: transferable
  await chain.send({ from: alice, to: at.resources.copper_ore, abi: R, functionName: 'transfer', args: [bob, 5n] });
  await deposit(bob, KIND.resource, rid('copper_ore'), 5n);
  assert.equal(await resOf('copper_ore', bob), 0n);
  assert.equal(chain.logs.at(-1).address.toLowerCase(), at.bridge.toLowerCase()); // Deposited
  await rejects(deposit(bob, KIND.resource, rid('copper_ore'), 1n), 'ERC20InsufficientBalance');
});

test('resources: unknown ids are refused; only the admin adds them, once', async () => {
  await rejects(claim(await voucher({ kind: KIND.resource, id: rid('not_a_resource'), amount: 1n })), 'UnknownResource');
  await rejects(deposit(alice, KIND.resource, rid('not_a_resource'), 1n), 'UnknownResource');
  await rejects(chain.send({ from: alice, to: at.bridge, abi: B, functionName: 'addResource', args: [rid('sun_gem'), 'X', 'X'] }), 'AccessControlUnauthorizedAccount');
  await rejects(chain.send({ from: admin, to: at.bridge, abi: B, functionName: 'addResource', args: [rid('wheat'), 'X', 'X'] }), 'ResourceExists');
  // nobody but the bridge mints
  await rejects(chain.send({ from: admin, to: at.resources.wheat, abi: R, functionName: 'mint', args: [admin, 1n] }), 'OnlyBridge');
});

test('unknown kinds are refused', async () => {
  await rejects(claim(await voucher({ kind: 4 })), 'BadKind');
});
