/* ============================================================================
   main.js: the Hollow Chapel vertical slice. Boot, intro, the warden's controls, camera, HUD.

   URL: ?q=low|high (default: low on touch devices), ?stats, ?auto (skip the title; tests),
        ?cam=x,y,z,tx,ty,tz (fixed camera for screenshots)
   Test hook: window.SHOWCASE = { R, world, player, foes, ... }
   ============================================================================ */
import * as THREE from 'three';
import { createRenderer, loadSky, isTouch, LOOK } from './render.js';
import { createMaterials, buildWorld, LAYOUT } from './world.js';
import { loadKnightAssets, makeKnight, LOOKS, gltfLoader } from './knight.js';
import { makeRevenants, makeSparks, makeOverlay, RULES } from './combat.js';
import { sfx } from '/game/lib/sfx.js';

const P = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
if (isTouch) document.body.classList.add('touch');

const R = createRenderer($('view'), P.get('q') || (isTouch ? 'low' : 'high'));
const { scene, camera } = R;

/* ---------------- loading ---------------- */
const manager = new THREE.LoadingManager();
let texP = 0, skyP = 0, knightP = 0;
const bar = () => { $('bar').firstElementChild.style.width = `${Math.round((texP * 0.45 + skyP * 0.25 + knightP * 0.3) * 100)}%`; };
manager.onProgress = (_u, a, b) => { texP = a / b; bar(); };

const M = createMaterials(manager);
const G = gltfLoader(manager);
const A = (f) => new URL('./assets/' + f, import.meta.url).href;
const [, models] = await Promise.all([
  loadSky(R, A('belfast_sunset_puresky_2k.hdr'), (e) => { if (e.total) { skyP = e.loaded / e.total; bar(); } }).then((s) => { skyP = 1; bar(); return s; }),
  Promise.all([G.loadAsync(A('rock_moss_set_01.glb')), G.loadAsync(A('fern_02.glb')), G.loadAsync(A('dead_tree_trunk_02.glb'))]).then(([rocks, fern, trunk]) => ({ rocks, fern, trunk })),
  loadKnightAssets(manager).then(() => { knightP = 1; bar(); }),
]);
const world = buildWorld(R, M, models);
const sparks = makeSparks(scene, R);
const overlay = makeOverlay(camera);

/* ---------------- the warden, the statue, the revenants ---------------- */
const me = makeKnight(scene, LOOKS.warden);
const player = {
  pos: LAYOUT.spawn.clone(), yaw: Math.PI, vel: new THREE.Vector3(), hp: 100, st: 100, stIdle: 0, dead: false, deadT: 0,
  atk: { p: -1, i: 0, dur: 0.6, hit: false, queued: false, end: -9, gap: false }, guard: false, guardAt: -9, roll: null, iUntil: 0, kills: 0,
};
const SWING = [{ dur: 0.62, dmg: 24 }, { dur: 0.58, dmg: 26 }, { dur: 0.78, dmg: 40 }]; // the combo: diagonal, backhand, overhead
me.root.position.copy(player.pos);
R.noAO.add(me.trail);

// the stone warden on the plinth: the same hero, posed in vigil and frozen
{
  const k = makeKnight(scene, { ...LOOKS.warden, key: 'statue', hood: true });
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6e6a64, roughness: 0.9, normalMap: M.T.blocks.nor, normalScale: new THREE.Vector2(0.5, 0.5), envMapIntensity: LOOK.envIntensity });
  k.root.traverse((o) => { if (o.isMesh) { o.material = stoneMat; o.castShadow = o.receiveShadow = true; } });
  k.root.position.set(LAYOUT.statue.x, 1.59, LAYOUT.statue.z);
  k.root.scale.setScalar(1.28);
  k.root.rotation.y = 0;
  for (let i = 0; i < 40; i++) k.update(1 / 30, { guard: 1 });
  if (k.trail) k.trail.visible = false;
  k.root.updateMatrixWorld(true);
  k.root.traverse((o) => { o.matrixAutoUpdate = false; });
}
const foes = makeRevenants(scene, world, overlay, sparks, [new THREE.Vector3(-3.5, 0, -8), new THREE.Vector3(3.8, 0, -7.2), new THREE.Vector3(0.5, 0, -10.2)]);
for (const e of foes.list) R.noAO.add(e.k.trail);

