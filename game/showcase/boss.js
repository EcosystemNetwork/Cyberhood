/* ============================================================================
   boss.js: the Ossuary Warden, the Undercroft's guardian. Not a man in a cloak: a six-legged
   crawler of grave bones, so its silhouette alone says "this is different".

   Built from rigid bone pieces (no skinning): a ribcage body on a spine, a horned skull with ember
   eyes, six legs of two bones each. Animated procedurally:
     gait     each foot stays planted until the body has carried its rest spot a stride away, then
              steps in an arc; legs move as two alternating tripods (never all on one side)
     legs     analytic two-bone IK from hip to foot, knees bent up and out (spider stance)
     attacks  impale: the front legs rear up (0.8 s, eyes flare), then drive down ahead
              sweep:  the body drops low (0.7 s), then spins once, legs sweeping a 3.3 m circle
     phase 2  under half health: faster, shorter telegraphs, the eyes burn brighter
   The fight follows combat.js's readability rules: one blow at a time, every blow telegraphed,
   damage on one frame. Parrying the impale staggers it open; a heavy interrupts a telegraph.
   ============================================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from './kit.js';
import { LOOK } from './render.js';
import { sfx } from '/game/lib/sfx.js';

export const BOSS = {
  name: 'THE OSSUARY WARDEN', hp: 560, speed: 2.3, radius: 1.25, height: 1.15,
  femur: 1.25, tibia: 1.55, stride: 0.95, stepT: 0.22,
  impale: { wind: 0.8, strike: 0.16, recover: 0.9, reach: 3.4, arc: Math.cos(Math.PI / 3), dmg: 30 },
  sweep: { wind: 0.7, spin: 0.55, recover: 0.8, reach: 3.3, dmg: 24 },
  stagger: 1.6,
};

// ---- bone geometry: tapered shafts with knobbed ends, vertex-coloured (darker in the grooves)
const BONE = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.72, metalness: 0, envMapIntensity: LOOK.envIntensity * 1.4 });
function tint(g, c0, c1, axis = 'y') {
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  g.computeBoundingBox();
  const b = g.boundingBox, lo = b.min[axis], hi = b.max[axis];
  for (let i = 0; i < p.count; i++) {
    const k = (p['get' + axis.toUpperCase()](i) - lo) / Math.max(1e-6, hi - lo), n = 0.88 + 0.12 * Math.sin(i * 12.9898);
    col.set([(c0[0] + (c1[0] - c0[0]) * k) * n, (c0[1] + (c1[1] - c0[1]) * k) * n, (c0[2] + (c1[2] - c0[2]) * k) * n], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
const IVORY = [0.78, 0.72, 0.6], DIRT = [0.32, 0.27, 0.22];
// a long bone along +y, length 1 (scaled at use): knob, shaft, knob
function longBone() {
  const pts = [[0, 0], [0.11, 0.01], [0.13, 0.05], [0.09, 0.12], [0.055, 0.22], [0.05, 0.5], [0.055, 0.78], [0.085, 0.88], [0.12, 0.95], [0.1, 0.99], [0, 1]];
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 10);
  return tint(g, DIRT, IVORY);
}
// the tibia ends in a hooked claw
function clawBone() {
  const pts = [[0, 0], [0.012, 0.0], [0.03, 0.08], [0.045, 0.3], [0.05, 0.6], [0.06, 0.85], [0.09, 0.94], [0.1, 0.99], [0, 1]];
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 9);
  return tint(g, [0.2, 0.17, 0.15], IVORY);
}
function ribcage(seed) {
  const rnd = rng(seed), parts = [];
  // spine: a chain of vertebrae along z
  for (let i = 0; i < 11; i++) {
    const z = 1.0 - i * 0.2, v = new THREE.CylinderGeometry(0.11, 0.13, 0.15, 8);
    v.rotateX(Math.PI / 2); v.translate(0, 0.18 + Math.sin(i * 0.5) * 0.05, z); parts.push(v);
    const sp = new THREE.ConeGeometry(0.05, 0.28 + rnd() * 0.12, 5); sp.translate(0, 0.38 + Math.sin(i * 0.5) * 0.05, z); parts.push(sp); // spinous process
  }
  // ribs: arcs hanging from the spine, wider in the middle
  for (let i = 0; i < 8; i++) {
    const z = 0.8 - i * 0.2, w = 0.55 + Math.sin((i / 7) * Math.PI) * 0.35;
    for (const s of [-1, 1]) {
      const c = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.2, z), new THREE.Vector3(s * w * 0.8, 0.12, z - 0.02), new THREE.Vector3(s * w, -0.25, z - 0.05), new THREE.Vector3(s * w * 0.55, -0.62, z - 0.08)]);
      parts.push(new THREE.TubeGeometry(c, 12, 0.035, 5, false));
    }
  }
  // pelvis plate at the back, sternum underneath
  const pel = new THREE.SphereGeometry(0.42, 12, 8); pel.scale(1.25, 0.55, 0.75); pel.translate(0, 0.0, -1.2); parts.push(pel);
  const st = new THREE.BoxGeometry(0.16, 0.06, 1.2); st.translate(0, -0.6, 0.15); parts.push(st);
  const g = mergeGeometries(parts.map((p) => { p = p.index ? p.toNonIndexed() : p; for (const k of Object.keys(p.attributes)) if (!['position', 'normal'].includes(k)) p.deleteAttribute(k); return p; }));
  return tint(g, DIRT, IVORY);
}
function skull() {
  const parts = [];
  const cran = new THREE.SphereGeometry(0.36, 16, 12); cran.scale(1, 0.85, 1.15); parts.push(cran);
  const snout = new THREE.BoxGeometry(0.36, 0.22, 0.42); snout.translate(0, -0.12, 0.34); parts.push(snout);
  const jaw = new THREE.BoxGeometry(0.34, 0.08, 0.46); jaw.translate(0, -0.32, 0.26); parts.push(jaw);
  for (const s of [-1, 1]) { // horns sweeping back
    const c = new THREE.CatmullRomCurve3([new THREE.Vector3(s * 0.22, 0.18, 0.05), new THREE.Vector3(s * 0.45, 0.42, -0.2), new THREE.Vector3(s * 0.5, 0.48, -0.6), new THREE.Vector3(s * 0.38, 0.32, -0.9)]);
    const h = new THREE.TubeGeometry(c, 14, 0.06, 6, false);
    const pos = h.attributes.position; // taper toward the tip
    for (let i = 0; i < pos.count; i++) { const t = Math.floor(i / 7) / 14, p = c.getPointAt(Math.min(1, t)); const v = new THREE.Vector3().fromBufferAttribute(pos, i).sub(p).multiplyScalar(1 - t * 0.8).add(p); pos.setXYZ(i, v.x, v.y, v.z); }
    parts.push(h);
    for (let k = 0; k < 4; k++) { const t = new THREE.ConeGeometry(0.03, 0.12, 4); t.rotateX(Math.PI); t.translate(s * (0.06 + k * 0.05), -0.25, 0.48); parts.push(t); } // teeth
  }
  const g = mergeGeometries(parts.map((p) => { p = p.index ? p.toNonIndexed() : p; for (const k of Object.keys(p.attributes)) if (!['position', 'normal'].includes(k)) p.deleteAttribute(k); p.computeVertexNormals(); return p; }));
  return tint(g, DIRT, IVORY);
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3(), _k = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
// place a +y-aligned unit-length mesh between two points
function span(m, p0, p1, thick = 1) {
  _d.subVectors(p1, p0);
  const L = _d.length();
  m.position.copy(p0);
  m.quaternion.setFromUnitVectors(_up, _d.normalize());
  m.scale.set(thick * Math.max(0.6, L), L, thick * Math.max(0.6, L));
}

export function makeBoss(scene, world, overlay, sparks, home) {
  const root = new THREE.Group();
  scene.add(root);
  const body = new THREE.Group(); // pitch / roll / bob live here
  root.add(body);
  const cage = new THREE.Mesh(ribcage(5), BONE); cage.castShadow = true; body.add(cage);
  const head = new THREE.Group(); head.position.set(0, 0.25, 1.35); body.add(head);
  const sk = new THREE.Mesh(skull(), BONE); sk.castShadow = true; head.add(sk);
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 1.8, 0.4) });
  for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), eyeMat); e.position.set(s * 0.14, 0.02, 0.36); head.add(e); }
  // its eyes light the bones around them (shares the area's point-light budget: the crypt keeps one free)
  const glow = new THREE.PointLight(0xff5a20, 6, 6, 2); glow.position.set(0, 0.2, 1.6); body.add(glow);

  const femurG = longBone(), clawG = clawBone();
  const legs = [];
  for (let i = 0; i < 3; i++) for (const s of [-1, 1]) {
    const f = new THREE.Mesh(femurG, BONE), t = new THREE.Mesh(clawG, BONE);
    f.castShadow = t.castShadow = true;
    root.add(f, t);
    legs.push({ s, i, hip: new THREE.Vector3(s * 0.5, 0.05, 0.7 - i * 0.65), rest: new THREE.Vector3(s * 2.0, 0, 1.35 - i * 1.25),
      group: (i + (s > 0 ? 1 : 0)) % 2, foot: new THREE.Vector3(), step: null, f, t, override: null });
  }

  const st = { pos: home.clone(), yaw: 0, hp: BOSS.hp, state: 'dormant', t: 0, vel: new THREE.Vector3(), hitDone: false, phase: 1, spin: 0, downT: 0, low: 0, rear: 0, sink: 0 };
  const target = { kind: 'boss', get pos() { return st.pos; }, get state() { return st.state === 'dead' ? 'dead' : st.state === 'stun' ? 'stun' : 'boss'; }, get stun() { return st.state === 'stun' ? BOSS.stagger : 0; }, radius: BOSS.radius, owner: null };
  const toWorld = (v, out) => out.copy(v).applyAxisAngle(_up, st.yaw).add(st.pos);
  for (const L of legs) toWorld(L.rest, L.foot).setY(world.heightAt(L.foot.x, L.foot.z));

  const hud = document.getElementById('boss'), hpFill = hud?.querySelector('.fill'), hpLag = hud?.querySelector('.lag');
  const showHud = (on) => hud?.classList.toggle('on', on);

  function gait(dt) {
    const stepping = [0, 0];
    for (const L of legs) if (L.step) stepping[L.group]++;
    for (const L of legs) {
      if (L.step) {
        L.step.t += dt / BOSS.stepT * (st.phase === 2 ? 1.25 : 1);
        const k = Math.min(1, L.step.t);
        L.foot.lerpVectors(L.step.from, L.step.to, k);
        L.foot.y += Math.sin(k * Math.PI) * 0.45;
        if (k >= 1) { L.step = null; if (Math.random() < 0.3) sfx.play('step', { dist: 6 }); }
        continue;
      }
      const want = toWorld(L.rest, new THREE.Vector3()).addScaledVector(st.vel, 0.28);
      want.y = world.heightAt(want.x, want.z);
      if (want.distanceTo(L.foot) > BOSS.stride && !stepping[1 - L.group]) {
        L.step = { t: 0, from: L.foot.clone(), to: want };
        stepping[L.group]++;
      }
    }
  }

  function setState(s) { st.state = s; st.t = 0; st.hitDone = false; }
  const E = () => (st.phase === 2 ? 0.75 : 1); // phase 2: shorter telegraphs

  return {
    root, target, legs,
    get hp() { return st.hp / BOSS.hp; }, get state() { return st.state; }, get pos() { return st.pos; },
    wake() { if (st.state === 'dormant') { setState('roar'); showHud(true); sfx.play('boom'); } },
    reset() {
      st.pos.copy(home); st.yaw = 0; st.hp = BOSS.hp; st.phase = 1; setState('dormant'); st.downT = 0; st.sink = 0; root.visible = true; eyeMat.color.setRGB(8, 1.8, 0.4); glow.intensity = 6;
      for (const L of legs) { L.step = null; L.override = null; toWorld(L.rest, L.foot).setY(world.heightAt(L.foot.x, L.foot.z)); }
      showHud(false);
    },
    setActive(on) { root.visible = on; if (!on) showHud(false); else if (st.state !== 'dormant' && st.state !== 'dead') showHud(true); },
    // the warden's blade lands
    strike(e, dmg, crit, dir, heavy) {
      if (st.state === 'dead' || st.state === 'dormant') return false;
      st.hp -= dmg;
      const at = st.pos.clone().setY(st.pos.y + 1.2).addScaledVector(dir, -0.6);
      sparks.burst(at, 'hit', crit ? 34 : 20, dir); sparks.burst(at, 'dust', 4);
      overlay.number(at.clone().setY(at.y + 0.7), String(Math.round(dmg)), crit ? 'crit' : '');
      if (st.hp <= 0) {
        st.hp = 0; setState('dead'); showHud(false);
        for (const L of legs) { L.override = null; L.step = null; }
        sfx.play('kill'); sfx.play('boom');
        return 'kill';
      }
      if (st.phase === 1 && st.hp < BOSS.hp / 2) { st.phase = 2; eyeMat.color.setRGB(14, 3, 0.6); glow.intensity = 10; sfx.play('boom'); }
      if (heavy && (st.state === 'impaleWind' || st.state === 'sweepWind')) { for (const L of legs) L.override = null; setState('stun'); } // a heavy breaks the telegraph
      sfx.play('hit');
      return 'hit';
    },
    parried() { for (const L of legs) L.override = null; setState('stun'); sfx.play('break'); },
    update(dt, t, player, hooks) {
      st.t += dt;
      const to = _a.subVectors(player.pos, st.pos).setY(0), d = to.length();
      const face = Math.atan2(to.x, to.z);
      const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
      let move = 0, turn = 7;
      const fwd = new THREE.Vector3(Math.sin(st.yaw), 0, Math.cos(st.yaw));
      st.low += ((st.state === 'sweepWind' ? 1 : 0) - st.low) * (1 - Math.exp(-dt * 8));
      st.rear += ((st.state === 'impaleWind' ? 1 : 0) - st.rear) * (1 - Math.exp(-dt * 9));
      // front legs during the impale: up and forward, then down hard ahead
      const front = legs.filter((L) => L.i === 0);

      switch (st.state) {
        case 'dormant': if (d < 9 && !player.dead) this.wake(); break;
        case 'roar': turn = 4; if (st.t > 1.2) setState('chase'); break;
        case 'chase':
          if (player.dead) break;
          move = d > 2.6 ? 1 : 0;
          if (st.t > 0.9 && d < 3.1 && Math.abs(wrap(face - st.yaw)) < 0.5) setState(Math.random() < 0.6 ? 'impaleWind' : 'sweepWind');
          else if (st.t > 2.5 && d < 4.2) setState('sweepWind');
          break;
        case 'impaleWind':
          for (const L of front) L.override = toWorld(new THREE.Vector3(L.s * 0.7, 2.1, 1.5), new THREE.Vector3());
          eyeMat.color.setRGB(8 + 10 * (st.t / BOSS.impale.wind), 2, 0.4);
          if (st.t > BOSS.impale.wind * E()) { setState('impaleStrike'); sfx.play('swing', { dist: d }); }
          break;
        case 'impaleStrike': {
          turn = 0;
          const k = Math.min(1, st.t / BOSS.impale.strike);
          for (const L of front) { const hi = toWorld(new THREE.Vector3(L.s * 0.7, 2.1, 1.5), new THREE.Vector3()), lo = toWorld(new THREE.Vector3(L.s * 0.35, 0, 2.9), new THREE.Vector3()); lo.y = world.heightAt(lo.x, lo.z); L.override = hi.lerp(lo, k * k); }
          if (!st.hitDone && k >= 1) {
            st.hitDone = true;
            sparks.burst(toWorld(new THREE.Vector3(0, 0.1, 2.9), new THREE.Vector3()), 'dust', 16);
            hooks.shake?.(0.35);
            if (d < BOSS.impale.reach && to.clone().normalize().dot(fwd) > BOSS.impale.arc) hooks.hitPlayer(target, BOSS.impale.dmg);
          }
          if (st.t > BOSS.impale.strike + 0.25) { for (const L of front) { L.foot.copy(L.override); L.override = null; } setState('recover'); }
          break;
        }
        case 'sweepWind':
          turn = 2;
          eyeMat.color.setRGB(8 + 10 * (st.t / BOSS.sweep.wind), 2, 0.4);
          if (st.t > BOSS.sweep.wind * E()) { setState('sweep'); st.spin = 0; sfx.play('throw', { dist: d }); }
          break;
        case 'sweep': {
          turn = 0;
          const k = Math.min(1, st.t / BOSS.sweep.spin), dy = (Math.PI * 2 * (k - st.spin));
          st.spin = k;
          st.yaw += dy;
          for (const L of legs) { toWorld(L.rest.clone().multiplyScalar(1.15), L.foot).setY(world.heightAt(L.foot.x, L.foot.z) + 0.15); L.step = null; }
          if (!st.hitDone && k > 0.3) { st.hitDone = true; if (d < BOSS.sweep.reach) hooks.hitPlayer(target, BOSS.sweep.dmg); }
          if (k >= 1) setState('recover');
          break;
        }
        case 'recover': turn = 3; if (st.t > (st.phase === 2 ? 0.6 : BOSS.impale.recover)) { eyeMat.color.setRGB(st.phase === 2 ? 14 : 8, st.phase === 2 ? 3 : 1.8, 0.4); setState('chase'); } break;
        case 'stun': turn = 0; if (st.t > BOSS.stagger) setState('chase'); break;
        case 'dead':
          st.downT += dt;
          st.sink = Math.min(BOSS.height - 0.35, st.sink + dt * 1.6);
          for (const L of legs) { L.foot.lerp(toWorld(L.rest.clone().multiplyScalar(1.25), new THREE.Vector3()).setY(st.pos.y), 1 - Math.exp(-dt * 3)); }
          eyeMat.color.multiplyScalar(Math.exp(-dt * 1.5)); glow.intensity *= Math.exp(-dt * 1.5);
          if (st.downT > 6) root.visible = false;
          break;
      }
      // turn + move
      if (turn && st.state !== 'dead') st.yaw += wrap(face - st.yaw) * (1 - Math.exp(-dt * turn * (st.phase === 2 ? 1.3 : 1)));
      const spd = BOSS.speed * (st.phase === 2 ? 1.3 : 1) * move;
      st.vel.set(Math.sin(st.yaw), 0, Math.cos(st.yaw)).multiplyScalar(spd);
      st.pos.addScaledVector(st.vel, dt);
      if (!player.dead && d < BOSS.radius + 0.4 && d > 1e-4) st.pos.addScaledVector(to.clone().normalize(), -(BOSS.radius + 0.4 - d));
      world.collide(st.pos, BOSS.radius);
      st.pos.y = world.heightAt(st.pos.x, st.pos.z);
      if (st.state !== 'dead' && st.state !== 'sweep') gait(dt);

      // body: sink for the sweep, rear for the impale, breathe; collapse when dead
      const by = BOSS.height - st.low * 0.45 + st.rear * 0.25 + Math.sin(t * 2.2) * 0.04 - st.sink;
      body.position.set(st.pos.x, st.pos.y + by, st.pos.z);
      body.rotation.set(-st.rear * 0.35, st.yaw, 0, 'YXZ');
      head.rotation.set(st.rear * 0.4 - 0.1 + Math.sin(t * 1.3) * 0.05, Math.sin(t * 0.9) * 0.15, 0);
      for (const L of legs) legIK2(L);
      if (hpFill) { hpFill.style.transform = `scaleX(${st.hp / BOSS.hp})`; hpLag.style.transform = `scaleX(${st.hp / BOSS.hp})`; }
    },
  };

  // hips in world space from the body's transform (pitch included), then IK
  function legIK2(L) {
    body.updateMatrixWorld(true);
    const hip = L.hip.clone().applyMatrix4(body.matrixWorld);
    const foot = L.override || L.foot, a = BOSS.femur, b = BOSS.tibia;
    _d.subVectors(foot, hip);
    const dist = Math.min(_d.length(), (a + b) * 0.995);
    _d.normalize();
    const x = (a * a - b * b + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, a * a - x * x));
    const out = _b.set(L.s, 0, 0).applyAxisAngle(_up, st.yaw);
    _n.copy(_up).multiplyScalar(1.4).add(out);
    _n.addScaledVector(_d, -_n.dot(_d)).normalize();
    _k.copy(hip).addScaledVector(_d, x).addScaledVector(_n, h);
    span(L.f, hip, _k, 0.85);
    const tipLen = _d.subVectors(foot, _k).length();
    L.t.position.copy(foot);
    L.t.quaternion.setFromUnitVectors(_up, _d.normalize().negate()); // the claw (y = 0) on the ground, knob at the knee
    L.t.scale.set(0.9, tipLen, 0.9);
  }
}
