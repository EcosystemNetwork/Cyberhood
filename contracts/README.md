# Taproot on Robinhood Chain

Robinhood Chain is an Arbitrum Orbit L2 where gas is paid in ETH. Testnet chain id `46630`, mainnet `4663` ([network details](https://docs.robinhood.com/chain/connecting)).

Gameplay stays on the game server (Supabase), which already decides every reward, purchase and trade. The chain is where players **own** what they've earned: they can withdraw it to a wallet, trade it anywhere, and deposit it back.

| Asset | Contract | Token id | Server support |
|---|---|---|---|
| Gold | `GameGold` ERC-20, 0 decimals (1 token = 1 gold) | — | withdraw + deposit |
| Resources (crops, monster drops, ores, fish, herbs, gems) | one `GameResource` ERC-20 each, 0 decimals, deployed by the bridge | bridge id `keccak256(resourceId)` | withdraw + deposit |
| Gear | `GameItems` ERC-1155 | `keccak256(itemId)` | withdraw + deposit |
| Farm plots | `FarmPlots` ERC-721 | plot number | contracts only (see below) |

## Market: resources for stock tokens

Players earn Robinhood stock tokens by selling resources they farmed. They withdraw a rare resource as its ERC-20, then sell it into a resource/stock pool on our own Uniswap V2 deployment. This is the official, audited bytecode, deployed by `tools/chain/dex.mjs`, because there is no Uniswap on the testnet. The pools are in `STOCK_POOLS` in `game/lib/chain.js`. The treasury seeded each one with 4 of its stock token plus resources minted through the bridge, at about 1,200 gold's worth of the resource per stock token. The wallet page shows live prices and sells with a 1% slippage guard (`Wallet.market()`, `quote()`, `sell()`).

**Testnet (46630), deployed 2026-11-21** (all addresses are also in `contracts/deployments/46630.json`):

| | Address |
|---|---|
| GameBridge | `0x57d08a96ffd80d6295259343035da8dd72a53f09` |
| Uniswap V2 Router02 / Factory | `0x899ff3295fcf7cc44f4ae5a592c2822d46744005` / `0xca69fe5ff55f57da43dbbb4a14cd43c7c036fa6c` |
| Sun Gem / TSLA | `0xe56042a0A07A1c8B3Ebfd9f58749A07975dde61D` |
| Golem Core / AMD | `0x34710FE0b6cd7B9DEe0ea846451d4EEe6C329d29` |
| Queen Silk / AMZN | `0x676881D179bEF20dEde60c1cB0e3810B1D0F1e31` |
| Goldfin / NFLX | `0x1473FD95ff407A2e2aAFAdBB80fB5371868c95Bc` |
| Royal Jelly / PLTR | `0x1Ff436BB822c4E832C2FA4DEeB608B890A442250` |

**Mainnet:** stock tokens are real, regulated securities, with eligibility and transfer rules. `dex.mjs` refuses mainnet without `I_HAVE_LEGAL_SIGNOFF=1`, and mainnet should use the official Uniswap deployment there.

## The Orchard: stake LP tokens, grow Bloom

`Bloom` (BLOOM, 18 decimals, 100M hard cap) is the game's reward token. The `Orchard` has one **grove** per resource / stock pool (`ORCHARD_GROVES` in `game/lib/chain.js`). Stake that pool's Uniswap V2 LP tokens in its grove and Bloom accrues every second, split between groves by their `alloc` weight.

- **Emission**: 2 Bloom/s across all groves, halving every 120 days. At most 2 × rate × halving (41.5M) is ever minted, and the constructor checks this fits under Bloom's cap. The settings are in `ORCHARD`.
- **Harvest**: 25% is paid straight away and 75% is locked, unlocking linearly over 30 days. New locked Bloom merges into your schedule, ending at the amount-weighted average of the two end times. `claimVested` pays out what has unlocked.
- **Non-custodial**: no role can move staked LP tokens. `emergencyWithdraw` always works and only gives up the unharvested Bloom. The admin (a multisig on mainnet) can add groves and change their weights, nothing more. Only the Orchard holds Bloom's `MINTER_ROLE`.
- **Deploy**: `npm run chain:orchard:testnet` runs `tools/chain/orchard.mjs`. It needs the pools from `dex.mjs`, re-running is safe, and `ADMIN=0x…` hands both contracts to a multisig. Then put the printed `{ bloom, orchard, groves }` into `CHAINS.testnet.orchard` in `game/lib/chain.js`.
- **In the game**: Elder Rowan tends a grove of five trees behind the Potion Shop in Taproot City (`game/world3d/orchardview.js`). Press F next to her to plant (add a withdrawn resource plus its stock token as liquidity and stake it in one step), harvest, claim or unstake. Each tree grows with your stake and grows one glowing fruit per 5 Bloom ready to harvest. `game/wallet.html` has the same actions, and `game/lib/wallet.js` provides `orchard()`, `plant()`, `stake()`, `unstake()`, `harvest()` and `claimBloom()`.
- **Tests**: `tests/chain-orchard.test.mjs` covers emission, the split and vesting, emergency exits, roles, a fuzz run that must never owe more than was emitted, and a real LP stake. `tests/chain-wallet-page.test.mjs` runs plant / harvest / unstake in the browser, and `tests/world3d/orchard.cdp.mjs` checks the 3D grove.

## How it works

```
 game account ──withdraw──▶ server debits + signs EIP-712 Claim ──▶ player calls GameBridge.claim ──▶ token minted
 game account ◀──credit──── chain sync sees Deposited(from, …) ◀── player calls GameBridge.deposit ◀── token burned
```

- **Wallet link** uses Sign-In with Ethereum (EIP-4361). Each account has one wallet and each wallet one account. A linked wallet can also sign in.
- **Withdraw** happens in one database transaction (`game_withdraw`): the server debits the balance and records the voucher together. A voucher works once (`nonce`) and only until its `deadline`, which is 1 hour.
- **Refund**: once the deadline has passed by *both* the server's clock and the chain's latest block, and `used(nonce)` is false on-chain, the chain sync gives the asset back (`game_refund`). A refunded voucher can never also be claimed.
- **Deposit** burns the token at the bridge. The chain sync records the `Deposited` event and credits the account linked to the sending wallet (`game_credit`, once per event). A deposit from a wallet that isn't linked waits, then arrives when the wallet is linked.
- **Resources** that can leave the game are listed in `RESOURCES` in `game/lib/chain.js`. Consumables, seeds and building blocks stay in-game. `GameBridge.addResource` (admin only) deploys each resource's ERC-20 at a CREATE2 address salted with its id: `deploy.mjs` adds them all, and `node tools/chain/resources.mjs` adds ones listed later (it prints the calldata for a multisig). A deposit that would push the bag past 99,999 keeps the rest in `econ.stash`, which is withdrawn first.
- **Gear** you withdraw is taken off your character. If you deposit a copy of gear you already own, it goes to `econ.stash` and can be withdrawn again.

Code:
- `contracts/src/`: the bridge's four contracts, plus `Bloom` and `Orchard`.
- `game/lib/chain.js`: networks, ABI and the Claim type, shared by browser and server.
- `supabase/functions/game/wallet.js`: the API routes `chain`, `loginnonce`, `walletlogin`, `linknonce`, `link`, `unlink`, `wallet`, `withdraw` and `chainsync`.
- `game/lib/wallet.js`: the browser side. `game/wallet.html` is a test bench page.
- Migration: `supabase/migrations/20261120_chain_bridge.sql`.

## Withdrawal limits

- **Wait after linking:** a newly linked wallet can withdraw only after `CHAIN_LINK_LOCK_HOURS` (default 72), so a stolen password can't link a new wallet and drain the account straight away.
- **Daily cap:** each account can withdraw at most `CHAIN_DAILY_VALUE` gold worth a day (default 10,000). Resources and gear count at their shop price; gear no shop sells counts as 500.
- **Imported value stays in the game:** what the one-time import of old browser saves granted is *bound* (`econ.bound`, `econ.boundGear`). Bound gold is spent first in the game, and it can't be withdrawn, traded or swapped into a pool. The import no longer brings in anything listed in `RESOURCES`.
- **On-chain mint caps:** `GameBridge` mints at most a set amount per token per day: gold in total, each item id, all plots together, and each resource. `deploy.mjs` sets the defaults from `MINT_CAPS` in `game/lib/chain.js`, and only the admin can change them (`setKindCap`, `setTokenCap`; `mintable(kind, id)` reads what's left). With no cap set, nothing can be claimed. So if the signer key leaks, at most one day's caps can be minted before the bridge is paused. A claim over the cap reverts, and the game refunds the voucher when it expires.

## Build and test

Foundry is not needed:

```sh
npm install
npm run chain:compile     # solc-js 0.8.37, same settings as foundry.toml
npm run test:chain        # contracts on an in-process EVM + the API end to end
```

With Foundry installed, `cd contracts && forge build` also works (OpenZeppelin comes from `../node_modules`).

## Deploy (testnet), the short way

`.env.chain.testnet` (gitignored, mode 600) holds the testnet deployer key, the voucher signer key and the sync secret. Then:

```sh
npm run chain:deploy:testnet                          # needs the deployer funded with testnet ETH
export SUPABASE_ACCESS_TOKEN=sbp_...                  # never saved anywhere
node tools/chain/supabase.mjs migrate                 # tables + functions
node tools/chain/supabase.mjs secrets                 # CHAIN_* secrets
node tools/chain/supabase.mjs deploy                  # the API as the function `game-chain`, from the committed code
node tools/chain/supabase.mjs schedule                # chain sync every minute
node tools/chain/supabase.mjs check
```

The live `game` function is left alone: the testnet build runs as `game-chain` on the same project, against the same accounts. Try it with the test page: `node game-dev-server.js`, then open
`http://localhost:8137/game/wallet.html?api=https://rxplfcuhsdvqposhpzyp.supabase.co/functions/v1/game-chain/`

## Deploy (testnet), step by step

1. Create the server's signer key and keep it secret. This key can mint, so it belongs only in the Edge Function's secrets:
   `node -e "console.log(require('viem/accounts').generatePrivateKey())"`
2. Fund a deployer address with testnet ETH from a Robinhood Chain faucet.
3. Deploy:
   `DEPLOYER_KEY=0x… CHAIN_SIGNER_ADDRESS=0x… npm run chain:deploy`
   This writes `contracts/deployments/46630.json` and prints the settings for step 5.
4. Run `supabase/migrations/20261120_chain_bridge.sql` on the game's Supabase project.
5. Set the function's secrets (`CHAIN_ID`, `CHAIN_BRIDGE`, `CHAIN_START_BLOCK`, `CHAIN_SIGNER_KEY`, `CHAIN_SYNC_KEY`, and optionally `CHAIN_RPC` with a provider key and `CHAIN_SIWE_DOMAINS`), then redeploy the `game` function.
6. Schedule `POST …/functions/v1/game/chainsync` every minute with the header `x-chain-sync-key`. The pg_cron snippet is at the end of the migration.

## Before mainnet

- **Admin must be a multisig.** `deploy.mjs` refuses to deploy to mainnet with the deployer as admin. The admin can unpause and change roles; `PAUSER_ROLE` can stop claims and deposits.
- **Get an external audit** of `GameBridge` and the server's withdraw, credit and refund paths.
- **Decide the gold economy.** Monster drops mint gold, so withdrawable gold is an inflation and botting target. Consider per-account daily withdrawal caps, a minimum account age or level, and sinks.
- **Plots**: the contracts support them, but withdrawing a plot also has to move the farm on it (crops, buildings, the `farm_plot` lock) to whoever holds the NFT. That needs a design pass before the server offers it.
- **Legal**: get advice on tradeable in-game currency for your jurisdictions.
- Fill in the mainnet RPC and explorer in `game/lib/chain.js`.

## Liquidity pools (in-game now, on-chain next)

Old Fenn, by the Taproot City fountain, keeps one gold ↔ resource pool for each resource in `POOLS` (`game/world3d/pools.js`). Each `POOLS` id is also a `RESOURCES` token, and `tests/pools.test.mjs` checks that.

**Today the pools run in-game, on the game server.**
- The pool maths is the same as Uniswap v2: constant product (x·y = k), a 0.3% fee on what goes in that stays in the pool, and LP shares minted as `sqrt(gold·res)` on the first deposit. The first deposit locks 100 shares forever, so a pool can't be drained or re-priced.
- Reserves are stored in `game_pools`, and each player's shares in `econ.lp`. `game_pool()` saves the pool and the player in one transaction, each compare-and-swap on its own rev (`supabase/migrations/20261120_liquidity_pools.sql`).
- The API has `GET pools` (public) and `POST pool` with `{ op: 'swap' | 'add' | 'remove', … }`. A swap takes a `min` out, which protects against slippage.
- The pools never create gold or resources. The test suite fuzzes 2,000 random actions and checks that the totals never change.

**Moving them on-chain.** This is planned and not built yet.
1. Deploy a Uniswap-v2-style pair for each resource ERC-20, paired against `GameGold`. Use 0 decimals and the same 0.3% fee. These can be audited v2 contracts, or a pair from a DEX already live on Robinhood Chain if one exists. `MIN_SHARES` matches v2's `MINIMUM_LIQUIDITY` in spirit, but v2 locks 1000 units: decide whether to keep 100 so the numbers stay player-sized.
2. Migrate each pool: the server withdraws its `game_pools` reserves to the bridge's admin and seeds the pair with them. Each holder's `econ.lp` shares become LP tokens pro rata, via claim vouchers (a new `kind` in `GameBridge`). Then close the in-game route.
3. Alternatively, keep both and let arbitrage connect them. Players already bridge gold and resources, so price gaps between Old Fenn's in-game pool and the on-chain pair close on their own. This needs no migration. It does mean two separate liquidity pools per resource.
4. Old Fenn's panel would then read reserves from the pair (viem `getReserves`) and send swaps from the linked wallet (`game/lib/wallet.js`).
