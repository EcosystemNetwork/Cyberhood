/* Deploys Bloom and the Orchard on Robinhood Chain and adds a grove for each resource / stock pool
   already seeded by tools/chain/dex.mjs (contracts/deployments/<chainId>.json `pools`). Safe to
   re-run: it skips what exists. Records everything in the deployments file.

     node --env-file=.env.chain.testnet tools/chain/orchard.mjs        (npm run chain:orchard:testnet)

   Needs DEPLOYER_KEY; [NETWORK=testnet] [CHAIN_RPC=...] [ADMIN=0x... to hand both contracts to a
   multisig afterwards] [ORCHARD_START=unix seconds, default: 10 minutes from now]. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS } from '../../game/lib/chain.js';
import { compile } from './compile.mjs';
import { deployOrchard, handOver } from './orchard-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const die = (m) => { console.error(m); process.exit(1); };
const net = CHAINS[env.NETWORK || 'testnet'] || die('NETWORK must be testnet or mainnet');
if (!net.testnet && !env.ADMIN) die('On mainnet set ADMIN to a multisig: the deployer must not stay admin');
const rpc = env.CHAIN_RPC || net.rpcUrls.default.http[0] || die('Set CHAIN_RPC for ' + net.name);
const deployer = privateKeyToAccount(env.DEPLOYER_KEY || die('Set DEPLOYER_KEY'));
const chain = { id: net.id, name: net.name, nativeCurrency: net.nativeCurrency, rpcUrls: { default: { http: [rpc] } } };
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });
const pub = createPublicClient({ chain, transport: http(rpc) });
const file = join(ROOT, `contracts/deployments/${net.id}.json`);
const load = () => JSON.parse(readFileSync(file, 'utf8'));
// other tools write this file too: re-read it right before each save and merge our part in
const save = (part) => { const d = load(); d.orchard = { ...(d.orchard || {}), ...part }; writeFileSync(file, JSON.stringify(d, null, 2) + '\n'); };

const io = {
  account: deployer.address,
  async deploy(art, args) {
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') die('deploy failed: ' + hash);
    return r.contractAddress;
  },
  async send(to, abi, functionName, args) {
    const hash = await wallet.writeContract({ address: to, abi, functionName, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') die(`${functionName} failed: ${hash}`);
    return hash;
  },
  read: (to, abi, functionName, args) => pub.readContract({ address: to, abi, functionName, args }),
};

const dep = load();
if (!dep.pools || !Object.keys(dep.pools).length) die('No pools in the deployments file: run tools/chain/dex.mjs first');
console.log(`${net.name}: deployer ${deployer.address}, ${Number(await pub.getBalance({ address: deployer.address })) / 1e18} ETH`);
const have = dep.orchard || {};
const start = have.start || Number(env.ORCHARD_START || Math.floor(Date.now() / 1000) + 600);
const built = compile();
const res = await deployOrchard(io, { built, pairs: dep.pools, have, start }, (l) => console.log('  ' + l));
save({ ...res, start });
if (env.ADMIN) {
  await handOver(io, { built, bloom: res.bloom, orchard: res.orchard, admin: getAddress(env.ADMIN) });
  console.log('  admin handed to ' + env.ADMIN);
}
console.log(`\nwrote contracts/deployments/${net.id}.json\nput into game/lib/chain.js CHAINS.${env.NETWORK || 'testnet'}.orchard: ${JSON.stringify({ bloom: res.bloom, orchard: res.orchard })}`);
