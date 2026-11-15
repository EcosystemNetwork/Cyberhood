// The Sendy portal in the middle of the Avenues' big plot, and the little sprout who stands by it.
// Both are plain three.js shapes; call tick(now) each frame to swirl the portal and bob the sprout.
import * as THREE from 'three';

const glow = (c) => new THREE.MeshBasicMaterial({ color: c });
const solid = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, ...o });

function swirlTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 8, 128, 128, 128);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, '#d8ff5a'); g.addColorStop(0.6, '#7a3ae0'); g.addColorStop(1, '#2a0a5a');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 6;
  for (let arm = 0; arm < 4; arm++) { // four spiral arms
    x.beginPath();
    for (let t = 0; t < 1; t += 0.02) {
      const a = arm * Math.PI / 2 + t * 5, r = t * 120;
      x[t ? 'lineTo' : 'moveTo'](128 + Math.cos(a) * r, 128 + Math.sin(a) * r);
    }
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makePortal() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.13, 12, 48), glow('#c8ff2e'));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.26, 0.06, 8, 48), glow('#9a4aff'));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1.02, 48), new THREE.MeshBasicMaterial({ map: swirlTexture(), side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.05, 0.22, 24), solid('#4a3a5a'));
  for (const m of [ring, rim, disc]) { m.position.y = 1.45; g.add(m); }
  base.position.y = 0.11; g.add(base);
  g.tick = (now) => { disc.rotation.z = -now * 0.0015; ring.scale.setScalar(1 + Math.sin(now * 0.004) * 0.03); };
  return g;
}

// the little green sprout: a teardrop body with a big grin, stubby arms, stick legs and a carrot root
export function makeSprout() {
  const g = new THREE.Group(), body = new THREE.Group();
  const green = solid('#b8e070'), dark = solid('#5a8a2a');
  // teardrop: a lathe from a round bottom up to a point
  const pts = [];
  for (let i = 0; i <= 24; i++) { const t = i / 24, y = t * 1.0, r = Math.sin(Math.PI * Math.pow(t, 0.75)) * 0.36 * (1 - t * 0.25); pts.push(new THREE.Vector2(Math.max(r, 0.001), y)); }
  const drop = new THREE.Mesh(new THREE.LatheGeometry(pts, 32), green);
  body.add(drop);
  const front = 0.3; // how far forward the face sits
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), solid('#f2f2f2'));
    eye.scale.set(0.9, 1.1, 0.5); eye.position.set(s * 0.13, 0.55, front); body.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.065, 12, 10), solid('#141810', { roughness: 0.2 }));
    pupil.scale.set(1, 1.1, 0.5); pupil.position.set(s * 0.11, 0.52, front + 0.06); body.add(pupil);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), glow('#ffffff'));
    shine.position.set(s * 0.1, 0.55, front + 0.1); body.add(shine);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.022, 0.02), dark);
    brow.position.set(s * 0.13, 0.72, front - 0.02); brow.rotation.z = s * -0.08; body.add(brow);
    const cheek = new THREE.Mesh(new THREE.CircleGeometry(0.04, 12), glow('#f0a0c0'));
    cheek.position.set(s * 0.22, 0.44, front - 0.06); cheek.rotation.y = s * 0.5; body.add(cheek);
    // arm + ball hand, held out to the side
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.32, 8), green);
    arm.position.set(s * 0.42, 0.42, 0); arm.rotation.z = s * 1.05; body.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), solid('#d2ec96'));
    hand.position.set(s * 0.56, 0.35, 0); body.add(hand);
    // stick leg, splayed out
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.03), solid('#9cc85a'));
    leg.position.set(s * 0.26, -0.12, 0); leg.rotation.z = s * 0.45; body.add(leg);
  }
  // open grin with a pink tongue
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.13, 20, Math.PI, Math.PI), solid('#1a2418'));
  mouth.scale.set(1.15, 0.75, 1); mouth.position.set(0, 0.36, front + 0.03); body.add(mouth);
  const tongue = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), solid('#f08aa8'));
  tongue.scale.set(1.3, 0.55, 1); tongue.position.set(0, 0.3, front + 0.035); body.add(tongue);
  // leafy collar and carrot root underneath
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.07, 10), dark);
  collar.position.y = -0.03; body.add(collar);
  const carrot = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.42, 10), solid('#f0a060'));
  carrot.rotation.x = Math.PI; carrot.position.y = -0.27; body.add(carrot);
  body.position.y = 0.55; // the root tip just above the ground
  g.add(body);
  g.tick = (now) => { body.position.y = 0.55 + Math.sin(now * 0.003) * 0.06; body.rotation.z = Math.sin(now * 0.0021) * 0.05; };
  return g;
}
