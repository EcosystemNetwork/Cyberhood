// Rendering upgrade: graphics presets, the frame-rate governor and district rain.
//   PORT=8137 node game-dev-server.js, then: node tests/world3d/render.cdp.mjs
import assert from 'node:assert/strict';
import { launch, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red');
  const boot = async (q) => {
    await A.go('about:blank'); // a fresh page each time: the old one's __world3d must not answer for the new one
    await A.go(`${BASE}/game/world3d/?area=fields&hour=13&nomp=1&${q}`);
    await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
    await sleep(1500);
  };

  // the old desktop frame is the high preset; ?governor=0 keeps headless timing out of it
  await A.ev(`localStorage.removeItem('w3d.gfx'); 1`);
  await boot('governor=0&rain=0');
  let g = await A.ev('__world3d.gfx()');
  assert.deepEqual([g.preset, g.shadowMap, g.bloom, g.scale], ['high', 2048, true, 1], JSON.stringify(g));
  assert.equal(await A.ev(`document.querySelector('#gfxBtn .lbl').textContent.trim()`), 'High');

  // the button cycles to low, which is remembered for the next visit
  await A.ev(`document.getElementById('gfxBtn').click(); 1`);
  g = await A.ev('__world3d.gfx()');
  assert.deepEqual([g.preset, g.shadowMap, g.bloom], ['low', 1024, false]);
  assert.equal(await A.ev('__world3d.rain().drops'), 400, 'low draws fewer drops');
  await boot('governor=0&rain=0');
  assert.equal((await A.ev('__world3d.gfx()')).preset, 'low', 'the choice survives a reload');
  await A.shot('render-low.png');
  await A.ev(`localStorage.removeItem('w3d.gfx'); 1`);

  // a pinned downpour: visible, and the sky and fog close in
  await boot('governor=0&rain=1');
  for (let i = 0; i < 80 && (await A.ev('__world3d.rain().wet')) < 0.8; i++) await sleep(100);
  const r = await A.ev('__world3d.rain()');
  assert.ok(r.visible && r.wet > 0.8 && r.local, JSON.stringify(r));
  await A.shot('render-rain.png');

  // the governor: headless swiftshader is slow, so with it on the scale drops below 1, never under the floor
  await boot('rain=0&gfx=high');
  for (let i = 0; i < 100 && (await A.ev('__world3d.gfx().scale')) === 1; i++) await sleep(200);
  g = await A.ev('__world3d.gfx()');
  console.log('governor on swiftshader:', JSON.stringify(g));
  assert.ok(g.scale >= 0.68 && g.scale <= 1);

  // every overworld point names a district, so rain can belong to one
  const d = await A.ev('[__world3d.districtAt(__world3d.P.x, __world3d.P.z), __world3d.districtAt(-5, -5)]');
  assert.equal(typeof d[0], 'string');
  assert.equal(d[1], null);
  console.log('render ok', JSON.stringify(d));
} finally {
  kill();
}