/* ---------------- input ---------------- */
const keys = new Set();
const input = { move: new THREE.Vector2(), sprint: false, look: new THREE.Vector2() };
let locked = false, started = false, dragging = false;
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); doRoll(); }
  if (e.code === 'KeyG') { R.setQuality(R.quality === 'high' ? 'low' : 'high'); toast(`Quality: ${R.quality}`); }
  if (e.code === 'F3') { e.preventDefault(); const s = $('stats'); s.style.display = s.style.display === 'block' ? 'none' : 'block'; }
  if (!started) start();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); player.guard = false; });
const canvas = $('view');
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!started) { start(); return; }
  if (!locked && !isTouch) { canvas.requestPointerLock?.(); dragging = true; }
  if (e.button === 0) doAttack();
  if (e.button === 2) setGuard(true);
});
addEventListener('mouseup', (e) => { if (e.button === 2) setGuard(false); dragging = false; });
document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === canvas; });
addEventListener('mousemove', (e) => { if (locked || dragging) input.look.x += e.movementX, input.look.y += e.movementY; });
addEventListener('wheel', (e) => { cam.dist = clamp(cam.dist + Math.sign(e.deltaY) * 0.4, 2.4, 7.5); }, { passive: true });

// touch: stick on the left, look by dragging anywhere else, three buttons
if (isTouch) {
  const stick = $('stick'), knob = stick.firstElementChild;
  let sid = null, lid = null, lx = 0, ly = 0;
  stick.addEventListener('pointerdown', (e) => { sid = e.pointerId; stick.setPointerCapture(sid); moveStick(e); if (!started) start(); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === sid) moveStick(e); });
  const endStick = (e) => { if (e.pointerId !== sid) return; sid = null; input.move.set(0, 0); knob.style.transform = ''; };
  stick.addEventListener('pointerup', endStick); stick.addEventListener('pointercancel', endStick);
  function moveStick(e) {
    const r = stick.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 2 - 1, y = (e.clientY - r.top) / r.height * 2 - 1;
    const L = Math.min(1, Math.hypot(x, y)), a = Math.atan2(y, x);
    input.move.set(Math.cos(a) * L, -Math.sin(a) * L);
    input.sprint = L > 0.95;
    knob.style.transform = `translate(${Math.cos(a) * L * 36}px, ${Math.sin(a) * L * 36}px)`;
  }
  canvas.addEventListener('pointerdown', (e) => { if (!started) { start(); return; } lid = e.pointerId; lx = e.clientX; ly = e.clientY; });
  canvas.addEventListener('pointermove', (e) => { if (e.pointerId !== lid) return; input.look.x += (e.clientX - lx) * 1.6; input.look.y += (e.clientY - ly) * 1.6; lx = e.clientX; ly = e.clientY; });
  canvas.addEventListener('pointerup', (e) => { if (e.pointerId === lid) lid = null; });
  const btn = (id, down, up) => { const b = $(id); b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.classList.add('on'); if (!started) start(); down(); }); for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => { b.classList.remove('on'); up?.(); }); };
  btn('tAtk', doAttack); btn('tBlk', () => setGuard(true), () => setGuard(false)); btn('tRol', doRoll);
}

/* ---------------- the warden's actions ---------------- */
function doAttack() {
  if (player.dead || player.roll) return;
  const a = player.atk;
  if (a.p >= 0) { if (a.p > 0.42) a.queued = true; return; }
  if (player.st < 8) return;
  startSwing();
}
function startSwing() {
  const a = player.atk;
  a.i = clock.t - a.end < 0.5 ? (a.i + 1) % 3 : 0; // mirrors glbhero's combo walk (COMBO_GAP)
  a.p = 0; a.dur = SWING[a.i].dur; a.hit = false; a.queued = false;
  player.st -= 12; player.stIdle = 0;
  sfx.play('swing');
}
function setGuard(on) {
  if (on && !player.guard) player.guardAt = clock.t;
  player.guard = on;
}
function doRoll() {
  if (player.dead || player.roll || player.st < 20 || !started) return;
  if (player.atk.p >= 0 && player.atk.p < 0.5) return; // committed to the swing
  const dir = moveDir().clone(); // moveDir hands back a shared scratch vector
  if (dir.lengthSq() < 0.01) dir.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
  player.roll = { t: 0, dir: dir.normalize() };
  player.yaw = Math.atan2(dir.x, dir.z);
  player.atk.p = -1; player.atk.queued = false;
  player.st -= 22; player.stIdle = 0;
  player.iUntil = clock.t + 0.42;
  me.roll();
  sfx.play('sprint');
}
const _md = new THREE.Vector3();
function moveDir() {
  let x = input.move.x, y = input.move.y;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  const L = Math.hypot(x, y);
  if (L > 1) { x /= L; y /= L; }
  const s = Math.sin(cam.yaw), c = Math.cos(cam.yaw); // camera looks along (-sin, -cos)
  return _md.set(-s * y + c * x, 0, -c * y - s * x);
}
// soft lock: the nearest living revenant within reach in front of the stick / facing
function lockTarget(range = 4.5) {
  let best = null, bd = 1e9;
  for (const e of foes.list) {
    if (e.state === 'dead' || e.state === 'rise') continue;
    const d = e.pos.distanceTo(player.pos);
    if (d < range && d < bd) { bd = d; best = e; }
  }
  return best;
}

