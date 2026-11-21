/* ============================================================================
   Old Fenn's liquidity pools: one gold <-> resource pool per tradeable resource.

   Each pool is a constant-product market maker (x * y = k), the same maths as
   Uniswap v2, so it can move on-chain later (the resources are already ERC-20s
   in contracts/, see game/lib/chain.js RESOURCES):
   - Swap: put gold in to get the resource out, or the reverse. A 0.3% fee on
     what you put in stays in the pool, so the pool grows for its providers.
   - Provide: put in gold and the resource at the pool's current ratio, get
     shares. Withdraw shares for your part of both sides, fees included.
   - The first deposit sets the price. MIN_SHARES of its shares are locked
     forever (they belong to Old Fenn), so a pool can never be drained to zero
     and its price can't be reset.

   Pools are shared by every player, so they live in their own table
   (game_pools, supabase/migrations/20261120_liquidity_pools.sql); a player's
   shares live in their economy (econ.lp). The server (supabase/functions/game/
   api.js, action `pool`) runs poolAction() and saves both in one transaction.
   No gold or resource is ever made here: everything paid out was put in.

   Pure logic, no DOM, so it runs in node and Deno as well.
   ============================================================================ */

export const POOL_KEEPER = 'Old Fenn';
export const FEE_BPS = 30;       // 0.3% of what goes in
export const MIN_SHARES = 100;   // locked at a pool's first deposit
export const MAX_AMOUNT = 1e9;   // per action, either side
export const POOL_BAG_MAX = 99999; // economy.js BAG_MAX: a swap may not overflow the bag

// The resources with a pool, and a starting price in gold Old Fenn suggests to the first provider
// (what a shop pays for one, shops.js SELL). Every id here is also an on-chain resource
// (game/lib/chain.js RESOURCES; tests/pools.test.mjs checks).
export const POOLS = {
  carrot: 3, wheat: 4, pumpkin: 45,
  slime_gel: 3, spore_cap: 4, bat_fang: 5, goblin_ear: 8, royal_jelly: 40, laurel: 20, golem_core: 400, queen_silk: 350,
  copper_ore: 3, silver_ore: 9, sun_gem: 120, minnow: 2, river_bass: 7, goldfin: 110, moonleaf: 3, glowcap: 90, root_dew: 15,
};
export const POOL_IDS = Object.keys(POOLS);
export const isPool = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(POOLS, id);

export const newPool = () => ({ gold: 0, res: 0, shares: 0 });
export function normPool(p) {
  const n = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  return p && typeof p === 'object' ? { gold: n(p.gold), res: n(p.res), shares: n(p.shares) } : newPool();
}
export const isOpen = (p) => p.shares > 0 && p.gold > 0 && p.res > 0;
// Gold for one of the resource, at the pool's current ratio (before fees and slippage).
export const priceOf = (p) => (isOpen(p) ? p.gold / p.res : 0);

