/* ============================================================================
   Fossil Dig: the little mini game under the hatch in Tilda's Workshop.

   An 8x8 wall of dirt hides a few fossils, each 2x2 tiles. Pick or hammer a
   tile and its neighbours take a hit too (Diamond and Pearl style): the pick
   hits a plus shape, the hammer the whole 3x3. Every swing also wears down the
   wall; at 0% the tunnel collapses. Dig all four tiles of a fossil to take it.

   The top half is plain logic (no DOM) so node tests can check it. The bottom
   half is the overlay: call openFossilDig(onClose).
   ============================================================================ */

export const G = 8; // the wall is G x G tiles
export const TOOLS = {
  // [dx, dy, damage]: how hard each tile is hit; `cost` is the wall integrity a swing uses up
  pick: { cost: 3, hits: [[0, 0, 2], [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]] },
  hammer: { cost: 7, hits: [[0, 0, 3], [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1]] },
};
export const FOSSILS = {
  amber: 'Old Amber', fern: 'Fern Fossil', egg: 'Dino Egg', shell: 'Spiral Shell', bones: 'Fish Bones', tooth: 'Giant Tooth',
};
export const FOSSIL_IDS = Object.keys(FOSSILS);
export const PER_DIG = 3;

// a fresh wall: tile strength 1 to 4, and PER_DIG fossils that do not overlap
export function makeDig(rand = Math.random) {
  const hp = Array.from({ length: G }, () => Array.from({ length: G }, () => {
    const r = rand();
    return r < 0.2 ? 4 : r < 0.45 ? 3 : r < 0.8 ? 2 : 1;
  }));
  const kinds = [...FOSSIL_IDS].sort(() => rand() - 0.5);
  const items = [];
  for (let tries = 0; items.length < PER_DIG && tries < 200; tries++) {
    const x = Math.floor(rand() * (G - 1)), y = Math.floor(rand() * (G - 1));
    if (items.some((o) => Math.abs(o.x - x) < 2 && Math.abs(o.y - y) < 2)) continue;
    items.push({ x, y, kind: kinds[items.length], got: false });
  }
  return { hp, items, integrity: 100, over: false, seed: Math.floor(rand() * 1e9) };
}

// one swing at tile (i, j). Returns { ok, found: [fossil kinds], collapsed }
export function strike(dig, i, j, tool) {
  const t = TOOLS[tool];
  if (!t || dig.over || i < 0 || j < 0 || i >= G || j >= G || dig.hp[j][i] === 0) return { ok: false, found: [], collapsed: false };
  for (const [dx, dy, d] of t.hits) {
    const x = i + dx, y = j + dy;
    if (x >= 0 && y >= 0 && x < G && y < G) dig.hp[y][x] = Math.max(0, dig.hp[y][x] - d);
  }
  dig.integrity = Math.max(0, dig.integrity - t.cost);
  const found = [];
  for (const o of dig.items) {
    if (o.got) continue;
    if ([0, 1].every((a) => [0, 1].every((b) => dig.hp[o.y + b][o.x + a] === 0))) { o.got = true; found.push(o.kind); }
  }
  if (dig.integrity === 0) dig.over = true;
  return { ok: true, found, collapsed: dig.over };
}

/* ---------- the overlay ---------- */

const KEY = 'taproot_fossils';
export function loadFossils() {
  try { const o = JSON.parse(localStorage.getItem(KEY)); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}
const saveFossils = (c) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {} };

const N = 32; // pixels per tile on the canvas
const PAL = {
  4: ['#4d4130', '#43382a', '#5a4c38'], 3: ['#6a5a41', '#5f5039', '#76654a'], 2: ['#8b7952', '#7e6d49', '#9a8761'],
  1: ['#8b7952', '#7e6d49', '#9a8761'], 0: ['#0c0a07', '#0a0806', '#100d09'],
};
const hash = (i, j, k, s) => { let h = (i * 374761393 + j * 668265263 + k * 2147483647 + s) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return (((h ^ (h >>> 16)) >>> 0) / 4294967296); };
function line([x0, y0], [x1, y1]) {
  const o = [], dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx - dy;
  for (;;) {
    o.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 > -dy) { e -= dy; x0 += sx; }
    if (e2 < dx) { e += dx; y0 += sy; }
  }
  return o;
}
const SMALL = [[5, 2], [4, 3], [4, 4], [3, 5], [3, 6], [9, 3], [10, 4], [10, 5], [11, 6], [4, 9], [5, 10], [5, 11], [6, 12], [10, 9], [10, 10], [9, 11], [9, 12], [8, 13], [11, 3], [12, 5]];
const BIG = [[2, 2, 7, 8], [14, 2, 9, 8], [7, 8, 2, 14], [9, 8, 14, 14], [7, 8, 9, 8], [7, 8, 7, 2], [5, 5, 2, 6], [12, 12, 14, 10], [9, 8, 9, 14]]
  .flatMap(([a, b, c, d]) => line([a, b], [c, d]));

