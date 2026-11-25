/* ============================================================================
   world.js: the Hollow Chapel, one dusk glade built to the showcase quality bar.

   Layout (metres; the hero is 1.55 m; -z is north):
     courtyard      cobbled disc r≈12 at the origin, ringed by a broken low wall, open to the
                    south (the road in) and the north (the chapel steps)
     chapel ruin    roofless gothic nave x∈[-5, 5], z∈[-30, -12]: a gabled west front with a
                    pointed-arch door and rose window, lancet side walls with buttresses, a
                    collapsed apse, a nave arcade of clustered columns, an altar with a spectral flame
     graveyard      east of the courtyard
     forest         dead oaks near, a ring of dark firs on the rising rim of the bowl

   Everything here is built from four CC0 PBR texture sets (assets/CREDITS.md) plus vertex
   colour, so the scene reads as one material language. Static stone is merged into one draw call;
   repeated props are InstancedMesh; trees swap hi/lo meshes by distance (InstancedLOD); grass is
   chunked so it frustum-culls, and thins out with distance by drawing fewer of its shuffled
   instances.
   ============================================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LOOK } from './render.js';
import { createKit, makeCollide, rng, fbm, sstep, boxUV, archRing } from './kit.js';

const A = new URL('./assets/', import.meta.url).href;

// ---- layout
export const LAYOUT = {
  court: 12, ring: 14.4,
  nave: { x0: -5, x1: 5, z0: -30, z1: -12 },
  statue: new THREE.Vector3(0, 0, -1.5),
  spawn: new THREE.Vector3(0, 0, 9),
  grave: { x0: 17, x1: 29, z0: -18, z1: -2 },
  mausoleum: { x0: 30, x1: 35, z0: -12.6, z1: -7.4 }, // the undercroft's way in: its door faces the graves (west)
  portal: new THREE.Vector3(30.1, 0, -10),
};
const N = LAYOUT.nave;
const pathX = (z) => Math.sin(z * 0.08) * 2.2;
function inRect(x, z, r, pad = 0) { return x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad; }
function rectDist(x, z, r) { const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1); return Math.hypot(dx, dz); }

export function heightAt(x, z) {
  const r = Math.hypot(x, z);
  let h = fbm(x * 0.045, z * 0.045) * 1.5 + fbm(x * 0.16 + 7, z * 0.16) * 0.22;
  const flat = Math.max(sstep(19, 13, r), sstep(6, 1.5, rectDist(x, z, N)), z > 0 ? sstep(4.5, 1.8, Math.abs(x - pathX(z))) * 0.85 : 0,
    sstep(5, 1, rectDist(x, z, LAYOUT.grave)) * 0.7, sstep(5, 1.5, rectDist(x, z, LAYOUT.mausoleum)));
  h *= 1 - flat;
  h += Math.min(13, Math.pow(Math.max(0, r - 36), 1.45) * 0.085) * (0.8 + 0.2 * fbm(x * 0.02, z * 0.02 + 5, 2)); // the bowl's rim, under the firs
  return h;
}
// 1 = cobbles, 0 = forest floor
function splatAt(x, z) {
  const r = Math.hypot(x, z), n = fbm(x * 0.3, z * 0.3, 3) * 0.5;
  let s = sstep(LAYOUT.court + 1.2, LAYOUT.court - 1.5, r + n * 2.2);
  if (inRect(x, z, { x0: N.x0 + 0.4, x1: N.x1 - 0.4, z0: N.z0 + 0.4, z1: N.z1 + 1.5 })) s = Math.max(s, 0.85 + n * 0.3);
  if (z > 0) s = Math.max(s, sstep(1.9, 0.6, Math.abs(x - pathX(z)) + n * 1.4) * sstep(46, 14, z) * 0.9);
  return Math.min(1, Math.max(0, s));
}

// ---- textures + materials
export function createMaterials(manager) {
  const TL = new THREE.TextureLoader(manager);
  const tex = (url, srgb) => {
    const t = TL.load(A + url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const set = (n) => ({ diff: tex(`tex/${n}_diff.webp`, true), nor: tex(`tex/${n}_nor.webp`), arm: tex(`tex/${n}_arm.webp`) });
  const T = { cobble: set('cobblestone_floor_08'), blocks: set('medieval_blocks_03'), ground: set('forrest_ground_01'), bark: set('bark_brown_02') };
  const env = LOOK.envIntensity;
  const pbr = (s, o = {}) => new THREE.MeshStandardMaterial({ map: s.diff, normalMap: s.nor, aoMap: s.arm, roughnessMap: s.arm, roughness: 1, metalness: 0, envMapIntensity: env, ...o });
  return {
    T,
    stone: pbr(T.blocks, { color: 0xd8d2c8, normalScale: new THREE.Vector2(1.1, 1.1) }),
    stoneDark: pbr(T.blocks, { color: 0x8f8a84 }),
    cobble: pbr(T.cobble),
    bark: pbr(T.bark, { color: 0x9a8f84 }),
    iron: new THREE.MeshStandardMaterial({ color: 0x2c2a29, roughness: 0.55, metalness: 1, envMapIntensity: env }),
    fir: new THREE.MeshStandardMaterial({ map: firBranchTexture(), alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true, roughness: 0.9, envMapIntensity: env * 0.55 }),
  };
}

// ---- geometry helpers
/* ============================================================================ */
export function buildWorld(R, M, models) {
  const { scene } = R;
  const root = new THREE.Group();
  scene.add(root);
  const K = createKit(heightAt); // the stone kit (kit.js): pieces + colliders
  const { colliders, circ } = K; // { a: Vector2, b: Vector2, r } segments, or { c: Vector2, r } circles
  const updaters = [];

  /* ---------------- terrain ---------------- */
  {
    const S = 190, n = 190;
    const g = new THREE.PlaneGeometry(S, S, n, n).rotateX(-Math.PI / 2);
    const p = g.attributes.position, splat = new Float32Array(p.count), col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), y = heightAt(x, z);
      p.setY(i, y);
      splat[i] = splatAt(x, z);
      // tint: moss in the hollows, dry leaf litter on rises, darker under the fir ring
      const m = fbm(x * 0.07 + 3, z * 0.07, 3), r = Math.hypot(x, z);
      const dark = 1 - sstep(30, 50, r) * 0.3;
      col.set([(0.92 + m * 0.12) * dark, (0.95 - m * 0.05) * dark, (0.9 - m * 0.08) * dark], i * 3);
    }
    g.setAttribute('splat', new THREE.BufferAttribute(splat, 1));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const T = M.T;
    const mat = new THREE.MeshStandardMaterial({ map: T.ground.diff, normalMap: T.ground.nor, roughnessMap: T.ground.arm, aoMap: T.ground.arm,
      roughness: 1, metalness: 0, vertexColors: true, envMapIntensity: LOOK.envIntensity });
    mat.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, { cDiff: { value: T.cobble.diff }, cNor: { value: T.cobble.nor }, cArm: { value: T.cobble.arm } });
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float splat;\nvarying float vSplat;\nvarying vec2 vXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat;\nvXZ = position.xz;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D cDiff, cNor, cArm;\nvarying float vSplat;\nvarying vec2 vXZ;')
        .replace('#include <map_fragment>', `
          vec2 uvF = vXZ / 3.4, uvC = vXZ / 2.3;
          vec4 dF = texture2D(map, uvF);
          dF.rgb = mix(dF.rgb, texture2D(map, vXZ / 12.7 + 0.37).rgb, 0.4);   // macro layer breaks up the tiling
          vec4 dC = texture2D(cDiff, uvC);
          float hC = dot(dC.rgb, vec3(0.333));                               // bright = stone tops; mortar gaps fill with soil first
          float splatS = smoothstep(0.4, 0.62, vSplat + (hC - 0.32) * 0.7);
          diffuseColor *= mix(dF, dC, splatS);`)
        .replace('#include <roughnessmap_fragment>', `
          vec4 armM = mix(texture2D(roughnessMap, uvF), texture2D(cArm, uvC), splatS);
          float roughnessFactor = roughness * armM.g;`)
        .replace('#include <normal_fragment_maps>', `
          mat3 tbnS = getTangentFrame(-vViewPosition, normal, uvF);
          vec3 mapN = normalize(mix(texture2D(normalMap, uvF).xyz * 2.0 - 1.0, texture2D(cNor, uvC).xyz * 2.0 - 1.0, splatS));
          mapN.xy *= normalScale;
          normal = normalize(tbnS * mapN);`)
        .replace('#include <aomap_fragment>', `
          float ambientOcclusion = (armM.r - 1.0) * aoMapIntensity + 1.0;
          reflectedLight.indirectDiffuse *= ambientOcclusion;`);
    };
    const terrain = new THREE.Mesh(g, mat);
    terrain.receiveShadow = true;
    root.add(terrain);
  }

  /* ---------------- stonework: everything merged into one stone mesh ---------------- */
  const { stoneDark, put, wall, box } = K;

  // -- west front (faces the courtyard, z = N.z1): gable, door, rose window, broken right shoulder
  const FW = N.x1 - N.x0;
  wall(N.x0, N.z1, N.x1, N.z1, {
    t: 1.1, seed: 3,
    top: (u) => { const gable = 8.6 + 4.2 * (1 - Math.abs(u - FW / 2) / (FW / 2)); return u > 6.6 ? Math.min(gable, 8.6 - (u - 6.6) * 1.1 + Math.sin(u * 5) * 0.4) : gable; },
    holes: [{ u: FW / 2 - 1.35, y: -0.5, w: 2.7, ys: 3.0 }, { circle: true, u: FW / 2, y: 7.25, r: 1.45 }],
    gaps: [[FW / 2 - 1.35, FW / 2 + 1.35]],
  });
  // door jamb mouldings: three receding orders of the arch
  for (let k = 1; k <= 3; k++) {
    const w = 2.7 + k * 0.62, s = archRing(w, 3.0, 0.31);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2, curveSegments: 14 });
    g.translate(0, 0, 0.5 + (3 - k) * 0.2);
    g.translate(0, 0, N.z1);
    put(g);
  }
  // string courses: horizontal mouldings that give the flat front its storeys
  // [y, x from, x to]: the upper one stops where the front's right shoulder has fallen
  // the lower one breaks around the door's outer order
  for (const [y, xa, xb] of [[4.55, N.x0 - 0.12, -2.35], [4.55, 2.35, N.x1 + 0.12], [8.1, N.x0 - 0.12, N.x0 + 6.3]]) {
    const w = xb - xa, cx = (xa + xb) / 2;
    const g = new THREE.BoxGeometry(w, 0.2, 0.3); g.translate(cx, y, N.z1 + 0.62); put(g, stoneDark);
    const g2 = new THREE.BoxGeometry(w, 0.1, 0.18); g2.translate(cx, y - 0.15, N.z1 + 0.58); put(g2, stoneDark);
  }
  // rose window tracery
  {
    const cy = 7.25, cz = N.z1;
    const ring = new THREE.TorusGeometry(1.42, 0.13, 8, 40); ring.translate(0, cy, cz); put(ring);
    const ring2 = new THREE.TorusGeometry(0.42, 0.1, 8, 24); ring2.translate(0, cy, cz); put(ring2);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, g = new THREE.BoxGeometry(0.11, 1.0, 0.2);
      g.translate(0, 0.92, 0); g.rotateZ(a); g.translate(0, cy, cz); put(g);
      const c = new THREE.TorusGeometry(0.3, 0.06, 6, 16); c.translate(Math.sin(-a + Math.PI / 8) * 0.98, cy + Math.cos(-a + Math.PI / 8) * 0.98, cz); put(c);
    }
  }
  // corner buttress towers with pinnacles
  for (const sx of [-1, 1]) {
    const x = sx > 0 ? N.x1 + 0.35 : N.x0 - 0.35, z = N.z1 + 0.2;
    box(1.7, 8.2, 1.7, x, 4.1 - 0.3, z);
    box(1.45, 2.6, 1.45, x, 9.0, z);
    if (sx < 0) { // the left one keeps its pinnacle
      const p = new THREE.ConeGeometry(0.9, 3.2, 4, 1); p.rotateY(Math.PI / 4); p.translate(x, 11.9, z); put(p);
      for (const [dx, dz] of [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]]) {
        const q = new THREE.ConeGeometry(0.16, 1.1, 4); q.translate(x + dx, 10.85, z + dz); put(q);
      }
    }
    circ(x, z, 1.05);
  }
  // -- side walls: lancets between buttresses, the east wall broken through mid-nave
  const bays = [-14.6, -18.6, -22.6, -26.6];
  for (const sx of [-1, 1]) {
    const x = sx < 0 ? N.x0 : N.x1, L = N.z1 - N.z0;
    wall(x, N.z1, x, N.z0, {
      t: 0.8, seed: 10 + sx,
      top: (u) => {
        let h = 6.4 + fbm(u * 0.4, sx * 9, 2) * 1.2;
        if (sx > 0) h -= 5.6 * sstep(6.2, 7.4, u) * sstep(11.6, 10.4, u); // the breach
        if (u > L - 4) h -= (u - (L - 4)) * 0.6;
        return h;
      },
      holes: bays.map((z) => ({ u: N.z1 - z - 0.6, y: 1.5, w: 1.2, ys: 3.6 })),
      gaps: sx > 0 ? [[7.0, 10.9]] : [],
    });
    for (const z of [-16.6, -20.6, -24.6, -28.6]) {
      if (sx > 0 && z > -23 && z < -18) continue;
      const bx = x + sx * 0.75;
      box(0.75, 4.6, 1.0, bx, 2.0, z); box(0.55, 1.6, 0.85, bx - sx * 0.08, 5.0, z);
      const cap = new THREE.ConeGeometry(0.5, 0.9, 4); cap.rotateY(Math.PI / 4); cap.scale(0.85, 1, 1.15); cap.translate(bx - sx * 0.08, 6.25, z); put(cap);
      circ(bx, z, 0.6);
    }
  }
  // -- apse: three low, broken walls
  const apse = [[N.x0, N.z0], [-2.8, N.z0 - 3.2], [2.8, N.z0 - 3.2], [N.x1, N.z0]];
  for (let i = 0; i < 3; i++) {
    const [ax, az] = apse[i], [bx, bz] = apse[i + 1];
    wall(ax, az, bx, bz, { t: 0.8, seed: 30 + i, top: (u, L) => 3.8 - i * 0.4 + Math.sin(u * 1.7 + i) * 1.1 - (i === 1 ? 2.2 * Math.sin((u / L) * Math.PI) : 0),
      holes: i === 1 ? [] : [{ u: 1.2, y: 1.4, w: 1.0, ys: 2.8 }] });
  }
  // -- nave arcade: clustered columns, some fallen
  {
    const column = (x, z, h) => K.column(x, z, h);
    const H = [6.3, 3.2, 6.3, 1.4, 4.4, 6.3, 2.2, 6.3];
    let i = 0;
    for (const z of [-15.6, -19.6, -23.6, -27.4]) for (const x of [-2.6, 2.6]) column(x, z, H[i++]);
    // fallen drums from the broken ones
    const drum = K.drum;
    drum(1.1, -19.0, 0.4); drum(-1.0, -23.4, 2.1); drum(0.4, -24.6, 1.2); drum(3.8, -21.0, 0.9);
  }
  // -- altar, and the chapel threshold
  box(2.4, 0.95, 1.1, 0, 0.475, -29.0); box(2.7, 0.12, 1.35, 0, 1.0, -29.0); box(3.4, 0.2, 2.2, 0, 0.1, -29.0, 0, stoneDark);
  circ(-0.7, -29, 0.8); circ(0.7, -29, 0.8);
  box(3.4, 0.16, 1.4, 0, 0.08, N.z1 + 0.8, 0, stoneDark);
  // -- courtyard ring wall: low and broken, open south (road) and north (chapel)
  {
    const R0 = LAYOUT.ring, rnd = rng(77);
    // arcs in radians from +x (z = sin a): gaps at +z (south, the road) and -z (north, the chapel)
    for (const [a0, a1] of [[0.18, 1.18], [1.95, 2.95], [-1.1, -0.18], [-2.95, -2.05]]) {
      const n = Math.max(2, Math.round(((a1 - a0) * R0) / 2.2));
      for (let i = 0; i < n; i++) {
        const t0 = a0 + ((a1 - a0) * i) / n, t1 = a0 + ((a1 - a0) * (i + 1)) / n;
        if (rnd() < 0.18) continue; // a missing stretch
        const h = 0.7 + rnd() * 0.7;
        wall(Math.cos(t0) * R0, Math.sin(t0) * R0, Math.cos(t1) * R0, Math.sin(t1) * R0, { t: 0.55, seed: 100 + i, top: (u) => h + Math.sin(u * 2.3 + i) * 0.25 });
        // coping stones
        const c = new THREE.BoxGeometry(Math.hypot(Math.cos(t1) - Math.cos(t0), Math.sin(t1) - Math.sin(t0)) * R0 * 0.9, 0.14, 0.7);
        c.rotateY(-((t0 + t1) / 2) - Math.PI / 2); c.translate(Math.cos((t0 + t1) / 2) * R0, h + 0.06, Math.sin((t0 + t1) / 2) * R0);
        if (rnd() > 0.4) put(c, stoneDark);
      }
    }
  }
  // -- the knight's plinth (the statue itself is the hero model in stone, added by main.js)
  {
    const S = LAYOUT.statue;
    box(2.6, 0.35, 2.6, S.x, 0.175, S.z, 0, stoneDark);
    box(2.0, 1.1, 2.0, S.x, 0.9, S.z);
    box(2.3, 0.18, 2.3, S.x, 1.5, S.z, 0, stoneDark);
    circ(S.x, S.z, 1.55);
  }

  buildMausoleum(K, root);
  K.build(M, root);

  /* ---------------- scattered stone: rubble, graves (instanced) ---------------- */
  const dummy = new THREE.Object3D();
  function instanced(geo, mat, xforms, { shadow = true } = {}) {
    const m = new THREE.InstancedMesh(geo, mat, xforms.length);
    xforms.forEach((f, i) => { dummy.position.copy(f.p); dummy.rotation.copy(f.r || new THREE.Euler()); dummy.scale.copy(f.s || new THREE.Vector3(1, 1, 1)); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); });
    m.castShadow = shadow; m.receiveShadow = true;
    m.computeBoundingSphere();
    root.add(m);
    return m;
  }
  {
    const rnd = rng(5), rub = [];
    const near = [[N.x1 + 1.5, -18.5, 3.5], [N.x0 - 1.4, -22, 2.5], [0, -31.8, 2.6], [5.6, -13.5, 1.6], [N.x1 + 2.6, -20, 3]];
    for (const [cx, cz, sp] of near) for (let i = 0; i < 9; i++) {
      const x = cx + (rnd() - 0.5) * sp * 2, z = cz + (rnd() - 0.5) * sp * 2, s = 0.45 + rnd() * 0.5;
      rub.push({ p: new THREE.Vector3(x, heightAt(x, z) + s * 0.2, z), r: new THREE.Euler(rnd() * 0.5, rnd() * 3, rnd() * 0.5), s: new THREE.Vector3(s * (1 + rnd() * 0.8), s * 0.7, s) });
    }
    instanced(boxUV(new RoundedBoxGeometry(0.9, 0.55, 0.6, 2, 0.06), 2.4), M.stone, rub);

    // graveyard: headstones, crosses, a few sunk and leaning
    const G = LAYOUT.grave, heads = [], crosses = [];
    for (let row = 0; row < 4; row++) for (let k = 0; k < 6; k++) {
      if (rnd() < 0.2) continue;
      const x = G.x0 + 1 + k * 2.0 + (rnd() - 0.5) * 0.5, z = G.z0 + 1.5 + row * 3.6 + (rnd() - 0.5) * 0.6;
      const f = { p: new THREE.Vector3(x, heightAt(x, z) - 0.08 - rnd() * 0.12, z), r: new THREE.Euler((rnd() - 0.5) * 0.25, Math.PI / 2 + (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.2), s: new THREE.Vector3(1, 0.85 + rnd() * 0.4, 1) };
      (rnd() < 0.3 ? crosses : heads).push(f);
      circ(x, z, 0.4);
    }
    const hs = new THREE.Shape(); hs.moveTo(-0.32, 0); hs.lineTo(0.32, 0); hs.lineTo(0.32, 0.72); hs.absarc(0, 0.72, 0.32, 0, Math.PI, false); hs.lineTo(-0.32, 0);
    const hg = new THREE.ExtrudeGeometry(hs, { depth: 0.14, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 2 }); hg.translate(0, 0, -0.07);
    instanced(boxUV(hg, 1.6), M.stoneDark, heads);
    const cg = mergeGeometries([new THREE.BoxGeometry(0.16, 1.35, 0.16).translate(0, 0.67, 0), new THREE.BoxGeometry(0.66, 0.16, 0.16).translate(0, 0.98, 0), new THREE.BoxGeometry(0.4, 0.14, 0.4).translate(0, 0.07, 0)].map((g) => g.toNonIndexed()));
    instanced(boxUV(cg, 1.6), M.stone, crosses);
  }

  /* ---------------- trees: procedural, instanced, hi/lo LOD ---------------- */
  const lods = [];
  {
    const deadHi = [0, 1, 2].map((s) => deadTree(s + 11, 4)), deadLo = [0, 1, 2].map((s) => deadTree(s + 11, 2));
    const firHi = [0, 1].map((s) => firTree(s + 3, true)), firLo = [0, 1].map((s) => firTree(s + 3, false));
    const rnd = rng(21), dead = [[], [], []], fir = [[], []];
    const ok = (x, z, pad) => Math.hypot(x, z) > LAYOUT.ring + 3 + pad && rectDist(x, z, N) > 3 + pad && !(z > 0 && Math.abs(x - pathX(z)) < 4) && rectDist(x, z, LAYOUT.grave) > 1.5 && rectDist(x, z, LAYOUT.mausoleum) > 4 + pad;
    for (let i = 0; i < 900 && dead.flat().length < 34; i++) {
      const a = rnd() * Math.PI * 2, r = 18 + rnd() * 22, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!ok(x, z, 0)) continue;
      const s = 0.8 + rnd() * 0.5;
      dead[i % 3].push({ p: new THREE.Vector3(x, heightAt(x, z) - 0.1, z), r: new THREE.Euler(0, rnd() * 6.3, 0), s: new THREE.Vector3(s, s, s) });
      circ(x, z, 0.45 * s);
    }
    for (let i = 0; i < 12000 && fir.flat().length < 900; i++) {
      const a = rnd() * Math.PI * 2, r = 29 + Math.pow(rnd(), 0.8) * 64, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!ok(x, z, 6) || fbm(x * 0.05, z * 0.05) < -0.25) continue;
      const s = 0.85 + rnd() * 0.75;
      fir[i % 2].push({ p: new THREE.Vector3(x, heightAt(x, z) - 0.2, z), r: new THREE.Euler(0, rnd() * 6.3, 0), s: new THREE.Vector3(s, s * (0.9 + rnd() * 0.3), s) });
      if (r < 40) circ(x, z, 0.5 * s);
    }
    dead.forEach((list, k) => lods.push(new InstancedLOD(root, deadHi[k], deadLo[k], M.bark, list, 30)));
    fir.forEach((list, k) => lods.push(new InstancedLOD(root, firHi[k], firLo[k], M.fir, list, 55)));
    for (const l of lods.slice(-2)) { R.noAO.add(l.hi); R.noAO.add(l.lo); } // alpha cards: AO's normal pass would see solid quads
  }

  /* ---------------- CC0 models: rocks, ferns, a fallen trunk ---------------- */
  {
    const rnd = rng(9);
    const subMeshes = (gltf) => { const out = []; gltf.scene.updateMatrixWorld(true); gltf.scene.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };
    const envFix = (m) => { m.envMapIntensity = LOOK.envIntensity; return m; };
    // rocks: each piece of the set, scattered and half-buried
    const rocks = subMeshes(models.rocks);
    rocks.forEach((src, k) => {
      const list = [];
      for (let i = 0; i < 40 && list.length < 6; i++) {
        const a = rnd() * Math.PI * 2, r = 15 + rnd() * 26, x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (rectDist(x, z, N) < 3 || (z > 0 && Math.abs(x - pathX(z)) < 3) || rectDist(x, z, LAYOUT.grave) < 1 || rectDist(x, z, LAYOUT.mausoleum) < 2) continue;
        const s = 0.7 + rnd() * 1.4;
        list.push({ p: new THREE.Vector3(x, heightAt(x, z) - 0.15 * s, z), r: new THREE.Euler(0, rnd() * 6.3, 0), s: new THREE.Vector3(s, s, s) });
        circ(x, z, 0.6 * s);
      }
      const g = src.geometry.clone().applyMatrix4(src.matrixWorld);
      instanced(g, envFix(src.material), list);
    });
    // ferns: the forest edge and the foot of walls
    const ferns = subMeshes(models.fern), fl = [];
    for (let i = 0; i < 3000 && fl.length < 260; i++) {
      const a = rnd() * Math.PI * 2, r = 12.5 + Math.pow(rnd(), 0.8) * 30, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (splatAt(x, z) > 0.25 || rectDist(x, z, N) < 0.6 || (z > 0 && Math.abs(x - pathX(z)) < 2.4) || fbm(x * 0.12, z * 0.12) < -0.05) continue;
      if (rectDist(x, z, LAYOUT.grave) < 0.5 || rectDist(x, z, LAYOUT.mausoleum) < 1) continue;
      const s = 0.6 + rnd() * 0.7;
      fl.push({ p: new THREE.Vector3(x, heightAt(x, z), z), r: new THREE.Euler(0, rnd() * 6.3, 0), s: new THREE.Vector3(s, s, s) });
    }
    for (const f of ferns) { const m = f.material; m.alphaTest = Math.max(m.alphaTest || 0, 0.45); m.side = THREE.DoubleSide; R.noAO.add(instanced(f.geometry.clone().applyMatrix4(f.matrixWorld), envFix(m), fl, { shadow: false })); }
    // fallen trunks
    for (const [x, z, ry] of [[-17, 6, 0.6], [12.5, -26, 2.2]]) {
      const t = models.trunk.scene.clone();
      t.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; envFix(o.material); } });
      t.position.set(x, heightAt(x, z) - 0.1, z); t.rotation.y = ry;
      root.add(t);
      circ(x, z, 1.2);
    }
  }

  /* ---------------- grass: chunked instanced tufts, wind, pushed aside by the player ---------------- */
  const grass = buildGrass(root, R, (x, z) => {
    if (splatAt(x, z) > 0.22 || Math.hypot(x, z) > 62 || rectDist(x, z, N) < 0.5 || rectDist(x, z, LAYOUT.mausoleum) < 0.3) return 0;
    const n = fbm(x * 0.09, z * 0.09, 3);
    return Math.min(1, Math.max(0, 0.55 + n * 1.3)) * (1 - sstep(48, 62, Math.hypot(x, z)));
  });

  /* ---------------- fire: braziers, altar flame, embers, glow ---------------- */
  const fires = [];
  const brazier = (x, z, light) => {
    const y = heightAt(x, z), g = new THREE.Group();
    g.position.set(x, y, z);
    const bowl = new THREE.LatheGeometry([[0, 0.78], [0.28, 0.8], [0.4, 0.92], [0.44, 1.08], [0.4, 1.1], [0.35, 0.96], [0, 0.94]].map(([r, h]) => new THREE.Vector2(r, h)), 16);
    const parts = [bowl, new THREE.CylinderGeometry(0.06, 0.09, 0.08, 10).translate(0, 0.76, 0)];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2, leg = new THREE.CylinderGeometry(0.025, 0.03, 0.95, 6);
      leg.translate(0, 0.47, 0); leg.rotateZ(0.22); leg.rotateY(a); parts.push(leg);
    }
    const iron = new THREE.Mesh(mergeGeometries(parts.map((p) => p.index ? p.toNonIndexed() : p).map((p) => { for (const k of Object.keys(p.attributes)) if (!['position', 'normal'].includes(k)) p.deleteAttribute(k); return p; })), M.iron);
    iron.castShadow = true; g.add(iron);
    const coals = new THREE.Mesh(new THREE.CircleGeometry(0.36, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.55, 0.12) }));
    coals.position.y = 1.0; g.add(coals);
    const f = makeFire({ color: 'warm', scale: 1 });
    f.position.y = 0.98; g.add(f);
    root.add(g);
    fires.push({ fire: f, light: null, pos: new THREE.Vector3(x, y + 1.5, z), base: 0 });
    circ(x, z, 0.45);
    if (light) addLight(fires.at(-1), 0xff8a3a, 22, 9);
  };
  const lights = [];
  function addLight(f, color, intensity, dist) {
    if (lights.length >= R.q.lights) return;
    const l = new THREE.PointLight(color, intensity, dist, 2);
    l.position.copy(f.pos);
    root.add(l);
    f.light = l; f.base = intensity;
    lights.push(l);
  }
  brazier(-2.6, N.z1 + 2.1, true); brazier(2.6, N.z1 + 2.1, true);
  brazier(-6.8, 5.8, false); brazier(6.8, 5.8, false);
  brazier(-9.4, -5.5, false); brazier(9.4, -5.5, true);
  // altar: a cold spectral flame and candles
  {
    const f = makeFire({ color: 'spirit', scale: 0.9 });
    f.position.set(0, 1.06, -29.0); root.add(f);
    fires.push({ fire: f, light: null, pos: new THREE.Vector3(0, 1.9, -28.6), base: 0 });
    addLight(fires.at(-1), 0x6fa8ff, 30, 11);
    const rnd = rng(4), candles = [], flames = [];
    for (let i = 0; i < 14; i++) {
      const x = (rnd() - 0.5) * 2.2, z = -29.0 + (rnd() - 0.5) * 0.8 + (rnd() < 0.5 ? 0.9 : -0.9) * (i > 7 ? 1 : 0);
      const h = 0.12 + rnd() * 0.22, y = (Math.abs(z + 29) < 0.6 && Math.abs(x) < 1.3 ? 1.06 : 0.2);
      candles.push({ p: new THREE.Vector3(x, y + h / 2, z), s: new THREE.Vector3(1, h / 0.3, 1) });
      flames.push({ p: new THREE.Vector3(x, y + h + 0.035, z) });
    }
    instanced(new THREE.CylinderGeometry(0.025, 0.028, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0xd9ccb0, roughness: 0.6, envMapIntensity: LOOK.envIntensity }), candles, { shadow: false });
    const fl = instanced(new THREE.SphereGeometry(0.018, 6, 4).scale(1, 2.2, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.6, 0.9) }), flames, { shadow: false });
    R.noAO.add(fl);
  }
  // embers + spirit motes + fireflies: one points system each, all additive HDR
  const embers = makeParticles(root, R, 'ember', fires.filter((f) => f.fire.userData.kind === 'warm').map((f) => f.pos), 220);
  const motes = makeParticles(root, R, 'firefly', null, 140);
  for (const f of fires) R.noAO.add(f.fire);
  R.noAO.add(embers.points); R.noAO.add(motes.points);

  /* ---------------- per frame ---------------- */
  let lodT = 0;
  function update(dt, t, camera, player) {
    grass.update(t, camera, player);
    for (const f of fires) {
      f.fire.userData.u.uTime.value = t;
      if (f.light) f.light.intensity = f.base * (0.82 + 0.12 * Math.sin(t * 11 + f.pos.x) + 0.08 * Math.sin(t * 23.7 + f.pos.z) + 0.06 * Math.sin(t * 5.3));
    }
    embers.update(dt, t); motes.update(dt, t);
    if ((lodT -= dt) <= 0) { lodT = 0.25; for (const l of lods) l.update(camera.position); }
  }

  const collide = makeCollide(colliders, 44); // 44: the edge of the glade

  return { root, heightAt, collide, update, colliders, lights, fires, grass, lods, noAO: R.noAO };
}

