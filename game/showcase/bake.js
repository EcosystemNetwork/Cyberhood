/* ============================================================================
   bake.js: one draw call per factor-only prop.

   The sword and the armour pieces are factor-only PBR (no textures): steel, brass, iron, leather.
   Loaded as-is, each material is its own draw, in every pass (shadow, AO, main), on every
   character. bake() merges a prop's meshes into one geometry that carries each material as vertex
   attributes (colour, roughness, metalness), drawn with one shared material. A tint (a revenant's
   rust) is just that material's colour, so it costs one more material, not a re-bake.
   ============================================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MATS = new Map();
export function bakedMaterial(envMapIntensity = 1, tint = null) {
  const key = envMapIntensity + '|' + (tint ? tint.getHexString() : '');
  if (MATS.has(key)) return MATS.get(key);
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, envMapIntensity });
  if (tint) m.color.copy(tint);
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 pbr;\nvarying vec2 vPbr;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPbr;')
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = clamp(vPbr.x${tint ? ' + 0.2' : ''}, 0.04, 1.0);`)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;');
  };
  m.customProgramCacheKey = () => 'baked-pbr' + (tint ? '-t' : '');
  MATS.set(key, m);
  return m;
}

// obj: an Object3D whose meshes use plain factor materials → a single Mesh in the frame obj sits in
// (its parent's), so obj's own node transform (meshopt's dequantize scale and offset) is kept
export function bake(obj, envMapIntensity = 1) {
  obj.parent?.updateMatrixWorld(true);
  obj.updateMatrixWorld(true);
  const inv = obj.parent ? obj.parent.matrixWorld.clone().invert() : new THREE.Matrix4(), parts = [], m4 = new THREE.Matrix4(), n3 = new THREE.Matrix3();
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.geometry, mat = o.material, n = src.attributes.position.count;
    m4.multiplyMatrices(inv, o.matrixWorld);
    n3.getNormalMatrix(m4);
    // quantized (int, normalized) attributes → float, so transforming them can't clip
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), pbr = new Float32Array(n * 2);
    const v = new THREE.Vector3(), c = mat.color;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(src.attributes.position, i).applyMatrix4(m4); pos.set([v.x, v.y, v.z], i * 3);
      v.fromBufferAttribute(src.attributes.normal, i).applyMatrix3(n3).normalize(); nor.set([v.x, v.y, v.z], i * 3);
      col.set([c.r, c.g, c.b], i * 3);
      pbr.set([mat.roughness, mat.metalness], i * 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('pbr', new THREE.BufferAttribute(pbr, 2));
    if (src.index) g.setIndex(Array.from(src.index.array));
    parts.push(g);
  });
  const mesh = new THREE.Mesh(mergeGeometries(parts), bakedMaterial(envMapIntensity));
  mesh.name = obj.name;
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