// a dirt tile at strength h: speckled, with small cracks at 2 and big ones at 1, black once dug (0)
function drawTile(c, h, i, j, seed) {
  const k = PAL[h], u = N / 16, s = N / 8;
  c.fillStyle = k[0]; c.fillRect(0, 0, N, N);
  for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) {
    const r = hash(i, j, a * 8 + b, seed);
    if (r < 0.3) { c.fillStyle = k[1]; c.fillRect(a * s, b * s, s, s); } else if (r > 0.82) { c.fillStyle = k[2]; c.fillRect(a * s, b * s, s, s); }
  }
  if (h > 0) {
    c.fillStyle = 'rgba(0,0,0,.16)';
    for (let d = 0; d < 7; d++) c.fillRect(Math.floor(hash(i, j, 99 + d, seed) * 14) * u, Math.floor(hash(i, j, 120 + d, seed) * 14) * u, u, u);
  }
  if (h === 1 || h === 2) { c.fillStyle = '#21170c'; (h === 2 ? SMALL : BIG).forEach((p) => c.fillRect(p[0] * u, p[1] * u, u, u)); }
  c.fillStyle = 'rgba(0,0,0,.32)'; c.fillRect(0, N - 1, N, 1); c.fillRect(N - 1, 0, 1, N);
}

const mk = (w, h, f) => { const e = document.createElement('canvas'); e.width = w; e.height = h; f(e.getContext('2d')); return e; };
function makeSprites() { // each fossil is a 64x64 picture: 2x2 tiles
  const px = (c, test, color) => { for (let y = 0; y < 64; y += 2) for (let x = 0; x < 64; x += 2) { const col = test(x, y); if (col) { c.fillStyle = col === true ? color : col; c.fillRect(x, y, 2, 2); } } };
  return {
    egg: mk(64, 64, (c) => px(c, (x, y) => { const t = ((x - 32) / 17) ** 2 + ((y - 33) / 24) ** 2; if (t >= 1) return false; return hash(x, y, 5, 1) < 0.08 ? '#9a8c70' : t > 0.8 ? '#b8aa88' : '#ebe0c6'; })),
    amber: mk(64, 64, (c) => {
      px(c, (x, y) => { const a = ((x - 26) / 22) ** 2 + ((y - 26) / 15) ** 2 < 1, b = ((x - 42) / 12) ** 2 + ((y - 38) / 22) ** 2 < 1; return a || b ? (x + y > 78 ? '#c4742a' : x + y < 56 ? '#f6c878' : '#e8963c') : false; });
      c.fillStyle = '#3a2410'; c.fillRect(26, 22, 2, 12); c.fillRect(22, 22, 10, 2);
    }),
    fern: mk(64, 64, (c) => {
      c.fillStyle = '#2e4a2c';
      for (let y = 8; y < 58; y += 2) {
        c.fillRect(31, y, 2, 2);
        const w = Math.max(2, y < 20 ? (y - 6) / 1.5 : (60 - y) / 2.2);
        if (y % 4 === 0) for (let d = 2; d < w; d += 2) { c.fillRect(31 - d, y + (d / 2 | 0), 2, 2); c.fillRect(33 + d, y + (d / 2 | 0), 2, 2); }
      }
    }),
    shell: mk(64, 64, (c) => px(c, (x, y) => {
      const r = Math.hypot(x - 32, y - 32); if (r > 24) return false;
      const a = Math.atan2(y - 32, x - 32) / (Math.PI * 2);
      const ring = (r / 6 + a) % 1; return ring < 0.22 ? '#7a6644' : r < 4 ? '#7a6644' : '#cdb98e';
    })),
    bones: mk(64, 64, (c) => {
      c.fillStyle = '#ddd5bb'; c.fillRect(14, 31, 38, 2);
      for (let x = 20; x < 46; x += 4) { c.fillRect(x, 24, 2, 8); c.fillRect(x, 33, 2, 8); }
      px(c, (x, y) => (Math.hypot(x - 10, y - 32) < 7 ? '#ddd5bb' : false));
      c.fillRect(52, 28, 2, 4); c.fillRect(54, 24, 2, 4); c.fillRect(54, 34, 2, 4); c.fillRect(52, 32, 2, 4);
      c.fillStyle = '#6a604a'; c.fillRect(8, 30, 2, 2);
    }),
    tooth: mk(64, 64, (c) => px(c, (x, y) => {
      if (y < 8 || y > 56) return false;
      const w = 18 * Math.pow(1 - (y - 8) / 48, 0.8); if (Math.abs(x - 32) > w) return false;
      return Math.abs(x - 32) > w - 3 ? '#a89c7c' : '#efe6c8';
    })),
  };
}