/* ---------------- hits on the warden ---------------- */
const fx = { shake: 0, stop: 0, slow: 0, flash: 0 };
function hitPlayer(e, dmg) {
  if (player.dead || clock.t < player.iUntil) return;
  const fwd = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
  const toE = e.pos.clone().sub(player.pos).setY(0).normalize();
  const at = player.pos.clone().add(toE.clone().multiplyScalar(0.45)); at.y += 1.3;
  if (player.guard && fwd.dot(toE) > 0.2) {
    if (clock.t - player.guardAt < RULES.parryWindow) {
      foes.parried(e);
      sparks.burst(at, 'parry', 40, toE.clone().negate());
      sfx.play('parry');
      overlay.number(at.clone().setY(at.y + 0.4), 'PARRY', 'block');
      fx.slow = 0.35; fx.shake = 0.25;
      return;
    }
    player.st -= RULES.blockCost; player.stIdle = 0;
    sparks.burst(at, 'block', 26, toE.clone().negate());
    sfx.play('crate');
    fx.shake = 0.18; fx.stop = 0.05;
    player.pos.addScaledVector(toE, -0.22);
    if (player.st > 0) return;
    player.st = 0; player.guard = false; toast('GUARD BROKEN', true); // broken: the blow still lands
  }
  player.hp -= dmg;
  me.hurt();
  sparks.burst(at, 'ichor', 18, toE.clone().negate());
  sfx.play('hurt');
  fx.shake = 0.4; fx.stop = 0.06; fx.flash = 1;
  player.pos.addScaledVector(toE, -0.35);
  if (player.atk.p >= 0 && player.atk.p < RULES.hitAt) player.atk.p = -1; // interrupted
  if (player.hp <= 0) {
    player.hp = 0; player.dead = true; player.deadT = 0; player.atk.p = -1;
    sfx.play('faint');
    toast('YOU HAVE FALLEN', true, 3);
  }
}

/* ---------------- HUD ---------------- */
let toastT = 0;
function toast(text, red = false, dur = 1.4) { const t = $('toast'); t.textContent = text; t.classList.toggle('red', red); t.classList.add('on'); toastT = dur; }
const hpFill = $('hp').querySelector('.fill'), hpLag = $('hp').querySelector('.lag'), stFill = $('st').querySelector('.fill');
function hud(dt) {
  hpFill.style.transform = `scaleX(${player.hp / 100})`; hpLag.style.transform = `scaleX(${player.hp / 100})`;
  stFill.style.transform = `scaleX(${Math.max(0, player.st) / 100})`;
  $('kills').textContent = player.kills ? `REVENANTS LAID TO REST  ${player.kills}` : '';
  if (toastT > 0 && (toastT -= dt) <= 0) $('toast').classList.remove('on');
  fx.flash = Math.max(0, fx.flash - dt * 2.2);
  $('flash').style.opacity = String(fx.flash * 0.9 + (player.hp < 30 && !player.dead ? 0.25 + 0.1 * Math.sin(clock.t * 5) : 0));
}

