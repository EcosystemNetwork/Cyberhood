/* ============================================================================
   preview.js: the Armoury, a turntable for checking characters against the art standard.
   Same renderer, sky and knight code as the Hollow Chapel, so what looks right here looks
   right in the world. ?look=revenant  ?light=studio  ?armor=gorget,helm  ?yaw=0.6  (tests)
   ============================================================================ */
import * as THREE from 'three';
import { createRenderer, loadSky, isTouch, LOOK } from './render.js';
import { loadKnightAssets, makeKnight, LOOKS } from './knight.js';
import { SLOT_NAMES } from './armor.js';
import { createMaterials } from './world.js';

const P = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const R = createRenderer($('view'), P.get('q') || (isTouch ? 'low' : 'high'));
const { scene, camera } = R;

const manager = new THREE.LoadingManager();
const M = createMaterials(manager);
const [sky] = await Promise.all([loadSky(R, new URL('./assets/belfast_sunset_puresky_2k.hdr', import.meta.url).href), loadKnightAssets(manager)]);
scene.fog = null; // a studio, not a glade

// ---- the stage: a stone plinth on a dark floor, a cool rim light behind for the silhouette
const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.08, 0.24, 48), new THREE.MeshStandardMaterial({ map: M.T.blocks.diff, normalMap: M.T.blocks.nor, roughnessMap: M.T.blocks.arm, color: 0x8a847c, envMapIntensity: LOOK.envIntensity }));
plinth.position.y = -0.12; plinth.receiveShadow = plinth.castShadow = true;
const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x141215, roughness: 0.95, envMapIntensity: 0.3 }));
floor.position.y = -0.24; floor.receiveShadow = true;
const rim = new THREE.DirectionalLight(0x9fb8ff, 1.6);
rim.position.set(-2, 3, -4);
scene.add(plinth, floor, rim);

// ---- characters
const knights = {};
for (const k of ['warden', 'revenant']) { knights[k] = makeKnight(scene, LOOKS[k]); knights[k].root.visible = false; }
let cur = null;
const S = { atk: -1, combo: [], guard: false, yaw: P.has('yaw') ? Number(P.get('yaw')) : 0.5, spin: !P.has('yaw'), dist: 3.3, pitch: 0.12, focusY: 0.85, light: P.get('light') || 'dusk' };

function pick(name) {
  for (const [k, v] of Object.entries(knights)) { v.root.visible = k === name; if (v.trail) v.trail.visible = false; }
  cur = knights[name];
  for (const b of $('looks').children) b.classList.toggle('on', b.dataset.k === name);
  syncSlots();
}
function syncSlots() {
  const worn = cur.armor.slots;
  for (const b of $('slots').children) b.classList.toggle('on', worn.includes(b.dataset.k));
  $('hood').classList.toggle('on', !!cur.hero.hood);
}
const btn = (host, label, k, on) => { const b = document.createElement('button'); b.textContent = label; b.dataset.k = k; b.onclick = () => on(k, b); $(host).appendChild(b); return b; };
btn('looks', 'Warden', 'warden', pick);
btn('looks', 'Revenant', 'revenant', pick);
for (const [k, name] of Object.entries(SLOT_NAMES)) btn('slots', name, k, (slot) => { cur.armor.show(slot, !cur.armor.slots.includes(slot)); syncSlots(); });
$('all').onclick = () => { for (const k of Object.keys(SLOT_NAMES)) cur.armor.show(k, true); syncSlots(); };
$('none').onclick = () => { for (const k of Object.keys(SLOT_NAMES)) cur.armor.show(k, false); syncSlots(); };
$('hood').onclick = () => { cur.hero.setHood(!cur.hero.hood); syncSlots(); };
const SW = [0.62, 0.58, 0.78];
btn('acts', 'Combo', 'combo', () => { S.combo = SW.slice(); S.atk = -1; });
const guardB = btn('acts', 'Guard', 'guard', () => { S.guard = !S.guard; guardB.classList.toggle('on', S.guard); });
btn('acts', 'Roll', 'roll', () => cur.roll());
btn('acts', 'Hit', 'hit', () => cur.hurt());
for (const e of ['victory', 'cheer', 'wave']) btn('emotes', e[0].toUpperCase() + e.slice(1), e, () => cur.hero.emote(e));
function setLight(l) {
  S.light = l;
  scene.background = l === 'dusk' ? sky.tex : new THREE.Color(0x0d0c0e);
  rim.intensity = l === 'dusk' ? 1.2 : 2.4;
  for (const b of $('lights').children) b.classList.toggle('on', b.dataset.k === l);
}
btn('lights', 'Dusk', 'dusk', setLight);
btn('lights', 'Studio', 'studio', setLight);

// ---- orbit: drag to turn, wheel / pinch to zoom, double-click to frame the face
const canvas = $('view'), ptrs = new Map();
let pinch0 = 0;
canvas.addEventListener('pointerdown', (e) => { ptrs.set(e.pointerId, [e.clientX, e.clientY]); canvas.setPointerCapture(e.pointerId); S.spin = false; });
canvas.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  const [x, y] = ptrs.get(e.pointerId);
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch0) S.dist = THREE.MathUtils.clamp(S.dist * (pinch0 / d), 1.0, 6);
    pinch0 = d;
    return;
  }
  S.yaw -= (e.clientX - x) * 0.008;
  S.pitch = THREE.MathUtils.clamp(S.pitch + (e.clientY - y) * 0.005, -0.3, 0.9);
});
const up = (e) => { ptrs.delete(e.pointerId); pinch0 = 0; };
canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
canvas.addEventListener('wheel', (e) => { S.dist = THREE.MathUtils.clamp(S.dist * (e.deltaY > 0 ? 1.1 : 0.9), 1.0, 6); }, { passive: true });
canvas.addEventListener('dblclick', () => { const face = S.dist > 1.6; S.dist = face ? 1.1 : 3.3; S.focusY = face ? 1.38 : 0.85; });

// ---- loop
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  if (S.spin) S.yaw += dt * 0.25;
  // combo: three swings, one frame of -1 between them so glbhero walks the chain
  if (S.atk >= 0) { S.atk += dt / S.cur; if (S.atk >= 1) S.atk = -1; }
  else if (S.combo.length) { S.cur = S.combo.shift(); S.atk = 0; }
  cur.update(dt, { atk: S.atk, guard: S.guard && S.atk < 0 ? 1 : 0 });
  if (cur.trail) cur.trail.visible = S.atk >= 0;
  const fy = S.focusY;
  const c = Math.cos(S.pitch);
  camera.position.set(Math.sin(S.yaw) * c * S.dist, fy + Math.sin(S.pitch) * S.dist, Math.cos(S.yaw) * c * S.dist);
  camera.lookAt(0, fy, 0);
  R.followSun(new THREE.Vector3());
  R.render();
}
pick(P.get('look') || 'warden');
setLight(S.light);
if (P.get('armor')) { for (const k of Object.keys(SLOT_NAMES)) cur.armor.show(k, false); for (const k of P.get('armor').split(',')) cur.armor.show(k, true); syncSlots(); }
if (P.has('dist')) { S.dist = Number(P.get('dist')); S.focusY = Number(P.get('fy') || 0.85); }
$('loading').classList.add('gone');
requestAnimationFrame(frame);
window.PREVIEW = { R, knights, S, pick, get cur() { return cur; } };
