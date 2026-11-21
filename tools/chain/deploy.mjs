/* Deploys the game's contracts to Robinhood Chain and wires them together:
   GameGold (ERC-20), GameItems (ERC-1155), FarmPlots (ERC-721) and GameBridge, gives the bridge
   BRIDGE_ROLE on each token, and has the bridge deploy an ERC-20 for every resource in
   game/lib/chain.js RESOURCES. Admin rights then move to ADMIN.

     DEPLOYER_KEY=0x...            pays gas; becomes admin unless ADMIN is set (needs testnet ETH:
                                   see the faucets on docs.robinhood.com/chain)
     CHAIN_SIGNER_ADDRESS=0x...    the game server's voucher signer (its key goes in CHAIN_SIGNER_KEY
                                   on the Edge Function, never in this repo)
     [ADMIN=0x...]                 admin + pauser, ideally a multisig
     [CHAIN_RPC=https://...]       default: the network's public RPC
     [NETWORK=testnet|mainnet]     default testnet
     [ITEMS_URI=...] [PLOTS_URI=...]  token metadata locations

     node tools/chain/deploy.mjs

   Writes contracts/deployments/<chainId>.json and prints the Edge Function settings to set.
   New signer key: node -e "console.log(require('viem/accounts').generatePrivateKey())" */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http, getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from './compile.mjs';
import { CHAINS, RESOURCES, resourceTokenName, KIND, MINT_CAPS } from '../../game/lib/chain.js';
import { itemTokenId } from '../../supabase/functions/game/wallet.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const die = (m) => { console.error(m); process.exit(1); };

const net = CHAINS[env.NETWORK || 'testnet'] || die('NETWORK must be testnet or mainnet');
const rpc = env.CHAIN_RPC || net.rpcUrls.default.http[0] || die('Set CHAIN_RPC for ' + net.name);
if (!/^0x[0-9a-fA-F]{64}$/.test(env.DEPLOYER_KEY || '')) die('Set DEPLOYER_KEY (0x + 64 hex)');
if (!isAddress(env.CHAIN_SIGNER_ADDRESS || '')) die('Set CHAIN_SIGNER_ADDRESS (the server signer\'s address)');
const deployer = privateKeyToAccount(env.DEPLOYER_KEY);
const admin = env.ADMIN ? getAddress(env.ADMIN) : deployer.address;
const signer = getAddress(env.CHAIN_SIGNER_ADDRESS);
const itemsUri = env.ITEMS_URI || 'https://taproot.love/game/meta/items/{id}.json';
const plotsUri = env.PLOTS_URI || 'https://taproot.love/game/meta/plots/';
if (net === CHAINS.mainnet && admin === deployer.address) die('On mainnet set ADMIN to a multisig, not the deployer key');

const chain = { id: net.id, name: net.name, nativeCurrency: net.nativeCurrency, rpcUrls: { default: { http: [rpc] } } };
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });
const pub = createPublicClient({ chain, transport: http(rpc) });

const id = await pub.getChainId();
if (id !== net.id) die(`RPC is chain ${id}, expected ${net.id}`);
console.log(`${net.name} (${id}) via ${rpc}\ndeployer ${deployer.address}  admin ${admin}  signer ${signer}`);

const balance = await pub.getBalance({ address: deployer.address });
console.log(`deployer balance ${Number(balance) / 1e18} ETH`);
if (balance === 0n) die(`Fund ${deployer.address} with ${net.testnet ? 'testnet ' : ''}ETH first${net.testnet ? ' (faucets: docs.robinhood.com/chain)' : ''}`);

const built = compile();
async function deploy(name, args) {
  const hash = await wallet.deployContract({ abi: built[name].abi, bytecode: built[name].bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') die(name + ' deploy failed: ' + hash);
  console.log(`${name.padEnd(10)} ${r.contractAddress}`);
  return { address: r.contractAddress, block: r.blockNumber };
}
// Deployed with the deployer as admin so it can grant the bridge its roles, then handed to ADMIN.
const gold = await deploy('GameGold', [deployer.address]);
const items = await deploy('GameItems', [deployer.address, itemsUri]);
const plots = await deploy('FarmPlots', [deployer.address, plotsUri]);
const bridge = await deploy('GameBridge', [deployer.address, signer, gold.address, items.address, plots.address]);

async function call(name, address, functionName, args) {
  const hash = await wallet.writeContract({ address, abi: built[name].abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') die(`${name}.${functionName} failed: ${hash}`);
}
const ADMIN_ROLE = '0x' + '0'.repeat(64);
for (const [name, c] of [['GameGold', gold], ['GameItems', items], ['FarmPlots', plots]]) {
  const role = await pub.readContract({ address: c.address, abi: built[name].abi, functionName: 'BRIDGE_ROLE' });
  await call(name, c.address, 'grantRole', [role, bridge.address]);
}
const resources = {};
for (const [id, r] of Object.entries(RESOURCES)) {
  await call('GameBridge', bridge.address, 'addResource', [itemTokenId(id), resourceTokenName(id), r.symbol]);
  resources[id] = await pub.readContract({ address: bridge.address, abi: built.GameBridge.abi, functionName: 'resources', args: [itemTokenId(id)] });
  console.log(`  ${r.symbol.padEnd(9)} ${resources[id]}`);
}
for (const [kind, cap] of Object.entries(MINT_CAPS)) { // daily mint caps (chain.js MINT_CAPS)
  await call('GameBridge', bridge.address, 'setKindCap', [KIND[kind], BigInt(cap)]);
  console.log(`  cap ${kind.padEnd(8)} ${cap} a day`);
}
if (admin !== deployer.address) { // hand everything to ADMIN
  for (const [name, c] of [['GameGold', gold], ['GameItems', items], ['FarmPlots', plots], ['GameBridge', bridge]]) {
    await call(name, c.address, 'grantRole', [ADMIN_ROLE, admin]);
    if (name === 'GameBridge') {
      const pauser = await pub.readContract({ address: c.address, abi: built.GameBridge.abi, functionName: 'PAUSER_ROLE' });
      await call(name, c.address, 'grantRole', [pauser, admin]);
      await call(name, c.address, 'renounceRole', [pauser, deployer.address]);
    }
    await call(name, c.address, 'renounceRole', [ADMIN_ROLE, deployer.address]);
  }
}

const out = {
  chainId: id, network: env.NETWORK || 'testnet', deployedAt: new Date().toISOString(), admin, signer,
  contracts: { bridge: bridge.address, gold: gold.address, items: items.address, plots: plots.address }, resources,
  startBlock: gold.block.toString(),
};
const dir = join(ROOT, 'contracts/deployments');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${id}.json`), JSON.stringify(out, null, 2) + '\n');
console.log(`\nwrote contracts/deployments/${id}.json\n\nEdge Function settings (supabase secrets set ...):
  CHAIN_ID=${id}
  CHAIN_BRIDGE=${bridge.address}
  CHAIN_START_BLOCK=${gold.block}
  CHAIN_SIGNER_KEY=<the signer's private key>
  CHAIN_SYNC_KEY=<a long random string, also used by the scheduler>
  CHAIN_RPC=<a provider URL with a key, e.g. Alchemy>   (optional; default the public RPC)`);
