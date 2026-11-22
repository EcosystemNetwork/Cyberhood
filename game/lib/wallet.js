/* The player's wallet on Robinhood Chain: connect, link to the game account, sign in with it,
   withdraw (claim) and deposit. The game server (supabase/functions/game/wallet.js) decides
   what may leave the game and signs it; this file only talks to the wallet and the API.

     import * as Wallet from '/game/lib/wallet.js';
     const info = await Wallet.chainInfo();             // { enabled, chainId, bridge, ... }
     const addr = await Wallet.connect();               // asks the wallet, switches to Robinhood Chain
     await Wallet.link(sessionKey);                     // ties it to the signed-in account
     const { voucher } = await Wallet.withdraw(sessionKey, { kind: 'gold', amount: 50 });
     // or { kind: 'resource', item: 'copper_ore', amount: 20 } (C.RESOURCES), { kind: 'item', item: 'fire_wand' }
     await Wallet.claim(voucher);                       // the player sends the claim (pays gas)
     await Wallet.deposit({ kind: 'gold', amount: 20 }); // back into the game (credited within a minute)
     await Wallet.market();                             // resource / stock-token pools and prices
     await Wallet.sell('sun_gem', 5);                   // sell withdrawn resources for stock tokens
     await Wallet.orchard();                            // the Orchard's groves, your stakes, pending Bloom
     await Wallet.plant('sun_gem', 5);                  // add sun_gem + TSLA liquidity and stake the LP
     await Wallet.harvest();                            // 25% of your Bloom now, 75% unlocks over 30 days

   Uses an injected EIP-1193 wallet (MetaMask, Rabby, Robinhood Wallet, Coinbase Wallet...).
   viem comes from a pinned CDN build so the game pages stay bundler-free. */
import { createWalletClient, createPublicClient, custom, getAddress, keccak256, toBytes } from 'https://esm.sh/viem@2.57.13';
import { createSiweMessage } from 'https://esm.sh/viem@2.57.13/siwe';
import { CHAINS, chainById, BRIDGE_ABI, ERC20_ABI, ERC1155_ABI, KIND, RESOURCES, ROUTER_ABI, STOCK_DECIMALS, PAIR_ABI, ORCHARD_ABI, ORCHARD_GROVES, BLOOM } from './chain.js';

// Same API location as game/lib/ledger.js: the dev server locally, the Edge Function live.
// ?api=https://<ref>.supabase.co/functions/v1/<function>/ picks another deployed function (only
// Supabase function URLs, so a link can't point the page at someone else's server).
const API = (() => {
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q && /^https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1\/[a-z0-9-]+\/$/.test(q)) return q;
  } catch (e) {}
  try { if (window.TAPROOT_API) return String(window.TAPROOT_API); } catch (e) {}
  try { const v = window.localStorage.getItem('taproot_api'); if (v) return v; } catch (e) {}
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)$/.test(location.hostname);
  return local ? '/api/game/' : 'https://rxplfcuhsdvqposhpzyp.supabase.co/functions/v1/game/';
})();
export const apiBase = () => API;
const GETS = ['chain', 'wallet', 'me', 'state'];
export async function api(action, key, body) {
  const get = GETS.includes(action);
  const res = await fetch(API + action, {
    method: get ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: get ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed (' + res.status + ')'), { status: res.status, data });
  return data;
}

export const itemTokenId = (id) => BigInt(keccak256(toBytes(id)));

let info = null;
// What the server uses: chain id, bridge address, whether withdrawals are open.
export async function chainInfo() {
  if (!info) info = await api('chain');
  return info;
}
// viem's chain object for the server's network.
async function chain() {
  const i = await chainInfo();
  const c = chainById(i.chainId) || CHAINS.testnet;
  return { id: c.id, name: c.name, nativeCurrency: c.nativeCurrency, rpcUrls: c.rpcUrls, blockExplorers: c.blockExplorers || undefined, testnet: c.testnet };
}

const provider = () => {
  if (!window.ethereum) throw new Error('No wallet found. Install a browser wallet such as MetaMask or Rabby.');
  return window.ethereum;
};
let account = null;
export const address = () => account;

// Asks the wallet for an account and switches it to Robinhood Chain (adding the network if needed).
export async function connect() {
  const eth = provider();
  const [a] = await eth.request({ method: 'eth_requestAccounts' });
  account = getAddress(a);
  const c = await chain();
  const hex = '0x' + c.id.toString(16);
  if ((await eth.request({ method: 'eth_chainId' })) !== hex) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code !== 4902 && !(e.data && e.data.originalError && e.data.originalError.code === 4902)) throw e;
      await eth.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: hex, chainName: c.name, nativeCurrency: c.nativeCurrency, rpcUrls: c.rpcUrls.default.http,
        blockExplorerUrls: c.blockExplorers ? [c.blockExplorers.default.url] : [],
      }] });
    }
  }
  return account;
}

