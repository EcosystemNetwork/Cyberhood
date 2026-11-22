// Bloom and the Orchard (contracts/src) on the in-process EVM: the halving emission, a harvest's
// paid / locked split and its linear unlock, stakers sharing a grove by stake, emergency exits,
// admin rights, a fuzz of random actions that must never mint more than was emitted, and the real
// flow: a player adds liquidity to a resource / stock pool on Uniswap V2 and stakes the LP tokens.
//   node --test tests/chain-orchard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits, keccak256, toBytes } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { compile } from '../tools/chain/compile.mjs';
import { MiniChain, deployAll } from './helpers/minichain.mjs';
import { deployDex, seedPools, claimSigner } from '../tools/chain/dex-core.mjs';
import { deployOrchard, orchardArgs, handOver } from '../tools/chain/orchard-core.mjs';
import { RESOURCES, STOCK_POOLS, ORCHARD, ORCHARD_GROVES, ORCHARD_ABI, BLOOM, ERC20_ABI, ROUTER_ABI, claimDomain } from '../game/lib/chain.js';

const built = compile({ withTests: true });
const O = built.Orchard.abi;
const admin = '0x' + 'a1'.repeat(20);
const players = ['b2', 'c3', 'd4', 'e5'].map((b) => '0x' + b.repeat(20));
const [alice, bob] = players;
const signer = privateKeyToAccount(generatePrivateKey());
const E18 = 10n ** 18n;
const DAY = 86400n;
const RATE = parseUnits(String(ORCHARD.ratePerSecond), 18);
const HALVING = BigInt(ORCHARD.halvingDays) * DAY;
const VEST = BigInt(ORCHARD.vestDays) * DAY;
const rejects = async (p, name) => { await assert.rejects(p, (e) => e.revert === name || e.message.includes(name)); };

let chain;
test.before(async () => { chain = await MiniChain.create(); });

const send = (from, to, abi, functionName, args = []) => chain.send({ from, to, abi, functionName, args });
const read = (to, abi, functionName, args = []) => chain.read({ to, abi, functionName, args });
const bal = (token, who) => read(token, ERC20_ABI, 'balanceOf', [who]);

// A fresh Bloom + Orchard with `n` mock LP tokens (MockStock: anyone can mint), each its own grove.
async function fresh({ n = 2, allocs = [100, 300], start = chain.time } = {}) {
  const bloom = await chain.deploy(admin, built.Bloom, [admin, parseUnits(String(BLOOM.cap), 18)]);
  const orchard = await chain.deploy(admin, built.Orchard, orchardArgs(admin, bloom, start));
  await send(admin, bloom, built.Bloom.abi, 'grantRole', [await read(bloom, built.Bloom.abi, 'MINTER_ROLE'), orchard]);
  const lps = [];
  for (let i = 0; i < n; i++) {
    const lp = await chain.deploy(admin, built.MockStock, ['LP' + i]);
    for (const p of players) {
      await send(p, lp, built.MockStock.abi, 'mint', [p, 1000n * E18]);
      await send(p, lp, ERC20_ABI, 'approve', [orchard, 2n ** 256n - 1n]);
    }
    await send(admin, orchard, O, 'addGrove', [lp, BigInt(allocs[i])]);
    lps.push(lp);
  }
  return { bloom, orchard, lps };
}

test('emission halves every epoch and its total stays under Bloom\'s cap', async () => {
  const { orchard } = await fresh({ start: chain.time + 100n });
  const s = await read(orchard, O, 'start');
  assert.equal(await read(orchard, O, 'emitted', [0n, s]), 0n); // nothing before the start
  assert.equal(await read(orchard, O, 'emitted', [s, s + 10n]), 10n * RATE);
  assert.equal(await read(orchard, O, 'emitted', [s + HALVING - 10n, s + HALVING + 10n]), 10n * RATE + 10n * (RATE / 2n));
  assert.equal(await read(orchard, O, 'emitted', [s, s + 3n * HALVING]), HALVING * (RATE + RATE / 2n + RATE / 4n));
  const all = await read(orchard, O, 'emitted', [s, s + 100n * HALVING]);
  assert.ok(all < 2n * RATE * HALVING && all > 2n * RATE * HALVING - RATE * HALVING / 2n ** 40n);
  assert.ok(2n * RATE * HALVING <= parseUnits(String(BLOOM.cap), 18));
});

test('an emission bigger than what is left of the cap is refused', async () => {
  const bloom = await chain.deploy(admin, built.Bloom, [admin, 1000n * E18]);
  await rejects(chain.deploy(admin, built.Orchard, orchardArgs(admin, bloom, chain.time)), 'BadConfig');
});

