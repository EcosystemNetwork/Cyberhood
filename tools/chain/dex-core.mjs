/* Uniswap V2 on Robinhood Chain: deploys it (the official, audited bytecode from Uniswap's npm
   packages: there is no Uniswap on the testnet) and seeds the resource / stock-token pools in
   game/lib/chain.js STOCK_POOLS.

   Written against a small `io` so the same code runs on the test chain (tests/chain-dex.test.mjs)
   and the real one (tools/chain/dex.mjs):
     io.account                         the treasury / deployer address
     io.deploy({ abi, bytecode }, args) -> address
     io.send(to, abi, functionName, args)
     io.read(to, abi, functionName, args) -> value */
import { createRequire } from 'node:module';
import { keccak256, toBytes, getAddress } from 'viem';
import { CLAIM_TYPES, claimDomain, KIND, BRIDGE_ABI, ERC20_ABI, ROUTER_ABI, FACTORY_ABI, PAIR_ABI, STOCK_POOLS, STOCK_DECIMALS } from '../../game/lib/chain.js';

const require = createRequire(import.meta.url);
const artifact = (p) => {
  const j = require(p);
  const b = (j.bytecode && (j.bytecode.object || j.bytecode)) || j.evm.bytecode.object;
  return { abi: j.abi, bytecode: b.startsWith('0x') ? b : '0x' + b };
};
export const UNI = {
  factory: artifact('@uniswap/v2-core/build/UniswapV2Factory.json'),
  pair: artifact('@uniswap/v2-core/build/UniswapV2Pair.json'),
  router: artifact('@uniswap/v2-periphery/build/UniswapV2Router02.json'),
  weth: artifact('@uniswap/v2-periphery/build/WETH9.json'),
};
// Router02 has the pair's init code hash built in; ours must be Uniswap's, or every swap misroutes.
export const PAIR_INIT_HASH = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';
if (keccak256(UNI.pair.bytecode) !== PAIR_INIT_HASH) throw new Error('UniswapV2Pair bytecode is not the official one');

const ZERO = '0x0000000000000000000000000000000000000000';
const rid = (id) => BigInt(keccak256(toBytes(id)));

export async function deployDex(io, log = () => {}) {
  const weth = await io.deploy(UNI.weth, []);
  log('WETH9      ' + weth);
  const factory = await io.deploy(UNI.factory, [io.account]); // feeToSetter: the treasury
  log('Factory    ' + factory);
  const router = await io.deploy(UNI.router, [factory, weth]);
  log('Router02   ' + router);
  return { factory, router, weth };
}

/* Seeds every pool in STOCK_POOLS that is still empty. The treasury's resource tokens are minted
   through the bridge with vouchers signed by the game's signer (`signClaim`), like any withdrawal;
   the stock tokens come from the treasury's balance. Returns { resource: pairAddress }. */
export async function seedPools(io, { bridge, chainId, dex, stocks, signClaim, pools = STOCK_POOLS, deadline }, log = () => {}) {
  const out = {};
  for (const p of pools) {
    const stock = stocks[p.stock];
    if (!stock) throw new Error('no address for stock ' + p.stock);
    const token = await io.read(bridge, BRIDGE_ABI, 'resources', [rid(p.resource)]);
    if (token === ZERO) throw new Error('resource not on the bridge: ' + p.resource);
    let pair = await io.read(dex.factory, FACTORY_ABI, 'getPair', [token, stock]);
    if (pair !== ZERO) {
      const [r0, r1] = await io.read(pair, PAIR_ABI, 'getReserves', []);
      if (r0 > 0n && r1 > 0n) { log(`${p.resource}/${p.stock}: already seeded (${pair})`); out[p.resource] = pair; continue; }
    }
    const nRes = BigInt(p.seed.resource), nStock = BigInt(p.seed.stock) * 10n ** BigInt(STOCK_DECIMALS);
    const haveStock = await io.read(stock, ERC20_ABI, 'balanceOf', [io.account]);
    if (haveStock < nStock) throw new Error(`treasury has ${haveStock} ${p.stock}, needs ${nStock}`);
    const have = await io.read(token, ERC20_ABI, 'balanceOf', [io.account]);
    if (have < nRes) { // mint the difference to the treasury through the bridge
      const c = { to: getAddress(io.account), kind: KIND.resource, id: rid(p.resource), amount: nRes - have, nonce: BigInt(keccak256(toBytes(`treasury-seed:${p.resource}:${Date.now()}:${Math.random()}`))), deadline };
      await io.send(bridge, BRIDGE_ABI, 'claim', [c, await signClaim(claimDomain(chainId, bridge), c)]);
    }
    await io.send(token, ERC20_ABI, 'approve', [dex.router, nRes]);
    await io.send(stock, ERC20_ABI, 'approve', [dex.router, nStock]);
    await io.send(dex.router, ROUTER_ABI, 'addLiquidity', [token, stock, nRes, nStock, nRes, nStock, io.account, deadline]);
    pair = await io.read(dex.factory, FACTORY_ABI, 'getPair', [token, stock]);
    log(`${p.resource}/${p.stock}: ${nRes} + ${p.seed.stock} ${p.stock} -> ${pair}`);
    out[p.resource] = pair;
  }
  return out;
}

// The voucher signer as seedPools wants it, from a viem account.
export const claimSigner = (account) => (domain, message) => account.signTypedData({ domain, types: CLAIM_TYPES, primaryType: 'Claim', message });