const B = BigInt;
const amount = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_AMOUNT;
function isqrt(n) { // floor(sqrt(n)) for a BigInt
  if (n < 2n) return n;
  let x = B(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/* What a swap pays out. side 'buy': `amountIn` gold in, resource out. 'sell': resource in, gold
   out. Rounds down, so the pool's x * y never shrinks. */
export function quote(p, side, amountIn) {
  if (!isOpen(p) || !amount(amountIn)) return 0;
  const [x, y] = side === 'buy' ? [p.gold, p.res] : [p.res, p.gold];
  const inFee = B(amountIn) * B(10000 - FEE_BPS);
  return Number((inFee * B(y)) / (B(x) * 10000n + inFee));
}
// The other side a deposit of `gold` needs at the pool's ratio (rounded up, in the pool's favour).
export const resFor = (p, gold) => (isOpen(p) && amount(gold) ? Number((B(gold) * B(p.res) + B(p.gold) - 1n) / B(p.gold)) : 0);
// The share of a pool `shares` is worth, in gold and the resource.
export function valueOfShares(p, shares) {
  if (!isOpen(p) || !(shares > 0)) return { gold: 0, res: 0 };
  return { gold: Number((B(shares) * B(p.gold)) / B(p.shares)), res: Number((B(shares) * B(p.res)) / B(p.shares)) };
}

/* Applies one pool action to a player's economy `e` ({ gold, bag, lp }) and the pool `p`, both
   changed in place. Returns '' if it went through, else why not (both left untouched).
     { t: 'swap', id, side: 'buy' | 'sell', n, min }   n in, at least `min` out (slippage guard)
     { t: 'add', id, gold, res }   first deposit: both amounts as given (sets the price);
                                   later: `gold`, plus the resource at the pool's ratio, at most `res`
     { t: 'remove', id, shares }
   Returns the amounts that moved in `out` when given: { gold, res, shares } (+ in, - out of the
   player). */
export function poolAction(e, p, a, out = {}) {
  if (!a || typeof a !== 'object' || !isPool(a.id)) return 'no such pool';
  const id = a.id, bag = e.bag, have = (n) => (bag[id] || 0) >= n;
  const give = (g, r) => { // + to the player, - from the player
    e.gold += g;
    bag[id] = (bag[id] || 0) + r;
    if (bag[id] <= 0) delete bag[id];
    p.gold -= g; p.res -= r;
    Object.assign(out, { gold: g, res: r });
  };
  e.lp = e.lp && typeof e.lp === 'object' ? e.lp : {};

  if (a.t === 'swap') {
    if (!isOpen(p)) return 'pool empty';
    if (!amount(a.n)) return 'bad amount';
    const min = a.min === undefined ? 1 : a.min;
    if (!Number.isInteger(min) || min < 1) return 'bad amount';
    const got = quote(p, a.side, a.n);
    if (got < 1) return 'too small';
    if (got < min) return 'price moved';
    if (got >= (a.side === 'buy' ? p.res : p.gold)) return 'too big';
    if (a.side === 'buy') {
      if (e.gold < a.n) return 'not enough gold';
      if ((bag[id] || 0) + got > POOL_BAG_MAX) return 'bag full';
      give(-a.n, got);
    } else if (a.side === 'sell') {
      if (!have(a.n)) return 'not enough';
      give(got, -a.n);
    } else return 'bad side';
    return '';
  }

  if (a.t === 'add') {
    if (!amount(a.gold) || !amount(a.res)) return 'bad amount';
    let res = a.res, minted;
    if (!isOpen(p)) {
      minted = Number(isqrt(B(a.gold) * B(a.res)));
      if (minted <= MIN_SHARES) return 'too small';
    } else {
      res = resFor(p, a.gold);
      if (res > a.res) return 'price moved';
      minted = Number((B(a.gold) * B(p.shares)) / B(p.gold));
      if (minted < 1) return 'too small';
    }
    if (e.gold < a.gold) return 'not enough gold';
    if (!have(res)) return 'not enough';
    const first = !isOpen(p);
    if (first) Object.assign(p, newPool());
    give(-a.gold, -res);
    p.shares += minted;
    const mine = first ? minted - MIN_SHARES : minted;
    e.lp[id] = (e.lp[id] || 0) + mine;
    out.shares = mine;
    return '';
  }

  if (a.t === 'remove') {
    const s = a.shares;
    if (!Number.isInteger(s) || s < 1) return 'bad amount';
    if ((e.lp[id] || 0) < s) return 'not enough shares';
    if (!isOpen(p) || s >= p.shares) return 'pool empty'; // can't happen: MIN_SHARES are never anyone's
    const v = valueOfShares(p, s);
    if (v.gold < 1 && v.res < 1) return 'too small';
    if ((bag[id] || 0) + v.res > POOL_BAG_MAX) return 'bag full';
    give(v.gold, v.res);
    p.shares -= s;
    e.lp[id] -= s;
    if (!e.lp[id]) delete e.lp[id];
    out.shares = -s;
    return '';
  }
  return 'bad action';
}
