/* Adds resources listed in game/lib/chain.js RESOURCES that the bridge doesn't have yet (each
   gets its own ERC-20 via GameBridge.addResource). Needs the bridge's admin.

     CHAIN_BRIDGE=0x... node tools/chain/resources.mjs                 lists what's missing
     CHAIN_BRIDGE=0x... ADMIN_KEY=0x... node tools/chain/resources.mjs --send   adds them

   With a multisig admin, leave out --send and submit the printed calls from the multisig.
   [NETWORK=testnet|mainnet] [CHAIN_RPC=...] as in deploy.mjs. */
import { createWalletClient, createPublicClient, http, encodeFunctionData, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, RESOURCES, BRIDGE_ABI, resourceTokenName } from '../../game/lib/chain.js';
import { itemTokenId } from '../../supabase/functions/game/wallet.js';

const env = process.env;
const die = (m) => { console.error(m); process.exit(1); };
const net = CHAINS[env.NETWORK || 'testnet'] || die('NETWORK must be testnet or mainnet');
const rpc = env.CHAIN_RPC || net.rpcUrls.default.http[0] || die('Set CHAIN_RPC');
const bridge = getAddress(env.CHAIN_BRIDGE || die('Set CHAIN_BRIDGE'));
const chain = { id: net.id, name: net.name, nativeCurrency: net.nativeCurrency, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });

const missing = [];
for (const [id, r] of Object.entries(RESOURCES)) {
  const at = await pub.readContract({ address: bridge, abi: BRIDGE_ABI, functionName: 'resources', args: [itemTokenId(id)] });
  if (/^0x0{40}$/.test(at)) missing.push([id, r]); else console.log(`have    ${r.symbol.padEnd(9)} ${at}`);
}
if (!missing.length) { console.log('all resources are on-chain'); process.exit(0); }
if (!process.argv.includes('--send')) {
  for (const [id, r] of missing) {
    const args = [itemTokenId(id), resourceTokenName(id), r.symbol];
    console.log(`missing ${r.symbol.padEnd(9)} to: ${bridge} data: ${encodeFunctionData({ abi: BRIDGE_ABI, functionName: 'addResource', args })}`);
  }
  process.exit(0);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(env.ADMIN_KEY || '')) die('Set ADMIN_KEY to send');
const wallet = createWalletClient({ account: privateKeyToAccount(env.ADMIN_KEY), chain, transport: http(rpc) });
for (const [id, r] of missing) {
  const hash = await wallet.writeContract({ address: bridge, abi: BRIDGE_ABI, functionName: 'addResource', args: [itemTokenId(id), resourceTokenName(id), r.symbol] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') die(`addResource ${id} failed: ${hash}`);
  console.log(`added   ${r.symbol.padEnd(9)} ${await pub.readContract({ address: bridge, abi: BRIDGE_ABI, functionName: 'resources', args: [itemTokenId(id)] })}`);
}
