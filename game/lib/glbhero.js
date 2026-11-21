/* ============================================================================
   glbhero.js: a ready-made, Mixamo-rigged character GLB (e.g. from Tripo) as the hero.

     await loadGlbHero('human');       // a key of HERO_URL, or a url
     const hero = makeGlbHero(look);   // same API as makeHero3D / makeBlenderHero; look.body picks the
                                       // loaded body (else the last loaded) and its START_WEAR
     each frame: hero.update(dt, { atk, atkL, lookAt, air, vy, down, sheathed })   (down: knocked out / fainted;
                 sheathed: weapons ride on the back, see SHEATH; a swing always draws them)
     hero.hurt();  hero.emote('happy' | 'wave' | 'victory' | 'cheer' | 'bow');  hero.fidget('look')
     hero.setHood(up)   the cloak's hood up on the head, or down on the back (look.hood: false starts it down);
                        hero.hood is true / false, or null with no hooded cloak on

   Gear: skinned clothing made for the same skeleton (tools/blender/cloak_game.py, wear_fit.py) is
   attached by bone name; its cloth strands join the hero's and are simulated like a cape, and the
   body's triangles it covers are left undrawn.
     await loadGlbGear();                       // every id in GEAR_URL
     makeGlbHero({ ...look, wear: ['green_cloak'] })   // or equip an item listed in GEAR_FOR_ITEM

   Clips come from tools/blender/rogue_anims.py. The motion is built in layers, each blended over
   the one before it, then shaped by procedural motion:

     1 locomotion   idle / walk / run, played at the ground speed the feet actually cover
     2 air          take-off → tuck → fall poses scrubbed by vertical speed; a mid-air jump flips
     3 landing      full-body crouch on touch-down, as deep as the fall was hard
     4 gesture      emotes, and idle fidgets after standing still a while (cancelled by moving)
     5 hurt         one of two hit reactions
     6 attacks      per hand; chained swings walk a combo (sword: diagonal → backhand → overhead,
                    unarmed: jab → cross → front kick), wands / bows thrust
     7 knockdown    full body, while down
     8 procedural   lean into turns and against acceleration, head and chest track lookAt;
                    attacks lunge, twist the hips and leave a trail
     9 cape         spring strands (bones baked by the Blender script) with gravity, drag and
                    inertia, kept out of the hips and legs, so the cloth follows every move

   Upper-body layers leave the legs to locomotion and only partly bend the spine, so a swing
   twists the chest without straightening the run's lean.
   ============================================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { buildWeapon } from '/game/lib/hero3d.js';

const HEIGHT = 1.55; // matches HERO_H in world3d
// Speeds (m/s, at HEIGHT) the walk / run clips cover with planted feet, measured in Blender.
// Playback is scaled to the real ground speed so the feet don't skate.
const WALK_V = 1.0, RUN_V = 2.7;
const UPPER = /(Spine|Neck|Head|Shoulder|Arm|Hand)/;
const FULL = new Set(['kick', 'land', 'knockdown']); // clips that take the legs as well
// How much of an upper-body layer the spine and head take (the rest of the arm chain takes all of it).
const SPINE_W = { Spine: 0.3, Spine1: 0.55, Spine2: 0.8, Neck: 0.4, Head: 0.3 };

const COMBO = { blade: ['slash', 'slash2', 'slash3'], bare: ['punch', 'punch2', 'kick'], cast: ['punch', 'punch2'] };
const COMBO_L = { blade: ['slashL'], bare: ['punchL'], cast: ['punchL'] };
const COMBO_GAP = 0.5;         // s after a swing ends that the next one still counts as a follow-up
const HURT = 0.45;             // s the hit reaction plays over
const HITS = ['hit', 'hit2'];
const EMOTES = { happy: ['cheer', 'victory', 'wave'] }; // a mood picks one of its gestures
const FIDGETS = ['look', 'stretch', 'fold'];
const FIDGET_AFTER = [7, 13];  // s of standing still before a fidget (random in range)
const LAND = { dur: 0.36, minVy: 3.5, fullVy: 12 }; // crouch length; impact speeds for none / full depth
const FLIP = 0.55;             // s for the mid-air flip
const BANK = { k: 0.035, max: 0.3 };   // lean into turns: rad per (rad/s × m/s)
const PITCH = { k: 0.03, max: 0.16 };  // lean against acceleration: rad per m/s²
const LOOK = { max: 1.1, share: { Spine2: 0.2, Neck: 0.3, Head: 0.5 } }; // head-turn limit, split along the neck

// Attack shaping, per clip. wind / hit: where the wind-up and strike keys sit in the clip (0..1).
// The game's swing progress is re-timed so the wind-up loads slowly, the strike snaps, holds a beat
// on impact, then eases out. lunge: m the body drives forward into the hit; twist: rad the hips
// coil back then whip through (sign = direction); dip: m the body sinks into a heavy blow.
const ATTACK = {
  slash: { wind: 0.35, hit: 0.53, lunge: 0.14, twist: 0.32, dip: 0 },
  slash2: { wind: 0.25, hit: 0.44, lunge: 0.12, twist: -0.36, dip: 0 },
  slash3: { wind: 0.28, hit: 0.44, lunge: 0.24, twist: 0.08, dip: 0.07 },
  slashL: { wind: 0.35, hit: 0.53, lunge: 0.14, twist: -0.32, dip: 0 },
  punch: { wind: 0.27, hit: 0.47, lunge: 0.12, twist: 0.3, dip: 0.02 },
  punch2: { wind: 0.27, hit: 0.47, lunge: 0.15, twist: -0.34, dip: 0.02 },
  punchL: { wind: 0.27, hit: 0.47, lunge: 0.12, twist: -0.3, dip: 0.02 },
  kick: { wind: 0.19, hit: 0.375, lunge: 0.08, twist: 0.12, dip: 0 },
};
const TIMING = { wind: 0.34, snap: 0.44, hold: 0.52 }; // game progress at wind-up, strike, end of the hit-stop
const ATTACK_SPINE = 0.55; // during a swing the spine takes this much more of the clip, so the chest really turns
const TRAIL = { n: 16, from: 0.3, to: 0.62 };          // ribbon samples; swing progress it's drawn over
// Carrying a weapon: the locomotion clips swing the arms as if empty-handed, which sweeps a blade
// through the thighs and, on the back-swing, the head. Outside a swing the weapon turns in the fist
// (as a wrist would) so it always points at least `out` to its own side, at least `fwd` ahead (not
// back over the arm that holds it) and no more than `up` upward (parts of its direction, in the
// hero's frame, before it's made unit length again). in: s to ease back after a swing.
const CARRY = { out: 0.42, fwd: 0.3, up: 0.2, in: 0.18 };
// Sheathed: weapons ride diagonally across the back, hilt up over the shoulder of the hand that
// holds it. back / up: m behind the chest / above the shoulders; lean: blade's sideways slope;
// dur: s for the weapon to fly between hand and back on a draw or sheathe.
const SHEATH = { back: 0.17, up: 0.06, lean: 0.55, dur: 0.2 };

// Cape: spring strands. stiff: pull toward the animated pose per 1/60 s (top → bottom of a strand);
// damp: velocity kept per 1/60 s (air drag); flutter: m of side-to-side ripple per m/s of speed.
// hang: how much each segment aims straight down rather than along the (leaning) torso;
// swing: max degrees a segment may swing off that aim (top → bottom of a strand).
// wind: how far back (per m/s of running, at the hem) each segment aims, so the cloak streams
// behind the runner instead of hanging into his striding legs.
const CAPE = { stiff: [0.5, 0.14], damp: 0.93, gravity: 9.8, flutter: 0.002, hang: 0.25, swing: [14, 60], wind: 0.16,
  colliders: [['Hips', null, 0.13], ['Spine1', null, 0.12], ['Spine2', null, 0.13], ['LeftUpLeg', 'LeftLeg', 0.085], ['RightUpLeg', 'RightLeg', 0.085],
    ['LeftLeg', 'LeftFoot', 0.06], ['RightLeg', 'RightFoot', 0.06],
    ['LeftArm', 'LeftForeArm', 0.08], ['RightArm', 'RightForeArm', 0.08], ['LeftForeArm', 'LeftHand', 0.06], ['RightForeArm', 'RightHand', 0.06]] };

// The world is lit for toon materials (shadow side floors at ~30-40%), but Tripo exports
// MeshStandardMaterial, whose shadow side falls to near black, so the face vanishes whenever it
// isn't toward the sun (and at night). Lift it with its own albedo as a soft fill plus a rim light,
// like hero3d's toon heroes. Tune FILL up if the face still reads too dark.
const FILL = 0.38, RIM_STRENGTH = 0.45, RIM_POWER = 2.3;
const RIM_COLOR = new THREE.Color('#ffe2ff');
function brighten(m, o = {}) {
  const fill = o.fill ?? FILL, rimS = o.rim ?? RIM_STRENGTH, rimC = o.rimColor ? new THREE.Color(o.rimColor) : RIM_COLOR;
  if (!m || m.userData.heroLit) return;
  m.userData.heroLit = true;
  if (m.map) { m.emissiveMap = m.map; m.emissive = new THREE.Color('#ffffff'); }
  else m.emissive = m.color.clone();
  m.emissiveIntensity = fill;
  m.roughness = Math.max(m.roughness ?? 0.5, 0.75); // no env map, so specular only adds dark sheen
  m.metalness = 0;
  m.onBeforeCompile = (s) => {
    s.uniforms.uRimColor = { value: rimC };
    s.fragmentShader = 'uniform vec3 uRimColor;\n' + s.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float rimF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), ${RIM_POWER.toFixed(2)});
      totalEmissiveRadiance += mix(diffuseColor.rgb, uRimColor, 0.45) * rimF * ${rimS.toFixed(2)};`);
  };
  m.customProgramCacheKey = () => `glbhero-rim-${rimS}`;
  m.needsUpdate = true;
}

// The GLB bodies a character can pick (character.body), and the files they're built from.
export const HERO_URL = { human: '/game/assets/characterart/human_game.glb', rogue: '/game/assets/characterart/rogue.glb' }; // clips baked by tools/blender/rogue_anims.py
let SRC = null;          // the last one loaded: what makeGlbHero builds unless look.body names another
const SRCS = {};         // url → loaded gltf
const SRC_LAST = () => SRC;
const LOADING = {}, GEAR_LOADING = {};
export const glbHeroReady = (body) => !!SRCS[HERO_URL[body] || body];
// loadGlbHero('human') or loadGlbHero(url). Loading the same one twice shares the first load.
export function loadGlbHero(which) {
  const url = HERO_URL[which] || which;
  LOADING[url] = LOADING[url] || new GLTFLoader().loadAsync(url).then((g) => {
    // the cape bones are simulated; drop the rest pose the exporter sampled into every clip
    for (const a of g.animations) a.tracks = a.tracks.filter((t) => !/^cape_/.test(t.name));
    g.scene.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach(brighten); });
    SRCS[url] = g;
    return g;
  });
  return LOADING[url].then((g) => { SRC = g; return g; });
}

// ---- gear: 3D clothing files, and which inventory items show them
// (the pants, boots and tunic are fitted from Tripo sculpts by tools/blender/wear_fit.py)
export const GEAR_URL = {
  green_cloak: '/game/assets/3ditems/green_cloak.glb',
  leather_pants: '/game/assets/3ditems/leather_pants_game.glb',
  leather_boots: '/game/assets/3ditems/leather_boots_game.glb',
  medieval_tunic: '/game/assets/3ditems/medieval_tunic_game.glb',
};
export const GEAR_FOR_ITEM = { ranger_hood: 'green_cloak', ranger_tunic: 'green_cloak', leather_boots: 'leather_boots' };
// The wardrobe (the Outfit rows in the world's bag): each piece's name and the part of the body it
// goes on. One piece per part: putting one on takes off whatever was there.
export const GEAR_INFO = {
  green_cloak: { name: 'Hooded Cloak', part: 'cloak', emoji: '\u{1F9E5}' },
  medieval_tunic: { name: 'Tunic', part: 'top', emoji: '\u{1F455}' },
  leather_pants: { name: 'Leather Pants', part: 'legs', emoji: '\u{1F456}' },
  leather_boots: { name: 'Leather Boots', part: 'feet', emoji: '\u{1F97E}' },
};
// What each hero starts out wearing (by its ?hero= name); ?wear=none strips it, ?wear=a,b replaces it
export const START_WEAR = { human: ['leather_pants', 'leather_boots', 'medieval_tunic', 'green_cloak'] };
export const wearFor = (hero, param) => param === 'none' ? [] : param ? param.split(',').filter(Boolean) : (START_WEAR[hero] || []);
const GEAR = {};
export async function loadGlbGear(ids = Object.keys(GEAR_URL)) {
  await Promise.all(ids.filter((id) => GEAR_URL[id]).map((id) => GEAR_LOADING[id] = GEAR_LOADING[id] || new GLTFLoader().loadAsync(GEAR_URL[id]).then((g) => {
    // cloth: a softer fill and a faint neutral rim (the hero's pink rim reads as lilac on fabric)
    g.scene.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach((m) => brighten(m, { fill: 0.22, rim: 0.12, rimColor: '#ffffff' })); });
    GEAR[id] = g;
  })));
}
// Re-bind a gear file's skinned meshes to the hero's bones (by name). Bones the hero lacks (cloth
// strands) move into the hero's skeleton under their parent, keeping their rest offsets. Adds the
// body vertices the gear covers (its hide_body extra, for a body of hide_body_of vertices) to `hide`.
function attachGear(model, gltf, hide) {
  const g = SkeletonUtils.clone(gltf.scene);
  const find = (n) => { let r = null; model.traverse((o) => { if (!r && o.isBone && o.name === n) r = o; }); return r; };
  const meshes = [];
  g.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  for (const sm of meshes) {
    const { hide_body: covered, hide_body_of: of } = sm.userData;
    if (covered && of) for (const i of covered) (hide[of] = hide[of] || new Set()).add(i);
    const src = sm.skeleton.bones;
    const mine = src.map((b) => find(b.name));
    src.forEach((b, i) => {
      if (mine[i] || (b.parent && b.parent.isBone && !find(b.parent.name) && src.includes(b.parent))) return;
      const host = b.parent && find(b.parent.name);
      if (host) host.add(b); // a strand root: hang it off the hero's own bone
    });
    const bones = src.map((b, i) => mine[i] || b);
    const host = (sm.parent && find(sm.parent.name)) || model.getObjectByProperty('isSkinnedMesh', true)?.parent || model;
    host.add(sm);
    sm.bind(new THREE.Skeleton(bones, sm.skeleton.boneInverses), sm.bindMatrix);
    sm.castShadow = true;
    sm.frustumCulled = false;
  }
  return meshes.length;
}

// Leave the body's triangles under worn clothing undrawn (all three corners covered), so skin can't
// show through where cloth runs close (inner thighs, armpits, feet in boots). The body keeps its
// shared vertex data; only this hero's copy gets a shorter index.
function hideUnder(bodies, hide) {
  for (const o of bodies) {
    const src = o.geometry, n = src.attributes.position.count, cut = hide[n];
    if (!cut || !src.index || src.groups.length > 1) continue;
    const idx = src.index.array, keep = [];
    for (let i = 0; i < idx.length; i += 3) {
      if (!(cut.has(idx[i]) && cut.has(idx[i + 1]) && cut.has(idx[i + 2]))) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    const g = new THREE.BufferGeometry();
    for (const k in src.attributes) g.setAttribute(k, src.attributes[k]);
    g.morphAttributes = src.morphAttributes;
    g.morphTargetsRelative = src.morphTargetsRelative;
    g.setIndex(keep);
    g.boundingBox = src.boundingBox;
    g.boundingSphere = src.boundingSphere;
    o.geometry = g;
  }
}

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (t) => t * t * (3 - 2 * t);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export function makeGlbHero(look = {}) {
  const eq = look.equipment || {};
  const SRC = (look.body && SRCS[HERO_URL[look.body]]) || SRC_LAST();
  const clip = (name) => SRC.animations.find((a) => a.name.toLowerCase() === name);
  const model = SkeletonUtils.clone(SRC.scene);
  // root (game-owned position / heading) > tilt (bank, pitch; pivots at the feet)
  //   > spin (flip; pivots at the waist) > model
  const root = new THREE.Group(), tilt = new THREE.Group(), spin = new THREE.Group(), lift = new THREE.Group();
  root.add(tilt); tilt.add(spin); spin.add(lift); lift.add(model);
  spin.position.y = HEIGHT * 0.5; lift.position.y = -HEIGHT * 0.5;
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.frustumCulled = false; // skinned bounds don't follow the animation
  });

  // stand on the ground, HEIGHT tall
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const h = Math.max(1e-3, box.max.y - box.min.y);
  model.scale.setScalar(HEIGHT / h);
  model.position.y = -box.min.y * (HEIGHT / h);

  // gear: what's asked for plus what the equipped items show
  const wear = [...new Set([...(Array.isArray(look.wear) ? look.wear : START_WEAR[look.body] || []), ...Object.values(eq).map((i) => GEAR_FOR_ITEM[i])])].filter((id) => GEAR[id]);
  const bodies = [];
  model.traverse((o) => { if (o.isSkinnedMesh) bodies.push(o); });
  const hide = {};
  for (const id of wear) attachGear(model, GEAR[id], hide);
  hideUnder(bodies, hide);
  // the hooded cloak carries its hood twice: up (hood) and pushed back onto the shoulders (cowl)
  const hoodUp = [], hoodDown = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (/^hood(_\d+)?$/.test(o.name)) hoodUp.push(o);
    else if (/^cowl(_\d+)?$/.test(o.name)) hoodDown.push(o);
  });
  let hood = hoodUp.length ? look.hood !== false : null;
  const setHood = (up) => {
    if (hood === null) return null;
    hood = !!up;
    for (const o of hoodUp) o.visible = hood;
    for (const o of hoodDown) o.visible = !hood;
    return hood;
  };
  setHood(hood);

  const bone = (n) => model.getObjectByName('mixamorig' + n) || model.getObjectByName('mixamorig:' + n);
  const B = { handR: bone('RightHand'), handL: bone('LeftHand') };

  // ---- layer 1-2: locomotion and air, one mixer, weights summing to 1
  const mixer = new THREE.AnimationMixer(model);
  const act = {};
  const add = (key, c) => { if (c) act[key] = mixer.clipAction(c); };
  add('idle', clip('idle') || SRC.animations[0]);
  add('walk', clip('walk') || clip('run'));
  add('run', clip('run') || clip('walk'));
  add('jump', clip('jump'));
  add('fall', clip('fall'));
  for (const k of ['idle', 'walk', 'run']) if (act[k]) { act[k].play(); act[k].setEffectiveWeight(k === 'idle' ? 1 : 0); }
  for (const k of ['jump', 'fall']) if (act[k]) { act[k].play(); act[k].paused = true; act[k].setEffectiveWeight(0); }
  const hasAir = !!(act.jump && act.fall);

  // ---- layers 3-7: posed clips, sampled straight from their tracks and slerped over what's there.
  // (Not through a second AnimationMixer: a mixer skips writing a value that hasn't changed since
  // its last write, so a held pose would lose to the locomotion mixer rewriting the same bones.)
  const L = {};
  const _p = new THREE.Vector3();
  for (const c of SRC.animations) {
    const name = c.name.toLowerCase();
    if (['idle', 'walk', 'run', 'jump', 'fall'].includes(name)) continue;
    const full = FULL.has(name);
    const targets = [];
    for (const t of c.tracks) {
      const [node, prop] = t.name.split('.');
      const pos = prop === 'position';
      if (!(prop === 'quaternion' || (full && pos && /Hips$/.test(node)))) continue;
      if (!full && !UPPER.test(node)) continue;
      const b = model.getObjectByName(node);
      if (!b) continue;
      const w = full ? 1 : (SPINE_W[node.replace(/^mixamorig:?/, '')] ?? 1);
      targets.push({ b, pos, w, f: t.createInterpolant() });
    }
    L[name] = { dur: c.duration, targets };
  }
  // pose(name, t, w, spine): blend clip `name` at time t (s) over the current pose with weight w;
  // spine 0..1 lets the spine / head take more of an upper-body clip than usual
  function pose(name, t, w, spine = 0) {
    const l = L[name];
    if (!l || w <= 0.001) return;
    w = Math.min(1, w);
    t = clamp(t, 0, l.dur);
    for (const x of l.targets) {
      const v = x.f.evaluate(t), k = w * (x.w + (1 - x.w) * spine);
      if (x.pos) x.b.position.lerp(_p.fromArray(v), k);
      else x.b.quaternion.slerp(_q.fromArray(v), k);
    }
  }
  const has = (n) => !!L[n];

  // weapons on the hand bones, oriented from each bone's rest pose so its own axes don't matter
  model.updateMatrixWorld(true);
  const REST = { blade: 1.85, wand: 1.5, pole: 0.75 };
  const hold = (b, id, side) => {
    if (!b || !id) return null;
    const g = new THREE.Group(), qBone = b.getWorldQuaternion(new THREE.Quaternion()).invert();
    b.add(g);
    const W = buildWeapon(id, g);
    if (!W) { g.removeFromParent(); return null; }
    const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(REST[W.type] ?? 1.5, 0, W.type === 'pole' ? -0.3 * side : 0));
    g.quaternion.copy(qBone).multiply(want);
    const ws = b.getWorldScale(new THREE.Vector3()).x || 1;
    g.scale.setScalar(1 / ws); // weapons are built in world units; undo the model's scale
    g.position.copy(new THREE.Vector3(0, -0.04, 0.01).applyQuaternion(qBone).multiplyScalar(1 / ws));
    const tip = new THREE.Object3D();
    tip.position.set(...W.tip);
    g.add(tip);
    return { W, tip, g, q0: g.quaternion.clone(), out: side < 0 ? -1 : 1, k: 1,
      hand: b, home: { p: g.position.clone(), q: g.quaternion.clone(), s: g.scale.clone() }, back: null, sh: 0, from: null };
  };
  // where a sheathed weapon sits, in the chest bone's frame (measured on idle, see below): grip behind the shoulder on its own
  // side, the weapon (built along +y from the grip) slanting down across the back to the other hip.
  // The hero faces +z, so its right is -x; side is -1 for the right hand.
  const chest = bone('Spine2') || bone('Spine1') || bone('Spine');
  // back: m behind the chest (backClear: enough to lie over the cloth worn there)
  function backMount(side, back = SHEATH.back) {
    const sh = side < 0 ? bone('RightArm') : bone('LeftArm');
    if (!chest || !sh) return null;
    const qr = root.getWorldQuaternion(new THREE.Quaternion());
    const toWorld = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(qr);
    const cp = chest.getWorldPosition(new THREE.Vector3()), sp = sh.getWorldPosition(new THREE.Vector3());
    const local = sp.clone().sub(cp).applyQuaternion(qr.clone().invert()); // shoulder, hero frame
    const grip = cp.clone().add(toWorld(local.x * 0.6, local.y + SHEATH.up, -back));
    const y = toWorld(-side * SHEATH.lean, -1, -0.12).normalize();         // down, toward the far hip
    const z = toWorld(0, 0, -1); z.sub(y.clone().multiplyScalar(z.dot(y))).normalize(); // flat to the back
    const x = new THREE.Vector3().crossVectors(y, z);
    const M = new THREE.Matrix4().makeBasis(x, y, z).setPosition(grip);
    M.premultiply(chest.matrixWorld.clone().invert());
    const m = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
    M.decompose(m.p, m.q, m.s);
    return m;
  }
  // how far behind the chest a sheathed weapon of this length must sit so it lies over the visible
  // gear (a cloak's cape and folded-down hood) rather than through it: the deepest gear point within
  // a hand's width of the weapon's line across the back, seen from behind, plus a little. The
  // weapon slants back as it goes down (backMount's -0.12), so lower points need less
  const gearMeshes = [];
  model.traverse((o) => { if (o.isSkinnedMesh && !bodies.includes(o)) gearMeshes.push(o); });
  const SLANT = 0.12 / Math.hypot(SHEATH.lean, 1);
  function backClear(side, len) {
    const sh = side < 0 ? bone('RightArm') : bone('LeftArm');
    if (!chest || !sh) return SHEATH.back;
    const qi = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const cp = chest.getWorldPosition(new THREE.Vector3());
    const g = sh.getWorldPosition(new THREE.Vector3()).sub(cp).applyQuaternion(qi);
    const gx = g.x * 0.6, gy = g.y + SHEATH.up, d = new THREE.Vector2(-side * SHEATH.lean, -1).normalize();
    const v = new THREE.Vector3();
    let need = SHEATH.back;
    for (const o of gearMeshes) {
      if (!o.visible) continue;
      o.skeleton.update();
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        o.applyBoneTransform(i, v);
        v.applyMatrix4(o.matrixWorld).sub(cp).applyQuaternion(qi);
        const rx = v.x - gx, ry = v.y - gy, t = rx * d.x + ry * d.y;
        if (t < -0.04 || t > len || Math.abs(rx * d.y - ry * d.x) > 0.06) continue;
        need = Math.max(need, -v.z - SLANT * Math.max(0, t) + 0.012);
      }
    }
    return need;
  }
  // sheathe / draw: reparent at once, then fly the weapon over from where it was (re-evaluated
  // each frame on its old bone, so it follows the body) to where it now belongs
  const _mA = new THREE.Matrix4(), _mB = new THREE.Matrix4(), _pA = new THREE.Vector3(), _pB = new THREE.Vector3(),
    _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _sA = new THREE.Vector3(), _sB = new THREE.Vector3();
  const onBack = (w) => !!w && w.g.parent === chest;
  function sheath(w, want) { // before carry(): put the weapon on its new bone, at its resting spot
    if (!w || !w.back) return;
    if (want !== onBack(w)) {
      w.from = { par: w.g.parent, p: w.g.position.clone(), q: w.g.quaternion.clone(), s: w.g.scale.clone() };
      w.sh = 0;
      (want ? chest : w.hand).add(w.g);
    } else if (!w.from) return;
    // while flying, sheathBlend overwrote last frame's spot: start again from the mount
    const m = want ? w.back : w.home;
    w.g.position.copy(m.p); w.g.quaternion.copy(m.q); w.g.scale.copy(m.s);
  }
  function sheathBlend(w, dt) { // after carry(): ease it there from where it was
    if (!w || !w.from) return;
    w.sh = Math.min(1, w.sh + dt / SHEATH.dur);
    if (w.sh >= 1) { w.from = null; return; }
    const k = ease(w.sh), par = w.g.parent;
    par.updateWorldMatrix(true, false);
    w.from.par.updateWorldMatrix(true, false);
    _mA.compose(w.from.p, w.from.q, w.from.s).premultiply(w.from.par.matrixWorld).decompose(_pA, _qA, _sA);
    _mB.compose(w.g.position, w.g.quaternion, w.g.scale).premultiply(par.matrixWorld).decompose(_pB, _qB, _sB);
    _mA.compose(_pA.lerp(_pB, k), _qA.slerp(_qB, k), _sA.lerp(_sB, k)).premultiply(_mB.copy(par.matrixWorld).invert());
    _mA.decompose(w.g.position, w.g.quaternion, w.g.scale);
  }
  const R = hold(B.handR, eq.rhand, -1), Lh = hold(B.handL, eq.lhand, 1);
  // the back mounts are measured on idle's first frame: the GLB's bind pose (what the hand mounts
  // above are aimed from) holds the chest at a different angle from any pose the game shows
  if (R || Lh) {
    mixer.update(0);
    model.updateMatrixWorld(true);
    // one mount per hood state (the hood up and the hood down cover the back differently)
    const h0 = hood;
    for (const up of hood === null ? [null] : [true, false]) {
      setHood(up);
      for (const [w, side] of [[R, -1], [Lh, 1]]) if (w) (w.backs ||= {})[up] = backMount(side, backClear(side, w.tip.position.length()));
    }
    setHood(h0);
    pickBacks();
  }
  // after the hood goes up or down, sheathed weapons move to that state's mount
  function pickBacks() {
    for (const w of [R, Lh]) {
      if (!w || !w.backs) continue;
      w.back = w.backs[hood];
      if (onBack(w) && !w.from && w.back) { w.g.position.copy(w.back.p); w.g.quaternion.copy(w.back.q); w.g.scale.copy(w.back.s); }
    }
  }
  const style = (w) => !w ? 'bare' : (w.W.type === 'wand' || w.W.bow) ? 'cast' : 'blade';
  const combos = { R: COMBO[style(R)].filter(has), L: COMBO_L[style(Lh)].filter(has) };

  // ---- weapon trail: a ribbon between two points (blade base → tip, or along the striking limb)
  const tN = TRAIL.n, tPos = new Float32Array(tN * 6), tCol = new Float32Array(tN * 6), samples = [];
  const tGeo = new THREE.BufferGeometry();
  tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  tGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
  const tIdx = [];
  for (let i = 0; i < tN - 1; i++) { const a = i * 2; tIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  tGeo.setIndex(tIdx);
  const trail = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  trail.frustumCulled = false;
  trail.visible = false;
  const baseOf = (w) => { if (!w || !w.W.base) return null; const o = new THREE.Object3D(); o.position.set(...w.W.base); w.tip.parent.add(o); return o; };
  const bladeBase = { R: baseOf(R), L: baseOf(Lh) };
  const trailCol = { R: new THREE.Color(R ? R.W.trail || '#ffffff' : '#bfe6ff'), L: new THREE.Color(Lh ? Lh.W.trail || '#ffffff' : '#bfe6ff') };
  const limb = { punch: ['RightHand', 'RightForeArm'], punch2: ['LeftHand', 'LeftForeArm'], punchL: ['LeftHand', 'LeftForeArm'], kick: ['RightFoot', 'RightLeg'] };
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  function trailPoints(hand, name) { // → _a tip, _b base, in world space
    const wpn = hand === 'R' ? R : Lh;
    if (wpn && bladeBase[hand] && !limb[name]) { wpn.tip.getWorldPosition(_a); bladeBase[hand].getWorldPosition(_b); return true; }
    const [e, f] = limb[name] || (hand === 'R' ? ['RightHand', 'RightForeArm'] : ['LeftHand', 'LeftForeArm']);
    const be = bone(e), bf = bone(f);
    if (!be || !bf) return false;
    be.getWorldPosition(_a); bf.getWorldPosition(_b);
    _b.lerp(_a, 0.6); // a short ribbon off the fist / foot
    return true;
  }
  let trailHand = 'R';

  // ---- cape strands: cape_<c>_<k> … cape_<c>_end, each simulated as a chain of tail particles
  const capeChains = [];
  for (let c = 0; ; c++) {
    const bs = [];
    for (let k = 0; bone && model.getObjectByName(`cape_${c}_${k}`); k++) bs.push(model.getObjectByName(`cape_${c}_${k}`));
    const end = model.getObjectByName(`cape_${c}_end`);
    if (!bs.length || !end) break;
    capeChains.push(bs.map((b, k) => ({ b, child: bs[k + 1] || end, rest: b.quaternion.clone(), p: new THREE.Vector3(), pp: new THREE.Vector3(), len: 0, k: k / Math.max(1, bs.length - 1) })));
  }
  const colliders = CAPE.colliders.map(([a, b, r]) => ({ a: bone(a), b: b && bone(b), r })).filter((c) => c.a);
  let capeReady = false;
  const _h = new THREE.Vector3(), _t = new THREE.Vector3(), _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3();
  const _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _rq = new THREE.Quaternion();
  function pushOut(P) {
    for (const c of colliders) {
      c.a.getWorldPosition(_c1);
      let q = _c1;
      if (c.b) { // nearest point on the bone segment
        c.b.getWorldPosition(_c2);
        _d.subVectors(_c2, _c1);
        const t = clamp(_n.subVectors(P, _c1).dot(_d) / Math.max(1e-6, _d.lengthSq()), 0, 1);
        q = _c2.copy(_c1).addScaledVector(_d, t);
      }
      _n.subVectors(P, q);
      const d = _n.length();
      if (d < c.r && d > 1e-5) P.addScaledVector(_n, (c.r - d) / d);
    }
  }
  function simCape(dt, speed, floorY) {
    if (!capeChains.length) return;
    const f = dt * 60, damp = Math.pow(CAPE.damp, f), gy = -CAPE.gravity * dt * dt;
    root.updateWorldMatrix(true, true);
    root.getWorldQuaternion(_rq);
    const side = _n.set(1, 0, 0).applyQuaternion(_rq).clone();
    const back = _n.set(0, 0, -1).applyQuaternion(_rq).clone();
    for (const chain of capeChains) {
      for (const s of chain) s.b.quaternion.copy(s.rest);
      chain[0].b.updateMatrixWorld(true);
      for (const s of chain) {
        s.b.getWorldPosition(_h);
        s.child.getWorldPosition(_t); // where the animated (rest-relative) pose would put this tail
        const animDir = _c1.subVectors(_t, _h).normalize().clone();
        // aim partly straight down, so a leaning torso doesn't tip the cape out behind
        const aim = _c2.copy(animDir).lerp(_n.set(0, -1, 0), CAPE.hang).addScaledVector(back, CAPE.wind * speed * (0.25 + 0.75 * s.k)).normalize().clone();
        const tgt = _d.copy(_h).addScaledVector(aim, _h.distanceTo(_t)).clone();
        if (!capeReady || s.p.distanceToSquared(_t) > 4) { s.p.copy(tgt); s.pp.copy(tgt); s.len = _h.distanceTo(_t); }
        const stiff = 1 - Math.pow(1 - (CAPE.stiff[0] + (CAPE.stiff[1] - CAPE.stiff[0]) * s.k), f);
        _d.subVectors(s.p, s.pp).multiplyScalar(damp);
        s.pp.copy(s.p);
        s.p.add(_d);
        s.p.y += gy;
        s.p.addScaledVector(side, Math.sin(st.clock * 13 + s.k * 4 + capeChains.indexOf(chain) * 2) * CAPE.flutter * speed * s.k * f);
        s.p.lerp(tgt, stiff);
        pushOut(s.p);
        if (s.p.y < floorY + 0.02) s.p.y = floorY + 0.02;
        // keep the cloth from stretching, and from swinging further than `swing` off its aim
        const dir = _c2.subVectors(s.p, _h).normalize();
        const maxA = THREE.MathUtils.degToRad(CAPE.swing[0] + (CAPE.swing[1] - CAPE.swing[0]) * s.k);
        const ang = dir.angleTo(aim);
        if (ang > maxA) {
          _q.setFromUnitVectors(aim, dir);
          _q.slerpQuaternions(_wq.identity(), _q, maxA / ang);
          dir.copy(aim).applyQuaternion(_q);
        }
        s.p.copy(_h).addScaledVector(dir, s.len);
        // the limits can put it back inside a leg or arm: push out once more, then restore the length
        pushOut(s.p);
        dir.subVectors(s.p, _h).normalize();
        s.p.copy(_h).addScaledVector(dir, s.len);
        // turn the bone so its tail lands on the particle
        const from = animDir, to = dir;
        _q.setFromUnitVectors(from, to);
        s.b.getWorldQuaternion(_wq);
        s.b.parent.getWorldQuaternion(_pq);
        s.b.quaternion.copy(_pq.invert().multiply(_q.multiply(_wq)));
        s.b.updateMatrixWorld(true);
      }
    }
    capeReady = true;
  }

  // ---- procedural helpers: rotate a bone about a world axis, whatever its own axes are
  const lookBones = Object.entries(LOOK.share).map(([n, k]) => ({ b: bone(n), k })).filter((x) => x.b);
  function turnBone(b, axis, ang) {
    b.parent.getWorldQuaternion(_q2);
    _q.setFromAxisAngle(axis, ang);
    b.quaternion.premultiply(_q2.clone().invert().multiply(_q).multiply(_q2));
    b.updateMatrixWorld(true);
  }

  const st = {
    prev: new THREE.Vector3(), first: true, clock: 0,
    speed: 0, accel: 0, yaw: 0, yawRate: 0, bank: 0, pitch: 0, lookYaw: 0,
    air: 0, wasAir: false, lastVy: 0, flip: -1, land: null,
    swing: { R: { p: -1, i: 0, name: null, end: -9 }, L: { p: -1, i: 0, name: null, end: -9 } },
    hurt: 0, hurtClip: 'hit', gesture: null, still: 0, nextFidget: FIDGET_AFTER[0], down: 0, downT: 0,
  };
  const startGesture = (name, interruptible) => {
    if (!has(name)) return false;
    st.gesture = { name, t: 0, dur: L[name].dur, fade: 1, interruptible };
    return true;
  };

  function swing(hand, p) {
    const s = st.swing[hand], list = combos[hand];
    if (!list.length) return;
    if (p >= 0 && (s.p < 0 || p < s.p)) { // a new swing starts
      s.i = st.clock - s.end < COMBO_GAP && s.name ? (s.i + 1) % list.length : 0;
      s.name = list[s.i];
    }
    if (p < 0 && s.p >= 0) s.end = st.clock;
    s.p = p;
    if (p < 0 || !s.name) return;
    const A = ATTACK[s.name] || { wind: 0.3, hit: 0.5, lunge: 0, twist: 0, dip: 0 };
    // re-time: slow load to the wind-up, snap to the strike, hold on impact, ease out
    let q;
    if (p < TIMING.wind) q = A.wind * ease(p / TIMING.wind);
    else if (p < TIMING.snap) { const k = (p - TIMING.wind) / (TIMING.snap - TIMING.wind); q = A.wind + (A.hit - A.wind) * k * k; }
    else if (p < TIMING.hold) q = A.hit;
    else { const k = (p - TIMING.hold) / (1 - TIMING.hold); q = A.hit + (1 - A.hit) * (1 - (1 - k) * (1 - k)); }
    const w = Math.min(1, p / 0.08, (1 - p) / 0.25);
    pose(s.name, q * L[s.name].dur, w, ATTACK_SPINE);
    // body drive: coil back with the wind-up, whip through on the strike, settle after
    const into = p < TIMING.wind ? -0.35 * ease(p / TIMING.wind)
      : p < TIMING.snap ? -0.35 + 1.35 * ease((p - TIMING.wind) / (TIMING.snap - TIMING.wind))
        : p < TIMING.hold ? 1 : 1 - ease((p - TIMING.hold) / (1 - TIMING.hold));
    fx.lunge += A.lunge * Math.max(0, into) * w;
    fx.twist += A.twist * into * w;
    fx.dip += A.dip * Math.max(0, into) * w;
    if (p >= TRAIL.from && p < TRAIL.to) { fx.trail = true; trailHand = hand; fx.trailName = s.name; }
  }
  const fx = { lunge: 0, twist: 0, dip: 0, trail: false, trailName: null };
  const hipsBone = bone('Hips');

  // keep a carried weapon out of the body (see CARRY). k: 1 carrying … 0 mid-swing (the clip aims it)
  const _cw = new THREE.Quaternion(), _cr = new THREE.Quaternion(), _cd = new THREE.Vector3(), _ce = new THREE.Vector3(), _cg = new THREE.Vector3();
  function carry(w, swinging, dt) {
    if (!w) return;
    w.k = swinging ? damp(w.k, 0, 40, dt) : Math.min(1, w.k + dt / CARRY.in);
    w.g.quaternion.copy(w.q0);
    if (w.k < 0.001) return;
    w.g.updateWorldMatrix(true, true);
    root.getWorldQuaternion(_cr);
    w.g.getWorldPosition(_cg);
    w.tip.getWorldPosition(_cd).sub(_cg).normalize().applyQuaternion(_cw.copy(_cr).invert()); // weapon direction, hero frame
    // the hero faces +z, so its right side is -x; w.out is +1 for the left hand, -1 for the right
    _ce.set(Math.max(_cd.x * w.out, CARRY.out) * w.out, Math.min(_cd.y, CARRY.up), Math.max(_cd.z, CARRY.fwd)).normalize();
    if (_ce.distanceToSquared(_cd) < 1e-6) return;
    _q.setFromUnitVectors(_cd, _ce);
    if (w.k < 1) _q.slerp(_cw.identity(), 1 - w.k);
    // that turn is in the hero's frame: bring it into the hand's
    w.g.parent.getWorldQuaternion(_cw);
    _q.premultiply(_cr).multiply(_cr.invert());           // → world
    w.g.quaternion.premultiply(_q.premultiply(_cw.clone().invert()).multiply(_cw));
  }

  return {
    root,
    setHood: (up) => { const r = setHood(up); pickBacks(); return r; },
    get hood() { return hood; },
    caster: R && R.W.cast ? R.W.cast : null,
    casterL: Lh && Lh.W.cast ? Lh.W.cast : null,
    tipWorld: (v) => (R ? R.tip : B.handR || root).getWorldPosition(v),
    tipWorldL: (v) => (Lh ? Lh.tip : B.handL || root).getWorldPosition(v),
    update(dt, s = {}) {
      dt = Math.min(dt, 0.1);
      st.clock += dt;
      // ---- read the motion off the root
      const pos = root.position;
      if (st.first) { st.prev.copy(pos); st.yaw = root.rotation.y; st.first = false; }
      const v = Math.hypot(pos.x - st.prev.x, pos.z - st.prev.z) / Math.max(dt, 1e-4);
      st.prev.copy(pos);
      const speed0 = st.speed;
      st.speed = damp(st.speed, v < 0.05 ? 0 : v, 10, dt);
      st.accel = damp(st.accel, (st.speed - speed0) / Math.max(dt, 1e-4), 8, dt);
      const yaw = root.rotation.y;
      st.yawRate = damp(st.yawRate, wrap(yaw - st.yaw) / Math.max(dt, 1e-4), 10, dt);
      st.yaw = yaw;
      const vy = s.vy ?? 0, air = !!s.air, down = !!s.down;

      // ---- 1 locomotion + 2 air
      const m = Math.min(1, st.speed / 0.6), r = clamp((st.speed - 1.3) / 1.2, 0, 1);
      if (act.walk) act.walk.timeScale = clamp(st.speed / WALK_V, 0.5, 1.8);
      if (act.run) act.run.timeScale = clamp(st.speed / RUN_V, 0.6, 2.3);
      st.air = damp(st.air, air ? 1 : 0, air ? 14 : 9, dt);
      const g = 1 - (hasAir ? st.air : 0);
      act.idle?.setEffectiveWeight((1 - m) * g);
      act.walk?.setEffectiveWeight(m * (1 - r) * g);
      act.run?.setEffectiveWeight(m * r * g);
      // a second jump in mid-air (vertical speed kicked back up) → forward flip
      if (air && st.wasAir && vy > st.lastVy + 3) st.flip = 0;
      if (hasAir) {
        let f = clamp((1.5 - vy) / 3, 0, 1); // rising → jump pose, dropping → fall pose
        let jt = clamp(1 - vy / 7.4, 0, 1);
        if (st.flip >= 0) { f = 0; jt = 1; } // hold the tuck through the flip
        act.jump.setEffectiveWeight((1 - g) * (1 - f));
        act.fall.setEffectiveWeight((1 - g) * f);
        act.jump.time = act.jump.getClip().duration * jt;                 // push-off → tuck at the apex
        act.fall.time = act.fall.getClip().duration * clamp(-vy / 9, 0, 1); // legs reach down as you drop
      }
      mixer.update(dt);

      // ---- 3 landing: crouch as deep as the fall was hard
      if (st.wasAir && !air && !down) {
        const k = clamp((-st.lastVy - LAND.minVy) / (LAND.fullVy - LAND.minVy), 0, 1);
        if (k > 0) st.land = { t: 0, amp: k * (st.speed > 1 ? 0.6 : 1) };
        st.flip = -1;
      }
      if (air) st.lastVy = vy;
      st.wasAir = air;
      if (st.land) {
        st.land.t += dt;
        const p = st.land.t / LAND.dur;
        if (p >= 1) st.land = null;
        else pose('land', p * L.land?.dur, st.land.amp * Math.min(1, p / 0.08));
      }

      // ---- 4 gestures: emotes, and fidgets after standing still
      const busy = st.swing.R.p >= 0 || st.swing.L.p >= 0 || st.hurt > 0 || down;
      const idle = st.speed < 0.1 && !air && !busy && !s.lookAt;
      st.still = idle && !st.gesture ? st.still + dt : (st.gesture ? st.still : 0);
      if (st.still > st.nextFidget) {
        st.still = 0;
        st.nextFidget = FIDGET_AFTER[0] + Math.random() * (FIDGET_AFTER[1] - FIDGET_AFTER[0]);
        startGesture(pick(FIDGETS.filter(has)), true);
      }
      const G = st.gesture;
      if (G) {
        G.t += dt;
        if (G.interruptible && (st.speed > 0.3 || air || busy)) G.fade = damp(G.fade, 0, 10, dt);
        if (G.t >= G.dur || G.fade < 0.02) st.gesture = null;
        else pose(G.name, G.t, G.fade * Math.min(1, G.t / 0.2, (G.dur - G.t) / 0.3));
      }

      // ---- 5 hurt
      if (st.hurt > 0) {
        st.hurt -= dt;
        const p = 1 - Math.max(0, st.hurt) / HURT;
        pose(st.hurtClip, p * L[st.hurtClip]?.dur, Math.min(1, p / 0.1, (1 - p) / 0.3));
      }

      // ---- 6 attacks, per hand, walking the combo on quick follow-ups
      fx.lunge = fx.twist = fx.dip = 0; fx.trail = false;
      swing('R', down ? -1 : Math.min(1, s.atk ?? -1));
      swing('L', down ? -1 : Math.min(1, s.atkL ?? -1));

      // ---- 7 knockdown
      st.down = damp(st.down, down ? 1 : 0, down ? 12 : 6, dt);
      st.downT = down ? st.downT + dt : 0;
      if (st.down > 0.01 && L.knockdown) pose('knockdown', down ? st.downT : L.knockdown.dur, st.down);

      // ---- 8 procedural: lean into turns and against acceleration, track lookAt, flip
      const bankT = down ? 0 : clamp(-st.yawRate * st.speed * BANK.k, -BANK.max, BANK.max);
      const pitchT = down || air ? 0 : clamp(st.accel * PITCH.k, -PITCH.max, PITCH.max);
      st.bank = damp(st.bank, bankT, 8, dt);
      st.pitch = damp(st.pitch, pitchT, 6, dt);
      tilt.rotation.set(st.pitch, 0, st.bank);

      let lookT = 0;
      if (s.lookAt && !down) lookT = clamp(wrap(Math.atan2(s.lookAt.x - pos.x, s.lookAt.z - pos.z) - yaw), -LOOK.max, LOOK.max);
      st.lookYaw = damp(st.lookYaw, lookT, 6, dt);
      if (Math.abs(st.lookYaw) > 0.005 && lookBones.length) {
        model.updateMatrixWorld(true);
        root.getWorldQuaternion(_q);
        const up = _v.copy(Y_AXIS).applyQuaternion(_q).clone();
        for (const x of lookBones) turnBone(x.b, up, st.lookYaw * x.k);
      }

      if (st.flip >= 0) {
        st.flip += dt / FLIP;
        if (st.flip >= 1) st.flip = -1;
      }
      spin.rotation.x = st.flip >= 0 ? Math.PI * 2 * ease(st.flip) : 0;

      // attack drive: lunge and dip move the whole body; the hips twist about the vertical
      st.lunge = damp(st.lunge ?? 0, fx.lunge, 30, dt);
      st.dip = damp(st.dip ?? 0, fx.dip, 30, dt);
      lift.position.set(0, -HEIGHT * 0.5 - st.dip, st.lunge);
      if (hipsBone && Math.abs(fx.twist) > 1e-3) {
        model.updateMatrixWorld(true);
        root.getWorldQuaternion(_q);
        turnBone(hipsBone, _v.copy(Y_AXIS).applyQuaternion(_q).clone(), fx.twist);
      }

      model.updateMatrixWorld(true);
      // sheathed rides on the back, but a swing in progress always has the weapon in hand
      sheath(R, !!s.sheathed && st.swing.R.p < 0);
      sheath(Lh, !!s.sheathed && st.swing.L.p < 0);
      if (!onBack(R)) carry(R, down || st.swing.R.p >= 0, dt);
      if (!onBack(Lh)) carry(Lh, down || st.swing.L.p >= 0, dt);
      sheathBlend(R, dt);
      sheathBlend(Lh, dt);

      // trail
      const scene = root.parent;
      if (scene && !trail.parent) scene.add(trail);
      if (fx.trail) {
        model.updateMatrixWorld(true);
        if (trailPoints(trailHand, fx.trailName)) {
          samples.unshift([_a.x, _a.y, _a.z, _b.x, _b.y, _b.z]);
          if (samples.length > tN) samples.pop();
        }
      } else if (samples.length) samples.splice(-Math.min(samples.length, 3));
      trail.visible = samples.length > 1;
      if (trail.visible) {
        const c = trailCol[trailHand];
        for (let i = 0; i < tN; i++) {
          const sm = samples[Math.min(i, samples.length - 1)], fade = Math.pow(1 - i / tN, 1.6);
          tPos.set(sm, i * 6);
          for (let j = 0; j < 2; j++) { const b = fade * (j ? 0.2 : 1); tCol.set([c.r * b, c.g * b, c.b * b], i * 6 + j * 3); }
        }
        tGeo.attributes.position.needsUpdate = tGeo.attributes.color.needsUpdate = true;
      }

      // ---- 9 cape, last, so it reacts to the final pose
      simCape(dt, st.speed, pos.y);
    },
    hurt() { st.hurt = HURT; st.hurtClip = pick(HITS.filter(has).length ? HITS.filter(has) : ['hit']); },
    emote(name = 'happy') {
      const opts = (EMOTES[name] || [name]).filter(has);
      if (opts.length) startGesture(pick(opts), false);
    },
    fidget(name) { return startGesture(name || pick(FIDGETS.filter(has)), true); },
    dispose() { mixer.stopAllAction(); trail.removeFromParent(); tGeo.dispose(); },
    setVisible(v) { root.visible = v; },
    canSheathe: !!((R && R.back) || (Lh && Lh.back)), // holding something that can go on the back
  };
}
