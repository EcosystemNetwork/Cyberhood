/* Robinhood Chain: the networks, the bridge's ABI and the signed Claim type, shared by the game
   (game/lib/wallet.js) and the game API (copied to supabase/functions/game/rules/chain.js by
   tools/sync-edge-rules.mjs). Plain data, no imports, so it loads in the browser, node and Deno.

   Robinhood Chain is an Arbitrum Orbit L2; gas is paid in ETH.
   Network details: https://docs.robinhood.com/chain/connecting */

export const CHAINS = {
  testnet: {
    id: 46630,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    // public RPC: rate-limited, fine for wallets and testing. The server's chain sync should use a
    // provider key (CHAIN_RPC), e.g. Alchemy, which Robinhood recommends.
    rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
    blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
    testnet: true,
    // deployed 2026-11-21 by tools/chain/deploy.mjs and tools/chain/dex.mjs (contracts/deployments/46630.json)
    contracts: {
      bridge: '0x57d08a96ffd80d6295259343035da8dd72a53f09', gold: '0x64952bbf8a7a4e8c8e1d04cb40a7e2a99d94ed59',
      items: '0xb40fbd7434c6c188b49ca6407c7ac956c2125d36', plots: '0x3150d5fc44cfaadf46abfb52ac36404f41670097',
    },
    // our own deployment of Uniswap V2 (official bytecode; there is no Uniswap on this testnet)
    dex: { factory: '0xca69fe5ff55f57da43dbbb4a14cd43c7c036fa6c', router: '0x899ff3295fcf7cc44f4ae5a592c2822d46744005', weth: '0xd359980d8f00579712e9e3d1f145dcf3a347c657' },
    // Robinhood's tokenized stocks on testnet (faucet tokens, 18 decimals)
    stocks: {
      TSLA: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E', AMD: '0x71178BAc73cBeb415514eB542a8995b82669778d',
      AMZN: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02', NFLX: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93',
      PLTR: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0',
    },
    // Bloom + the Orchard (tools/chain/orchard.mjs): { bloom, orchard, groves: { resource: gid } }, null until deployed
    orchard: null,
  },
  mainnet: {
    id: 4663,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    // TODO before mainnet: confirm RPC + explorer URLs from docs.robinhood.com/chain/connecting
    rpcUrls: { default: { http: [] } },
    blockExplorers: null,
    testnet: false,
    contracts: { bridge: null, gold: null, items: null, plots: null },
    // TODO before mainnet: the official Uniswap deployment there, and legal review before any
    // stock token is involved (they are real, regulated securities on mainnet)
    dex: { factory: null, router: null, weth: null },
    stocks: {},
    orchard: null,
  },
};

// Which network the game uses unless told otherwise (server: CHAIN_ID env).
export const DEFAULT_NETWORK = 'testnet';
export const chainById = (id) => Object.values(CHAINS).find((c) => c.id === Number(id)) || null;

// What the bridge moves. Must match GameBridge.sol KIND_*.
export const KIND = { gold: 0, item: 1, plot: 2, resource: 3 };
export const KIND_NAME = ['gold', 'item', 'plot', 'resource'];

/* Resources that can leave the game, each its own ERC-20 (GameResource.sol, 0 decimals), deployed
   by GameBridge.addResource(keccak256(id), name, symbol): tools/chain/deploy.mjs adds them all,
   tools/chain/resources.mjs adds ones listed here later. Bag items not listed (consumables, seeds,
   building blocks) stay in the game. A symbol is permanent once deployed. */
