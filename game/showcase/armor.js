/* ============================================================================
   armor.js: modular armour on attachment points (sockets).

   The kit (assets/armor_kit.glb, built by tools/blender/armor_kit.py) holds one node per piece,
   each with its origin at the joint it hangs from. A slot is one or two pieces; each piece names
   its socket bone and, for limb pieces, the next bone down the limb (`to`), whose direction the
   piece's +y axis follows. Pieces are placed once in the hero's idle pose, in the hero's frame,
   then parented to their bone (Object3D.attach keeps the world transform), so they ride every
   animation from then on. Rigid plates on a skinned body: shoulders and knees are the joints
   where that shows, so the cops sit proud of them.

     const set = attachArmor(hero.root, scene, ['gorget', 'pauldrons'], { tint })
     set.show('helm', false)
   ============================================================================ */
import * as THREE from 'three';
import { LOOK } from './render.js';
import { bake, bakedMaterial } from './bake.js';

// off: metres in the hero's frame (+x = the hero's left, +y up, +z front); mirrored for _R pieces
export const SOCKETS = {
  helm: [{ node: 'helm', bone: 'Head', off: [0, 0.008, -0.004], scale: 1.1 }], // over the hair
  gorget: [{ node: 'gorget', bone: 'Neck', off: [0, -0.012, -0.012] }],
  // pauldrons ride over a cloak: out and up from the joint, a size larger
  pauldrons: [{ node: 'pauldron_L', bone: 'LeftArm', off: [0.03, 0.035, -0.004], scale: 1.18 }, { node: 'pauldron_R', bone: 'RightArm', off: [-0.03, 0.035, -0.004], scale: 1.18 }],
  breastplate: [{ node: 'breastplate', bone: 'Spine2', off: [0, 0.02, 0.05] }],
  vambraces: [{ node: 'vambrace_L', bone: 'LeftForeArm', to: 'LeftHand' }, { node: 'vambrace_R', bone: 'RightForeArm', to: 'RightHand' }],
  greaves: [{ node: 'greave_L', bone: 'LeftLeg', to: 'LeftFoot', off: [0, 0, 0.004] }, { node: 'greave_R', bone: 'RightLeg', to: 'RightFoot', off: [0, 0, 0.004] }],
};
export const SLOT_NAMES = { helm: 'Sallet', gorget: 'Gorget', pauldrons: 'Pauldrons', breastplate: 'Breastplate', vambraces: 'Vambraces', greaves: 'Greaves' };

let KIT = null;
export async function loadArmorKit(loader) {
  const g = await loader.loadAsync(new URL('./assets/armor_kit.glb', import.meta.url).href);
  KIT = {};
  for (const o of [...g.scene.children]) KIT[o.name] = bake(o, LOOK.envIntensity * 2); // one draw per piece (bake.js)
}

const bone = (root, n) => root.getObjectByName('mixamorig' + n) || root.getObjectByName('mixamorig:' + n);
const _p = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

export function attachArmor(root, scene, slots, { tint = null } = {}) {
  const pieces = {};
  if (!KIT) return { pieces, show() {}, slots: [] };
  root.updateMatrixWorld(true);
  const qh = root.getWorldQuaternion(new THREE.Quaternion());
  for (const slot of Object.keys(SOCKETS)) {
    for (const s of SOCKETS[slot]) {
      const b = bone(root, s.bone), src = KIT[s.node];
      if (!b || !src) continue;
      const o = src.clone();
      if (tint) o.material = bakedMaterial(LOOK.envIntensity * 2, tint);
      b.getWorldPosition(_p);
      if (s.off) _p.add(_c.fromArray(s.off).applyQuaternion(qh));
      _q.copy(qh);
      const to = s.to && bone(root, s.to);
      if (to) { // +y down the limb, +z toward the hero's front
        _y.copy(to.getWorldPosition(_c)).sub(b.getWorldPosition(new THREE.Vector3())).normalize();
        _z.set(0, 0, 1).applyQuaternion(qh);
        _z.addScaledVector(_y, -_z.dot(_y)).normalize();
        _x.crossVectors(_y, _z);
        _q.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
      }
      scene.add(o);
      o.position.copy(_p); o.quaternion.copy(_q); o.scale.setScalar(s.scale || 1);
      o.updateMatrixWorld(true);
      b.attach(o);
      o.visible = slots.includes(slot);
      (pieces[slot] = pieces[slot] || []).push(o);
    }
  }
  return {
    pieces,
    get slots() { return Object.keys(pieces).filter((k) => pieces[k][0].visible); },
    show(slot, on) { for (const o of pieces[slot] || []) o.visible = on; },
  };
}
