// GameBridge's daily mint caps: even with the signer's key, only so much can be minted a day.
//   node --test tests/chain-caps.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { compile } from '../tools/chain/compile.mjs';
import { MiniChain, deployAll } from './helpers/minichain.mjs';
import { CLAIM_TYPES, claimDomain, KIND, RESOURCES, MINT_CAPS } from '../game/lib/chain.js';

const built = compile();
const B = built.GameBridge.abi;
const admin = '0x' + 'a1'.repeat(20);
const alice = '0x' + 'b2'.repeat(20);
const signer = privateKeyToAccount(generatePrivateKey());
const DAY = 86400;
const copper = BigInt(keccak256(toBytes('copper_ore')));
const wand = BigInt(keccak256(toBytes('fire_wand')));

let chain, at;
test.before(async () => {
  chain = await MiniChain.create();
  at = await deployAll(chain, built, {
    admin, signer: signer.address, resources: { copper_ore: RESOURCES.copper_ore },
    caps: { gold: 100, item: 2, plot: 1, resource: 30 },
  });
});

let nextNonce = 1n;
async function claim(over) {
  const c = { to: alice, kind: KIND.gold, id: 0n, amount: 1n, nonce: nextNonce++, deadline: chain.time + 3600n, ...over };
  const signature = await signer.signTypedData({ domain: claimDomain(chain.chainId, at.bridge), types: CLAIM_TYPES, primaryType: 'Claim', message: c });
  return chain.send({ from: alice, to: at.bridge, abi: B, functionName: 'claim', args: [c, signature] });
}
const rejects = (p, name) => assert.rejects(p, (e) => e.revert === name || e.message.includes(name));
const mintable = (kind, id) => chain.read({ to: at.bridge, abi: B, functionName: 'mintable', args: [kind, id] });
const asAdmin = (functionName, args) => chain.send({ from: admin, to: at.bridge, abi: B, functionName, args });

test('the deploy sets every kind\'s cap (tools/chain/deploy.mjs uses chain.js MINT_CAPS)', async () => {
  for (const kind of ['gold', 'item', 'plot', 'resource']) assert.ok(MINT_CAPS[kind] > 0, kind);
  assert.equal(await chain.read({ to: at.bridge, abi: B, functionName: 'kindCap', args: [KIND.gold] }), 100n);
});

test('gold: a day\'s cap mints, a voucher past it reverts, the next day it opens again', async () => {
  await claim({ amount: 60n });
  assert.equal(await mintable(KIND.gold, 0n), 40n);
  await rejects(claim({ amount: 41n }), 'OverCap');
  await claim({ amount: 40n });
  await rejects(claim({ amount: 1n }), 'OverCap');
  chain.warp(DAY);
  assert.equal(await mintable(KIND.gold, 0n), 100n);
  await claim({ amount: 100n });
});

test('each item id and each resource has its own window', async () => {
  await claim({ kind: KIND.item, id: wand, amount: 2n });
  await rejects(claim({ kind: KIND.item, id: wand, amount: 1n }), 'OverCap');
  await claim({ kind: KIND.item, id: wand + 1n, amount: 1n }); // another item id
  await claim({ kind: KIND.resource, id: copper, amount: 30n });
  await rejects(claim({ kind: KIND.resource, id: copper, amount: 1n }), 'OverCap');
});

test('all plots share one window', async () => {
  await claim({ kind: KIND.plot, id: 7n, amount: 1n });
  await rejects(claim({ kind: KIND.plot, id: 8n, amount: 1n }), 'OverCap');
});

test('only the admin sets caps; a token cap overrides its kind\'s; with no cap nothing mints', async () => {
  await rejects(chain.send({ from: alice, to: at.bridge, abi: B, functionName: 'setKindCap', args: [KIND.gold, 10n ** 9n] }), 'AccessControlUnauthorizedAccount');
  await asAdmin('setTokenCap', [KIND.item, wand, 5n]);
  assert.equal(await chain.read({ to: at.bridge, abi: B, functionName: 'capOf', args: [KIND.item, wand] }), 5n);
  await claim({ kind: KIND.item, id: wand, amount: 3n }); // 2 already this window
  await asAdmin('setKindCap', [KIND.gold, 0n]);
  chain.warp(DAY);
  await rejects(claim({ amount: 1n }), 'OverCap'); // fails closed
  await rejects(asAdmin('setKindCap', [9, 1n]), 'BadKind');
  await rejects(asAdmin('setKindCap', [KIND.gold, 2n ** 192n]), 'BadCap');
});