/* ---------------- camera ---------------- */
const cam = { yaw: 0, pitch: 0.2, dist: 4.4, focus: new THREE.Vector3(), intro: 1, blend: 0 };
const fixedCam = P.get('cam')?.split(',').map(Number);
const _cp = new THREE.Vector3(), _ct = new THREE.Vector3();
function updateCamera(dt, t) {
  cam.yaw -= input.look.x * 0.0026;
  cam.pitch = clamp(cam.pitch + input.look.y * 0.0022, -0.35, 1.05);
  input.look.set(0, 0);
  cam.focus.lerp(_ct.copy(player.pos).setY(player.pos.y + 1.42), 1 - Math.exp(-dt * 12));
  const cy = Math.cos(cam.pitch), right = new THREE.Vector3(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
  _cp.set(Math.sin(cam.yaw) * cy, Math.sin(cam.pitch), Math.cos(cam.yaw) * cy).multiplyScalar(cam.dist).add(cam.focus).addScaledVector(right, 0.42);
  // inside the nave the walls would stand between camera and warden: keep the camera in
  const N = LAYOUT.nave;
  if (player.pos.x > N.x0 && player.pos.x < N.x1 && player.pos.z > N.z0 && player.pos.z < N.z1) {
    _cp.x = clamp(_cp.x, N.x0 + 0.7, N.x1 - 0.7); _cp.z = clamp(_cp.z, N.z0 - 2.5, N.z1 + 6);
  }
  _cp.y = Math.max(_cp.y, world.heightAt(_cp.x, _cp.z) + 0.35);
  const look = cam.focus.clone().addScaledVector(right, 0.42);

  // intro: a slow crane past the statue toward the chapel front, then hand over to the player
  if (cam.intro > 0) {
    const a = t * 0.07 + 0.3;
    const ip = new THREE.Vector3(Math.sin(a) * 15, 3.4 + Math.sin(t * 0.13) * 0.8, Math.cos(a) * 15 - 4);
    const it = new THREE.Vector3(0, 3.6, -11);
    _cp.lerpVectors(_cp, ip, cam.intro); look.lerpVectors(look, it, cam.intro);
    if (started) cam.intro = Math.max(0, cam.intro - dt / 1.8);
  }
  camera.position.copy(_cp);
  if (fx.shake > 0) { camera.position.x += (Math.random() - 0.5) * fx.shake * 0.12; camera.position.y += (Math.random() - 0.5) * fx.shake * 0.12; fx.shake = Math.max(0, fx.shake - dt * 2.4); }
  camera.lookAt(look);
  camera.fov = damp(camera.fov, player.roll ? 56 : input.sprint || keys.has('ShiftLeft') ? 53 : 50, 6, dt);
  camera.updateProjectionMatrix();
  if (fixedCam) { camera.position.set(fixedCam[0], fixedCam[1], fixedCam[2]); camera.lookAt(fixedCam[3], fixedCam[4], fixedCam[5]); }
}

/* ---------------- start ---------------- */
function start() {
  if (started) return;
  started = true;
  $('title').classList.add('gone');
  $('hud').classList.add('on');
  cam.yaw = 0; cam.pitch = 0.18;
  if (!isTouch && !P.has('auto')) canvas.requestPointerLock?.();
}

/* ---------------- the loop ---------------- */
const clock = { t: 0, last: performance.now(), fps: 60 };
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - clock.last) / 1000);
  clock.last = now;
  clock.fps = damp(clock.fps, 1 / Math.max(dt, 1e-3), 3, 1 / 60);
  // hit-stop and parry slow-motion bend game time, not the camera
  let gdt = dt;
  if (fx.stop > 0) { fx.stop -= dt; gdt = dt * 0.05; } else if (fx.slow > 0) { fx.slow -= dt; gdt = dt * 0.35; }
  clock.t += gdt;
  const t = clock.t;

  if (started) stepPlayer(gdt);
  me.root.position.copy(player.pos);
  me.root.rotation.y = player.yaw;
  const lock = lockTarget(8);
  me.update(gdt, { atk: player.atk.p, guard: player.guard && !player.roll && player.atk.p < 0 ? 1 : 0, down: player.dead, lookAt: lock ? lock.pos.clone().setY(lock.pos.y + 1.4) : null });
  foes.update(gdt, t, player, { hitPlayer });
  sparks.update(gdt);
  world.update(gdt, t, camera, player.pos);
  overlay.update(dt);
  updateCamera(dt, t);
  R.followSun(player.pos);
  hud(dt);
  R.render();
  stats(dt);
}

