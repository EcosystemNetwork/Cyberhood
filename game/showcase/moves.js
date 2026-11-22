/* ============================================================================
   moves.js: hand-keyed combat moves, layered over glbhero's animation at runtime.

   Same vocabulary as tools/blender/rogue_anims.py, so a move can later be baked into the GLB
   unchanged. Directions are in the character's own frame: F forward, R right, U up (combine as
   'F+U', '-R'). A key is { op: degrees }:
     'swing Bone DIR'   rotate the bone (and its children) by deg toward DIR
     'turn Bone AXIS'   rotate about AXIS: +U turns left, +F rolls the top to the right, +R tips the top back
   A move is keys on a timeline (s), eased between, additive on whatever the body is doing:
   the reaction of a hit plays over a run, the guard recoil over the guard pose. `hold` parks the
   timeline on a key until release() (a charged attack's wind-up).
   ============================================================================ */
import * as THREE from 'three';

export const MOVES = {
  // a blow from the front / back / left / right: the body gives the way the blow pushes it
  hitF: { keys: [[0, {}], [0.07, { 'turn Spine1 R': 10, 'turn Spine2 R': 12, 'turn Head R': 16, 'swing LeftArm -F': 14, 'swing RightArm -F': 10 }], [0.45, {}]] },
  hitB: { keys: [[0, {}], [0.07, { 'turn Spine1 R': -14, 'turn Spine2 R': -10, 'turn Head R': 14, 'swing LeftArm F+U': 18, 'swing RightArm F+U': 14 }], [0.45, {}]] },
  hitL: { keys: [[0, {}], [0.07, { 'turn Spine1 F': 9, 'turn Spine2 F': 9, 'turn Spine2 U': -16, 'turn Head F': -10, 'swing LeftArm -R+U': 16 }], [0.45, {}]] },
  hitR: { keys: [[0, {}], [0.07, { 'turn Spine1 F': -9, 'turn Spine2 F': -9, 'turn Spine2 U': 16, 'turn Head F': 10, 'swing RightArm R+U': 16 }], [0.45, {}]] },
  // a blow taken on the guard: the arms give, the chest rocks back, then it all comes back up
  block: { keys: [[0, {}], [0.06, { 'turn Spine1 R': 6, 'turn Spine2 R': 7, 'turn Head R': 5, 'swing RightArm -F': 12, 'swing LeftArm -F': 10, 'swing RightForeArm U': 8 }], [0.34, {}]] },
  // guard broken: arms flung wide, chest thrown back, a long stagger before the hands come back
  guardBreak: { keys: [[0, {}], [0.08, { 'turn Spine1 R': 16, 'turn Spine2 R': 16, 'turn Head R': 20, 'swing RightArm R+U': 40, 'swing LeftArm -R+U': 36, 'swing RightForeArm R': 20 }],
    [0.55, { 'turn Spine1 R': 10, 'turn Spine2 R': 8, 'turn Head R': 8, 'swing RightArm R+U': 22, 'swing LeftArm -R+U': 18 }], [0.85, {}]] },
  // parry: the blade beats outward and the chest turns with it, then returns to guard
  parry: { keys: [[0, {}], [0.07, { 'turn Spine2 U': -22, 'turn Spine1 U': -10, 'swing RightForeArm R+F': 34, 'swing RightArm R': 18 }], [0.3, {}]] },
  // the charged heavy: coil (held), then release
  heavyWind: { hold: 1, keys: [[0, {}], [0.35, { 'turn Spine1 U': -18, 'turn Spine2 U': -22, 'turn Spine2 R': 10, 'turn Head U': 20, 'swing RightArm U-F': 70, 'swing RightForeArm U': 45, 'swing LeftArm F': 25 }],
    [0.5, { 'turn Spine1 U': -18, 'turn Spine2 U': -22, 'turn Spine2 R': 10, 'turn Head U': 20, 'swing RightArm U-F': 70, 'swing RightForeArm U': 45, 'swing LeftArm F': 25 }]] },
  heavyStrike: { keys: [[0, { 'turn Spine1 U': -18, 'turn Spine2 U': -22, 'turn Spine2 R': 10, 'turn Head U': 20, 'swing RightArm U-F': 70, 'swing RightForeArm U': 45, 'swing LeftArm F': 25 }],
    [0.1, { 'turn Spine1 R': -16, 'turn Spine2 R': -14, 'turn Spine2 U': 18, 'turn Head R': -6, 'swing RightArm F-U': 30 }],
    [0.24, { 'turn Spine1 R': -18, 'turn Spine2 R': -12, 'turn Spine2 U': 14, 'turn Head R': -6 }], [0.62, {}]] },
};

