// The human GLB hero (?hero=human): every move in the anim lab loads, poses the skeleton and stays
// sane (no NaN bones, feet on the ground, right height), then the hero spawns and moves in the world.
// Captures land in out/human-*.png.  CHROME=/usr/bin/chromium node tests/world3d/human.cdp.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep, BASE, OUT } from './harness.mjs';

const HERO = process.argv[2] || 'human';
const LAB = `${BASE}/game/world3d/anim-lab.html?hero=${HERO}&w=640&h=720`;
const BARE = '&wear=none'; // pose checks measure the body, not cloth
// [mode, seconds into the move, extra query]
const SHOTS = [
  ['idle', 0.5, ''], ['run', 0.8, ''], ['jump', 0.3, ''], ['flip', 0.5, ''], ['land', 0.66, '&move=0'],
  ['attack', 0.17, '&move=0'], ['attack', 0.17, '&move=0&eq=iron_sword'], ['combo', 0.57, '&move=0&eq=iron_sword'], ['combo', 0.97, '&move=0&eq=iron_sword'],
  ['combo', 0.97, '&move=0'], ['hurt', 0.2, '&move=0'], ['turn', 1.5, ''], ['stop', 0.2, ''], ['down', 1.5, ''],
  ['emote', 0.8, '&name=wave'], ['emote', 0.8, '&name=victory'], ['emote', 0.8, '&name=cheer'], ['emote', 0.8, '&name=bow'],
  ['fidget', 1.0, '&name=look'], ['fidget', 1.0, '&name=stretch'], ['fidget', 1.0, '&name=fold'],
];
// Pose facts read off the live scene: the lab keeps no globals, so walk the renderer's scene via a probe.
const PROBE = `(() => {
  const T = window.__lab; if (!T) return { err: 'no __lab' };
  const { THREE, hero } = T;
  hero.root.updateMatrixWorld(true);
  let nan = 0, bones = 0, sm = null; const q = {};
  hero.root.traverse((o) => {
    if (o.isSkinnedMesh && !sm) sm = o;
    if (!o.isBone) return;
    bones++;
    if (![...o.quaternion.toArray(), ...o.position.toArray()].every(Number.isFinite)) nan++;
    q[o.name] = o.quaternion.toArray().map((v) => +v.toFixed(4));
  });
  // skinned bounds: lowest / highest vertex in world space
  const v = new THREE.Vector3(), pos = sm.geometry.attributes.position; let lo = 1e9, hi = -1e9;
  for (let i = 0; i < pos.count; i += 7) { sm.getVertexPosition(i, v); v.applyMatrix4(sm.matrixWorld); lo = Math.min(lo, v.y); hi = Math.max(hi, v.y); }
  return { nan, bones, lo: +lo.toFixed(3), hi: +hi.toFixed(3), y: hero.root.position.y, q };
})()`;

