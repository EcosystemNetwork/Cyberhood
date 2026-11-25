/* ============================================================================
   kit.js: the gothic stone kit. Every built place (the chapel, the mausoleum, the undercroft)
   is assembled from these pieces, so they share one material language and one draw budget.

     const K = createKit(heightAt)
     K.wall(x0, z0, x1, z1, { h | top(u, L), t, holes, gaps })   elevation + arch holes, collision
     K.box(w, h, d, x, y, z, ry?, list?)      ashlar block
     K.column(x, z, h, { y, r, cluster })     moulded base, shaft (clustered or plain), capital
     K.drum(x, z, ry, y?)                     a fallen column drum
     K.buttress(x, z, side, h)                stepped buttress with a capped set-off
     K.vault(x0, x1, z0, z1, spring, rise)    barrel vault, inside surface (for interiors)
     K.rib(x, z, span, spring, rise)          transverse arch rib across a vault
     K.stairs(x, y, z, w, n, rise, run, dir)  a flight (dir: +1 climbs toward +z, -1 toward -z)
     K.sarcophagus(x, z, ry)                  chest tomb with a moulded lid
     K.build(M, parent)                       merge everything into two meshes (light/dark ashlar)

   Geometry is world-space; UVs are box-projected at build time (2.4 m per texture tile), so any
   piece takes the stone texture without unwrapping. Colliders are 2D: segments and circles.
   ============================================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---- deterministic noise (shared with world.js)
export function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function hash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, z, o = 4) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < o; i++) { s += a * (vnoise(x * f, z * f) * 2 - 1); a *= 0.5; f *= 2.03; } return s; }
export const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// box-projected UVs in world space (scale: metres per texture tile), for procedural stonework
export function boxUV(g, scale) {
  g = g.index ? g.toNonIndexed() : g;
  g.clearGroups();
  const p = g.attributes.position, uv = new Float32Array(p.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = p.getX(i + k), y = p.getY(i + k), z = p.getZ(i + k);
      const [u, v] = ay > ax && ay > az ? [x, z] : ax > az ? [z, y] : [x, y];
      uv[(i + k) * 2] = u / scale; uv[(i + k) * 2 + 1] = v / scale;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
// a gothic (equilateral) pointed arch as a path: x, y0 = bottom-left, w wide, springing at ys
export function archPath(x, y0, w, ys) {
  const p = new THREE.Path();
  p.moveTo(x, y0); p.lineTo(x + w, y0); p.lineTo(x + w, ys);
  p.absarc(x, ys, w, 0, Math.PI / 3, false);
  p.absarc(x + w, ys, w, (2 * Math.PI) / 3, Math.PI, false);
  p.lineTo(x, y0);
  return p;
}

// a pointed-arch moulding band, open at the foot (a door's "order"): w wide outside, band thick,
// springing at ys, centred on x = 0 and standing on y = 0. As one outline, not shape + hole: a
// hole that reaches the outline's edge is dropped by the triangulator and the door seals shut.
export function archRing(w, ys, band) {
  const s = new THREE.Shape(), a = -w / 2, b = w / 2, i = w - 2 * band;
  s.moveTo(a, 0); s.lineTo(a + band, 0); s.lineTo(a + band, ys);
  s.absarc(a + band + i, ys, i, Math.PI, (2 * Math.PI) / 3, true); // inner arch, left → apex
  s.absarc(a + band, ys, i, Math.PI / 3, 0, true);                // apex → right
  s.lineTo(b - band, 0); s.lineTo(b, 0); s.lineTo(b, ys);
  s.absarc(a, ys, w, 0, Math.PI / 3, false);                        // outer arch, right → apex
  s.absarc(b, ys, w, (2 * Math.PI) / 3, Math.PI, false);            // apex → left
  s.lineTo(a, 0);
  return s;
}

// push a circle (pos.x, pos.z, radius r) out of every collider; maxR: keep within that radius of the origin
export function makeCollide(colliders, maxR = Infinity) {
  const _p = new THREE.Vector2(), _d = new THREE.Vector2(), _ab = new THREE.Vector2();
  return function collide(pos, r) {
    _p.set(pos.x, pos.z);
    for (const c of colliders) {
      if (c.c) { _d.subVectors(_p, c.c); }
      else {
        _ab.subVectors(c.b, c.a);
        const t = Math.max(0, Math.min(1, _d.subVectors(_p, c.a).dot(_ab) / _ab.lengthSq()));
        _d.subVectors(_p, _ab.multiplyScalar(t).add(c.a));
      }
      const L = _d.length(), min = r + c.r;
      if (L < min && L > 1e-6) _p.addScaledVector(_d, (min - L) / L);
    }
    const rr = Math.hypot(_p.x, _p.y);
    if (rr > maxR) _p.multiplyScalar(maxR / rr);
    pos.x = _p.x; pos.z = _p.y;
  };
}

export function createKit(heightAt = () => 0) {
  const stone = [], stoneDark = [], colliders = [];
  const seg = (x0, z0, x1, z1, r) => colliders.push({ a: new THREE.Vector2(x0, z0), b: new THREE.Vector2(x1, z1), r });
  const circ = (x, z, r) => colliders.push({ c: new THREE.Vector2(x, z), r });
  const put = (g, list = stone) => { list.push(g); return g; };

  // a wall from (x0,z0) to (x1,z1): elevation shape with a (jagged) top, arch holes, extruded t thick.
  // y0: base height. clean: square courses, no lost blocks (interiors).
  function wall(x0, z0, x1, z1, { h, t = 0.9, top, holes = [], gaps = [], seed = 1, list, y0 = 0, clean = false, collide = true }) {
    const L = Math.hypot(x1 - x0, z1 - z0), rnd = rng(seed);
    const s = new THREE.Shape();
    // doorways (arches from the ground) are notches in the outline: a hole crossing the outline's
    // edge is dropped by the triangulator. Walked left to right: up the left jamb, over, down.
    s.moveTo(0, -0.4);
    for (const H of holes.filter((h) => !h.circle && h.y <= 0).sort((a, b) => a.u - b.u)) {
      s.lineTo(H.u, -0.4); s.lineTo(H.u, H.ys);
      s.absarc(H.u + H.w, H.ys, H.w, Math.PI, (2 * Math.PI) / 3, true);
      s.absarc(H.u, H.ys, H.w, Math.PI / 3, 0, true);
      s.lineTo(H.u + H.w, -0.4);
    }
    s.lineTo(L, -0.4);
    const steps = Math.max(2, Math.ceil(L / 0.45));
    for (let i = steps; i >= 0; i--) {
      const u = (i / steps) * L;
      let y = top ? top(u, L) : h;
      if (!clean) y = Math.max(0.3, Math.round((y - rnd() * 0.18) / 0.22) * 0.22); // lost blocks, a course at a time
      s.lineTo(u, y);
    }
    s.lineTo(0, -0.4);
    for (const H of holes.filter((h) => h.circle || h.y > 0)) s.holes.push(H.circle ? new THREE.Path().absarc(H.u, H.y, H.r, 0, Math.PI * 2, true) : archPath(H.u, H.y, H.w, H.ys));
    const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 10 });
    g.translate(0, y0, -t / 2);
    g.rotateY(Math.atan2(-(z1 - z0), x1 - x0));
    g.translate(x0, 0, z0);
    put(g, list);
    if (collide) { // the wall's line, minus doorways
      const dir = [(x1 - x0) / L, (z1 - z0) / L];
      let u0 = 0;
      for (const [ga, gb] of [...gaps, [L, L]]) {
        if (ga - u0 > 0.05) seg(x0 + dir[0] * u0, z0 + dir[1] * u0, x0 + dir[0] * ga, z0 + dir[1] * ga, t / 2);
        u0 = gb;
      }
    }
    return g;
  }
  const box = (w, h, d, x, y, z, ry = 0, list) => { const g = new THREE.BoxGeometry(w, h, d); g.rotateY(ry); g.translate(x, y, z); return put(g, list); };

  const PROF = [[0, 0], [0.5, 0], [0.5, 0.16], [0.42, 0.22], [0.42, 0.3], [0.34, 0.38], [0.32, 0.5]];
  // r scales the whole column; cluster: four engaged shafts (gothic) or one plain round shaft (romanesque)
  function column(x, z, h, { y = 0, r = 1, cluster = true, collide = true, list } = {}) {
    const pts = [...PROF, [0.3, h / r - 0.55], [0.36, h / r - 0.42], [0.46, h / r - 0.24], [0.52, h / r - 0.12], [0.52, h / r], [0, h / r]].map(([a, b]) => new THREE.Vector2(a * r, b * r));
    const g = new THREE.LatheGeometry(pts, 14); g.translate(x, y, z); put(g, list);
    if (cluster) for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4, sh = new THREE.CylinderGeometry(0.12 * r, 0.12 * r, h - 1.0 * r, 8);
      sh.translate(x + Math.cos(a) * 0.3 * r, y + 0.5 * r + (h - 1.0 * r) / 2, z + Math.sin(a) * 0.3 * r); put(sh, list);
    }
    if (collide) circ(x, z, 0.62 * r);
  }
  const drum = (x, z, ry, y = heightAt(x, z)) => { const g = new THREE.CylinderGeometry(0.33, 0.33, 0.95, 14); g.rotateZ(Math.PI / 2); g.rotateY(ry); g.translate(x, y + 0.3, z); put(g); circ(x, z, 0.55); };
  // side: which way it stands out from the wall, as a unit vector [sx, sz]
  function buttress(x, z, [sx, sz], h = 4.6) {
    const ry = Math.atan2(sx, sz);
    const b1 = new THREE.BoxGeometry(1.0, h, 0.75); b1.rotateY(ry); b1.translate(x, h / 2 - 0.3, z); put(b1);
    const b2 = new THREE.BoxGeometry(0.85, 1.6, 0.55); b2.rotateY(ry); b2.translate(x - sx * 0.08, h + 0.4, z - sz * 0.08); put(b2);
    const cap = new THREE.ConeGeometry(0.5, 0.9, 4); cap.rotateY(Math.PI / 4); cap.scale(1.15, 1, 0.85); cap.rotateY(ry); cap.translate(x - sx * 0.08, h + 1.65, z - sz * 0.08); put(cap);
    circ(x, z, 0.6);
  }
  // barrel vault (inside surface) over x0..x1, running z0..z1; elliptical: springs at `spring`, rises `rise`
  function vault(x0, x1, z0, z1, spring, rise, list) {
    const nu = 18, nz = Math.max(2, Math.round(Math.abs(z1 - z0) / 2)), pos = [], idx = [];
    const cx = (x0 + x1) / 2, rx = (x1 - x0) / 2;
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nz; j++) {
      const a = Math.PI * (i / nu);
      pos.push(cx + Math.cos(a) * rx, spring + Math.sin(a) * rise, z0 + (z1 - z0) * (j / nz));
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nz; j++) {
      const a = i * (nz + 1) + j, b = a + nz + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    if ((z1 - z0) < 0) { const ix = g.index.array; for (let k = 0; k < ix.length; k += 3) [ix[k + 1], ix[k + 2]] = [ix[k + 2], ix[k + 1]]; g.computeVertexNormals(); }
    return put(g, list);
  }
  // a transverse rib: a half-ring of square section under the vault, standing on two responds
  function rib(x, z, span, spring, rise, list = stoneDark) {
    const g = new THREE.TorusGeometry(span / 2, 0.14, 4, 20, Math.PI);
    g.rotateZ(0); g.scale(1, rise / (span / 2), 1.6); g.translate(x, spring, z);
    return put(g, list);
  }
  function stairs(x, y, z, w, n, rise, run, dir = 1, list = stoneDark) {
    for (let i = 0; i < n; i++) { const g = new THREE.BoxGeometry(w, rise * (i + 1), run); g.translate(x, y + (rise * (i + 1)) / 2, z + dir * (i + 0.5) * run); put(g, list); }
  }
  function sarcophagus(x, z, ry = 0, y = 0) {
    const parts = [new THREE.BoxGeometry(0.95, 0.7, 2.1).translate(0, 0.35, 0), new THREE.BoxGeometry(1.08, 0.1, 2.24).translate(0, 0.05, 0),
      new THREE.BoxGeometry(1.06, 0.12, 2.22).translate(0, 0.76, 0), new THREE.BoxGeometry(0.86, 0.12, 2.0).translate(0, 0.88, 0)];
    for (const p of parts) { p.rotateY(ry); p.translate(x, y, z); put(p, parts.indexOf(p) % 2 ? stoneDark : stone); }
    const c = Math.cos(ry), s = Math.sin(ry);
    seg(x - s * 0.9, z - c * 0.9, x + s * 0.9, z + c * 0.9, 0.55);
  }

  function build(M, parent) {
    const out = [];
    for (const [list, mat] of [[stone, M.stone], [stoneDark, M.stoneDark]]) {
      if (!list.length) continue;
      const m = new THREE.Mesh(mergeGeometries(list.map((g) => boxUV(g, 2.4))), mat);
      m.castShadow = m.receiveShadow = true;
      parent.add(m);
      out.push(m);
    }
    return out;
  }
  return { stone, stoneDark, colliders, seg, circ, put, wall, box, column, drum, buttress, vault, rib, stairs, sarcophagus, build };
}