function stepPlayer(dt) {
  const p = player;
  if (p.dead) {
    p.deadT += dt;
    if (p.deadT > 4) {
      Object.assign(p, { dead: false, hp: 100, st: 100, pos: LAYOUT.spawn.clone(), yaw: Math.PI, roll: null });
      foes.reset();
      toast('THE CHAPEL WAITS');
    }
    return;
  }
  // stamina: regenerates after a short rest, slower while guarding
  p.stIdle += dt;
  if (p.stIdle > 0.6) p.st = Math.min(100, p.st + dt * (p.guard ? 12 : 34));

  const dir = moveDir();
  const a = p.atk;
  if (p.roll) {
    const r = p.roll;
    r.t += dt;
    const k = r.t / 0.6, spd = 6.8 * (1 - k * k * 0.85);
    p.pos.addScaledVector(r.dir, spd * dt);
    if (r.t > 0.12 && r.t - dt <= 0.12) sparks.burst(p.pos.clone().setY(p.pos.y + 0.1), 'dust', 6);
    if (r.t >= 0.6) { p.roll = null; sfx.play('land'); }
  } else {
    const sprint = (keys.has('ShiftLeft') || keys.has('ShiftRight') || input.sprint) && !p.guard && a.p < 0;
    const speed = a.p >= 0 ? 0.7 : p.guard ? 1.5 : sprint ? 5.6 : 3.4;
    const want = dir.clone().multiplyScalar(speed);
    p.vel.x = damp(p.vel.x, want.x, 10, dt); p.vel.z = damp(p.vel.z, want.z, 10, dt);
    p.pos.addScaledVector(p.vel, dt);
    // facing: toward a locked foe while fighting, else where we're going
    const lock = lockTarget();
    let faceTo = null;
    if ((a.p >= 0 || p.guard) && lock) faceTo = Math.atan2(lock.pos.x - p.pos.x, lock.pos.z - p.pos.z);
    else if (a.p >= 0 && a.p < 0.3 && dir.lengthSq() > 0.01) faceTo = Math.atan2(dir.x, dir.z);
    else if (dir.lengthSq() > 0.01 && a.p < 0) faceTo = Math.atan2(dir.x, dir.z);
    if (faceTo !== null) p.yaw += wrap(faceTo - p.yaw) * (1 - Math.exp(-dt * (a.p >= 0 ? 9 : 12)));
  }
  // the swing
  if (a.p >= 0) {
    a.p += dt / a.dur;
    if (!a.hit && a.p >= RULES.hitAt) {
      a.hit = true;
      const fwd = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
      let any = false;
      for (const e of foes.list) {
        const to = e.pos.clone().sub(p.pos).setY(0), d = to.length();
        if (d > RULES.reach || to.normalize().dot(fwd) < RULES.arc) continue;
        const crit = e.state === 'stun' && e.stun > 0.5; // riposte on a parried foe
        const dmg = SWING[a.i].dmg * (crit ? 1.8 : 1) * (0.92 + Math.random() * 0.16);
        const r = foes.strike(e, dmg, crit, fwd);
        if (r) any = true;
        if (r === 'kill') { p.kills++; fx.slow = 0.4; }
      }
      if (any) { fx.stop = a.i === 2 ? 0.09 : 0.06; fx.shake = a.i === 2 ? 0.35 : 0.22; }
    }
    if (a.p >= 1) { a.p = -1; a.end = clock.t; if (a.queued && p.st >= 8) a.gap = true; }
  } else if (a.gap) { a.gap = false; startSwing(); } // one frame of p = -1 between swings lets glbhero walk its combo
  world.collide(p.pos, 0.36);
  p.pos.y = world.heightAt(p.pos.x, p.pos.z);
}

/* ---------------- perf overlay ---------------- */
const statsEl = $('stats');
if (P.has('stats')) statsEl.style.display = 'block';
let statsT = 0;
function stats(dt) {
  if (statsEl.style.display !== 'block' || (statsT -= dt) > 0) return;
  statsT = 0.5;
  const i = R.renderer.info;
  statsEl.textContent = `${clock.fps.toFixed(0)} fps   ${R.quality}\ncalls ${i.render.calls}   tris ${(i.render.triangles / 1000).toFixed(0)}k\ngeo ${i.memory.geometries}   tex ${i.memory.textures}\ngrass ${world.grass.count()}   lights ${world.lights.length}`;
}

// ready
$('title').classList.add('ready');
$('hint').textContent = isTouch ? 'Tap to begin' : 'Click to begin';
$('veil').classList.add('gone');
R.renderer.compile(scene, camera);
requestAnimationFrame(frame);
if (P.has('auto')) start();
window.SHOWCASE = { R, world, player, foes, me, cam, clock, start, toast, doAttack, doRoll, setGuard, keys, input };