export const RESOURCES = {
  // crops (farm.js)
  carrot:      { name: 'Carrot', symbol: 'CARROT' },
  wheat:       { name: 'Wheat', symbol: 'WHEAT' },
  pumpkin:     { name: 'Pumpkin', symbol: 'PUMPKIN' },
  // monster drops (economy.js MONSTER_LOOT)
  slime_gel:   { name: 'Slime Gel', symbol: 'SLIME' },
  spore_cap:   { name: 'Spore Cap', symbol: 'SPORE' },
  bat_fang:    { name: 'Bat Fang', symbol: 'FANG' },
  goblin_ear:  { name: 'Goblin Ear', symbol: 'GOBEAR' },
  royal_jelly: { name: 'Royal Jelly', symbol: 'JELLY' },
  laurel:      { name: 'Laurel', symbol: 'LAUREL' },
  golem_core:  { name: 'Golem Core', symbol: 'GCORE' },
  queen_silk:  { name: 'Queen Silk', symbol: 'QSILK' },
  // Guild expeditions (guild.js)
  copper_ore:  { name: 'Copper Ore', symbol: 'COPPER' },
  silver_ore:  { name: 'Silver Ore', symbol: 'SILVER' },
  sun_gem:     { name: 'Sun Gem', symbol: 'SUNGEM' },
  minnow:      { name: 'Minnow', symbol: 'MINNOW' },
  river_bass:  { name: 'River Bass', symbol: 'BASS' },
  goldfin:     { name: 'Goldfin', symbol: 'GOLDFIN' },
  moonleaf:    { name: 'Moonleaf', symbol: 'MOONLEAF' },
  glowcap:     { name: 'Glowcap', symbol: 'GLOWCAP' },
  root_dew:    { name: 'Root Dew', symbol: 'ROOTDEW' },
};
export const resourceTokenName = (id) => 'Taproot ' + RESOURCES[id].name;

/* Resource / stock-token pools (Uniswap V2). Players earn stock tokens by withdrawing resources
   they farmed and selling them into these. `seed` is what tools/chain/dex.mjs puts in at the start
   (resource count, whole stock tokens): about 1,200 gold of the resource per stock token, from the
   shops' sell prices (sun_gem 120g, goldfin 110g, royal_jelly 40g; boss drops rated ~300g). */
export const STOCK_POOLS = [
  { resource: 'sun_gem',     stock: 'TSLA', seed: { resource: 40,  stock: 4 } },
  { resource: 'golem_core',  stock: 'AMD',  seed: { resource: 16,  stock: 4 } },
  { resource: 'queen_silk',  stock: 'AMZN', seed: { resource: 16,  stock: 4 } },
  { resource: 'goldfin',     stock: 'NFLX', seed: { resource: 44,  stock: 4 } },
  { resource: 'royal_jelly', stock: 'PLTR', seed: { resource: 120, stock: 4 } },
];
export const STOCK_DECIMALS = 18;
export const ROUTER_ABI = [
  { type: 'function', name: 'getAmountsOut', stateMutability: 'view', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }], outputs: [{ name: '', type: 'uint256[]' }] },
  { type: 'function', name: 'swapExactTokensForTokens', stateMutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: '', type: 'uint256[]' }] },
  { type: 'function', name: 'addLiquidity', stateMutability: 'nonpayable', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'amountADesired', type: 'uint256' }, { name: 'amountBDesired', type: 'uint256' }, { name: 'amountAMin', type: 'uint256' }, { name: 'amountBMin', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amountA', type: 'uint256' }, { name: 'amountB', type: 'uint256' }, { name: 'liquidity', type: 'uint256' }] },
];
export const PAIR_ABI = [
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ name: 'r0', type: 'uint112' }, { name: 'r1', type: 'uint112' }, { name: 't', type: 'uint32' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
];
export const FACTORY_ABI = [
  { type: 'function', name: 'getPair', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }, { name: 'b', type: 'address' }], outputs: [{ name: '', type: 'address' }] },
];

/* The EIP-712 voucher the server signs for a withdrawal (GameBridge.sol CLAIM_TYPEHASH).
   id: 0 for gold; keccak256 of the game id for gear and resources; the plot number for plots. */
