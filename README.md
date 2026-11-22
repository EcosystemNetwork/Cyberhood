# Taproot (Cyberhood)

A browser game: a 3D world with farming, mining, building, fishing, an arena, guild pets and companions, player trading and liquidity pools. Players can also take gold, resources and gear on-chain on **Robinhood Chain**. It plays online with an account, or offline in **solo mode** with no account.

The live site, [taproot.love](https://taproot.love), is built from the `taproot26/taproot26` repo. Game work lands here first and is ported there.

## Quick start

```sh
npm install
node game-dev-server.js
```

Then open <http://localhost:8137/game/>, or <http://localhost:8137/game/world3d/?solo=1> for solo mode.

The dev server runs fully offline. It serves the static site, runs the real game API handler, and stands in for Supabase with a local JSON database (`game-local-db.json`). Delete that file to wipe local accounts. Locally, `GAME_DEV=1` is on by default, which gives every account every item. Set `GAME_DEV=0` to play with real rules.

## Layout

| Path | What it is |
|---|---|
| `game/` | The client: static HTML and JS, with no build step. `index.html` is the title screen and character creator. |
| `game/world3d/` | The main 3D world and its systems: `farm.js`, `mine.js`, `blocks.js`, `arena.js`, `guild.js`, `petbrain.js`, `pools.js`, `shops.js`, `parkour.js`, `solo.js`, `economy.js` |
| `game/city3d/`, `game/sea3d/` | Other 3D areas |
| `game/lib/` | Shared client code: hero rendering, sound, auth (`mpauth.js`), ledger, wallet and chain (`wallet.js`, `chain.js`) |
| `game/items.js` | Item definitions, shared by the client and the server |
| `supabase/functions/game/` | **The game API**, a Supabase Edge Function. `index.ts` is the entry point, `api.js` the handlers and `wallet.js` the chain bridge. |
| `supabase/migrations/` | Database schema: economy, auth rate limits, trading, chain bridge, pools |
| `api/game/` | A Node adapter that runs the same API for the dev server and Docker |
| `netlify/` | A Netlify function adapter (legacy) |
| `contracts/` | Solidity contracts for Robinhood Chain. See [contracts/README.md](contracts/README.md). |
| `apps/solo-android/` | Solo mode packed as an offline Android app with Capacitor. See [its README](apps/solo-android/README.md). |
| `tools/` | Blender and pixel-art asset scripts, chain deploy scripts, the health check and the edge-rules sync |
| `tests/` | Node unit and integration tests, plus headless-Chrome checks in `tests/world3d/` |
| `devlog/` | Development notes |

## Tests

```sh
npm test            # all unit and integration tests (node --test)
npm run test:chain  # only the contract, bridge, DEX and wallet-page tests
```

The contracts are compiled with solc-js and tested in an in-process EVM (ethereumjs), so you don't need Foundry or a node.

The browser checks in `tests/world3d/*.cdp.mjs` drive headless Chrome against a running dev server:

```sh
node game-dev-server.js &
CHROME=/usr/bin/google-chrome node tests/world3d/farm.cdp.mjs
```

`BASE` changes the server URL (the default is `http://localhost:8137`). On Linux, `CHROME_ANGLE=gl` uses the GPU, because software rendering can drop below 1 fps.

## Shared rule files

The Edge Function can only bundle files inside `supabase/functions/`, so the game's rule files (`game/items.js`, `game/world3d/economy.js` and others) are copied into `supabase/functions/game/rules/`. After you change any of them, run:

```sh
node tools/sync-edge-rules.mjs
```

`tests/edge-rules-sync.test.mjs` fails while the copies differ.

## Deploying

- **Game API**: deploy the Supabase Edge Function `game` with `verify_jwt = false`, because the game uses its own Bearer session key. Run new files in `supabase/migrations/` against the database. The function needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY`.
- **Chain API**: the testnet build runs as a separate function, `game-chain`, deployed with `node tools/chain/supabase.mjs deploy`. It also needs the `CHAIN_*` secrets: `CHAIN_RPC`, `CHAIN_ID`, `CHAIN_BRIDGE`, `CHAIN_SIGNER_KEY`, `CHAIN_SYNC_KEY` and others. After each deploy, run `node --env-file=.env.chain.testnet tools/chain/smoke.mjs`.
- **Static site**: the repo root is the site. `vercel.json` and `netlify.toml` send `/` to `/game/` and `/solo` to solo mode.
- **Self-hosted**: the `Dockerfile` runs the dev server with `GAME_DEV=0`, saving its database to the `/app/data` volume.
- **Health check**: `node tools/healthcheck.js` checks a deployed site and API. Add `--signup` to also make a throwaway account and play a little.

## Robinhood Chain

Gameplay stays server-authoritative. The chain is where players own what they've earned:

- Gold is an ERC-20, and each resource is its own ERC-20.
- Gear is an ERC-1155 and farm plots are an ERC-721.
- A player links a wallet with Sign-In with Ethereum (SIWE).
- To withdraw, the server signs an EIP-712 voucher and the player claims it from `GameBridge`.
- Deposits are burned on-chain and credited back to the game account.

Players can sell resources for testnet stock tokens through the game's own Uniswap V2 pools. Addresses, scripts and the full design are in [contracts/README.md](contracts/README.md).

```sh
npm run chain:compile
npm run chain:deploy:testnet   # needs .env.chain.testnet
npm run chain:dex:testnet
```

## Secrets

Keys live in `.env.local` (read by the dev server) and `.env.chain.testnet`. Both are gitignored. Never commit them. The voucher signer key goes only into the Edge Function secrets.
