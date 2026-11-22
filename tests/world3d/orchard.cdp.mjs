// The Orchard in the 3D world (orchardview.js): Taproot City has Elder Rowan and a grove of five
// trees; F next to her opens the Orchard panel; connect the (injected) wallet, plant Sun Gem with
// TSLA in its grove, its tree grows and fruits as Bloom builds up, and Harvest pays it out.
// Runs its own in-process chain and dev server, so nothing else needs to be running:
//   CHROME=/usr/bin/chromium CHROME_ANGLE=gl node tests/world3d/orchard.cdp.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 27000 + Math.floor(Math.random() * 2000);
process.env.BASE = `http://localhost:${PORT}`;
const { launch, sleep, near, BASE } = await import('./harness.mjs');
const { compile } = await import('../../tools/chain/compile.mjs');
const { MiniChain, deployAll } = await import('../helpers/minichain.mjs');
const { deployDex, seedPools, claimSigner } = await import('../../tools/chain/dex-core.mjs');
const { deployOrchard } = await import('../../tools/chain/orchard-core.mjs');
const { RESOURCES, STOCK_POOLS, ERC20_ABI, claimDomain, KIND } = await import('../../game/lib/chain.js');

// the chain: bridge + resources, mock stock tokens, Uniswap V2 pools, the Orchard
const built = compile({ withTests: true });
const chain = await MiniChain.create();
const signerKey = generatePrivateKey(), signer = privateKeyToAccount(signerKey);
const treasury = '0x' + 'a1'.repeat(20);
const at = await deployAll(chain, built, { admin: treasury, signer: signer.address, resources: RESOURCES });
const stocks = {};
for (const sym of new Set(STOCK_POOLS.map((x) => x.stock))) {
  stocks[sym] = await chain.deploy(treasury, built.MockStock, [sym]);
  await chain.send({ from: treasury, to: stocks[sym], abi: built.MockStock.abi, functionName: 'mint', args: [treasury, 5n * 10n ** 18n] });
}
const io = { account: treasury, deploy: (a, args) => chain.deploy(treasury, a, args), send: (to, abi, functionName, args) => chain.send({ from: treasury, to, abi, functionName, args }), read: (to, abi, functionName, args) => chain.read({ to, abi, functionName, args }) };
const dex = await deployDex(io);
const pairs = await seedPools(io, { bridge: at.bridge, chainId: chain.chainId, dex, stocks, signClaim: claimSigner(signer), deadline: chain.time + 3600n });
const orch = await deployOrchard(io, { built, pairs, start: chain.time });