const walletClient = async () => createWalletClient({ account, chain: await chain(), transport: custom(provider()) });
// Reads go through the connected wallet's own RPC (connect() put it on the right chain).
const publicClient = async () => createPublicClient({ chain: await chain(), transport: custom(provider()) });

// A Sign-In with Ethereum message for `purpose` (link | login), signed by the wallet.
async function signIn(purpose, key) {
  if (!account) await connect();
  const n = await api(purpose === 'link' ? 'linknonce' : 'loginnonce', key, {});
  const message = createSiweMessage({
    domain: location.host, address: account, statement: n.statement, uri: location.origin + location.pathname,
    version: '1', chainId: n.chainId, nonce: n.nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 10 * 60 * 1000),
  });
  const signature = await provider().request({ method: 'personal_sign', params: [message, account] });
  return { message, signature };
}

// Links the connected wallet to the signed-in account. Deposits that were waiting arrive now.
export async function link(sessionKey) { return api('link', sessionKey, await signIn('link', sessionKey)); }
export async function unlink(sessionKey) { return api('unlink', sessionKey, {}); }
// Signs in with a linked wallet: returns what /login returns ({ key, username, character, ... }).
export async function login() { return api('walletlogin', null, await signIn('login')); }
// The linked wallet, spare gear, and claims signed but not yet sent.
export async function status(sessionKey) { return api('wallet', sessionKey); }

// { kind: 'gold', amount }, { kind: 'resource', item, amount } or { kind: 'item', item }:
// leaves the game now, returns the voucher.
export async function withdraw(sessionKey, what) { return api('withdraw', sessionKey, what); }

// Sends a signed voucher to the bridge. Returns the transaction hash once it's mined.
export async function claim(voucher) {
  if (!account) await connect();
  const c = voucher.claim;
  const wc = await walletClient();
  const hash = await wc.writeContract({
    address: voucher.bridge, abi: BRIDGE_ABI, functionName: 'claim',
    args: [{ to: c.to, kind: c.kind, id: BigInt(c.id), amount: BigInt(c.amount), nonce: BigInt(c.nonce), deadline: BigInt(c.deadline) }, voucher.signature],
  });
  await (await publicClient()).waitForTransactionReceipt({ hash });
  return hash;
}

// Burns tokens at the bridge; the server credits the linked account at its next chain sync.
export async function deposit({ kind, item, amount = 1 }) {
  if (!account) await connect();
  const i = await chainInfo();
  const id = kind === 'item' || kind === 'resource' ? itemTokenId(item) : 0n;
  const wc = await walletClient();
  const hash = await wc.writeContract({ address: i.bridge, abi: BRIDGE_ABI, functionName: 'deposit', args: [KIND[kind], id, BigInt(amount)] });
  await (await publicClient()).waitForTransactionReceipt({ hash });
  return hash;
}

// A resource's ERC-20 address (null until the admin has added it), e.g. to show "add to wallet".
export async function resourceToken(id) {
  const i = await chainInfo();
  const at = await (await publicClient()).readContract({ address: i.bridge, abi: BRIDGE_ABI, functionName: 'resources', args: [itemTokenId(id)] });
  return /^0x0{40}$/.test(at) ? null : at;
}

// On-chain balances: gold, every resource, and each of `items` (gear ids).
export async function balances(items = []) {
  if (!account) await connect();
  const i = await chainInfo();
  const pc = await publicClient();
  const read = (functionName, args = []) => pc.readContract({ address: i.bridge, abi: BRIDGE_ABI, functionName, args });
  const [goldAt, itemsAt] = await Promise.all([read('gold'), read('items')]);
  const gold = await pc.readContract({ address: goldAt, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] });
  const counts = items.length
    ? await pc.readContract({ address: itemsAt, abi: ERC1155_ABI, functionName: 'balanceOfBatch', args: [items.map(() => account), items.map(itemTokenId)] })
    : [];
  const resources = {};
  await Promise.all(Object.keys(RESOURCES).map(async (id) => {
    const at = await read('resources', [itemTokenId(id)]);
    if (!/^0x0{40}$/.test(at)) resources[id] = await pc.readContract({ address: at, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] });
  }));
  const stocks = {};
  if (i.dex) await Promise.all(Object.entries(i.dex.stocks).map(async ([sym, at]) => { stocks[sym] = await pc.readContract({ address: at, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }); }));
  return { gold, resources, stocks, items: Object.fromEntries(items.map((id, n) => [id, counts[n]])) };
}

