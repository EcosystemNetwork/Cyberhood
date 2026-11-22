/* The Orchard: deploys Bloom and the Orchard (contracts/src) with the settings in
   game/lib/chain.js ORCHARD, gives the Orchard Bloom's MINTER_ROLE, and adds a grove for every
   ORCHARD_GROVES pool whose pair exists. Safe to re-run: what is already there is skipped.

   Written against the same `io` as dex-core.mjs, so it runs on the test chain
   (tests/chain-orchard.test.mjs) and the real one (tools/chain/orchard.mjs). */
import { parseUnits } from 'viem';
import { BLOOM, ORCHARD, ORCHARD_GROVES, ORCHARD_ABI } from '../../game/lib/chain.js';

const DAY = 86400n;
export const orchardArgs = (admin, bloom, start) => [
  admin, bloom, BigInt(start),
  parseUnits(String(ORCHARD.ratePerSecond), BLOOM.decimals),
  BigInt(ORCHARD.halvingDays) * DAY,
  BigInt(ORCHARD.unlockedBps),
  BigInt(ORCHARD.vestDays) * DAY,
];

/* built: { Bloom, Orchard } artifacts. pairs: { resource: pairAddress } (dex-core seedPools / the
   deployments file). have: what is already deployed ({ bloom, orchard }). start: unix seconds.
   Returns { bloom, orchard, groves: { resource: gid } }. */
export async function deployOrchard(io, { built, pairs, have = {}, start, groves = ORCHARD_GROVES }, log = () => {}) {
  const bloom = have.bloom || await io.deploy(built.Bloom, [io.account, parseUnits(String(BLOOM.cap), BLOOM.decimals)]);
  if (!have.bloom) log('Bloom      ' + bloom);
  const orchard = have.orchard || await io.deploy(built.Orchard, orchardArgs(io.account, bloom, start));
  if (!have.orchard) log('Orchard    ' + orchard);

  const MINTER = await io.read(bloom, built.Bloom.abi, 'MINTER_ROLE', []);
  if (!(await io.read(bloom, built.Bloom.abi, 'hasRole', [MINTER, orchard]))) {
    await io.send(bloom, built.Bloom.abi, 'grantRole', [MINTER, orchard]);
    log('Orchard may mint Bloom');
  }

  const out = {};
  const n = Number(await io.read(orchard, ORCHARD_ABI, 'groveCount', []));
  const byLp = {};
  for (let i = 0; i < n; i++) byLp[(await io.read(orchard, ORCHARD_ABI, 'groves', [BigInt(i)]))[0].toLowerCase()] = i;
  for (const g of groves) {
    const pair = pairs[g.resource];
    if (!pair) { log(`${g.resource}/${g.stock}: no pair yet, skipped`); continue; }
    if (byLp[pair.toLowerCase()] === undefined) {
      const gid = Object.keys(byLp).length;
      await io.send(orchard, ORCHARD_ABI, 'addGrove', [pair, BigInt(g.alloc)]);
      byLp[pair.toLowerCase()] = gid;
      log(`grove ${gid}: ${g.resource}/${g.stock} (alloc ${g.alloc})`);
    }
    out[g.resource] = byLp[pair.toLowerCase()];
  }
  return { bloom, orchard, groves: out };
}

/* Hands both contracts' admin role to `admin` (a multisig) and drops the deployer's. */
export async function handOver(io, { built, bloom, orchard, admin }) {
  for (const [at, abi] of [[bloom, built.Bloom.abi], [orchard, built.Orchard.abi]]) {
    const ADMIN = await io.read(at, abi, 'DEFAULT_ADMIN_ROLE', []);
    await io.send(at, abi, 'grantRole', [ADMIN, admin]);
    await io.send(at, abi, 'renounceRole', [ADMIN, io.account]);
  }
}
