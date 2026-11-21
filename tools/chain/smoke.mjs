/* End-to-end check of the deployed testnet build, on the real chain: makes a throwaway game
   account (chainsmoke_<random>), gives a fresh wallet a little gas from the deployer, links the
   wallet (SIWE), withdraws gold + a resource + the starting weapon, claims all three on-chain,
   deposits some back, runs the chain sync, and checks the account got it.

     node --env-file=.env.chain.testnet tools/chain/smoke.mjs
     [API=https://rxplfcuhsdvqposhpzyp.supabase.co/functions/v1/game-chain/] [NETWORK=testnet]

   The SIWE domain used is localhost:8137, which the testnet build accepts (supabase.mjs secrets). */
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { CHAINS, BRIDGE_ABI, ERC20_ABI, KIND } from '../../game/lib/chain.js';
import { itemTokenId } from '../../supabase/functions/game/wallet.js';

const env = process.env;
const die = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const API = env.API || 'https://rxplfcuhsdvqposhpzyp.supabase.co/functions/v1/game-chain/';
const net = CHAINS[env.NETWORK || 'testnet'];
const rpc = env.CHAIN_RPC || net.rpcUrls.default.http[0];
const chain = { id: net.id, name: net.name, nativeCurrency: net.nativeCurrency, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc) });
const ok = (m) => console.log('  ✓ ' + m);

async function api(action, key, body, headers = {}) {
  const get = ['chain', 'wallet', 'me', 'state'].includes(action);
  const res = await fetch(API + action, {
    method: get ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}), ...headers },
    body: get ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${action}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const info = await api('chain');
if (!info.enabled) die('withdrawals are not enabled on ' + API);
if (info.chainId !== net.id) die(`API is on chain ${info.chainId}`);
ok(`API ${API} on ${info.name}, bridge ${info.bridge}`);

// a throwaway account with 120 gold, 20 Slime Gel and a knight's sword
const username = 'chainsmoke_' + Math.random().toString(36).slice(2, 8);
const su = await api('signup', null, { username, password: 'smoke-' + generatePrivateKey().slice(2, 18) });
const key = su.key;
await api('act', key, { actions: [{ t: 'import', field: { bag: { slime_gel: 20 } } }, ...['wreck', 'lonely', 'gull', 'doubloon'].map((id) => ({ t: 'chest', id }))] });
const sword = (await api('save', key, { character: { name: 'Smoke', cls: 'knight', skin: 1, hs: 'short', hc: 0 } })).character.equipment.rhand;
const st0 = await api('state', key);
if (st0.econ.gold !== 120 || st0.econ.bag.slime_gel !== 20 || !sword) die('account setup: ' + JSON.stringify(st0.econ));
ok(`account ${username}: 120 gold, 20 Slime Gel, ${sword}`);

// a fresh player wallet, given gas by the deployer
const player = privateKeyToAccount(generatePrivateKey());
const deployer = privateKeyToAccount(env.DEPLOYER_KEY || die('needs DEPLOYER_KEY (--env-file=.env.chain.testnet)'));
const dw = createWalletClient({ account: deployer, chain, transport: http(rpc) });
await pub.waitForTransactionReceipt({ hash: await dw.sendTransaction({ to: player.address, value: parseEther('0.002') }) });
ok(`wallet ${player.address} funded (${formatEther(await pub.getBalance({ address: player.address }))} ETH)`);
const pw = createWalletClient({ account: player, chain, transport: http(rpc) });

// link it
const n = await api('linknonce', key, {});
const message = createSiweMessage({ domain: 'localhost:8137', address: player.address, statement: n.statement, uri: 'http://localhost:8137/game/wallet.html', version: '1', chainId: n.chainId, nonce: n.nonce, issuedAt: new Date() });
await api('link', key, { message, signature: await player.signMessage({ message }) });
ok('wallet linked');

// withdraw three kinds and claim each
const send = async (fn, args) => {
  const hash = await pw.writeContract({ address: info.bridge, abi: BRIDGE_ABI, functionName: fn, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') die(`${fn} reverted: ${hash}`);
  return hash;
};
const claim = (v) => send('claim', [{ ...v.claim, id: BigInt(v.claim.id), amount: BigInt(v.claim.amount), nonce: BigInt(v.claim.nonce), deadline: BigInt(v.claim.deadline) }, v.signature]);
for (const what of [{ kind: 'gold', amount: 50 }, { kind: 'resource', item: 'slime_gel', amount: 8 }, { kind: 'item', item: sword }]) {
  const w = await api('withdraw', key, what);
  ok(`withdrew ${JSON.stringify(what)}; claim tx ${await claim(w.voucher)}`);
}
const gold = await pub.readContract({ address: info.bridge, abi: BRIDGE_ABI, functionName: 'gold' });
const gel = await pub.readContract({ address: info.bridge, abi: BRIDGE_ABI, functionName: 'resources', args: [itemTokenId('slime_gel')] });
const bal = (t) => pub.readContract({ address: t, abi: ERC20_ABI, functionName: 'balanceOf', args: [player.address] });
if ((await bal(gold)) !== 50n || (await bal(gel)) !== 8n) die('on-chain balances');
ok(`on-chain: 50 TGOLD (${gold}), 8 SLIME (${gel})`);
if ((await api('wallet', key)).pending.length) die('sent claims are still offered');
ok('no claims left to send');

// deposit back and let the sync credit it
await send('deposit', [KIND.gold, 0n, 20n]);
await send('deposit', [KIND.resource, itemTokenId('slime_gel'), 3n]);
await send('deposit', [KIND.item, itemTokenId(sword), 1n]);
ok('deposited 20 gold, 3 Slime Gel and the sword');
let st;
for (let i = 0; i < 20; i++) { // the sync waits for confirmations; the scheduler also runs it each minute
  await new Promise((r) => setTimeout(r, 6000));
  if (env.CHAIN_SYNC_KEY) await fetch(API + 'chainsync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-chain-sync-key': env.CHAIN_SYNC_KEY }, body: '{}' });
  st = await api('me', key);
  if (st.state.econ.gold === 90 && st.state.econ.bag.slime_gel === 15 && st.inventory.includes(sword)) break;
}
if (st.state.econ.gold !== 90 || st.state.econ.bag.slime_gel !== 15 || !st.inventory.includes(sword)) die('deposits not credited: ' + JSON.stringify(st.state.econ));
ok('credited: 90 gold, 15 Slime Gel, sword back');
console.log('\nPASS: Robinhood testnet round trip works end to end');