/* ---- the market: withdrawn resources trade for Robinhood stock tokens (Uniswap V2) ---- */
const formatStock = (v) => { const s = (Number(v) / 10 ** STOCK_DECIMALS); return s >= 1 ? s.toFixed(3) : s.toPrecision(3); };
export { formatStock };
async function dex() {
  const i = await chainInfo();
  if (!i.dex) throw new Error('There is no market on this network yet');
  return i.dex;
}
// What `amount` of a resource sells for right now: { stock: 'TSLA', out: bigint (18 decimals) }.
export async function quote(resource, amount) {
  const d = await dex();
  const pool = d.pools.find((p) => p.resource === resource);
  if (!pool) throw new Error('No market for ' + resource);
  const token = await resourceToken(resource);
  const pc = await publicClient();
  const [, out] = await pc.readContract({ address: d.router, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [BigInt(amount), [token, d.stocks[pool.stock]]] });
  return { stock: pool.stock, out, token, stockAt: d.stocks[pool.stock], router: d.router };
}
// Every pool with the price of one resource: [{ resource, stock, one: bigint }].
export async function market() {
  const d = await dex();
  return Promise.all(d.pools.map(async (p) => ({ ...p, one: (await quote(p.resource, 1)).out })));
}
/* Sells withdrawn resource tokens for the pool's stock token. Refuses to fill for less than the
   quote minus `slippageBps` (default 1%). Returns { hash, out }. */
export async function sell(resource, amount, { slippageBps = 100 } = {}) {
  if (!account) await connect();
  const n = BigInt(amount);
  const q = await quote(resource, n);
  const pc = await publicClient(), wc = await walletClient();
  const allowed = await pc.readContract({ address: q.token, abi: ERC20_ABI, functionName: 'allowance', args: [account, q.router] });
  if (allowed < n) await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: q.token, abi: ERC20_ABI, functionName: 'approve', args: [q.router, n] }) });
  const min = q.out * BigInt(10000 - slippageBps) / 10000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const hash = await wc.writeContract({ address: q.router, abi: ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [n, min, [q.token, q.stockAt], account, deadline] });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('The sale failed: ' + hash);
  return { hash, out: q.out, stock: q.stock };
}

/* ---- the Orchard: stake a pool's LP tokens in its grove and Bloom grows (contracts/src/Orchard.sol) ---- */
// The network's Orchard (chain.js CHAINS.<net>.orchard). A page may set window.TAPROOT_ORCHARD to
// the same shape first, like TAPROOT_API (the test bench does, against its test chain).
async function orchardCfg() {
  try { if (window.TAPROOT_ORCHARD && window.TAPROOT_ORCHARD.orchard) return window.TAPROOT_ORCHARD; } catch (e) {}
  const c = chainById((await chainInfo()).chainId);
  if (!c || !c.orchard || !c.orchard.orchard) throw new Error('The Orchard is not planted on this network yet');
  return c.orchard;
}
const BLOOM_ONE = 10 ** BLOOM.decimals;
export const formatBloom = (v) => { const n = Number(v) / BLOOM_ONE; return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(3); };
async function send(address, abi, functionName, args) {
  const pc = await publicClient(), wc = await walletClient();
  const hash = await wc.writeContract({ address, abi, functionName, args });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(functionName + ' failed: ' + hash);
  return hash;
}
async function allow(token, spender, n) {
  const pc = await publicClient();
  const have = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account, spender] });
  if (have < n) await send(token, ERC20_ABI, 'approve', [spender, n]);
}

/* Everything the Orchard shows: { rate (Bloom wei a second, all groves), groves: [{ gid, resource,
   stock, lp, alloc, staked, perSecond, and once connected: mine, pending, wallet (LP held) }],
   vest: { locked, ready, end (unix s) } | null, bloom (your balance) | null }. */
