/* ============================================================================
   The Orchard in the 3D world: a grove of five trees behind the Potion Shop in
   Taproot City, one per resource / stock pool, and Elder Rowan, who tends it
   (press F next to her). Edit freely.

   The Orchard itself is on Robinhood Chain (contracts/src/Orchard.sol): stake a
   pool's Uniswap V2 LP tokens in its grove and Bloom grows for you every
   second. Everything here goes through the linked wallet (game/lib/wallet.js);
   the game server is not involved, so it works the same signed in or not.

   - Each tree grows with your stake in its grove, and hangs one glowing fruit
     per few Bloom you could harvest from it right now.
   - The panel: plant (add a withdrawn resource + its stock token as liquidity
     and stake it in one go), unstake, harvest all, claim unlocked Bloom.
   ============================================================================ */
import { RESOURCES, ORCHARD_GROVES } from '/game/lib/chain.js';

// Where the grove stands in Taproot City (tiles, before the city is stitched into the world), and its keeper.
export const ORCHARD_TREES = [[3.6, 31.6], [5.6, 33.0], [7.6, 31.6], [9.6, 33.0], [12.6, 32.4]];
export const ROWAN = ['Elder Rowan', 'keeper of the Orchard', 7.5, 29.6,
  { skin: 2, hc: 5, hs: 'long', equipment: { head: 'wizard_hat', body: 'mage_robe', rhand: 'oak_staff' } },
  'Plant a pool in my groves and Bloom grows for you, second by second. Press F to see them.'];

const BLOOM_PER_FRUIT = 5; // one fruit per this much harvestable Bloom, up to MAX_FRUIT
const MAX_FRUIT = 14;
const REFRESH_MS = 20000;

