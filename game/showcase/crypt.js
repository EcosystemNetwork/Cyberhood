/* ============================================================================
   crypt.js: the Undercroft, the second place built from the stone kit (kit.js).

   Under the graveyard's tomb house a stair goes down into a barrel-vaulted hall:
     stair         z 0 … 4.5, climbing toward +z (back up to the graveyard)
     hall          x -4.5 … 4.5, z 0 … -27: squat round columns, transverse ribs, burial niches
                   in the side walls, chest tombs between the columns
     relic alcove  the far end: the Warden's first sword, standing in a stone block, in cold light

   Light is the whole point down here: no sun, a dim cold-to-warm image light from a tiny
   gradient room (so PBR still has something to reflect), torches in iron sconces, and the relic's
   blue. The same exposure / tone mapping as the glade; only the light changes.
   ============================================================================ */
import * as THREE from 'three';
import { createKit, makeCollide, rng } from './kit.js';
import { makeFire } from './world.js';
import { swordMesh } from './knight.js';
import { LOOK } from './render.js';

export const CRYPT = {
  x0: -4.5, x1: 4.5, z0: -27, z1: 0,
  spring: 2.9, rise: 1.9,                       // the vault: springing height, rise to the crown
  spawn: new THREE.Vector3(0, 0, -1.2),         // the foot of the stair, facing in
  exitZ: 3.4,                                   // walking this far up the stair takes you out
  relic: new THREE.Vector3(0, 0, -24.6),
  foes: [new THREE.Vector3(-1.4, 0, -11), new THREE.Vector3(1.4, 0, -17.5)],
  fog: { color: 0x0b0a0c, density: 0.04 },
};

// the stair rises 0.32 m per 0.45 m tread
export const cryptHeight = (x, z) => Math.min(3.2, Math.max(0, z) * (0.32 / 0.45));

function darkRoom(renderer) {
  // a gradient room for image light: warm dark floor, cold dark vault, a faint warm band at torch height
  const s = new THREE.Scene(), g = new THREE.SphereGeometry(10, 48, 24), col = [];
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 10, band = Math.exp(-((y - 0.1) ** 2) / 0.02);
    col.push((0.05 + band * 0.12) * 1.8, (0.035 + band * 0.07) * 1.8, (0.03 + band * 0.025 + Math.max(0, y) * 0.03) * 1.8);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  s.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromScene(s, 0.03).texture;
  pm.dispose();
  return env;
}