test('a lone staker earns the grove\'s share: 25% paid now, 75% unlocking over the vest', async () => {
  const { bloom, orchard } = await fresh(); // groves weighted 100 : 300
  const t0 = chain.time;
  await send(alice, orchard, O, 'deposit', [1n, 10n * E18]);
  chain.warp(Number(DAY));
  const t1 = chain.time;
  const earned = (await read(orchard, O, 'emitted', [t0, t1])) * 300n / 400n;
  const pend = await read(orchard, O, 'pending', [1n, alice]);
  assert.ok(earned - pend < 1000n, `pending ${pend} vs ${earned}`); // only rounding dust
  await send(alice, orchard, O, 'harvestAll');
  const paid = await bal(bloom, alice);
  assert.ok(earned - paid * 4n < 4000n && paid > 0n);
  const [stillLocked, ready, end] = await read(orchard, O, 'vestOf', [alice]);
  const locked = stillLocked + ready; // the read is a block (2 s) after the harvest
  assert.equal(end, t1 + VEST);
  assert.ok(locked - paid * 3n < 4n, `locked ${locked} is 3x paid ${paid}`);
  assert.ok(ready <= (locked * 2n) / VEST + 1n);

  chain.warp(Number(VEST / 2n));
  const [, half] = await read(orchard, O, 'vestOf', [alice]);
  const diff = half * 2n > locked ? half * 2n - locked : locked - half * 2n;
  assert.ok(diff < locked / 10000n, 'half unlocked at half time');
  chain.warp(Number(VEST));
  const before = await bal(bloom, alice);
  await send(alice, orchard, O, 'claimVested');
  assert.equal(await bal(bloom, alice), before + locked);
  assert.deepEqual((await read(orchard, O, 'vestOf', [alice])).slice(0, 2), [0n, 0n]);
});

test('two stakers split a grove by stake, and withdrawing returns the LP tokens', async () => {
  const { bloom, orchard, lps } = await fresh({ n: 1, allocs: [100] });
  await send(alice, orchard, O, 'deposit', [0n, 30n * E18]);
  await send(bob, orchard, O, 'deposit', [0n, 10n * E18]);
  chain.warp(3600);
  const a = await read(orchard, O, 'pending', [0n, alice]);
  const b = await read(orchard, O, 'pending', [0n, bob]);
  const ratio = Number(a * 1000n / b);
  assert.ok(ratio > 3000 && ratio < 3010, 'about 3 : 1, alice had the grove alone for one block: ' + ratio);
  const lpBefore = await bal(lps[0], bob);
  await send(bob, orchard, O, 'withdraw', [0n, 10n * E18]);
  assert.equal(await bal(lps[0], bob), lpBefore + 10n * E18);
  assert.ok((await bal(bloom, bob)) > 0n, 'withdrawing harvests');
  await rejects(send(bob, orchard, O, 'withdraw', [0n, 1n]), 'Insufficient');
});

test('emergencyWithdraw always returns the stake and gives up the unharvested Bloom', async () => {
  const { bloom, orchard, lps } = await fresh({ n: 1, allocs: [100] });
  await send(alice, orchard, O, 'deposit', [0n, 5n * E18]);
  chain.warp(3600);
  const lpBefore = await bal(lps[0], alice);
  await send(alice, orchard, O, 'emergencyWithdraw', [0n]);
  assert.equal(await bal(lps[0], alice), lpBefore + 5n * E18);
  assert.equal(await bal(bloom, alice), 0n);
  assert.equal(await read(orchard, O, 'pending', [0n, alice]), 0n);
});

test('only the admin adds or reweights groves, a pool is listed once, nobody else can mint Bloom', async () => {
  const { bloom, orchard, lps } = await fresh({ n: 1, allocs: [100] });
  await rejects(send(alice, orchard, O, 'addGrove', [alice, 1n]), 'AccessControlUnauthorizedAccount');
  await rejects(send(alice, orchard, O, 'setGrove', [0n, 1n]), 'AccessControlUnauthorizedAccount');
  await rejects(send(admin, orchard, O, 'addGrove', [lps[0], 1n]), 'AlreadyListed');
  await rejects(send(admin, orchard, O, 'setGrove', [9n, 1n]), 'NoGrove');
  await rejects(send(admin, bloom, built.Bloom.abi, 'mint', [admin, 1n]), 'AccessControlUnauthorizedAccount');
  await send(admin, orchard, O, 'setGrove', [0n, 0n]); // a grove at weight 0 earns nothing
  await send(alice, orchard, O, 'deposit', [0n, E18]);
  chain.warp(3600);
  assert.equal(await read(orchard, O, 'pending', [0n, alice]), 0n);
});