/* ---------------- the mausoleum: a gabled tomb house, its dark door the way down ---------------- */
function buildMausoleum(K, root) {
  const { x0, x1, z0, z1 } = LAYOUT.mausoleum, cz = (z0 + z1) / 2, D = z1 - z0, y0 = heightAt((x0 + x1) / 2, cz) - 0.15;
  const H = 3.4, G = 1.7; // eaves height, gable rise
  const gable = (u, L) => H + G * (1 - Math.abs(u - L / 2) / (L / 2));
  K.wall(x0, z1, x0, z0, { t: 0.55, y0, clean: true, top: gable, holes: [{ u: D / 2 - 0.75, y: -0.5, w: 1.5, ys: 1.95 }], gaps: [[D / 2 - 0.75, D / 2 + 0.75]] });
  K.wall(x1, z0, x1, z1, { t: 0.55, y0, clean: true, top: gable, holes: [{ circle: true, u: D / 2, y: H + 0.55, r: 0.42 }] });
  K.wall(x0, z0, x1, z0, { t: 0.55, y0, clean: true, h: H });
  K.wall(x1, z1, x0, z1, { t: 0.55, y0, clean: true, h: H });
  // the door's two receding orders
  for (let k = 1; k <= 2; k++) {
    const w = 1.5 + k * 0.44, s = archRing(w, 1.95, 0.22);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1, curveSegments: 12 });
    g.rotateY(-Math.PI / 2); g.translate(x0 - 0.28 - (2 - k) * 0.15, y0, cz);
    K.put(g, K.stoneDark);
  }
  // pitched roof, ridge running east-west, with a coping ridge
  const pitch = Math.atan2(G, D / 2), slab = Math.hypot(G, D / 2) + 0.35;
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(x1 - x0 + 0.7, 0.2, slab);
    g.rotateX(s * pitch); g.translate((x0 + x1) / 2, y0 + H + G / 2 + 0.12, cz + s * (D / 4 + 0.05));
    K.put(g, K.stoneDark);
  }
  K.box(x1 - x0 + 0.8, 0.22, 0.3, (x0 + x1) / 2, y0 + H + G + 0.18, cz, 0, K.stoneDark);
  // corner buttresses with pinnacles, a plinth course, and a cross on the west gable
  for (const [x, z] of [[x0, z0], [x0, z1], [x1, z0], [x1, z1]]) {
    K.box(0.7, H + 0.4, 0.7, x, y0 + (H + 0.4) / 2 - 0.2, z);
    const p = new THREE.ConeGeometry(0.42, 1.3, 4); p.rotateY(Math.PI / 4); p.translate(x, y0 + H + 0.85, z); K.put(p);
    K.circ(x, z, 0.5);
  }
  K.box(x1 - x0 + 0.5, 0.35, D + 0.5, (x0 + x1) / 2, y0 + 0.02, cz, 0, K.stoneDark);
  K.box(0.16, 1.0, 0.16, x0 - 0.1, y0 + H + G + 0.6, cz); K.box(0.16, 0.16, 0.6, x0 - 0.1, y0 + H + G + 0.75, cz);
  K.circ((x0 + x1) / 2 + 0.6, cz, 2.1); // the inside is the stairwell: you only get as far as the door
  // darkness past the door: the stair going down
  const dark = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.7, H - 0.2, D - 0.7), new THREE.MeshBasicMaterial({ color: 0x020203 }));
  dark.position.set((x0 + x1) / 2, y0 + (H - 0.2) / 2, cz);
  root.add(dark);
}

