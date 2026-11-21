/* Deploys Uniswap V2 (official bytecode) on Robinhood Chain if it isn't there yet, and seeds the
   resource / stock-token pools in game/lib/chain.js STOCK_POOLS from the treasury (the deployer):
   its stock tokens, plus resource tokens minted to it through the bridge with signer vouchers.
   Safe to re-run: it skips what exists. Records everything in contracts/deployments/<chainId>.json.

     node --env-file=.env.chain.testnet tools/chain/dex.mjs          (npm run chain:dex:testnet)

   Needs DEPLOYER_KEY and CHAIN_SIGNER_KEY; [NETWORK=testnet] [CHAIN_RPC=...]. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS } from '../../game/lib/chain.js';
import { deployDex, seedPools, claimSigner } from './dex-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const die = (m) => { console.error(m); process.exit(1); };
const net = CHAINS[env.NETWORK || 'testnet'] || die('NETWORK must be testnet or mainnet');
if (!net.testnet && !env.I_HAVE_LEGAL_SIGNOFF) die('Stock-token pools on mainnet need legal review first (set I_HAVE_LEGAL_SIGNOFF=1 once you have it)');
const rpc = env.CHAIN_RPC || net.rpcUrls.default.http[0];
const deployer = privateKeyToAccount(env.DEPLOYER_KEY || die('Set DEPLOYER_KEY'));
const signer = privateKeyToAccount(env.CHAIN_SIGNER_KEY || die('Set CHAIN_SIGNER_KEY'));
const chain = { id: net.id, name: net.name, nativeCurrency: net.nativeCurrency, rpcUrls: { default: { http: [rpc] } } };
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });
const pub = createPublicClient({ chain, transport: http(rpc) });
const file = join(ROOT, `contracts/deployments/${net.id}.json`);
const dep = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(dep, null, 2) + '\n');

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

console.log(`${net.name}: treasury ${deployer.address}, ${Number(await pub.getBalance({ address: deployer.address })) / 1e18} ETH`);
if (!dep.dex) {
  dep.dex = await deployDex(io, (l) => console.log('  ' + l));
  save();
} else console.log('  Uniswap V2 already deployed: router ' + dep.dex.router);

const block = await pub.getBlock();
dep.pools = { ...(dep.pools || {}), ...(await seedPools(io, {
  bridge: dep.contracts.bridge, chainId: net.id, dex: dep.dex, stocks: net.stocks,
  signClaim: claimSigner(signer), deadline: block.timestamp + 1800n,
}, (l) => console.log('  ' + l))) };
save();
console.log(`\nwrote contracts/deployments/${net.id}.json\nput into game/lib/chain.js CHAINS.${env.NETWORK || 'testnet'}.dex: ${JSON.stringify(dep.dex)}`);
console.log(`ETH left: ${Number(await pub.getBalance({ address: deployer.address })) / 1e18}`);