const { player, kill } = await launch();
const fails = [], rows = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log('  FAIL', msg); } };
try {
  const p = await player('Human');
  await p.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 720, deviceScaleFactor: 1, mobile: false });
  let rest = null;
  for (const [mode, t, extra] of SHOTS) {
    const tag = `${mode}${extra.replace(/&move=0/, '').replace(/[&=]/g, '-')}@${t}`;
    await p.go(`${LAB}&mode=${mode}&t=${t}${extra}${BARE}`);
    const title = await p.ev(`new Promise((r) => { const i = setInterval(() => { if (/READY|ERROR/.test(document.title)) { clearInterval(i); r(document.title); } }, 100); setTimeout(() => r('TIMEOUT'), 30000); })`);
    const hud = await p.ev(`document.getElementById('hud').textContent`);
    check(title === 'READY', `${tag}: page ${title} ${title === 'READY' ? '' : hud}`);
    if (title !== 'READY') continue;
    const s = await p.ev(PROBE);
    await p.shot(`${HERO}-${tag}.png`);
    if (s.err) { check(false, `${tag}: ${s.err}`); continue; }
    if (mode === 'idle') rest = s.q;
    // how far the pose is from idle: the most any bone has turned, degrees
    let moved = 0, n = 0;
    if (rest) for (const k in s.q) { if (!rest[k]) continue; const d = Math.abs(s.q[k].reduce((a, x, i) => a + x * rest[k][i], 0)); moved = Math.max(moved, 2 * Math.acos(Math.min(1, d)) * 57.3); n++; }
    moved = +moved.toFixed(1);
    rows.push({ move: tag, bones: s.bones, feet: +(s.lo - s.y).toFixed(2), top: +(s.hi - s.y).toFixed(2), poseDeg: moved });
    check(s.nan === 0, `${tag}: ${s.nan} bones with NaN`);
    check(s.bones >= 65, `${tag}: only ${s.bones} bones`);
    const grounded = !['jump', 'flip', 'land'].includes(mode);
    if (grounded && mode !== 'down') check(Math.abs(s.lo) < 0.12, `${tag}: lowest vertex at y=${s.lo} (should stand on the ground)`);
    if (mode === 'idle') check(s.hi > 1.4 && s.hi < 1.7, `idle: stands ${s.hi} m tall (want ~1.55)`);
    if (mode === 'down') check(s.hi < 1.0, `down: still ${s.hi} m tall while knocked down`);
    const missing = HERO === 'human' && /bow|fold/.test(extra); // the human bake has no bow / fold clips (rogue_anims.py TRIMS)
    if (mode !== 'idle' && !missing) check(moved > 8, `${tag}: pose is the same as idle (${moved}°), clip did not play`);
  }
  console.table(rows);
  // ---- the carried blade stays out of the body: step each move at 60 Hz, cast a ray along the blade
  // (from 13 cm past the grip, clear of the fist) at the skinned body, count frames where it hits
  for (const [mode, dur] of [['idle', 2], ['run', 2], ['turn', 3], ['stop', 1.5], ['jump', 1.2], ['combo', 1.6]]) {
    await p.go(`${LAB}&mode=${mode}&t=0&eq=iron_sword&wear=none`);
    await p.ev(`new Promise((r) => { const i = setInterval(() => { if (/READY|ERROR/.test(document.title)) { clearInterval(i); r(1); } }, 50); })`);
    const r = await p.ev(`(() => {
      const { THREE, hero, step } = __lab;
      let body = null, hand = null;
      hero.root.traverse((o) => { if (o.isSkinnedMesh && !body) body = o; if (o.isBone && /RightHand$/.test(o.name)) hand = o; });
      body.material.side = THREE.DoubleSide;
      body.geometry.boundingSphere = body.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const ray = new THREE.Raycaster(), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
      const si = body.geometry.attributes.skinIndex, sw = body.geometry.attributes.skinWeight;
      const boneOf = (v) => { let k = 0; for (let j = 1; j < 4; j++) if (sw.getComponent(v, j) > sw.getComponent(v, k)) k = j; return body.skeleton.bones[si.getComponent(v, k)].name; };
      let frames = 0, bad = 0; const where = new Set();
      for (let f = 0; f < 60 + ${dur * 60}; f++) {
        step();
        if (f < 55) continue;
        hero.root.updateMatrixWorld(true);
        hand.getWorldPosition(a); hero.tipWorld(b);
        ray.set(a, d.subVectors(b, a).normalize()); ray.near = 0.13; ray.far = a.distanceTo(b);
        const hits = ray.intersectObject(body, false).map((h) => boneOf(h.face.a).replace(/^mixamorig:?/, '')).filter((n) => !/RightHand|RightForeArm/.test(n));
        frames++; if (hits.length) { bad++; hits.forEach((n) => where.add(n)); }
      }
      return { frames, bad, where: [...where].join(' ') };
    })()`);
    console.log(`blade ${mode}: through the body on ${r.bad}/${r.frames} frames ${r.where}`);
    check(r.bad <= r.frames * 0.02, `${mode}: the sword passes through the body on ${r.bad}/${r.frames} frames (${r.where})`);
  }
  // starts out in its cloak (START_WEAR), and ?wear=none takes it off
  for (const [q, want] of [['', true], ['&wear=none', false]]) {
    await p.go(`${LAB}&mode=idle&t=0.2${q}`);
    await p.ev(`new Promise((r) => { const i = setInterval(() => { if (/READY|ERROR/.test(document.title)) { clearInterval(i); r(1); } }, 50); })`);
    const n = await p.ev(`(() => { let n = 0; __lab.hero.root.traverse((o) => { if (o.isSkinnedMesh) n++; }); return n; })()`);
    if (HERO === 'human') check((n > 1) === want, `cloak${q}: ${n} skinned meshes, expected ${want ? 'body + cloak' : 'body only'}`);
  }

  // ---- in the world: spawns as the GLB hero, runs, jumps, swings, no page errors
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  await p.go(`${BASE}/game/world3d/?area=fields&hour=13&hero=${HERO}`);
  const up = await p.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d && __world3d.mp.live) { clearInterval(t); r(true); } }, 200); setTimeout(() => r(false), 90000); })`);
  console.log(`world: booted ${up} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check(up, 'world: did not boot with ?hero=' + HERO);
  await sleep(2000);
  // the hero in the world: skinned GLB, sane bones, and how far its pose is from the one it stood in
  const W = (ref) => p.ev(`(() => {
    const h = __world3d.hero(), root = h.root || h.g || h; let bones = 0, nan = 0, skinned = 0, d = 0, n = 0;
    const ref = ${ref ? 'window.__ref' : 'null'}, q = {};
    root.traverse((o) => { if (o.isSkinnedMesh) skinned++; if (!o.isBone) return; bones++;
      if (![...o.quaternion.toArray(), ...o.position.toArray()].every(Number.isFinite)) nan++;
      q[o.name] = o.quaternion.toArray();
      if (ref && ref[o.name]) { d = Math.max(d, 2 * Math.acos(Math.min(1, Math.abs(q[o.name].reduce((a, x, i) => a + x * ref[o.name][i], 0)))) * 57.3); n++; } });
    if (!ref) window.__ref = q;
    const P = __world3d.P;
    return { bones, nan, skinned, maxDeg: +d.toFixed(1), x: +P.x.toFixed(2), z: +P.z.toFixed(2), y: +(P.y || 0).toFixed(2) };
  })()`);
  const crop = async (file) => { const r = await p.send('Page.captureScreenshot', { format: 'png', clip: { x: 400, y: 120, width: 480, height: 420, scale: 2 } }); writeFileSync(join(OUT, file), Buffer.from(r.result.data, 'base64')); };
  const idle = await W(false);
  console.log('world idle  ', idle);
  check(idle.skinned >= (HERO === 'human' ? 2 : 1) && idle.bones >= 65, `world: hero is not the GLB character (${idle.skinned} skinned meshes, ${idle.bones} bones)`);
  await crop(`${HERO}-world-idle.png`);
  // frame rate under software GL swings with machine load, so wait on the result, not the clock
  const until = (expr, ms = 20000) => p.ev(`new Promise((r) => { let best = -1e9; const t0 = performance.now(); const i = setInterval(() => { const v = ${expr}; best = Math.max(best, +v); if (v === true || performance.now() - t0 > ${ms}) { clearInterval(i); r(best); } }, 30); })`);
  const fps = await p.ev(`new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 > 2000 ? r(n / 2) : requestAnimationFrame(f); }; f(); })`);
  console.log('world fps   ', fps);
  await p.down('KeyW', 'w');
  await until(`Math.hypot(__world3d.P.x - ${idle.x}, __world3d.P.z - ${idle.z}) > 1.5`);
  const run = await W(true); console.log('world run   ', run);
  await crop(`${HERO}-world-run.png`);
  check(Math.hypot(run.x - idle.x, run.z - idle.z) > 1, `world: W moved the hero only ${Math.hypot(run.x - idle.x, run.z - idle.z).toFixed(2)} m`);
  check(run.maxDeg > 15, `world: run pose is ${run.maxDeg}° off idle, run clip not playing`);
  await p.ev(`(__world3d.jump(), 1)`);
  await until(`__world3d.P.y > 0.5`, 5000);
  const jump = await W(true); console.log('world jump  ', jump);
  await crop(`${HERO}-world-jump.png`);
  check(jump.y > 0.3, `world: jump lifted the hero only ${jump.y} m`);
  await p.up('KeyW', 'w');
  await until(`__world3d.P.y === 0 && Math.hypot(__world3d.P.vx, __world3d.P.vz) < 0.05`, 8000); await sleep(800);
  await p.down('KeyJ', 'j');
  await until(`__world3d.P.atk > 0.4`, 5000);
  const atk = await W(true); console.log('world attack', atk);
  await crop(`${HERO}-world-attack.png`);
  await p.up('KeyJ', 'j');
  check(atk.maxDeg > 15, `world: attack pose is ${atk.maxDeg}° off idle, swing not playing`);
  for (const s of [idle, run, jump, atk]) check(s.nan === 0, `world: ${s.nan} NaN bones`);
} finally { kill(); }
console.log(fails.length ? `\n${fails.length} FAILED\n - ` + fails.join('\n - ') : '\nPASS');
process.exit(fails.length ? 1 : 0);