// the player's wallet: 6 Sun Gem (as if withdrawn) and 1 TSLA
const walletKey = generatePrivateKey(), addr = privateKeyToAccount(walletKey).address;
const c = { to: addr, kind: KIND.resource, id: BigInt(keccak256(toBytes('sun_gem'))), amount: 6n, nonce: 77n, deadline: chain.time + 3600n };
await chain.send({ from: addr, to: at.bridge, abi: built.GameBridge.abi, functionName: 'claim', args: [c, await signer.signTypedData({ domain: claimDomain(chain.chainId, at.bridge), types: { Claim: [{ name: 'to', type: 'address' }, { name: 'kind', type: 'uint8' }, { name: 'id', type: 'uint256' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, primaryType: 'Claim', message: c })] });
await chain.send({ from: addr, to: stocks.TSLA, abi: built.MockStock.abi, functionName: 'mint', args: [addr, 10n ** 18n] });

const rpc = await chain.serve();
const dir = mkdtempSync(join(tmpdir(), 'taproot-orchard-'));
const server = spawn(process.execPath, [join(ROOT, 'game-dev-server.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'db.json'), SUPABASE_URL: `http://127.0.0.1:${PORT}`, SUPABASE_SERVICE_KEY: 'local-mock-key',
    GAME_DEV: '0', CHAIN_ID: '46630', CHAIN_RPC: rpc.url, CHAIN_BRIDGE: at.bridge, CHAIN_SIGNER_KEY: signerKey, CHAIN_SYNC_KEY: 'k', CHAIN_CONFIRMATIONS: '0',
    CHAIN_DEX: JSON.stringify({ router: dex.router, stocks }) },
  stdio: 'ignore',
});
for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/game/'); break; } catch (e) { await sleep(100); } }

const { player, kill } = await launch();
try {
  const A = await player('Rowan');
  await A.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.ethereum = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [${JSON.stringify(addr)}];
        if (method === 'eth_chainId') return '0xb626';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        const r = await (await fetch(${JSON.stringify(rpc.url)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
        if (r.error) throw Object.assign(new Error(r.error.message), r.error);
        return r.result;
      },
      on() {}, removeListener() {},
    };
    window.TAPROOT_ORCHARD = ${JSON.stringify(orch)};` });
  await A.go(`${BASE}/game/world3d/?area=city&hour=13&nomp=1`);
  const up = await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d && __world3d.orchard()) { clearInterval(t); r(1); } }, 200); setTimeout(() => r(0), 30000); })`);
  if (!up) console.log('world not up');
  assert.ok(up, 'the world loaded with an Orchard');
  assert.equal(await A.ev('__world3d.orchard().trees.length'), 5);

  // walk up to Elder Rowan: F opens the Orchard
  const rowan = await A.ev(`(() => { const t = __world3d.orchard().trees[2]; return { x: t.x, z: t.z }; })()`);
  await A.ev(`(() => { const k = __world3d.orchard().keeper; __world3d.tp(k.x, k.z - 1.2, Math.PI); return 1; })()`);
  for (let i = 0; i < 20 && !/Orchard/.test(await near(A)); i++) await sleep(250);
  assert.match(await near(A), /Elder Rowan's Orchard/);
  await A.shot('orchard-grove.png');
  await A.key('KeyF', 'f');
  await sleep(600);
  assert.equal(await A.ev(`document.getElementById('shopTitle').textContent`), 'The Orchard');

  const click = (sel) => A.ev(`(() => { const b = document.querySelector('#shopList ${sel}'); if (!b || b.disabled) return false; b.click(); return true; })()`);
  const list = () => A.ev(`document.getElementById('shopList').innerText`);
  const waitFor = async (re, ms = 20000) => { for (let w = 0; w < ms && !re.test(await list()); w += 250) await sleep(250); assert.match(await list(), re); };

  assert.ok(await click('[data-act="o_connect"]'));
  await waitFor(/Sun Gem \/ TSLA/);
  assert.match(await list(), /2\.00 Bloom\/s across the groves/);

  // plant 4 Sun Gem
  assert.ok(await click('[data-act="o_pick"][data-id="sun_gem"]'));
  await A.ev(`(() => { const i = document.querySelector('#shopList input[data-orchard-amt]'); i.value = '4'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  assert.ok(await click('[data-act="o_plant"]'));
  await waitFor(/yours: 100%/);
  assert.equal(await chain.read({ to: at.resources.sun_gem, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }), 2n);

  // an hour later the tree has grown and fruited
  chain.warp(3600);
  await A.ev(`__world3d.orchard().open(); 1`);
  await waitFor(/ready to harvest 1[34]\d\d/);
  await sleep(1500);
  const tree = await A.ev(`(() => { const t = __world3d.orchard().trees[0]; return { size: t.g.scale.x, fruit: t.fruit.filter((f) => f.visible).length }; })()`);
  assert.ok(tree.size > 1.2, 'the planted tree grew: ' + tree.size);
  assert.equal(tree.fruit, 14, 'full of fruit');
  await A.ev(`document.getElementById('shopPanel').hidden = true; 1`);
  await A.ev(`__world3d.tp(${rowan.x}, ${rowan.z - 2.2}, Math.PI); __world3d.cam(6, 0.35); 1`);
  await sleep(800);
  await A.shot('orchard-fruit.png');
  await A.ev(`document.getElementById('shopPanel').hidden = false; 1`);

  assert.ok(await click('[data-act="o_harvest"]'));
  await waitFor(/^.*\b3[56]\d(\.\d+)? Bloom/m);
  const bloom = await chain.read({ to: orch.bloom, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] });
  assert.ok(bloom > 350n * 10n ** 18n, String(bloom));
  assert.equal(await A.ev(`__world3d.orchard().trees[0].fruit.filter((f) => f.visible).length`), 0);
  console.log('orchard: ok');
} finally {
  kill(); server.kill(); rpc.close(); rmSync(dir, { recursive: true, force: true });
}
