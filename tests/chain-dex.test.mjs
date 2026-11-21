// Uniswap V2 (official bytecode) and the resource / stock-token pools on the in-process EVM:
// deploy, seed every pool in STOCK_POOLS (resources minted to the treasury through the bridge),
// seeding twice changes nothing, and a player sells a withdrawn resource for a stock token at
// the price the router quotes.
//   node --test tests/chain-dex.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { compile } from '../tools/chain/compile.mjs';
import { MiniChain, deployAll } from './helpers/minichain.mjs';
import { deployDex, seedPools, claimSigner } from '../tools/chain/dex-core.mjs';
import { RESOURCES, STOCK_POOLS, KIND, CLAIM_TYPES, claimDomain, ERC20_ABI, ROUTER_ABI, PAIR_ABI, BRIDGE_ABI } from '../game/lib/chain.js';

const built = compile({ withTests: true });
const treasury = '0x' + 'a1'.repeat(20);
const player = '0x' + 'b2'.repeat(20);
const signer = privateKeyToAccount(generatePrivateKey());
const E18 = 10n ** 18n;
let chain, at, dex, stocks, io;

test.before(async () => {
  chain = await MiniChain.create();
  at = await deployAll(chain, built, { admin: treasury, signer: signer.address, resources: RESOURCES });
  stocks = {};
  for (const s of new Set(STOCK_POOLS.map((p) => p.stock))) {
    stocks[s] = await chain.deploy(treasury, built.MockStock, [s]);
    await chain.send({ from: treasury, to: stocks[s], abi: built.MockStock.abi, functionName: 'mint', args: [treasury, 5n * E18] }); // like the faucet
  }
  io = {
    account: treasury,
    deploy: (art, args) => chain.deploy(treasury, art, args),
    send: (to, abi, functionName, args) => chain.send({ from: treasury, to, abi, functionName, args }),
    read: (to, abi, functionName, args) => chain.read({ to, abi, functionName, args }),
  };
  dex = await deployDex(io);
});

const cfg = () => ({ bridge: at.bridge, chainId: chain.chainId, dex, stocks, signClaim: claimSigner(signer), deadline: chain.time + 3600n });
const bal = (token, who) => chain.read({ to: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] });

test('every pool is seeded at its configured price, from the treasury', async () => {
  const pairs = await seedPools(io, cfg());
  for (const p of STOCK_POOLS) {
    const [r0, r1] = await chain.read({ to: pairs[p.resource], abi: PAIR_ABI, functionName: 'getReserves' });
    const t0 = (await chain.read({ to: pairs[p.resource], abi: PAIR_ABI, functionName: 'token0' })).toLowerCase();
    const [res, stock] = t0 === at.resources[p.resource].toLowerCase() ? [r0, r1] : [r1, r0];
    assert.equal(res, BigInt(p.seed.resource), p.resource);
    assert.equal(stock, BigInt(p.seed.stock) * E18, p.stock);
    assert.equal(await bal(stocks[p.stock], treasury), 1n * E18); // one of each stays in reserve
  }
});

test('seeding again leaves the pools alone', async () => {
  const before = chain.number;
  await seedPools(io, cfg());
  assert.equal(chain.number, before); // no transactions
});

test('a player sells a withdrawn resource for a stock token', async () => {
  // the player withdrew 10 Sun Gem from the game (a server-signed voucher)
  const c = { to: player, kind: KIND.resource, id: BigInt(keccak256(toBytes('sun_gem'))), amount: 10n, nonce: 777n, deadline: chain.time + 3600n };
  const sig = await signer.signTypedData({ domain: claimDomain(chain.chainId, at.bridge), types: CLAIM_TYPES, primaryType: 'Claim', message: c });
  await chain.send({ from: player, to: at.bridge, abi: BRIDGE_ABI, functionName: 'claim', args: [c, sig] });
  const gem = at.resources.sun_gem, tsla = stocks.TSLA;
  const path = [gem, tsla];
  const [, quoted] = await chain.read({ to: dex.router, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [10n, path] });
  // x*y=k with the 0.3% fee: 10 gems into 40 gems / 4 TSLA pays a bit under 0.8 TSLA
  assert.ok(quoted > 79n * E18 / 100n && quoted < 80n * E18 / 100n, String(quoted));
  await chain.send({ from: player, to: gem, abi: ERC20_ABI, functionName: 'approve', args: [dex.router, 10n] });
  await chain.send({ from: player, to: dex.router, abi: ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [10n, quoted, path, player, chain.time + 600n] });
  assert.equal(await bal(tsla, player), quoted);
  assert.equal(await bal(gem, player), 0n);
});

test('a swap that would pay less than the minimum is refused', async () => {
  const gem = at.resources.sun_gem, tsla = stocks.TSLA;
  await chain.send({ from: treasury, to: tsla, abi: ERC20_ABI, functionName: 'approve', args: [dex.router, E18] });
  await assert.rejects(chain.send({ from: treasury, to: dex.router, abi: ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [E18 / 10n, 1000n, [tsla, gem], treasury, chain.time + 600n] }), /revert/);
});
