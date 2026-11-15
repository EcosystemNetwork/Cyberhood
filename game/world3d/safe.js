// A safe camp: a glowing ring on the ground with a little campfire and rune stones round its edge.
// Monsters can't come inside the ring. makeSafeCamp(r) builds it at the origin; tick(now) animates it.
import * as THREE from 'three';

const glow = (c, o = {}) => new THREE.MeshBasicMaterial({ color: c, ...o });
const solid = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });

function softDisc() { // a soft round glow for the floor inside the ring
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(160,255,200,0.55)'); g.addColorStop(0.7, 'rgba(90,255,200,0.18)'); g.addColorStop(1, 'rgba(90,255,200,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeSafeCamp(r = 2.2) {
  const g = new THREE.Group();
  const flat = (geo, mat, y) => { const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI / 2; m.position.y = y; g.add(m); return m; };
  flat(new THREE.CircleGeometry(r, 48), new THREE.MeshBasicMaterial({ map: softDisc(), transparent: true, depthWrite: false }), 0.02);
  const ring = flat(new THREE.RingGeometry(r - 0.09, r, 64), glow('#7affc8', { transparent: true, opacity: 0.9, side: THREE.DoubleSide }), 0.03);
  // rune stones round the edge
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3, s = new THREE.Group();
    const stone = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.42, 0.14), new THREE.MeshStandardMaterial({ color: '#6a6088', roughness: 0.7, emissive: '#2a6a5a', emissiveIntensity: 0.6 }));
    stone.position.y = 0.21; stone.rotation.y = -a; s.add(stone);
    const rune = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.24), glow('#9affd8'));
    rune.position.set(Math.cos(a) * -0.072, 0.24, Math.sin(a) * -0.072); rune.rotation.y = -a - Math.PI / 2; s.add(rune);
    s.position.set(Math.cos(a) * (r + 0.05), 0, Math.sin(a) * (r + 0.05));
    g.add(s);
  }
  // the campfire: a ring of stones, two crossed logs, flames and a warm light
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2, st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09), solid('#6a6274'));
    st.position.set(Math.cos(a) * 0.36, 0.06, Math.sin(a) * 0.36); g.add(st);
  }
  for (const ry of [0.5, -0.5]) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.6, 8), solid('#6a4224'));
    log.rotation.set(0, ry, Math.PI / 2); log.position.y = 0.09; g.add(log);
  }
  const flames = [['#ff7a1a', 0.24, 0.75, 0], ['#ffc23a', 0.16, 0.56, 0.04], ['#fff2a0', 0.09, 0.36, 0.08]].map(([c, w, h, y]) => {
    const f = new THREE.Mesh(new THREE.ConeGeometry(w, h, 8), glow(c));
    f.position.y = 0.12 + h / 2 + y; g.add(f); return f;
  });
  const light = new THREE.PointLight('#ffb060', 10, 7, 1.4);
  light.position.y = 0.8; g.add(light);
  g.tick = (now) => {
    const t = now * 0.001;
    flames.forEach((f, i) => { f.scale.set(1, 0.85 + 0.25 * Math.abs(Math.sin(t * (7 + i * 2) + i)), 1); f.rotation.y = t * (1 + i); });
    light.intensity = 9 + Math.sin(t * 13) * 1.2 + Math.sin(t * 7.3) * 0.8;
    ring.material.opacity = 0.7 + 0.25 * Math.sin(t * 2);
  };
  return g;
}