const ease = (t) => t * t * (3 - 2 * t);
const AX = { F: [0, 0, 1], R: [-1, 0, 0], U: [0, 1, 0] }; // hero faces +z, its right is -x
function dirOf(s, q) { // 'F+U' / '-R' → world vector in the hero frame
  const v = new THREE.Vector3();
  for (const m of s.matchAll(/([+-]?)([FRU])/g)) v.add(new THREE.Vector3(...AX[m[2]]).multiplyScalar(m[1] === '-' ? -1 : 1));
  return v.normalize().applyQuaternion(q);
}

export function makeMover(root) {
  const bones = {}, depth = {};
  const bone = (n) => {
    if (!(n in bones)) {
      bones[n] = root.getObjectByName('mixamorig' + n) || root.getObjectByName('mixamorig:' + n) || null;
      let d = 0; for (let o = bones[n]; o; o = o.parent) d++;
      depth[n] = d;
    }
    return bones[n];
  };
  // parse once: 'swing RightArm F+U' → { kind, bone, dir }
  const OPS = {};
  for (const m of Object.values(MOVES)) for (const [, k] of m.keys) for (const op of Object.keys(k)) if (!OPS[op]) { const [kind, b, dir] = op.split(' '); OPS[op] = { kind, bone: b, dir }; }
  const active = []; // { name, t, held }
  const _q = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _h = new THREE.Quaternion();

  function sample(m, t) {
    const K = m.keys;
    if (t >= K[K.length - 1][0]) return K[K.length - 1][1];
    let i = 0; while (i < K.length - 2 && t >= K[i + 1][0]) i++;
    const [t0, a] = K[i], [t1, b] = K[i + 1], s = ease(Math.min(1, Math.max(0, (t - t0) / (t1 - t0))));
    const out = {};
    for (const op of new Set([...Object.keys(a), ...Object.keys(b)])) out[op] = (a[op] || 0) + ((b[op] || 0) - (a[op] || 0)) * s;
    return out;
  }
  function rotateWorld(b, q) { // apply a world-space rotation to bone b
    b.getWorldQuaternion(_qw); b.parent.getWorldQuaternion(_qp);
    b.quaternion.copy(_qp.invert().multiply(q).multiply(_qw));
    b.updateMatrixWorld(true);
  }

  return {
    play(name) { if (!MOVES[name]) return; for (let i = active.length - 1; i >= 0; i--) if (active[i].name === name) active.splice(i, 1); active.push({ name, t: 0, held: !!MOVES[name].hold }); },
    release(name) { for (const a of active) if (a.name === name) a.held = false; },
    stop(name) { for (let i = active.length - 1; i >= 0; i--) if (!name || active[i].name === name) active.splice(i, 1); },
    playing: (name) => active.some((a) => a.name === name),
    update(dt) {
      if (!active.length) return;
      const sum = {};
      for (let i = active.length - 1; i >= 0; i--) {
        const a = active[i], m = MOVES[a.name];
        const holdT = m.hold != null ? m.keys[m.hold][0] : Infinity;
        a.t = a.held ? Math.min(a.t + dt, holdT) : a.t + dt;
        if (!a.held && a.t >= m.keys[m.keys.length - 1][0]) { active.splice(i, 1); continue; }
        const s = sample(m, a.t);
        for (const op in s) sum[op] = (sum[op] || 0) + s[op];
      }
      root.updateMatrixWorld(true);
      root.getWorldQuaternion(_h);
      // parents before children, so each swing aims from where its parent has already moved it
      const ops = Object.keys(sum).filter((op) => Math.abs(sum[op]) > 0.05 && bone(OPS[op].bone)).sort((x, y) => depth[OPS[x].bone] - depth[OPS[y].bone]);
      for (const op of ops) {
        const { kind, bone: bn, dir } = OPS[op], b = bones[bn], rad = THREE.MathUtils.degToRad(sum[op]);
        if (kind === 'turn') _q.setFromAxisAngle(dirOf(dir, _h), rad);
        else {
          const child = b.children.find((c) => c.isBone);
          if (!child) continue;
          b.getWorldPosition(_b); _a.copy(child.getWorldPosition(new THREE.Vector3())).sub(_b).normalize(); // the bone's own direction
          const axis = _a.clone().cross(dirOf(dir, _h));
          if (axis.lengthSq() < 1e-6) continue;
          _q.setFromAxisAngle(axis.normalize(), rad);
        }
        rotateWorld(b, _q);
      }
    },
  };
}