export function buildCrypt(R, M) {
  const root = new THREE.Group();
  root.visible = false;
  R.scene.add(root);
  const K = createKit(cryptHeight);
  const { x0, x1, z0, z1, spring, rise } = CRYPT, W = x1 - x0;
  const vaultTop = (u) => spring + rise * Math.sqrt(Math.max(0, 1 - ((u - W / 2) / (W / 2)) ** 2));

  // floor, walls with burial niches, end walls closing the vault
  K.box(W + 2, 0.4, z1 - z0 + 2, 0, -0.2, (z0 + z1) / 2 - 0.5, 0, K.stoneDark);
  const niches = [-3.0, -7.5, -12.5, -17.5, -22.0];
  for (const [x, a, b] of [[x0, z1, z0], [x1, z0, z1]]) {
    K.wall(x, a, x, b, { t: 0.6, h: spring + 0.15, clean: true,
      holes: niches.map((z) => ({ u: x === x0 ? z1 - z - 0.6 : z - z0 - 0.6, y: 0.55, w: 1.2, ys: 1.25 })) });
    K.wall(x + (x < 0 ? -0.75 : 0.75), a, x + (x < 0 ? -0.75 : 0.75), b, { t: 0.5, h: spring + 0.15, clean: true, collide: false }); // niche backs
  }
  // entrance wall with the stair's doorway, and the stairwell
  K.wall(x0, z1, x1, z1, { t: 0.7, clean: true, top: vaultTop, holes: [{ u: W / 2 - 1.2, y: -0.5, w: 2.4, ys: 1.9 }], gaps: [[W / 2 - 1.2, W / 2 + 1.2]] });
  K.stairs(0, 0, z1 + 0.35, 2.4, 10, 0.32, 0.45, 1);
  for (const sx of [-1, 1]) K.wall(sx * 1.45, z1 + 0.3, sx * 1.45, z1 + 5, { t: 0.5, h: 5.2, clean: true });
  K.box(3.4, 0.4, 5, 0, 5.4, z1 + 2.6, 0, K.stoneDark); // stairwell ceiling
  K.wall(-1.5, z1 + 5, 1.5, z1 + 5, { t: 0.5, h: 5.4, clean: true });
  // far end: the relic alcove, a deep pointed arch
  K.wall(x0, z0, x1, z0, { t: 0.7, clean: true, top: vaultTop, holes: [{ u: W / 2 - 1.5, y: -0.5, w: 3.0, ys: 1.8 }], gaps: [[W / 2 - 1.5, W / 2 + 1.5]] });
  for (const sx of [-1, 1]) K.wall(sx * 1.6, z0, sx * 1.6, z0 - 3, { t: 0.4, h: 4.2, clean: true });
  K.wall(-1.8, z0 - 3, 1.8, z0 - 3, { t: 0.5, h: 4.2, clean: true });
  K.box(3.6, 0.3, 3.4, 0, 4.25, z0 - 1.5, 0, K.stoneDark);
  K.box(3.0, 0.22, 2.6, 0, 0.11, z0 - 1.5, 0, K.stoneDark); // alcove step
  // vault, ribs on the column line, and the arcade
  K.vault(x0 + 0.3, x1 - 0.3, z1, z0, spring, rise);
  const bays = [-5, -10, -15, -20];
  for (const z of [-0.45, ...bays, z0 + 0.45]) K.rib(0, z, W - 0.6, spring, rise);
  // columns rise to meet the vault (and the rib that crosses over each capital)
  for (const z of bays) for (const sx of [-1, 1]) K.column(sx * 2.25, z, vaultTop(2.25 + W / 2) - 0.05, { r: 0.85, cluster: false });
  // tombs between the columns, along the walls
  const rnd = rng(3);
  for (const z of [-7.5, -12.5, -17.5]) for (const sx of [-1, 1]) if (rnd() > 0.15) K.sarcophagus(sx * 3.35, z, 0);
  // the relic's block
  K.box(1.4, 0.9, 0.9, 0, 0.45, CRYPT.relic.z, 0);
  K.box(1.6, 0.12, 1.1, 0, 0.96, CRYPT.relic.z, 0, K.stoneDark);
  K.circ(0, CRYPT.relic.z, 0.85);
  K.build(M, root);

  // the relic: the longsword, point down in the stone, a cold light running in its fuller
  const relic = new THREE.Group();
  relic.position.set(0, 1.02 + 0.5, CRYPT.relic.z);
  const sword = swordMesh();
  sword.rotation.x = Math.PI;
  relic.add(sword);
  const glow = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.62, 0.016), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.8, 2.4, 6) }));
  glow.position.y = -0.48;
  relic.add(glow);
  root.add(relic);

  // torches in iron sconces, three of them lit (the light budget), the rest just burn
  const fires = [], lights = [];
  const iron = M.iron;
  const torch = (x, z, lit) => {
    const sx = Math.sign(x), g = new THREE.Group();
    g.position.set(x - sx * 0.05, 1.75, z);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6), iron); arm.rotation.z = sx * 0.9; arm.position.set(-sx * 0.12, 0, 0); g.add(arm);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.05, 0.14, 10, 1, true), iron); cup.position.set(-sx * 0.27, 0.15, 0); g.add(cup);
    const f = makeFire({ color: 'warm', scale: 0.55 }); f.position.set(-sx * 0.27, 0.2, 0); g.add(f);
    root.add(g);
    R.noAO.add(f);
    const e = { fire: f, light: null, base: 0, pos: new THREE.Vector3(x - sx * 0.45, 2.15, z) };
    if (lit && lights.length < Math.max(1, R.q.lights - 1)) {
      e.light = new THREE.PointLight(0xff8a3a, 26, 12, 2); e.light.position.copy(e.pos); e.base = 26; root.add(e.light); lights.push(e.light);
    }
    fires.push(e);
  };
  torch(x0 + 0.3, -2.5, true); torch(x1 - 0.3, -2.5, false);
  torch(x1 - 0.3, -10, true); torch(x0 + 0.3, -10, false);
  torch(x0 + 0.3, -17.5, true); torch(x1 - 0.3, -17.5, false);
  const relicLight = new THREE.PointLight(0x7fb0ff, 18, 10, 2);
  relicLight.position.set(0, 2.1, CRYPT.relic.z + 0.6);
  root.add(relicLight); lights.push(relicLight);

  // dust hanging in the torchlight
  const N = 260, dpos = new Float32Array(N * 3), dseed = new Float32Array(N), r2 = rng(17);
  for (let i = 0; i < N; i++) { dpos.set([x0 + r2() * W, 0.3 + r2() * 3.4, z0 + r2() * (z1 - z0)], i * 3); dseed[i] = r2(); }
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
  const dm = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPx: { value: R.renderer.getPixelRatio() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: `uniform float uTime, uPx; varying float vA;
      void main(){ vec3 p = position; float s = fract(sin(dot(p.xz, vec2(12.9898, 78.233))) * 43758.5);
        p += vec3(sin(uTime * 0.21 + s * 40.0), sin(uTime * 0.13 + s * 20.0) * 0.6, cos(uTime * 0.17 + s * 30.0)) * 0.35;
        vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; vA = 0.35 + 0.65 * s; gl_PointSize = 0.022 * uPx * 900.0 / -mv.z; }`,
    fragmentShader: `varying float vA; void main(){ float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)); gl_FragColor = vec4(vec3(0.55, 0.42, 0.3) * a * vA, 1.0); }`,
  });
  const dust = new THREE.Points(dg, dm);
  dust.frustumCulled = false;
  root.add(dust);
  R.noAO.add(dust);

  const env = darkRoom(R.renderer);
  const colliders = K.colliders;
  // the hall's walls are segments; also keep everyone off the stair's sides and out of the alcove's back
  const collide = makeCollide(colliders);

  return {
    root, env, colliders, lights, fires, relic, relicLight, collide,
    heightAt: cryptHeight,
    grass: { count: () => 0 },
    // keep the third-person camera inside the hall and under the vault
    clampCamera(p) {
      p.x = THREE.MathUtils.clamp(p.x, x0 + 0.45, x1 - 0.45);
      p.z = THREE.MathUtils.clamp(p.z, z0 - 2.4, z1 + 4.6);
      if (p.z > z1) p.x = THREE.MathUtils.clamp(p.x, -1.1, 1.1);
      const ceil = p.z > z1 ? 5.0 : vaultTop(p.x - x0) - 0.35;
      p.y = Math.min(p.y, ceil);
    },
    update(dt, t) {
      for (const f of fires) {
        f.fire.userData.u.uTime.value = t;
        if (f.light) f.light.intensity = f.base * (0.8 + 0.12 * Math.sin(t * 10.7 + f.pos.z) + 0.08 * Math.sin(t * 23.1 + f.pos.x));
      }
      relicLight.intensity = relicLight.userData.base ?? 18;
      relicLight.intensity *= 0.9 + 0.1 * Math.sin(t * 1.7);
      dm.uniforms.uTime.value = t;
    },
  };
}