export const CLAIM_TYPES = {
  Claim: [
    { name: 'to', type: 'address' },
    { name: 'kind', type: 'uint8' },
    { name: 'id', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};
export const claimDomain = (chainId, bridge) => ({ name: 'TaprootBridge', version: '1', chainId: Number(chainId), verifyingContract: bridge });

// How long a signed withdrawal can be submitted for; after that (plus slack for the last blocks)
// the server refunds it if it was never used.
export const CLAIM_TTL_S = 60 * 60;
export const REFUND_SLACK_S = 5 * 60;

const claimTuple = { name: 'c', type: 'tuple', components: CLAIM_TYPES.Claim };
/* What GameBridge may mint per token per day (setKindCap), so a leaked signer key can only do so
   much before the bridge is paused: gold in total, each item id, all plots together, each
   resource. Set at deploy; the admin (multisig) changes them with setKindCap / setTokenCap. A
   claim over the cap reverts, and the game refunds the voucher once it expires. */
export const MINT_CAPS = { gold: 250000, item: 50, plot: 5, resource: 50000 };

export const BRIDGE_ABI = [
  { type: 'function', name: 'mintable', stateMutability: 'view', inputs: [{ name: 'kind', type: 'uint8' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'error', name: 'OverCap', inputs: [] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [claimTuple, { name: 'signature', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'kind', type: 'uint8' }, { name: 'id', type: 'uint256' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'used', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'hashClaim', stateMutability: 'view', inputs: [claimTuple], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'resources', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'gold', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'items', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'addResource', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint256' }, { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }], outputs: [{ name: 'token', type: 'address' }] },
  { type: 'event', name: 'Claimed', inputs: [
    { name: 'nonce', type: 'uint256', indexed: true }, { name: 'to', type: 'address', indexed: true },
    { name: 'kind', type: 'uint8', indexed: false }, { name: 'id', type: 'uint256', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Deposited', inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'kind', type: 'uint8', indexed: false }, { name: 'id', type: 'uint256', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }] },
];
export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
];
export const ERC1155_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'balanceOfBatch', stateMutability: 'view', inputs: [{ name: 'a', type: 'address[]' }, { name: 'ids', type: 'uint256[]' }], outputs: [{ name: '', type: 'uint256[]' }] },
];
export const ERC721_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];

// Sign-In with Ethereum: the statements shown in the wallet for each purpose.
export const SIWE_STATEMENT = {
  link: 'Link this wallet to your Taproot account.',
  login: 'Sign in to Taproot.',
};

/* The Orchard (contracts/src/Orchard.sol): stake a pool's Uniswap V2 LP tokens in its grove and
   Bloom (contracts/src/Bloom.sol, 18 decimals) grows for you every second. tools/chain/orchard.mjs
   deploys it with these settings and adds a grove per entry in ORCHARD_GROVES; the admin
   (multisig) can change a grove's weight later with setGrove. At most 2 * rate * halving Bloom is
   ever emitted (here 2 * 2 * 120 days = 41.47M of the 100M cap); the rest of the cap is kept for
   later sinks and rewards. */
export const BLOOM = { name: 'Taproot Bloom', symbol: 'BLOOM', decimals: 18, cap: 100_000_000 };
export const ORCHARD = {
  ratePerSecond: 2,          // whole Bloom a second, all groves together, in the first epoch
  halvingDays: 120,          // the rate halves every this many days
  unlockedBps: 2500,         // 25% of a harvest is paid at once
  vestDays: 30,              // the other 75% unlocks linearly over this
};
// One grove per resource / stock pool (STOCK_POOLS); `alloc` is its share of the emission.
export const ORCHARD_GROVES = STOCK_POOLS.map((p) => ({ resource: p.resource, stock: p.stock, alloc: 100 }));
export const ORCHARD_ABI = [
  { type: 'function', name: 'bloom', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'groveCount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'groves', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [
    { name: 'lp', type: 'address' }, { name: 'alloc', type: 'uint256' }, { name: 'staked', type: 'uint256' }, { name: 'acc', type: 'uint256' }, { name: 'last', type: 'uint256' }] },
  { type: 'function', name: 'totalAlloc', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'rate', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'listed', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'stakes', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }, { name: '', type: 'address' }], outputs: [{ name: 'amount', type: 'uint256' }, { name: 'debt', type: 'uint256' }] },
  { type: 'function', name: 'pending', stateMutability: 'view', inputs: [{ name: 'gid', type: 'uint256' }, { name: 'who', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'vestOf', stateMutability: 'view', inputs: [{ name: 'who', type: 'address' }], outputs: [{ name: 'locked', type: 'uint256' }, { name: 'ready', type: 'uint256' }, { name: 'end', type: 'uint256' }] },
  { type: 'function', name: 'addGrove', stateMutability: 'nonpayable', inputs: [{ name: 'lp', type: 'address' }, { name: 'alloc', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setGrove', stateMutability: 'nonpayable', inputs: [{ name: 'gid', type: 'uint256' }, { name: 'alloc', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'gid', type: 'uint256' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'gid', type: 'uint256' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'harvestAll', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'claimVested', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'emergencyWithdraw', stateMutability: 'nonpayable', inputs: [{ name: 'gid', type: 'uint256' }], outputs: [] },
];