test('fuzz: random stakes, withdrawals, harvests and exits never mint more than was emitted', async () => {
  const { bloom, orchard, lps } = await fresh();
  const t0 = chain.time;
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const staked = [{}, {}];
  for (let step = 0; step < 150; step++) {
    const who = players[rnd(players.length)], gid = rnd(2), op = rnd(10);
    const have = staked[gid][who] || 0n;
    if (op < 4) {
      const amt = BigInt(rnd(50) + 1) * E18 / 7n;
      await send(who, orchard, O, 'deposit', [BigInt(gid), amt]);
      staked[gid][who] = have + amt;
    } else if (op < 6 && have > 0n) {
      const amt = have / BigInt(rnd(3) + 1);
      await send(who, orchard, O, 'withdraw', [BigInt(gid), amt]);
      staked[gid][who] = have - amt;
    } else if (op < 8) await send(who, orchard, O, 'harvestAll');
    else if (op === 8) await send(who, orchard, O, 'claimVested');
    else if (have > 0n) { await send(who, orchard, O, 'emergencyWithdraw', [BigInt(gid)]); staked[gid][who] = 0n; }
    chain.warp(rnd(5) * 3600 + rnd(60));
  }
  // the Orchard holds exactly what is staked
  for (let gid = 0; gid < 2; gid++) {
    const sum = Object.values(staked[gid]).reduce((a, b) => a + b, 0n);
    assert.equal(await bal(lps[gid], orchard), sum);
    assert.equal((await read(orchard, O, 'groves', [BigInt(gid)]))[2], sum);
  }
  // minted + still locked + still pending <= emitted
  let owed = await read(bloom, ERC20_ABI.concat(built.Bloom.abi), 'totalSupply');
  for (const p of players) {
    owed += (await read(orchard, O, 'vestOf', [p]))[0] + (await read(orchard, O, 'vestOf', [p]))[1];
    for (let gid = 0; gid < 2; gid++) owed += await read(orchard, O, 'pending', [BigInt(gid), p]);
  }
  const emitted = await read(orchard, O, 'emitted', [t0, chain.time]);
  assert.ok(owed <= emitted, `owed ${owed} > emitted ${emitted}`);
  assert.ok(owed > 0n);
});

test('end to end: the deploy tool plants a grove per stock pool; a player stakes real LP tokens', async () => {
  const at = await deployAll(chain, built, { admin, signer: signer.address, resources: RESOURCES });
  const stocks = {};
  for (const s of new Set(STOCK_POOLS.map((p) => p.stock))) {
    stocks[s] = await chain.deploy(admin, built.MockStock, [s]);
    await send(admin, stocks[s], built.MockStock.abi, 'mint', [admin, 5n * E18]);
  }
  const io = {
    account: admin,
    deploy: (art, args) => chain.deploy(admin, art, args),
    send: (to, abi, fn, args) => send(admin, to, abi, fn, args),
    read: (to, abi, fn, args) => read(to, abi, fn, args),
  };
  const dex = await deployDex(io);
  const pairs = await seedPools(io, { bridge: at.bridge, chainId: chain.chainId, dex, stocks, signClaim: claimSigner(signer), deadline: chain.time + 3600n });
  const res = await deployOrchard(io, { built, pairs, start: chain.time });
  assert.equal(await read(res.orchard, O, 'groveCount'), BigInt(ORCHARD_GROVES.length));
  const again = await deployOrchard(io, { built, pairs, have: res, start: chain.time });
  assert.deepEqual(again, res, 're-running changes nothing');
  assert.equal(await read(res.orchard, O, 'groveCount'), BigInt(ORCHARD_GROVES.length));

  // alice adds sun_gem + TSLA liquidity, then stakes the LP tokens
  const gem = at.resources.sun_gem, tsla = stocks.TSLA, gid = BigInt(res.groves.sun_gem);
  await send(alice, tsla, built.MockStock.abi, 'mint', [alice, E18]);
  // sun_gem only comes from the bridge: mint her 10 with a voucher, as a withdrawal would
  const sign = claimSigner(signer);
  const c = { to: alice, kind: 3, id: BigInt(keccak256(toBytes('sun_gem'))), amount: 10n, nonce: 999_001n, deadline: chain.time + 3600n };
  await send(alice, at.bridge, built.GameBridge.abi, 'claim', [c, await sign(claimDomain(chain.chainId, at.bridge), c)]);
  await send(alice, gem, ERC20_ABI, 'approve', [dex.router, 10n]);
  await send(alice, tsla, ERC20_ABI, 'approve', [dex.router, E18]);
  await send(alice, dex.router, ROUTER_ABI, 'addLiquidity', [gem, tsla, 10n, E18, 1n, 1n, alice, chain.time + 600n]);
  const lp = await bal(pairs.sun_gem, alice);
  assert.ok(lp > 0n);
  await send(alice, pairs.sun_gem, ERC20_ABI, 'approve', [res.orchard, lp]);
  await send(alice, res.orchard, O, 'deposit', [gid, lp]);
  chain.warp(600);
  assert.ok((await read(res.orchard, O, 'pending', [gid, alice])) > 0n);
  await send(alice, res.orchard, O, 'harvestAll');
  assert.ok((await bal(res.bloom, alice)) > 0n);

  // handing over to a multisig leaves the deployer with no rights
  const msig = '0x' + 'f6'.repeat(20);
  await handOver(io, { built, bloom: res.bloom, orchard: res.orchard, admin: msig });
  await rejects(send(admin, res.orchard, O, 'setGrove', [0n, 1n]), 'AccessControlUnauthorizedAccount');
  await send(msig, res.orchard, O, 'setGrove', [0n, 1n]);
});