const CSS = `
#fossilDig{position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;background:rgba(10,6,2,.86);font-family:ui-monospace,Menlo,Consolas,monospace;color:#d8c8a0;padding:12px;box-sizing:border-box}
#fossilDig *{box-sizing:border-box}
#fossilDig .fd{background:#14110d;border:2px solid #2a241a;max-width:900px;width:100%;max-height:100%;overflow:auto;padding:16px;display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:16px;position:relative}
@media(max-width:640px){#fossilDig .fd{grid-template-columns:1fr}}
#fossilDig canvas{display:block;image-rendering:pixelated;width:min(100%,calc(100vh - 210px));min-width:220px;aspect-ratio:1;margin:0 auto;cursor:crosshair;touch-action:manipulation}
#fossilDig .tb{display:flex;gap:8px;margin-bottom:10px;align-items:center}
#fossilDig button{font:13px ui-monospace,Menlo,Consolas,monospace;padding:6px 12px;border:2px solid #3a3022;color:#d8c8a0;background:#1e1912;border-radius:5px;cursor:pointer}
#fossilDig button.on{border-color:#e0a84a}
#fossilDig .bar{height:12px;background:#0b0907;border:2px solid #2a241a;margin:4px 0 12px}
#fossilDig .bar i{display:block;height:100%;width:100%}
#fossilDig .col{border:2px solid #2a241a;padding:12px;background:#110e0a;align-self:start}
#fossilDig .cg{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 6px;margin-top:10px}
#fossilDig .cell{text-align:center;font-size:10px;min-height:78px}
#fossilDig .ic{width:100%;max-width:58px;aspect-ratio:1;margin:0 auto 3px;border:2px solid transparent;background:#0b0907}
#fossilDig .ic.got{border-color:#6f9a5c}
#fossilDig .ic img{width:100%;image-rendering:pixelated;display:block}
#fossilDig .x{color:#e0a84a}
#fossilDig .wrap{position:relative;width:fit-content;max-width:100%;margin:0 auto}
#fossilDig .ov{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:rgba(10,8,5,.82);font-size:14px;text-align:center}
#fossilDig .msg{font-size:12px;color:#a89878;margin-top:8px;min-height:18px;text-align:center}
`;

