// The wallet test bench (game/wallet.html + game/lib/wallet.js) in headless Chromium, end to end:
// password sign-in, connect an injected wallet, link it (SIWE), withdraw gold, a resource and a
// piece of gear and send each claim, deposit back, and see the chain sync credit it.
// The injected wallet signs with a test key in the page and sends transactions to an in-process
// chain (tests/helpers/minichain.mjs); the game API is the dev server on its mock database.
// Needs Chromium/Chrome (CHROME=..., default /usr/bin/chromium) and network access to esm.sh.
//   node --test tests/chain-wallet-page.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compile } from '../tools/chain/compile.mjs';
import { MiniChain, deployAll } from './helpers/minichain.mjs';
import { RESOURCES, STOCK_POOLS, ERC20_ABI } from '../game/lib/chain.js';
import { deployDex, seedPools, claimSigner } from '../tools/chain/dex-core.mjs';
import { deployOrchard } from '../tools/chain/orchard-core.mjs';
import { itemTokenId } from '../supabase/functions/game/wallet.js';
import { grant } from './helpers/grant.mjs';

const CHROME = process.env.CHROME || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 25000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
const SYNC_KEY = 'page-sync-key';

test('the wallet page: link, withdraw and claim, deposit and credit, sell for a stock token, plant in the Orchard', { skip: !CHROME && 'no Chrome/Chromium', timeout: 180000 }, async (t) => {
  process.env.CHROME = CHROME;
  process.env.BASE = BASE;
  const { launch, sleep } = await import('./world3d/harness.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'taproot-page-'));
  const built = compile({ withTests: true });
  const chain = await MiniChain.create();
  const signerKey = generatePrivateKey();
  const at = await deployAll(chain, built, { admin: '0x' + 'a1'.repeat(20), signer: privateKeyToAccount(signerKey).address, resources: RESOURCES });
  // the market: mock stock tokens, Uniswap V2 and the seeded resource / stock pools
  const treasury = '0x' + 'a1'.repeat(20), stocks = {};
  for (const sym of new Set(STOCK_POOLS.map((x) => x.stock))) {
    stocks[sym] = await chain.deploy(treasury, built.MockStock, [sym]);
    await chain.send({ from: treasury, to: stocks[sym], abi: built.MockStock.abi, functionName: 'mint', args: [treasury, 5n * 10n ** 18n] });
  }
  const io = { account: treasury, deploy: (a, args) => chain.deploy(treasury, a, args), send: (to, abi, functionName, args) => chain.send({ from: treasury, to, abi, functionName, args }), read: (to, abi, functionName, args) => chain.read({ to, abi, functionName, args }) };
  const dex = await deployDex(io);
  const pairs = await seedPools(io, { bridge: at.bridge, chainId: chain.chainId, dex, stocks, signClaim: claimSigner(privateKeyToAccount(signerKey)), deadline: chain.time + 3600n });
  // the Orchard, with a grove per pool, already growing
  const orch = await deployOrchard(io, { built, pairs, start: chain.time });
  const rpc = await chain.serve();
  const server = spawn(process.execPath, [join(ROOT, 'game-dev-server.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'db.json'), SUPABASE_URL: `http://127.0.0.1:${PORT}`, SUPABASE_SERVICE_KEY: 'local-mock-key',
      GAME_DEV: '0', CHAIN_ID: '46630', CHAIN_RPC: rpc.url, CHAIN_BRIDGE: at.bridge, CHAIN_SIGNER_KEY: signerKey,
      CHAIN_SYNC_KEY: SYNC_KEY, CHAIN_CONFIRMATIONS: '0', CHAIN_SIWE_DOMAINS: `localhost:${PORT}`,
      CHAIN_LINK_LOCK_HOURS: '0', CHAIN_DEX: JSON.stringify({ router: dex.router, stocks }),
    },
    stdio: 'ignore',
  });
  const browser = await launch();
  t.after(() => { browser.kill(); server.kill(); rpc.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/game/'); break; } catch (e) { await sleep(100); } }

  // an account with gold, Slime Gel and a knight's kit, made through the API
  const api = async (action, key, body) => (await fetch(`${BASE}/api/game/${action}`, {
    method: ['me', 'state', 'wallet'].includes(action) ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: ['me', 'state', 'wallet'].includes(action) ? undefined : JSON.stringify(body || {}),
  })).json();
  const username = 'p' + Math.random().toString(36).slice(2, 10);
  let { key } = await api('signup', null, { username, password: 'hunter2hunter2' });
  await grant(BASE, username, { bag: { slime_gel: 40, sun_gem: 8 } });
  await api('act', key, { actions: ['wreck', 'lonely', 'gull', 'doubloon'].map((id) => ({ t: 'chest', id })) });
  const sword = (await api('save', key, { character: { name: 'Hero', cls: 'knight', skin: 1, hs: 'short', hc: 0 } })).character.equipment.rhand;

  // the test wallet, injected before the page loads
  const walletKey = generatePrivateKey();
  const addr = privateKeyToAccount(walletKey).address;
  const p = await browser.player('wallet');
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.ethereum = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(addr)}];
        if (method === 'eth_chainId') return '0xb626';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'personal_sign') {
          const { privateKeyToAccount } = await import('https://esm.sh/viem@2.57.13/accounts');
          return privateKeyToAccount(${JSON.stringify(walletKey)}).signMessage({ message: params[0] });
        }
        const r = await (await fetch(${JSON.stringify(rpc.url)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
        if (r.error) throw Object.assign(new Error(r.error.message), r.error);
        return r.result;
      },
      on() {}, removeListener() {},
    };
    window.TAPROOT_ORCHARD = ${JSON.stringify(orch)};` });
  await p.go(`${BASE}/game/wallet.html`);

  const log = () => p.ev(`document.getElementById('log').innerText`);
  async function click(id, want, ms = 30000) { // clicks, then waits for `want` in the log (fails fast on an error line)
    const before = (await log()).length;
    await p.ev(`document.getElementById(${JSON.stringify(id)}).click(), 1`);
    for (let waited = 0; waited < ms; waited += 250) {
      await sleep(250);
      const bad = await p.ev(`[...document.querySelectorAll('#log .bad')].map((d) => d.textContent).join(' | ')`);
      if (bad) assert.fail(`${id}: ${bad}`);
      if ((await log()).length !== before && (await log()).includes(want)) return;
    }
    assert.fail(`${id}: no "${want}" in log:\n${await log()}`);
  }
  const sync = () => fetch(`${BASE}/api/game/chainsync`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-chain-sync-key': SYNC_KEY }, body: '{}' }).then((r) => r.json());

  // the page found the API and the bridge
  for (let i = 0; i < 40 && !(await p.ev(`document.getElementById('net').textContent`)).includes('open'); i++) await sleep(250);
  assert.match(await p.ev(`document.getElementById('net').textContent`), new RegExp(at.bridge, 'i'));

  await p.ev(`document.getElementById('user').value = ${JSON.stringify(username)}; document.getElementById('pass').value = 'hunter2hunter2'; 1`);
  await click('pwlogin', 'signed in as ' + username);
  key = await p.ev(`localStorage.getItem('taproot_session')`); // signing in on the page replaced the session
  await click('connect', '', 15000).catch(() => {}); // logs nothing on success
  assert.equal((await p.ev(`document.getElementById('addr').textContent`)).toLowerCase(), addr.toLowerCase());
  await click('link', 'linked ' + addr.toLowerCase());

  // gold
  await p.ev(`document.getElementById('gold').value = 30; 1`);
  await click('wgold', 'claimed: 0x');
  // a resource: the select lists bag resources once refresh() ran
  for (let i = 0; i < 40 && !(await p.ev(`document.getElementById('res').value`)); i++) await sleep(250);
  await p.ev(`document.getElementById('res').value = 'slime_gel'; document.getElementById('resn').value = 12; 1`);
  await click('wres', 'claimed: 0x');
  // gear
  await p.ev(`document.getElementById('item').value = ${JSON.stringify(sword)}; 1`);
  await click('witem', 'claimed: 0x');

  const erc20 = (to) => chain.read({ to, abi: built.GameGold.abi, functionName: 'balanceOf', args: [addr] });
  assert.equal(await erc20(at.gold), 30n);
  assert.equal(await erc20(at.resources.slime_gel), 12n);
  assert.equal(await chain.read({ to: at.items, abi: built.GameItems.abi, functionName: 'balanceOf', args: [addr, itemTokenId(sword)] }), 1n);
  assert.equal((await api('state', key)).econ.gold, 90);
  // sent claims aren't offered again, even before the chain sync has seen them
  assert.equal((await api('wallet', key)).pending.length, 0);

  // the on-chain balance button reads it back through the wallet
  await p.ev(`document.getElementById('bal').click(), 1`);
  for (let i = 0; i < 40 && !(await p.ev(`document.getElementById('balout').textContent`)); i++) await sleep(250);
  assert.match(await p.ev(`document.getElementById('balout').textContent`), /30 gold · Slime Gel×12/);

  // deposit 5 Slime Gel and 10 gold back; the sync credits them
  await p.ev(`document.getElementById('dres').value = 'slime_gel'; document.getElementById('dresn').value = 5; document.getElementById('dgold').value = 10; 1`);
  await click('depres', 'deposited: 0x');
  await click('depgold', 'deposited: 0x');
  const s = await sync();
  assert.equal(s.credited, 2, JSON.stringify(s));
  const st = await api('state', key);
  assert.equal(st.econ.gold, 100);
  assert.equal(st.econ.bag.slime_gel, 33);

  // sell: withdraw 5 Sun Gem, then sell them for TSLA in the market section
  await p.ev(`document.getElementById('res').value = 'sun_gem'; document.getElementById('resn').value = 5; 1`);
  await click('wres', 'claimed: 0x');
  for (let i = 0; i < 40 && !(await p.ev(`!!document.getElementById('sell-sun_gem')`)); i++) await sleep(250);
  assert.match(await p.ev(`document.getElementById('market').innerText`), /Sun Gem → TSLA: 1 = 0\.097\d* TSLA/);
  await p.ev(`document.getElementById('sell-n-sun_gem').value = 5; 1`);
  await click('sell-sun_gem', 'sold 5 Sun Gem for');
  const tsla = await chain.read({ to: stocks.TSLA, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] });
  // 5 gems into a 40 gem / 4 TSLA pool: about 0.44 TSLA after the 0.3% fee
  assert.ok(tsla > 44n * 10n ** 16n && tsla < 45n * 10n ** 16n, String(tsla));
  assert.equal(await chain.read({ to: at.resources.sun_gem, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }), 0n);

  // the Orchard: withdraw 2 more Sun Gem, plant them with TSLA from the sale, let Bloom grow, harvest
  await p.ev(`document.getElementById('res').value = 'sun_gem'; document.getElementById('resn').value = 2; 1`);
  await click('wres', 'claimed: 0x');
  for (let i = 0; i < 40 && !(await p.ev(`!!document.getElementById('plant-sun_gem')`)); i++) await sleep(250);
  assert.match(await p.ev(`document.getElementById('orchard-sum').textContent`), /^2\.00 Bloom\/s across 5 groves/);
  await p.ev(`document.getElementById('plant-n-sun_gem').value = 2; 1`);
  await click('plant-sun_gem', 'planted 2 Sun Gem');
  const gid = BigInt(orch.groves.sun_gem);
  const [staked] = await chain.read({ to: orch.orchard, abi: built.Orchard.abi, functionName: 'stakes', args: [gid, addr] });
  assert.ok(staked > 0n);
  assert.equal(await chain.read({ to: at.resources.sun_gem, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }), 0n);
  chain.warp(3600); // an hour of growth: 2 Bloom/s split over 5 groves, all of the sun_gem grove's to us
  await click('harvest', 'harvested: 0x');
  const bloom = await chain.read({ to: orch.bloom, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] });
  // a quarter of ~1440 Bloom (3600 s x 0.4 Bloom/s) is paid now; the rest is locked
  assert.ok(bloom > 355n * 10n ** 18n && bloom < 365n * 10n ** 18n, String(bloom));
  for (let i = 0; i < 40 && !/locked/.test(await p.ev(`document.getElementById('orchard-sum').textContent`)); i++) await sleep(250);
  assert.match(await p.ev(`document.getElementById('orchard-sum').textContent`), /you hold 36\d\.?\d* Bloom · 10\d\d\.?\d* locked/);
  await click('unstake-sun_gem', 'unstaked from Sun Gem: 0x');
  assert.equal((await chain.read({ to: orch.orchard, abi: built.Orchard.abi, functionName: 'stakes', args: [gid, addr] }))[0], 0n);
  assert.equal(await chain.read({ to: pairs.sun_gem, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }), staked);
  await p.shot('wallet-page.png');
});