/* ============================================================================
   InstancedLOD: N placements of one prop, drawn as two InstancedMeshes (hi near / lo far),
   re-sorted a few times a second. Keeps the instancing win and still drops detail with distance.
   ============================================================================ */
class InstancedLOD {
  constructor(parent, hiGeo, loGeo, mat, xforms, dist) {
    this.mats = xforms.map((f) => new THREE.Matrix4().compose(f.p, new THREE.Quaternion().setFromEuler(f.r), f.s));
    this.pos = xforms.map((f) => f.p);
    this.dist2 = dist * dist;
    this.hi = new THREE.InstancedMesh(hiGeo, mat, xforms.length);
    this.lo = new THREE.InstancedMesh(loGeo, mat, xforms.length);
    for (const m of [this.hi, this.lo]) { m.castShadow = true; m.receiveShadow = true; m.count = 0; parent.add(m); }
    this.lo.castShadow = false; // far trees are past the shadow map anyway
  }
  update(cam) {
    let h = 0, l = 0;
    for (let i = 0; i < this.mats.length; i++) {
      const p = this.pos[i], d2 = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2;
      if (d2 < this.dist2) this.hi.setMatrixAt(h++, this.mats[i]); else this.lo.setMatrixAt(l++, this.mats[i]);
    }
    this.hi.count = h; this.lo.count = l;
    for (const m of [this.hi, this.lo]) { m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); }
  }
}