export function openFossilDig(onClose) {
  if (document.getElementById('fossilDig')) return;
  if (!document.getElementById('fossilDigCss')) { const s = document.createElement('style'); s.id = 'fossilDigCss'; s.textContent = CSS; document.head.appendChild(s); }
  const sprites = makeSprites();
  const silhouette = (id) => mk(64, 64, (c) => { c.drawImage(sprites[id], 0, 0); c.globalCompositeOperation = 'source-in'; c.fillStyle = '#34322e'; c.fillRect(0, 0, 64, 64); });
  const sil = Object.fromEntries(FOSSIL_IDS.map((id) => [id, silhouette(id).toDataURL()]));
  const coll = loadFossils();
  const root = document.createElement('div');
  root.id = 'fossilDig';
  root.innerHTML = `<div class="fd"><div>
    <div class="tb"><button data-t="pick" class="on">&#9935; Pick (1)</button><button data-t="hammer">&#128296; Hammer (2)</button><button data-a="new" style="margin-left:auto">New dig</button><button data-a="close" aria-label="Close">Esc</button></div>
    <div class="wl" style="font-size:13px"></div><div class="bar"><i></i></div>
    <div class="wrap"><canvas width="${G * N}" height="${G * N}"></canvas><div class="ov"><span>The tunnel collapsed.</span><button data-a="new">Dig again</button></div></div>
    <div class="msg"></div></div>
    <div class="col"><div style="font-size:15px;letter-spacing:1px;color:#f0e4c0">COLLECTION</div><div class="cn" style="font-size:12px;color:#a89878"></div><div class="cg"></div></div></div>`;
  document.body.appendChild(root);
  const $ = (q) => root.querySelector(q);
  const cv = $('canvas'), cx = cv.getContext('2d');
  let dig, tool = 'pick', hov = null;
  const tiles = new Map();
  const tileImg = (h, i, j) => {
    const k = `${h},${i},${j}`;
    if (!tiles.has(k)) tiles.set(k, mk(N, N, (c) => drawTile(c, h, i, j, dig.seed)));
    return tiles.get(k);
  };
  const say = (t) => { $('.msg').textContent = t; };
  function draw() {
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) cx.drawImage(tileImg(dig.hp[j][i], i, j), i * N, j * N);
    for (const o of dig.items) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++)
      if (dig.hp[o.y + b][o.x + a] === 0) cx.drawImage(sprites[o.kind], a * N, b * N, N, N, (o.x + a) * N, (o.y + b) * N, N, N);
    if (hov && !dig.over) { // red corner brackets round the tile you are over
      cx.strokeStyle = '#ee6a5a'; cx.lineWidth = 3;
      const x = hov[0] * N, y = hov[1] * N, L = 9;
      [[x, y, 1, 1], [x + N, y, -1, 1], [x, y + N, 1, -1], [x + N, y + N, -1, -1]].forEach(([px, py, sx, sy]) => {
        cx.beginPath(); cx.moveTo(px + sx * (L + 1), py + sy * 2); cx.lineTo(px + sx * 2, py + sy * 2); cx.lineTo(px + sx * 2, py + sy * (L + 1)); cx.stroke();
      });
    }
  }
  function ui() {
    const p = Math.round(dig.integrity);
    $('.wl').textContent = `Wall integrity - ${p}%`;
    const f = $('.bar i'); f.style.width = `${p}%`; f.style.background = p > 60 ? '#8fae6a' : p > 30 ? '#e0b050' : '#d9603f';
    $('.cn').textContent = `${FOSSIL_IDS.filter((id) => coll[id] > 0).length}/${FOSSIL_IDS.length} discovered`;
    $('.cg').innerHTML = FOSSIL_IDS.map((id) => coll[id] > 0
      ? `<div class="cell"><div class="ic got"><img src="${sprites[id].toDataURL()}" alt=""></div>${FOSSILS[id]}<div class="x">x${coll[id]}</div></div>`
      : `<div class="cell"><div class="ic"><img src="${sil[id]}" alt=""></div>???</div>`).join('');
    $('.ov').style.display = dig.over ? 'flex' : 'none';
  }
  function fresh() { dig = makeDig(); tiles.clear(); say('Pick hits a plus shape. Hammer hits the whole 3x3.'); draw(); ui(); }
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    return [Math.min(G - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * G))), Math.min(G - 1, Math.max(0, Math.floor((e.clientY - r.top) / r.height * G)))];
  };
  cv.addEventListener('pointermove', (e) => { hov = at(e); draw(); });
  cv.addEventListener('pointerleave', () => { hov = null; draw(); });
  cv.addEventListener('click', (e) => {
    const [i, j] = at(e);
    const r = strike(dig, i, j, tool);
    if (!r.ok) return;
    for (const k of r.found) { coll[k] = (coll[k] || 0) + 1; say(`Found: ${FOSSILS[k]}!`); }
    if (r.found.length) saveFossils(coll);
    if (r.collapsed) say('The wall gave way.');
    draw(); ui();
  });
  const setTool = (t) => { tool = t; root.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === t)); };
  function close() {
    removeEventListener('keydown', onKey, true);
    root.remove();
    if (onClose) onClose();
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.t) setTool(b.dataset.t);
    else if (b.dataset.a === 'new') fresh();
    else if (b.dataset.a === 'close') close();
  });
  // swallow every key while the overlay is up so the game behind it does not move or open its bag
  function onKey(e) {
    e.stopImmediatePropagation();
    if (e.code === 'Escape') { e.preventDefault(); close(); } else if (e.code === 'Digit1') setTool('pick'); else if (e.code === 'Digit2') setTool('hammer');
  }
  addEventListener('keydown', onKey, true);
  fresh();
}
