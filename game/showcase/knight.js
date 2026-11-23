/* ============================================================================
   knight.js: the showcase's characters, built on the game's own hero (game/lib/glbhero.js),
   so everything made here carries straight back into world3d.

   glbhero owns the animation stack: locomotion, air, landings, combo swings with lunge / twist /
   hit-stop, hit reactions, knockdown, cape simulation, weapon carry, sword trail. This file only
   adds what the showcase needs on top, without touching that module:

     PBR look     glbhero lifts its materials for the toon-lit world (emissive fill, roughness
                  floor, pink rim). Here the sky's light does that job, so each character gets its
                  own clean copies: no fill, real roughness, a faint cool rim for readability.
     longsword    the Blender-built GLB (tools/blender/longsword.py) replaces the procedural blade
                  inside glbhero's own weapon mount, so carry / trail / combos all still apply.
     guard        a two-bone IK pose: sword hand up before the face, blade level across the body.
     roll         glbhero's mid-air flip with the tuck held, lowered to the ground and driven forward.
     revenants    the same body, cloaked and hooded, darkened, with ember eyes.
   ============================================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { loadGlbHero, loadGlbGear, makeGlbHero } from '/game/lib/glbhero.js';
import { LOOK } from './render.js';
import { loadArmorKit, attachArmor } from './armor.js';
import { bake, bakedMaterial } from './bake.js';
import { makeMover } from './moves.js';
import { fullerGlow } from './loot.js';

export const gltfLoader = (manager) => new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);

let SWORD = null;
export const swordMesh = () => SWORD.clone(); // the baked longsword, for set dressing (the undercroft's relic)
export async function loadKnightAssets(manager) {
  const [, , sword] = await Promise.all([loadGlbHero('human'), loadGlbGear(), gltfLoader(manager).loadAsync(new URL('./assets/longsword.glb', import.meta.url).href), loadArmorKit(gltfLoader(manager))]);
  SWORD = bake(sword.scene, 1.25); // four materials → one draw (bake.js)
}

// ---- materials: clean PBR copies per look (glbhero's are shared by every hero and lit for toon)
const MATS = new Map();
function pbr(src, look) {
  const key = src.uuid + look.key;
  if (MATS.has(key)) return MATS.get(key);
  const m = src.clone(); // Material.copy leaves glbhero's onBeforeCompile / cache key behind
  const body = /tripo/i.test(src.name);
  m.emissive.set(0x000000); m.emissiveMap = null; m.emissiveIntensity = 1;
  m.metalness = 0;
  m.roughness = body ? 0.66 : 0.86;
  m.envMapIntensity = LOOK.envIntensity * 1.15;
  if (look.tint) { m.color.multiply(look.tint); m.roughness = Math.min(1, m.roughness + 0.08); }
  if (look.cloakTint && /cape|hood|cowl|cloak/i.test(src.name)) m.color.multiply(look.cloakTint); // players tell apart by their cloaks
  const rim = look.rim;
  m.onBeforeCompile = (s) => {
    s.uniforms.uRim = { value: rim };
    s.fragmentShader = 'uniform vec3 uRim;\n' + s.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float rimF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
      totalEmissiveRadiance += uRim * rimF;`);
  };
  m.customProgramCacheKey = () => 'showcase-rim';
  m.needsUpdate = true;
  MATS.set(key, m);
  return m;
}

const bone = (root, n) => root.getObjectByName('mixamorig' + n) || root.getObjectByName('mixamorig:' + n);

// swap glbhero's procedural sword for the longsword, keeping its mount, tip and trail base markers
function fitSword(hero, tint) {
  const hand = bone(hero.root, 'RightHand');
  const g = hand && hand.children.find((c) => !c.isBone);
  if (!g) return null;
  for (const c of [...g.children]) if (c.isMesh || (c.children.length && !c.isBone)) g.remove(c);
  const marks = g.children.filter((c) => !c.isMesh).sort((a, b) => a.position.y - b.position.y);
  if (marks.length >= 2) { marks[0].position.set(0, 0.32, 0); marks[marks.length - 1].position.set(0, 0.835, 0); }
  else if (marks.length === 1) marks[0].position.set(0, 0.835, 0);
  const s = SWORD.clone();
  if (tint) s.material = bakedMaterial(1.25, tint);
  g.add(s);
  return g;
}

// analytic two-bone IK in world space: rotate a (upper) and b (lower) so c (end) reaches target,
// the elbow bending toward pole. w blends from the animated pose.
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3(), _e = new THREE.Vector3(), _d = new THREE.Vector3(),
  _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _q0 = new THREE.Quaternion();
function aim(bn, from, to, w) { // rotate bone bn (world) so direction `from` turns into `to`
  _q.setFromUnitVectors(from, to);
  bn.getWorldQuaternion(_qw);
  bn.parent.getWorldQuaternion(_qp);
  _q0.copy(bn.quaternion);
  bn.quaternion.copy(_qp.invert().multiply(_q).multiply(_qw));
  if (w < 1) bn.quaternion.copy(_q0.slerp(bn.quaternion, w));
  bn.updateMatrixWorld(true);
}
function twoBoneIK(a, b, c, target, pole, w) {
  a.getWorldPosition(_pa); b.getWorldPosition(_pb); c.getWorldPosition(_pc);
  const l1 = _pa.distanceTo(_pb), l2 = _pb.distanceTo(_pc);
  _d.subVectors(target, _pa);
  const dist = Math.min(_d.length(), (l1 + l2) * 0.999);
  _d.normalize();
  const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  _n.subVectors(pole, _pa); _n.addScaledVector(_d, -_n.dot(_d)).normalize();
  _e.copy(_pa).addScaledVector(_d, x).addScaledVector(_n, h); // desired elbow
  aim(a, _pb.clone().sub(_pa).normalize(), _e.clone().sub(_pa).normalize(), w);
  b.getWorldPosition(_pb); c.getWorldPosition(_pc);
  aim(b, _pc.clone().sub(_pb).normalize(), target.clone().sub(_pb).normalize(), w);
}

/* ---------------------------------------------------------------------------- */
// look: { key, wear, hood, tint?: Color, rim: Color, eyes?: Color }
export function makeKnight(scene, look) {
  const hero = makeGlbHero({ body: 'human', wear: look.wear, hood: look.hood, equipment: { rhand: 'iron_sword' } });
  scene.add(hero.root);
  const weapon = fitSword(hero, look.tint && new THREE.Color(0.55, 0.5, 0.48));
  const swordMeshes = new Set();
  weapon?.traverse((o) => swordMeshes.add(o));
  const conv = (m) => (m.isMeshStandardMaterial ? pbr(m, look) : m);
  hero.root.traverse((o) => { if (o.isMesh && !swordMeshes.has(o)) o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material); });
  const B = { arm: bone(hero.root, 'RightArm'), fore: bone(hero.root, 'RightForeArm'), hand: bone(hero.root, 'RightHand'),
    armL: bone(hero.root, 'LeftArm'), foreL: bone(hero.root, 'LeftForeArm'), handL: bone(hero.root, 'LeftHand'), head: bone(hero.root, 'Head'), spine: bone(hero.root, 'Spine2') };

  // the trail ribbon glbhero adds to the scene on its first update: find it to tint it steel-white
  const before = new Set(scene.children);
  hero.update(0.016, {});
  const trail = scene.children.find((o) => !before.has(o) && o.isMesh);
  if (trail) trail.material.color.copy(look.trail || new THREE.Color(1.9, 1.7, 6.5));

  // ember eyes (revenants): two tiny HDR spheres on the head bone, aimed from the idle pose
  const eyes = [];
  if (look.eyes && B.head) {
    hero.root.updateMatrixWorld(true);
    const hp = B.head.getWorldPosition(new THREE.Vector3());
    const mat = new THREE.MeshBasicMaterial({ color: look.eyes.clone() });
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 6).scale(1.5, 0.8, 1), mat);
      const wp = hp.clone().add(new THREE.Vector3(sx * 0.034, 0.045, 0.1).applyQuaternion(hero.root.quaternion));
      B.head.add(e);
      e.position.copy(B.head.worldToLocal(wp));
      e.scale.divideScalar(B.head.getWorldScale(new THREE.Vector3()).x);
      e.userData.showcase = true;
      eyes.push(e);
    }
  }

  // armour on its sockets, placed in this idle pose (see armor.js); every slot is attached, worn ones shown
  const armor = attachArmor(hero.root, scene, look.armor || [], { tint: look.armorTint });
  const mover = makeMover(hero.root); // hand-keyed combat moves over the animation (moves.js)

  const st = { guard: 0, roll: -1, rollPhase: 0, air: false };
  const _t = new THREE.Vector3(), _pole = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(0, 1, 0);
  const _m = new THREE.Matrix4(), _qq = new THREE.Quaternion();

  return {
    hero, root: hero.root, trail, eyes, weapon, armor,
    tipWorld: (v) => hero.tipWorld(v),
    get rolling() { return st.roll >= 0; },
    // start a dodge roll: glbhero flips when vertical speed jumps up mid-air; we fake the air time
    roll() { if (st.roll >= 0) return false; st.roll = 0; st.rollPhase = 0; return true; },
    hurt: () => hero.hurt(),
    // a blow from world point `from`: the body gives the way it was pushed (front blows also play the mocap flinch)
    hit(from) {
      const q = hero.root.quaternion, d = new THREE.Vector3().subVectors(from, hero.root.position).setY(0).normalize();
      const f = d.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(q)), r = d.dot(new THREE.Vector3(-1, 0, 0).applyQuaternion(q));
      const name = f > 0.55 ? 'hitF' : f < -0.55 ? 'hitB' : r > 0 ? 'hitR' : 'hitL';
      if (name === 'hitF') hero.hurt();
      mover.play(name);
      return name;
    },
    play: (n) => mover.play(n), release: (n) => mover.release(n), stopMove: (n) => mover.stop(n), playing: (n) => mover.playing(n),
    /* s: { atk, guard (0..1 target), down, lookAt } */
    update(dt, s = {}) {
      let air = false, vy = 0;
      if (st.roll >= 0) {
        st.roll += dt;
        air = true;
        vy = st.rollPhase === 0 ? 0 : 6;          // frame 1: in the air; frame 2: the "second jump" that flips
        if (st.rollPhase < 2) st.rollPhase++;
        if (st.roll > 0.56) { vy = -5.5; }         // a small landing crouch on the way out
        if (st.roll > 0.6) { st.roll = -1; air = false; }
      }
      hero.update(dt, { atk: s.atk ?? -1, air, vy, down: !!s.down, lookAt: s.lookAt });
      // keep the roll on the ground: glbhero spins about the waist, so sink the body through it
      const spin = hero.root.children[0]?.children[0];
      if (spin) {
        const k = st.roll >= 0 ? Math.sin(Math.min(1, st.roll / 0.55) * Math.PI) : 0;
        spin.position.y = 0.775 - 0.5 * k;
      }

      // guard: IK the sword hand up before the face, then lay the blade level across the body
      st.guard += ((s.guard ?? 0) - st.guard) * (1 - Math.exp(-dt * 18));
      const w = st.guard;
      if (w > 0.01 && B.arm && B.fore && B.hand) {
        hero.root.updateMatrixWorld(true);
        const q = hero.root.quaternion;
        _f.set(0, 0, 1).applyQuaternion(q); _r.set(-1, 0, 0).applyQuaternion(q);
        const base = hero.root.position;
        _t.copy(base).addScaledVector(_u, 1.32).addScaledVector(_f, 0.36).addScaledVector(_r, 0.1);
        _pole.copy(base).addScaledVector(_u, 0.9).addScaledVector(_r, 0.6).addScaledVector(_f, -0.2);
        twoBoneIK(B.arm, B.fore, B.hand, _t, _pole, w);
        // off hand rises to brace the blade's flat
        if (B.armL && B.foreL && B.handL) {
          _t.copy(base).addScaledVector(_u, 1.3).addScaledVector(_f, 0.38).addScaledVector(_r, -0.22);
          _pole.copy(base).addScaledVector(_u, 0.9).addScaledVector(_r, -0.6).addScaledVector(_f, -0.2);
          twoBoneIK(B.armL, B.foreL, B.handL, _t, _pole, w * 0.85);
        }
        if (weapon) {
          // blade: toward the off-hand side, a little up and forward; flat facing the foe
          const y = _r.clone().multiplyScalar(-0.92).addScaledVector(_u, 0.3).addScaledVector(_f, 0.18).normalize();
          const z = _f.clone().addScaledVector(y, -_f.dot(y)).normalize();
          const x = new THREE.Vector3().crossVectors(y, z);
          _m.makeBasis(x, y, z);
          _qq.setFromRotationMatrix(_m);
          weapon.parent.getWorldQuaternion(_q).invert();
          const want = _q.multiply(_qq);
          weapon.quaternion.slerp(want, w);
        }
      }
      // combat moves last, so a block recoil pushes the guard the IK just built
      mover.update(dt);
    },
    // wear a blade variant (loot.js ITEMS): its glowing fuller and its trail colour; null = the plain longsword
    setBlade(item) {
      const s = weapon?.children.find((c) => c.isMesh && c.geometry === SWORD.geometry);
      if (!s) return;
      for (const c of [...s.children]) if (c.userData.fuller) s.remove(c);
      if (item) s.add(fullerGlow(item.fuller));
      if (trail) trail.material.color.copy(item ? item.trail : look.trail || new THREE.Color(1.9, 1.7, 6.5));
    },
    setEyes(k) { for (const e of eyes) e.material.color.copy(look.eyes).multiplyScalar(k); },
  };
}

export const LOOKS = {
  warden: { key: 'warden', wear: ['leather_pants', 'leather_boots', 'medieval_tunic', 'green_cloak'], hood: false, rim: new THREE.Color(0.10, 0.11, 0.14),
    armor: ['pauldrons', 'vambraces', 'greaves'] }, // the gorget hides under the cloak's cowl; the Armoury can add it
  revenant: { key: 'revenant', wear: ['leather_pants', 'leather_boots', 'medieval_tunic', 'green_cloak'], hood: true, tint: new THREE.Color(0.2, 0.19, 0.22),
    armor: ['pauldrons', 'greaves'], armorTint: new THREE.Color(0.62, 0.5, 0.42),
    rim: new THREE.Color(0.16, 0.05, 0.03), eyes: new THREE.Color(9, 2.2, 0.5), trail: new THREE.Color(5, 1.2, 0.6) },
};