/* ---------------- procedural trees ---------------- */
// a tapered tube along a curve (radius r0 → r1), bark UVs in metres
function taperTube(curve, r0, r1, radial, rings, flare = 0, seed = 0) {
  const frames = curve.computeFrenetFrames(rings, false), pos = [], nor = [], uv = [], idx = [];
  const len = curve.getLength(), circ = Math.max(1, Math.round((Math.PI * 2 * r0) / 0.7));
  for (let i = 0; i <= rings; i++) {
    const t = i / rings, c = curve.getPointAt(t), N = frames.normals[i], B = frames.binormals[i];
    let r = r0 + (r1 - r0) * t;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      let rr = r;
      if (flare && t < 0.12) rr *= 1 + flare * Math.pow(1 - t / 0.12, 2) * (0.6 + 0.4 * Math.sin(a * 5 + seed)); // root buttresses
      const n = new THREE.Vector3().addScaledVector(N, Math.cos(a)).addScaledVector(B, Math.sin(a)).normalize();
      pos.push(c.x + n.x * rr, c.y + n.y * rr, c.z + n.z * rr);
      nor.push(n.x, n.y, n.z);
      uv.push((j / radial) * circ, (t * len) / 1.6);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
function deadTree(seed, depthMax) {
  const rnd = rng(seed * 7919), parts = [];
  const grow = (from, dir, len, r, depth) => {
    const pts = [from.clone()], n = 4;
    const d = dir.clone();
    for (let i = 1; i <= n; i++) {
      d.add(new THREE.Vector3((rnd() - 0.5) * 0.5, (rnd() - 0.3) * 0.25, (rnd() - 0.5) * 0.5)).normalize();
      pts.push(pts[i - 1].clone().addScaledVector(d, len / n));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const radial = [9, 7, 5, 4, 3][depth] ?? 3, r1 = r * 0.45;
    parts.push(taperTube(curve, r, r1, depthMax <= 2 ? Math.max(3, radial - 3) : radial, depth === 0 ? 10 : 6, depth === 0 ? 0.9 : 0, seed));
    if (depth >= depthMax) return;
    const kids = depth === 0 ? 3 + Math.floor(rnd() * 2) : 2 + Math.floor(rnd() * 2);
    for (let k = 0; k < kids; k++) {
      const t = 0.42 + rnd() * 0.5, p = curve.getPointAt(t), tan = curve.getTangentAt(t);
      const side = new THREE.Vector3(rnd() - 0.5, 0, rnd() - 0.5).normalize();
      const nd = tan.clone().multiplyScalar(0.65).addScaledVector(side, 0.75 + rnd() * 0.4).add(new THREE.Vector3(0, 0.15 + rnd() * 0.25, 0)).normalize();
      grow(p, nd, len * (0.5 + rnd() * 0.2), (r + (r1 - r) * t) * 0.62, depth + 1);
    }
  };
  grow(new THREE.Vector3(0, -0.2, 0), new THREE.Vector3((rnd() - 0.5) * 0.2, 1, (rnd() - 0.5) * 0.2).normalize(), 4.2 + rnd() * 2.5, 0.32, 0);
  return mergeGeometries(parts);
}
// fir: a trunk, a dark inner cone for density, and tiers of drooping branch cards (alpha-cut
// needle texture painted in firBranchTexture). Card normals lean outward and up, so the crown
// shades like a soft volume instead of flat cards.
const FIR_H = 13;
function firTree(seed, hi) {
  const rnd = rng(seed * 104729), pos = [], nor = [], uv = [], col = [], idx = [];
  const tiers = hi ? 12 : 8, cards = hi ? 7 : 5;
  const quad = (verts) => { // verts: [[p, n, uv, c] x (rows*2)], rows of 2
    const base = pos.length / 3;
    for (const [p, n, t, c] of verts) { pos.push(...p); nor.push(...n); uv.push(...t); col.push(c, c, c); }
    for (let r = 0; r < verts.length / 2 - 1; r++) { const i = base + r * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
  };
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1), y = 1.7 + t * (FIR_H - 2.6), L = Math.pow(1 - t, 0.85) * 3.3 + 0.45;
    const shade = 0.55 + 0.45 * t;
    for (let c = 0; c < cards; c++) {
      const a = (c / cards) * Math.PI * 2 + k * 2.39 + rnd() * 0.5, droop = 0.25 + rnd() * 0.25 + (1 - t) * 0.15;
      const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
      const W = L * (0.5 + rnd() * 0.15);
      // two cards per branch, crossed about its length (rolled ±50°), so it has area from any side
      for (const roll of [0.85 + (rnd() - 0.5) * 0.3, -0.85 + (rnd() - 0.5) * 0.3]) {
        const cr = Math.cos(roll), sr = Math.sin(roll), rows = [];
        for (let r = 0; r <= 2; r++) {
          const f = r / 2, along = L * f, drop = along * droop + f * f * L * 0.18;
          const cx = dx * along, cz = dz * along, cy = y - drop;
          const n = [dx * 0.55, 0.85, dz * 0.55];
          for (const side of [-0.5, 0.5]) {
            const sw = side * W * (1 - f * 0.35);
            rows.push([[cx + px * sw * cr, cy + sw * sr, cz + pz * sw * cr], n, [0.07 + f * 0.91, side + 0.5], shade * (0.42 + 0.58 * f)]);
          }
        }
        quad(rows);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  // trunk and the dark core, textured from the opaque bark swatch in the texture's corner
  const solid = (geo, rgb) => {
    const u = geo.attributes.uv, c = new Float32Array(u.count * 3);
    for (let i = 0; i < u.count; i++) { u.setXY(i, 0.005 + u.getX(i) * 0.04, 0.89 + u.getY(i) * 0.1); c.set(rgb, i * 3); }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo.toNonIndexed();
  };
  const parts = [g.toNonIndexed(), solid(new THREE.CylinderGeometry(0.1, 0.32, FIR_H * 0.96, hi ? 8 : 5).translate(0, FIR_H * 0.48, 0), [0.8, 0.8, 0.8])];
  // a narrow dark-green core so the crown never shows sky straight through the trunk
  parts.push(solid(new THREE.ConeGeometry(0.75, FIR_H - 3.5, hi ? 7 : 5, 1, true).translate(0, 2.4 + (FIR_H - 3.5) / 2, 0), [0.16, 0.3, 0.18]));
  return mergeGeometries(parts);
}
// the needle texture: a bark swatch (top-left), then one fir branch with side twigs and needles,
// drawn over a soft leaf mass so the card keeps its silhouette in the small mip levels
export function firBranchTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d'), rnd = rng(7);
  g.fillStyle = '#3b2e25'; g.fillRect(0, 0, 28, 28);
  for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(20,14,10,${0.3 + rnd() * 0.4})`; g.fillRect(rnd() * 28, rnd() * 28, 1 + rnd() * 2, 4 + rnd() * 8); }
  const twigs = [];
  const main = (x) => 128 + (x / 512) ** 2 * 18; // the branch droops a little toward its tip
  for (let x = 50; x < 490; x += 14 + rnd() * 8) {
    const side = twigs.length % 2 ? 1 : -1, len = (1 - x / 520) * 95 + 15;
    const ang = side * (0.75 + rnd() * 0.3);
    twigs.push({ x, y: main(x), dx: Math.cos(ang * 0.6) * len, dy: Math.sin(ang) * len * 0.9 });
  }
  // leaf mass
  g.fillStyle = 'rgba(22, 34, 22, 0.92)';
  g.beginPath(); g.moveTo(40, 128);
  for (const t of twigs) g.lineTo(t.x + t.dx * 0.8, t.y + t.dy * 0.75);
  g.lineTo(505, main(505)); g.closePath(); g.fill();
  const needle = (x, y, ang, len, light) => {
    const k = light ? 30 + rnd() * 30 : rnd() * 18;
    g.strokeStyle = `rgb(${24 + k}, ${40 + k * 1.3}, ${26 + k * 0.6})`;
    g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); g.stroke();
  };
  for (const t of twigs) {
    g.strokeStyle = '#2e241c'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(t.x, t.y); g.lineTo(t.x + t.dx, t.y + t.dy); g.stroke();
    const steps = 18, base = Math.atan2(t.dy, t.dx);
    for (let i = 0; i < steps; i++) {
      const f = i / steps, x = t.x + t.dx * f, y = t.y + t.dy * f, len = 9 + rnd() * 7 * (1 - f * 0.5);
      needle(x, y, base - 1.0 - rnd() * 0.3, len, f > 0.6); needle(x, y, base + 1.0 + rnd() * 0.3, len, f > 0.6);
    }
  }
  g.strokeStyle = '#33271e'; g.lineWidth = 5;
  g.beginPath(); g.moveTo(30, 128); for (let x = 30; x < 505; x += 10) g.lineTo(x, main(x)); g.stroke();
  for (let x = 40; x < 500; x += 3) { const y = main(x); needle(x, y, -1.2 - rnd() * 0.5, 10 + rnd() * 6, x > 380); needle(x, y, 1.2 + rnd() * 0.5, 10 + rnd() * 6, x > 380); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* ---------------- grass ---------------- */
function buildGrass(parent, R, density) {
  // one tuft: 6 curved blades, 4 segments each; uv.y = height along the blade (0 root → 1 tip)
  const pos = [], nor = [], col = [], uv = [], idx = [];
  const rnd = rng(42);
  for (let b = 0; b < 6; b++) {
    const a = rnd() * Math.PI * 2, ox = Math.cos(a) * 0.09 * rnd(), oz = Math.sin(a) * 0.09 * rnd();
    const h = 0.32 + rnd() * 0.36, w = 0.024 + rnd() * 0.014, lean = 0.12 + rnd() * 0.22, face = rnd() * Math.PI;
    const dx = Math.cos(face), dz = Math.sin(face), bx = Math.cos(a), bz = Math.sin(a);
    const dry = rnd() < 0.3;
    const base = pos.length / 3;
    for (let s = 0; s <= 4; s++) {
      const t = s / 4, y = h * t, off = lean * t * t, ww = w * (1 - t * 0.85);
      for (const side of [-1, 1]) {
        pos.push(ox + bx * off + dx * ww * side, y, oz + bz * off + dz * ww * side);
        nor.push(bx * 0.35, 1, bz * 0.35);
        const c = dry ? [0.32 + t * 0.32, 0.27 + t * 0.24, 0.12 + t * 0.08] : [0.1 + t * 0.26, 0.14 + t * 0.3, 0.05 + t * 0.09];
        col.push(...c);
        uv.push(side * 0.5 + 0.5, t);
      }
    }
    for (let s = 0; s < 4; s++) { const i = base + s * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.normalizeNormals();

  const U = { uTime: { value: 0 }, uPlayer: { value: new THREE.Vector3(0, -99, 0) }, uFar: { value: 52 } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, side: THREE.DoubleSide, envMapIntensity: LOOK.envIntensity * 0.7 });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime, uFar;\nuniform vec3 uPlayer;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float hgt = uv.y;
          vec3 wp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;   // tuft root, world
          float gust = sin(uTime * 0.9 + wp.x * 0.11 + wp.z * 0.07) * 0.5 + 0.5;
          vec3 wind = vec3(1.0, 0.0, 0.35) * (sin(uTime * 2.1 + wp.x * 0.6 + wp.z * 0.4) * 0.6 + gust * 0.9) * 0.16;
          vec2 away = wp.xz - uPlayer.xz;
          float near = 1.0 - smoothstep(0.2, 1.1, length(away));
          wind.xz += normalize(away + 1e-4) * near * 0.55;
          wind.y -= near * 0.2;
          mat3 im = mat3(instanceMatrix);
          float sc = length(im[0]);
          transformed += transpose(im) * (wind * hgt * hgt) / (sc * sc);
          float fade = 1.0 - smoothstep(uFar * 0.72, uFar, distance(wp.xz, cameraPosition.xz));
          transformed *= fade;
        }`);
  };

  // chunks of 14 m; instances shuffled so drawing the first n of them is an even thinning
  const C = 14, chunks = [], dummy = new THREE.Object3D(), rnd2 = rng(1234);
  const perM2 = 8 * R.q.grass;
  for (let cx = -65; cx < 65; cx += C) for (let cz = -65; cz < 65; cz += C) {
    const list = [];
    const tries = Math.round(C * C * perM2 * 1.6);
    for (let i = 0; i < tries; i++) {
      const x = cx + rnd2() * C, z = cz + rnd2() * C, d = density(x, z);
      if (d <= 0 || rnd2() > d * 0.62) continue;
      list.push([x, z]);
    }
    if (!list.length) continue;
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([x, z], i) => {
      const s = 0.7 + rnd2() * 0.65;
      dummy.position.set(x, heightAt(x, z) - 0.02, z); dummy.rotation.set(0, rnd2() * 6.28, 0); dummy.scale.set(s, s * (0.8 + rnd2() * 0.5), s);
      dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix);
    });
    m.receiveShadow = true; m.castShadow = false;
    m.computeBoundingSphere();
    m.userData.full = list.length;
    m.userData.center = new THREE.Vector3(cx + C / 2, 0, cz + C / 2);
    parent.add(m);
    R.noAO.add(m);
    chunks.push(m);
  }
  return {
    chunks, count: () => chunks.reduce((s, m) => s + (m.visible ? m.count : 0), 0),
    update(t, camera, player) {
      U.uTime.value = t;
      if (player) U.uPlayer.value.copy(player);
      const cp = camera.position;
      for (const m of chunks) {
        const d = Math.hypot(m.userData.center.x - cp.x, m.userData.center.z - cp.z);
        m.visible = d < U.uFar.value + 8;
        m.count = Math.max(1, Math.round(m.userData.full * (d < 18 ? 1 : d < 32 ? 0.45 : 0.18)));
      }
    },
  };
}

