// Character creator: pick the Human body, see the 3D preview, save; the server keeps it, the world
// builds you as the human (in the hooded cloak), and another player sees you as the human too.
//   CHROME=/usr/bin/chromium node tests/world3d/bodypick.cdp.mjs     (dev server on :8137)
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
const T0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const waitFor = (p, expr, ms = 30000) => p.ev(`new Promise((r) => { const t0 = Date.now(); const i = setInterval(() => { let v; try { v = ${expr}; } catch (e) {} if (v || Date.now() - t0 > ${ms}) { clearInterval(i); r(!!v); } }, 100); })`);
// the hero's skinned meshes (1 = the bare body, 2+ = body and cloak); 0 = the toon hero
const skinned = (p, expr) => p.ev(`(() => { let n = 0; (${expr}).root.traverse((o) => { if (o.isSkinnedMesh) n++; }); return n; })()`);
try {
  const A = await player('Robin');
  const user = 'robin' + Date.now().toString(36).slice(-6);
  // a fresh account, signed in the way the landing page does it
  await A.go(`${BASE}/game/`);
  const key = await A.ev(`fetch('/api/game/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '${user}', password: 'hunter22hunter' }) }).then((r) => r.json()).then((d) => d.key)`);
  assert.ok(key, 'signed up');
  await A.ev(`localStorage.setItem('taproot_session', ${JSON.stringify(key)}); localStorage.removeItem('taproot_character'); 1`);
  await A.go(`${BASE}/game/?create=1`);
  assert.ok(await waitFor(A, `!document.getElementById('creator').hidden`), 'creator opens'); log('creator opens');
  await A.shot('bodypick-1-classic.png');
  assert.equal(await A.ev(`document.querySelector('[data-k=body][data-v=classic]').getAttribute('aria-pressed')`), 'true', 'classic is the default');

  // pick Human: the skin / hair rows go, a 3D canvas appears and draws the character
  await A.ev(`document.querySelector('[data-k=body][data-v=human]').click(); 1`);
  assert.ok(await waitFor(A, `document.querySelector('#stage canvas.p3d') && !document.querySelector('#stage .p3dmsg')`, 60000), '3D preview loaded'); log('3D preview loaded');
  await sleep(800);
  // the canvas doesn't keep its drawing buffer, so measure a screenshot of the stage instead: pixels
  // that differ from the stage's backdrop (the same capture with the canvas hidden)
  const shotOf = async () => { const r = await A.ev(`(() => { const b = document.getElementById('stage').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()`); return (await A.send('Page.captureScreenshot', { format: 'png', clip: { x: r[0], y: r[1], width: r[2], height: r[3], scale: 1 } })).result.data; };
  const withHero = await shotOf();
  await A.ev(`document.querySelector('#stage canvas.p3d').style.visibility = 'hidden'; 1`);
  const without = await shotOf();
  await A.ev(`document.querySelector('#stage canvas.p3d').style.visibility = ''; 1`);
  const drawn = await A.ev(`Promise.all([${JSON.stringify('data:image/png;base64,' + withHero)}, ${JSON.stringify('data:image/png;base64,' + without)}].map((u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; }))).then(([a, b]) => {
    const c = document.createElement('canvas'); c.width = a.width; c.height = a.height; const g = c.getContext('2d');
    g.drawImage(a, 0, 0); const pa = g.getImageData(0, 0, c.width, c.height).data; g.drawImage(b, 0, 0); const pb = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 30) n++;
    return n / (c.width * c.height); })`);
  console.log('preview covers', (drawn * 100).toFixed(1) + '% of the stage');
  assert.ok(drawn > 0.03, 'the preview draws the character');
  assert.equal(await A.ev(`getComputedStyle(document.getElementById('skin').closest('.grp')).display`), 'none', 'skin row hidden for the human');
  await A.shot('bodypick-2-human.png');
  // class change re-dresses him (the ranger gets a bow, the knight a sword)
  await A.ev(`document.querySelector('[data-k=cls][data-v=ranger]').click(); 1`);
  await sleep(600);
  await A.shot('bodypick-3-ranger.png');
  await A.ev(`document.querySelector('[data-k=cls][data-v=knight]').click(); 1`);
  await A.ev(`(() => { const n = document.getElementById('name'); n.value = 'Robin'; n.dispatchEvent(new Event('input')); return 1; })()`);

  // save: the server keeps body
  await A.ev(`document.getElementById('save').click(); 1`);
  assert.ok(await waitFor(A, `!document.getElementById('home').hidden`), 'saved, home shows'); log('saved, home shows');
  const me = await A.ev(`fetch('/api/game/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('taproot_session') } }).then((r) => r.json())`);
  assert.equal(me.character.body, 'human', 'server saved body: human');
  // and refuses a body that doesn't exist (kept as the classic hero)
  const bad = await A.ev(`fetch('/api/game/save', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('taproot_session') }, body: JSON.stringify({ character: { ...${JSON.stringify(me.character)}, body: 'dragon' } }) }).then((r) => r.json())`);
  assert.equal(bad.character.body, undefined, 'unknown body dropped');
  await A.ev(`fetch('/api/game/save', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('taproot_session') }, body: JSON.stringify({ character: ${JSON.stringify(me.character)} }) }).then((r) => r.json())`);

  // the world: you are the human, in the cloak
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13`);
  // slower than usual to boot: it loads the human model first (and software GL is slow)
  assert.ok(await waitFor(A, `window.__world3d && __world3d.mp.live`, 120000), 'A in the world'); log('A in the world');
  const mine = await skinned(A, '__world3d.hero()');
  console.log('A sees self: skinned meshes', mine);
  assert.ok(mine >= 2, 'you are the human with the cloak');
  await sleep(1500);
  await A.shot('bodypick-4-world.png');

  // another (classic) player sees A as the human
  const B = await player('Blue');
  await B.go(`${BASE}/game/world3d/?area=fields&hour=13`);
  assert.ok(await waitFor(B, `window.__world3d && __world3d.mp.live`, 300000), 'B in the world'); log('B in the world');
  assert.ok(await waitFor(B, `[...__world3d.ghosts.values()].some((g) => g.name === 'Robin')`, 20000), 'B sees A'); log('B sees A');
  assert.ok(await waitFor(B, `(() => { const g = [...__world3d.ghosts.values()].find((g) => g.name === 'Robin'); let n = 0; g.hero.root.traverse((o) => { if (o.isSkinnedMesh) n++; }); return n >= 2; })()`, 90000), 'B sees A as the human');
  assert.equal(await skinned(B, '__world3d.hero()'), 0, 'B is still the classic hero');
  console.log('PASS');
  await B.shot('bodypick-5-seen-by-other.png');
} finally { kill(); }
process.exit(0);
