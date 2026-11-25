/* ============================================================================
   loot.js: drops you can read from across the room, and the blades they carry.

   A drop pops out of the kill in an arc, lands, and stands in a pillar of light coloured by its
   rarity (rare: ember gold, legendary: grave blue), with a ground ring and the item turning above
   it. Walk over it to take it. Weapons are the longsword with a glowing fuller and their own trail,
   so a new blade reads in the hand, in the swing and on the ground.
   ============================================================================ */
import * as THREE from 'three';
import { swordMesh } from './knight.js';
import { sfx } from '/game/lib/sfx.js';

export const RARITY = {
  rare: { beam: new THREE.Color(2.4, 1.15, 0.3), height: 4.5, label: 'RARE' },
  legendary: { beam: new THREE.Color(0.9, 1.9, 5.0), height: 8, label: 'LEGENDARY' },
};
export const ITEMS = {
  ember_blade: { name: 'Ember Blade', rarity: 'rare', fuller: new THREE.Color(5, 1.4, 0.25), trail: new THREE.Color(7, 2.0, 0.4), dmg: 1.2, sparks: 'hit' },
  grave_edge: { name: 'Grave Edge', rarity: 'legendary', fuller: new THREE.Color(0.9, 2.6, 7), trail: new THREE.Color(1.6, 3.4, 10), dmg: 1.45, sparks: 'parry' },
};

// the fuller's glow: a thin HDR strip down the blade, in the sword's own frame (blade along +y)
export function fullerGlow(color) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.6, 0.017), new THREE.MeshBasicMaterial({ color }));
  m.position.y = 0.46;
  m.userData.fuller = true;
  return m;
}

const beamMat = (color) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: color }, uTime: { value: 0 } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec2 vUv;
    void main(){ float a = pow(1.0 - vUv.y, 2.2) * (0.75 + 0.25 * sin(vUv.y * 18.0 - uTime * 4.0)); // bright at the foot, rippling up
      float edge = 1.0 - abs(vUv.x * 2.0 - 1.0); gl_FragColor = vec4(uColor * a * (0.35 + 0.65 * edge), 1.0); }`,
});

export function makeLoot(scene, R) {
  const drops = [];
  function drop(from, id, to, area) {
    const it = ITEMS[id], rar = RARITY[it.rarity];
    const g = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, rar.height, 20, 1, true), beamMat(rar.beam));
    beam.geometry.translate(0, rar.height / 2, 0);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: rar.beam, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    ring.position.y = 0.03;
    const blade = swordMesh();
    blade.add(fullerGlow(it.fuller));
    blade.rotation.z = Math.PI / 2;
    const spin = new THREE.Group(); spin.add(blade); blade.position.x = 0.42; // turn about the blade's middle
    const item = new THREE.Group(); item.add(spin);
    g.add(beam, ring, item);
    for (const o of [beam, ring]) { o.renderOrder = 6; R.noAO.add(o); }
    g.position.copy(from);
    scene.add(g);
    const d = { id, area, g, beam, ring, item, spin, from: from.clone(), to: to.clone(), t: 0, landed: false };
    drops.push(d);
    sfx.play(it.rarity === 'legendary' ? 'win' : 'coin');
    return d;
  }
  return {
    drops, drop,
    clear() { for (const d of drops) d.g.removeFromParent(); drops.length = 0; },
    setVisible(on, area) { for (const d of drops) d.g.visible = on && d.area === area; },
    // returns the id picked up this frame, if any
    update(dt, t, playerPos, heightAt) {
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        d.t += dt;
        if (!d.landed) { // a 0.7 s arc out of the kill
          const k = Math.min(1, d.t / 0.7);
          d.g.position.lerpVectors(d.from, d.to, k);
          d.g.position.y = heightAt(d.g.position.x, d.g.position.z) + Math.sin(k * Math.PI) * 1.6;
          d.beam.scale.y = k; d.ring.scale.setScalar(k);
          if (k >= 1) { d.landed = true; sfx.play('pickup', { dist: 4 }); }
        }
        d.item.position.y = 0.75 + Math.sin(t * 2.2) * 0.08;
        d.spin.rotation.y = t * 1.6;
        d.beam.material.uniforms.uTime.value = t;
        d.ring.material.opacity = 0.6 + 0.4 * Math.sin(t * 3);
        if (d.landed && d.g.visible && Math.hypot(playerPos.x - d.g.position.x, playerPos.z - d.g.position.z) < 1.0) {
          d.g.removeFromParent(); drops.splice(i, 1);
          return d.id;
        }
      }
      return null;
    },
  };
}