/* ---------------- fire: three crossed shader planes, noise-shaped, HDR additive ---------------- */
export function makeFire({ color, scale }) {
  const u = { uTime: { value: 0 }, uSpirit: { value: color === 'spirit' ? 1 : 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uTime, uSpirit; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main(){
        vec2 p = vUv; float t = uTime;
        float q = n(vec2(p.x * 4.0, p.y * 3.0 - t * 3.2)) * 0.6 + n(vec2(p.x * 9.0, p.y * 6.0 - t * 5.1)) * 0.4;
        float w = (1.0 - p.y) * 0.42 + 0.04;                      // narrows toward the tip
        float body = smoothstep(w, w * 0.25, abs(p.x - 0.5 + (q - 0.5) * 0.22 * p.y));
        float f = body * smoothstep(1.0, 0.25, p.y + q * 0.35) * smoothstep(0.0, 0.08, p.y);
        vec3 warm = mix(vec3(3.2, 0.55, 0.08), vec3(6.0, 3.4, 1.2), smoothstep(0.35, 0.9, f));
        vec3 cold = mix(vec3(0.15, 0.6, 3.2), vec3(1.6, 3.6, 6.0), smoothstep(0.35, 0.9, f));
        vec3 c = mix(warm, cold, uSpirit);
        gl_FragColor = vec4(c * f, 1.0);
      }`,
  });
  const g = new THREE.Group();
  g.userData = { u, kind: color };
  const plane = new THREE.PlaneGeometry(0.62 * scale, 1.15 * scale).translate(0, 0.55 * scale, 0);
  for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(plane, mat); m.rotation.y = (i / 3) * Math.PI; m.renderOrder = 5; g.add(m); }
  return g;
}

/* ---------------- particles: embers rising off the braziers, fireflies in the dusk ---------------- */
function makeParticles(parent, R, kind, sources, n) {
  const pos = new Float32Array(n * 3), seed = new Float32Array(n);
  const rnd = rng(kind === 'ember' ? 8 : 99);
  for (let i = 0; i < n; i++) seed[i] = rnd();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const u = { uTime: { value: 0 }, uPx: { value: R.renderer.getPixelRatio() } };
  const ember = kind === 'ember';
  const mat = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: `attribute float seed; uniform float uTime, uPx; varying float vA;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        float tw = ${ember ? '1.0' : '0.5 + 0.5 * sin(uTime * (1.5 + seed * 2.0) + seed * 40.0)'};
        vA = tw; gl_PointSize = (${ember ? '0.05' : '0.07'} * uPx * 900.0) / -mv.z; }`,
    fragmentShader: `varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d));
      gl_FragColor = vec4(${ember ? 'vec3(4.0, 1.3, 0.3)' : 'vec3(2.2, 3.0, 0.7)'} * a * vA, 1.0); }`,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;
  parent.add(points);
  const life = new Float32Array(n), vel = new Float32Array(n * 3);
  const spawn = (i) => {
    if (ember) {
      const s = sources[i % sources.length];
      pos.set([s.x + (rnd() - 0.5) * 0.4, s.y - 0.4, s.z + (rnd() - 0.5) * 0.4], i * 3);
      vel.set([(rnd() - 0.5) * 0.3, 0.9 + rnd() * 1.2, (rnd() - 0.5) * 0.3], i * 3);
      life[i] = 1.2 + rnd() * 2.2;
    } else {
      const a = rnd() * Math.PI * 2, r = 13 + rnd() * 24, x = Math.cos(a) * r, z = Math.sin(a) * r;
      pos.set([x, heightAt(x, z) + 0.4 + rnd() * 2.2, z], i * 3);
      vel.set([0, 0, 0], i * 3);
      life[i] = 6 + rnd() * 10;
    }
  };
  for (let i = 0; i < n; i++) { spawn(i); life[i] *= rnd(); }
  return {
    points,
    update(dt, t) {
      u.uTime.value = t;
      for (let i = 0; i < n; i++) {
        life[i] -= dt;
        if (life[i] <= 0) { spawn(i); continue; }
        const k = i * 3;
        if (ember) {
          vel[k] += Math.sin(t * 3 + i) * 0.6 * dt; vel[k + 2] += Math.cos(t * 2.6 + i) * 0.6 * dt;
          pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt; pos[k + 2] += vel[k + 2] * dt;
        } else {
          pos[k] += Math.sin(t * 0.7 + seed[i] * 50) * 0.35 * dt; pos[k + 1] += Math.sin(t * 1.1 + seed[i] * 20) * 0.15 * dt; pos[k + 2] += Math.cos(t * 0.6 + seed[i] * 30) * 0.35 * dt;
        }
      }
      g.attributes.position.needsUpdate = true;
    },
  };
}
