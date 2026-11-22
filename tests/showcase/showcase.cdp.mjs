// The Hollow Chapel showcase: boots clean, renders, and the combat loop works.
//   PORT=8193 node game-dev-server.js &
//   BASE=http://localhost:8193 CHROME=/usr/bin/chromium CHROME_ANGLE=gl node tests/showcase/showcase.cdp.mjs [outDir]
// Screenshots (fixed cameras + gameplay) land in outDir (default tests/showcase/out).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, BASE } from '../world3d/harness.mjs';

const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });
const ONLY = process.env.ONLY; // e.g. ONLY=shots to skip the combat checks

const { player, kill } = await launch();
try {
  const A = await player('Warden');
  const errors = [];
  A.send('Runtime.enable');
  const snap = async (file) => { const r = await A.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, file), Buffer.from(r.result.data, 'base64')); };
  const boot = async (qs) => {
    await A.go(`${BASE}/game/showcase/?auto&stats&${qs}`);
    const ok = await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.SHOWCASE) { clearInterval(t); r(true); } }, 250); setTimeout(() => r(false), 60000); })`);
    assert.ok(ok, 'the showcase boots (window.SHOWCASE) within 60 s');
    await sleep(2500);
  };

  // ---- fixed cameras: the art review set
  const CAMS = {
    hero: '0.9,1.75,11.6,0,1.25,9',               // the warden, close
    court: '9,4.2,15,0,2.5,-8',                    // courtyard → chapel front
    facade: '-3.5,2.2,-4,0,6,-12',                 // looking up at the west front
    nave: '0.5,2.0,-13.5,0,1.6,-28',               // down the nave to the altar
    glade: '-19,5.5,17,0,2,-10',                   // wide, from the forest edge
  };
  for (const [name, c] of Object.entries(ONLY === 'play' ? {} : CAMS)) {
    await boot(`cam=${c}`);
    await snap(`cam_${name}.png`);
  }
  if (ONLY !== 'play') {
  const info = JSON.parse(await A.ev(`JSON.stringify({ calls: SHOWCASE.R.renderer.info.render.calls, tris: SHOWCASE.R.renderer.info.render.triangles, fps: SHOWCASE.clock.fps, grass: SHOWCASE.world.grass.count(), q: SHOWCASE.R.quality })`));
  console.log('render', info);
  assert.ok(info.calls < 500, `draw calls stay under budget (${info.calls})`);
  }

  if (ONLY !== 'shots') {
    // ---- gameplay
    await boot('');
    await snap('play_start.png');
    // walk toward the courtyard: W held
    await A.down('KeyW', 'w'); await sleep(1800); await A.up('KeyW', 'w');
    const z1 = await A.ev('SHOWCASE.player.pos.z');
    assert.ok(z1 < 7, `W walks the warden toward the chapel (z ${z1})`);
    // bring a revenant in front of the warden and strike it
    await A.ev(`(() => { const S = SHOWCASE, p = S.player.pos, e = S.foes.list[0]; e.pos.set(p.x, p.y, p.z - 1.5); e.state = 'stun'; e.stun = 5; S.player.yaw = Math.PI; S.cam.yaw = 0; return 1; })()`);
    const hp0 = await A.ev('SHOWCASE.foes.list[0].hp');
    await A.ev('SHOWCASE.doAttack(); 1'); await sleep(700);
    await snap('play_swing.png');
    const hp1 = await A.ev('SHOWCASE.foes.list[0].hp');
    assert.ok(hp1 < hp0, `a swing at a revenant in reach hurts it (${hp0} → ${hp1})`);
    // the combo walks: three swings chained
    await A.ev(`SHOWCASE.foes.list[0].stun = 5; SHOWCASE.foes.list[0].hp = 1; 1`);
    for (let i = 0; i < 3; i++) { await A.ev('SHOWCASE.doAttack(); 1'); await sleep(i === 2 ? 900 : 420); }
    assert.ok(await A.ev('SHOWCASE.foes.list[0].hp') < 0.5, 'a chained combo lands every swing');
    // stage a revenant blow on open ground east of the courtyard: warden at (7, 4) facing north,
    // the other revenants parked out of the way, then a strike from 1.3 m in front
    const stage = `(() => { const S = SHOWCASE, P = S.player; P.pos.set(7, 0, 4); P.yaw = Math.PI; P.hp = 100; P.st = 100; P.iUntil = 0; P.atk.p = -1;
      S.foes.list.forEach((o, i) => { o.state = 'stun'; o.stun = 99; o.pos.set(-8 - i * 2, 0, 6); });
      const e = S.foes.list[1]; e.state = 'strike'; e.t = 0; e.p = 0.3; e.hitDone = false; e.stun = 0; e.pos.set(7, 0, 2.7); e.yaw = 0; return 1; })()`;
    // guard held well before the blow (not a parry): blocked, no HP lost, stamina paid
    await A.ev('SHOWCASE.setGuard(true); SHOWCASE.clock.t += 1; 1');
    await sleep(200);
    await A.ev(stage);
    await sleep(600);
    await snap('play_guard.png');
    assert.equal(await A.ev('SHOWCASE.player.hp'), 100, 'a guarded blow from the front does no damage');
    assert.ok(await A.ev('SHOWCASE.player.st') < 100, 'the blocked blow costs stamina (so it really landed on the guard)');
    await A.ev('SHOWCASE.setGuard(false); 1');
    // the same blow unguarded hurts
    await A.ev(stage);
    await sleep(600);
    assert.ok(await A.ev('SHOWCASE.player.hp') < 100, 'an unguarded blow hurts the warden');
    // a guard raised just before the blow is a parry: the revenant is stunned open
    await A.ev(stage);
    await A.ev('SHOWCASE.setGuard(true); 1');
    await sleep(500);
    assert.equal(await A.ev('SHOWCASE.foes.list[1].state'), 'stun', 'a just-in-time guard parries and stuns the attacker');
    assert.equal(await A.ev('SHOWCASE.player.hp'), 100, 'a parried blow does no damage');
    await A.ev('SHOWCASE.setGuard(false); 1');
    // dodge roll: moves the warden over 1.5 m
    await A.ev('(() => { const P = SHOWCASE.player; P.pos.set(7, 0, 4); P.yaw = Math.PI; P.st = 100; return 1; })()');
    await sleep(100);
    const before = JSON.parse(await A.ev('JSON.stringify(SHOWCASE.player.pos)'));
    await A.ev('SHOWCASE.doRoll(); 1'); await sleep(250);
    await snap('play_roll.png');
    await sleep(500);
    const after = JSON.parse(await A.ev('JSON.stringify(SHOWCASE.player.pos)'));
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > 1.5, 'a dodge roll carries the warden over 1.5 m');
    await snap('play_end.png');
  }
  const errs = await A.ev('window.__errs || []');
  assert.equal(errs.length, 0, 'no page errors: ' + JSON.stringify(errs));
  console.log('showcase: all checks passed →', OUT);
} finally {
  kill();
}