let W = null; // game/lib/wallet.js, loaded the first time it is needed (it pulls viem from the CDN)
const wallet = async () => (W ||= await import('/game/lib/wallet.js'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createOrchardView(d) {
  /* d = { THREE, scene, groundAt(x, z), toast(msg), sfx, burst(x, y, z, color, n), rerender(),
         at: { ox, oy } (where the city sits in the world), keeper: { x, z } (Elder Rowan) } */
  const { THREE } = d;
  const ui = { sel: null, amt: '1' };
  let state = null, err = null, busy = false, loading = false, lastLoad = 0;

  /* ---------- the trees ---------- */
  const bark = new THREE.MeshStandardMaterial({ color: '#6b4a2e', roughness: 0.95 });
  const leafCols = ['#6cc04a', '#7acc52', '#5cb045', '#86d05a', '#68bb4c']; // the world's bright greens
  const fruitMat = new THREE.MeshStandardMaterial({ color: '#ffd36a', emissive: '#ffb02e', emissiveIntensity: 1.6, roughness: 0.4 });
  const fruitGeo = new THREE.SphereGeometry(0.09, 10, 8);
  const ox = (d.at && d.at.ox) || 0, oy = (d.at && d.at.oy) || 0;
  const trees = ORCHARD_TREES.map(([tx, tz], i) => {
    const x = tx + ox, z = tz + oy;
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 1.3, 8), bark);
    trunk.position.y = 0.65; trunk.castShadow = true; g.add(trunk);
    const crown = new THREE.Group(); crown.position.y = 1.55; g.add(crown);
    const leaf = new THREE.MeshStandardMaterial({ color: leafCols[i % leafCols.length], roughness: 0.85, flatShading: true });
    [[0, 0, 0, 0.75], [0.42, -0.12, 0.1, 0.5], [-0.38, -0.08, -0.15, 0.52], [0.05, 0.38, -0.05, 0.48]].forEach(([lx, ly, lz, r]) => {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leaf);
      m.position.set(lx, ly, lz); m.castShadow = true; crown.add(m);
    });
    // fruit hang on fixed spots round the crown; only `n` of them show
    const fruit = [];
    for (let k = 0; k < MAX_FRUIT; k++) {
      const a = k * 2.399, h = -0.25 + ((k * 37) % 10) / 18, r = 0.62 + ((k * 13) % 5) / 25;
      const f = new THREE.Mesh(fruitGeo, fruitMat);
      f.position.set(Math.cos(a) * r, h, Math.sin(a) * r); f.visible = false; crown.add(f); fruit.push(f);
    }
    // a ring of soil marks the grove even before anyone plants
    const ring = new THREE.Mesh(new THREE.CircleGeometry(0.7, 20), new THREE.MeshStandardMaterial({ color: '#5a3e28', roughness: 1 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; ring.receiveShadow = true; g.add(ring);
    g.position.set(x, d.groundAt ? d.groundAt(x, z) : 0, z);
    d.scene.add(g);
    return { g, crown, fruit, x, z, size: 0.7, sizeT: 0.7, phase: i * 1.7 };
  });

  // How each tree should look from the last read: bigger with your stake, fruit for what is ready.
  function dress() {
    trees.forEach((t, i) => {
      const gv = state && state.groves.find((g) => g.resource === ORCHARD_GROVES[i].resource);
      const share = gv && gv.staked > 0n && gv.mine ? Number((gv.mine * 1000n) / gv.staked) / 1000 : 0;
      t.sizeT = 0.7 + (gv && gv.staked > 0n ? 0.25 : 0) + share * 0.6; // a planted grove is fuller; yours grows more
      const ready = gv && gv.pending ? Number(gv.pending / 10n ** 15n) / 1000 : 0;
      const n = Math.min(MAX_FRUIT, Math.floor(ready / BLOOM_PER_FRUIT)); // a fruit for every full BLOOM_PER_FRUIT
      t.fruit.forEach((f, k) => { f.visible = k < n; });
    });
  }

  function update(dt, now) {
    for (const t of trees) {
      t.size += (t.sizeT - t.size) * Math.min(1, dt * 2);
      t.g.scale.setScalar(t.size);
      t.crown.rotation.z = Math.sin(now / 1400 + t.phase) * 0.035;
      t.fruit.forEach((f, k) => { if (f.visible) f.position.y += Math.sin(now / 500 + k) * 0.0006; });
    }
    if (W && W.address() && !loading && now - lastLoad > REFRESH_MS) load();
  }

  /* ---------- reading the chain ---------- */
  async function load() {
    loading = true; lastLoad = performance.now();
    try { state = await (await wallet()).orchard(); err = null; dress(); }
    catch (e) { err = e.shortMessage || e.message || String(e); }
    loading = false;
    d.rerender();
  }

  /* ---------- the panel ---------- */
  function render(e) {
    e.title.textContent = 'The Orchard';
    e.greet.textContent = 'Elder Rowan: "Plant a resource with its stock token and the grove takes root. Bloom grows every second: a quarter is yours at harvest, the rest ripens over thirty days."';
    e.tabs.innerHTML = '';
    if (!W || !W.address()) {
      e.list.innerHTML = `<p class="shop-empty">The Orchard is on Robinhood Chain. Connect a wallet to see your groves.${err ? `<br><small>${esc(err)}</small>` : ''}</p>`
        + '<div class="row"><div class="txt"><b>Wallet</b><small>Your browser wallet (MetaMask, Rabby, Robinhood Wallet…)</small></div><button data-act="o_connect">Connect</button></div>';
      return;
    }
    if (err && !state) { e.list.innerHTML = `<p class="shop-empty">${esc(err)}</p>`; return; }
    if (!state) { e.list.innerHTML = '<p class="shop-empty">Elder Rowan walks the rows…</p>'; return; }
    const B = W.formatBloom, v = state.vest || { locked: 0n, ready: 0n, end: 0 };
    const pend = state.groves.reduce((a, g) => a + (g.pending || 0n), 0n);
    const days = v.end ? Math.max(0, Math.ceil((v.end * 1000 - Date.now()) / 86400000)) : 0;
    let html = `<div class="row"><div class="ico">\u{1F338}</div><div class="txt"><b>${B(state.bloom || 0n)} Bloom</b>`
      + `<small>${B(state.rate)} Bloom/s across the groves · ready to harvest ${B(pend)} · locked ${B(v.locked)}${days ? ` (free in ${days}d)` : ''} · unlocked ${B(v.ready)}</small></div>`
      + `<button data-act="o_harvest" ${busy || pend === 0n ? 'disabled' : ''}>Harvest</button>`
      + `<button class="alt" data-act="o_claim" ${busy || v.ready === 0n ? 'disabled' : ''}>Claim</button></div>`;
    for (const g of state.groves) {
      const name = RESOURCES[g.resource] ? RESOURCES[g.resource].name : g.resource;
      const share = g.staked > 0n && g.mine ? Number((g.mine * 10000n) / g.staked) / 100 : 0;
      const open = ui.sel === g.resource;
      html += `<div class="row${open ? ' on' : ''}"><div class="ico">\u{1F333}</div><div class="txt"><b>${esc(name)} / ${esc(g.stock)}</b>`
        + `<small>${B(g.perSecond * 86400n)} Bloom a day for the grove · yours: ${share ? share + '%' : 'nothing planted'} · ready ${B(g.pending || 0n)}</small></div>`
        + (open ? '<button class="alt" data-act="o_close">Close</button>' : `<button data-act="o_pick" data-id="${g.resource}">Plant</button>`)
        + `<button class="alt" data-act="o_unstake" data-id="${g.resource}" ${busy || !g.mine ? 'disabled' : ''}>Unstake</button></div>`;
      if (open) {
        html += `<div class="pool-form"><label>${esc(name)} to plant <input data-orchard-amt="1" inputmode="numeric" value="${esc(ui.amt)}" placeholder="0"></label>`
          + `<p class="pool-note">Withdraw ${esc(name)} to your wallet first (the wallet page). Planting pairs it with ${esc(g.stock)} at the pool's price and stakes the LP tokens.</p>`
          + `<button data-act="o_plant" ${busy || !/^[1-9]\d*$/.test(ui.amt) ? 'disabled' : ''}>${busy ? '…' : 'Plant'}</button></div>`;
      }
    }
    e.list.innerHTML = html;
  }

  async function run(fn, done) {
    busy = true; d.rerender();
    try { const r = await fn(await wallet()); if (done) d.toast(done(r)); if (d.sfx) d.sfx.play('coin'); celebrate(); }
    catch (e) { d.toast(e.shortMessage || e.message || 'The wallet said no'); }
    busy = false;
    await load();
  }
  function celebrate() { if (d.burst) for (const t of trees) d.burst(t.x, 1.6 * t.size, t.z, 0xffd36a, 8); }

  function click(b) {
    const act = b.dataset.act, id = b.dataset.id;
    if (act === 'o_connect') { run((w) => w.connect(), () => 'Wallet connected'); return; }
    if (busy) return;
    if (act === 'o_pick') { ui.sel = id; ui.amt = '1'; }
    else if (act === 'o_close') ui.sel = null;
    else if (act === 'o_harvest') { run((w) => w.harvest(), () => 'Harvested: a quarter is yours now, the rest ripens'); return; }
    else if (act === 'o_claim') { run((w) => w.claimBloom(), () => 'Claimed your ripened Bloom'); return; }
    else if (act === 'o_unstake') { run((w) => w.unstake(id), () => 'Unstaked: the LP tokens are back in your wallet'); return; }
    else if (act === 'o_plant') { const n = Number(ui.amt), r = ui.sel; ui.sel = null; run((w) => w.plant(r, n), (x) => `Planted ${n} ${RESOURCES[r].name}: ${x.lp} LP staked`); return; }
    d.rerender();
  }
  function input(el) {
    if (!el.matches('input[data-orchard-amt]')) return;
    ui.amt = el.value.replace(/\D/g, '').slice(0, 9);
    const go = el.closest('.pool-form') && el.closest('.pool-form').querySelector('[data-act="o_plant"]');
    if (go) go.disabled = busy || !/^[1-9]\d*$/.test(ui.amt);
  }

  return {
    ui, trees, update, render, click, input, keeper: d.keeper || null,
    state: () => state,
    open() { ui.sel = null; if (W && W.address()) load(); else wallet().then(() => d.rerender()).catch((e) => { err = e.message; d.rerender(); }); },
  };
}