export async function orchard() {
  const o = await orchardCfg();
  const pc = await publicClient();
  const r = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });
  const [rate, totalAlloc] = await Promise.all([r(o.orchard, ORCHARD_ABI, 'rate'), r(o.orchard, ORCHARD_ABI, 'totalAlloc')]);
  const groves = await Promise.all(Object.entries(o.groves).map(async ([resource, gid]) => {
    const [lp, alloc, staked] = await r(o.orchard, ORCHARD_ABI, 'groves', [BigInt(gid)]);
    const g = ORCHARD_GROVES.find((x) => x.resource === resource);
    const out = { gid, resource, stock: g ? g.stock : null, lp, alloc, staked, perSecond: totalAlloc ? rate * alloc / totalAlloc : 0n };
    if (account) {
      const [[mine], pending, wallet] = await Promise.all([
        r(o.orchard, ORCHARD_ABI, 'stakes', [BigInt(gid), account]), r(o.orchard, ORCHARD_ABI, 'pending', [BigInt(gid), account]), r(lp, ERC20_ABI, 'balanceOf', [account])]);
      Object.assign(out, { mine, pending, wallet });
    }
    return out;
  }));
  let vest = null, bloom = null;
  if (account) {
    const [locked, ready, end] = await r(o.orchard, ORCHARD_ABI, 'vestOf', [account]);
    vest = { locked, ready, end: Number(end) };
    bloom = await r(o.bloom, ERC20_ABI, 'balanceOf', [account]);
  }
  return { rate, groves, vest, bloom, address: o.orchard, bloomAt: o.bloom };
}

async function grove(resource) {
  const o = await orchardCfg();
  if (o.groves[resource] === undefined) throw new Error('No grove for ' + resource);
  const gid = BigInt(o.groves[resource]);
  const [lp] = await (await publicClient()).readContract({ address: o.orchard, abi: ORCHARD_ABI, functionName: 'groves', args: [gid] });
  return { o, gid, lp };
}
// Stakes LP tokens you hold in a resource's grove (all of them by default).
export async function stake(resource, amount) {
  if (!account) await connect();
  const { o, gid, lp } = await grove(resource);
  const n = amount === undefined ? await (await publicClient()).readContract({ address: lp, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }) : BigInt(amount);
  if (n === 0n) throw new Error('You have no LP tokens for this grove');
  await allow(lp, o.orchard, n);
  return send(o.orchard, ORCHARD_ABI, 'deposit', [gid, n]);
}
// Takes LP tokens back out of a grove (all by default); harvests that grove on the way.
export async function unstake(resource, amount) {
  if (!account) await connect();
  const { o, gid } = await grove(resource);
  const n = amount === undefined ? (await (await publicClient()).readContract({ address: o.orchard, abi: ORCHARD_ABI, functionName: 'stakes', args: [gid, account] }))[0] : BigInt(amount);
  return send(o.orchard, ORCHARD_ABI, 'withdraw', [gid, n]);
}
// Harvests every grove you are in and pays out what has unlocked.
export async function harvest() { if (!account) await connect(); return send((await orchardCfg()).orchard, ORCHARD_ABI, 'harvestAll', []); }
// Pays out the locked Bloom that has unlocked so far.
export async function claimBloom() { if (!account) await connect(); return send((await orchardCfg()).orchard, ORCHARD_ABI, 'claimVested', []); }

/* Plants in a grove in one go: adds `amount` of a withdrawn resource plus the matching stock
   tokens (at the pool's current price) as liquidity, then stakes all the LP tokens you get.
   Refuses to fill more than `slippageBps` (default 1%) off. Returns { stockIn, lp }. */
export async function plant(resource, amount, { slippageBps = 100 } = {}) {
  if (!account) await connect();
  const d = await dex();
  const pool = d.pools.find((p) => p.resource === resource);
  if (!pool) throw new Error('No pool for ' + resource);
  const { lp } = await grove(resource);
  const pc = await publicClient();
  const token = await resourceToken(resource), stockAt = d.stocks[pool.stock];
  const [r0, r1] = await pc.readContract({ address: lp, abi: PAIR_ABI, functionName: 'getReserves' });
  const t0 = await pc.readContract({ address: lp, abi: PAIR_ABI, functionName: 'token0' });
  const [rRes, rStock] = t0.toLowerCase() === token.toLowerCase() ? [r0, r1] : [r1, r0];
  const n = BigInt(amount);
  const stockIn = n * rStock / rRes + 1n;
  await allow(token, d.router, n);
  await allow(stockAt, d.router, stockIn);
  const keep = BigInt(10000 - slippageBps);
  const before = await pc.readContract({ address: lp, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] });
  await send(d.router, ROUTER_ABI, 'addLiquidity', [token, stockAt, n, stockIn, n * keep / 10000n, stockIn * keep / 10000n, account, BigInt(Math.floor(Date.now() / 1000) + 600)]);
  const got = (await pc.readContract({ address: lp, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] })) - before;
  await stake(resource, got);
  return { stockIn, lp: got };
}

