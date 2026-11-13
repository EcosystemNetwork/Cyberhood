// The Gear button in the bag pulls up the Armory — the same screen as the pre-game page — over the
// 3D world. Picking an item there and pressing Back dresses the hero in it, without reloading.
import assert from 'node:assert/strict';
import { launch, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red');
  // the Armory signs in for real, so this needs a real local account with a character
  const name = 'gear' + Date.now().toString(36).slice(-7);
  const key = await A.ev(`(async () => {
    const post = (a, b, k) => fetch('/api/game/' + a, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(k ? { Authorization: 'Bearer ' + k } : {}) }, body: JSON.stringify(b) }).then((r) => r.json());
    const d = await post('signup', { username: '${name}', password: 'testtest123' });
    const character = { name: 'Red', cls: 'knight', skin: 1, hs: 'short', hc: 1, equipment: { feet: 'leather_boots' } };
    await post('save', { character }, d.key);
    localStorage.setItem('taproot_session', d.key);
    localStorage.setItem('taproot_character', JSON.stringify(character));
    localStorage.removeItem('taproot3d_fp');
    return d.key;
  })()`);
  assert.ok(key, 'a local account to sign in with');

  await A.go(`${BASE}/game/world3d/?area=city&hour=13&nomp=1`);
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
  await sleep(2000);
  assert.equal(await A.ev(`__world3d.gearOf('feet')`), 'leather_boots');

  // the bag has a Gear button, and it opens the Armory over the world
  await A.key('KeyB', 'b'); await sleep(300);
  assert.equal(await A.ev(`!!document.getElementById('gearBtn') && !document.getElementById('bagPanel').hidden`), true, 'the bag shows a Gear button');
  await A.ev(`document.getElementById('gearBtn').click(); 1`);
  const frame = `document.getElementById('armoryFrame')`;
  let open = false;
  for (let i = 0; i < 60 && !open; i++) {
    await sleep(200);
    open = await A.ev(`(() => { const f = ${frame}; const d = f && f.contentDocument; return !!(d && d.getElementById('armory') && !d.getElementById('armory').hidden && d.querySelector('[data-equip]')); })()`);
  }
  assert.equal(open, true, 'Gear opens the Armory screen, straight to its item cards');

  // pick the windrunner boots on the Feet tab
  await A.ev(`(() => { const d = ${frame}.contentDocument; d.querySelector('[data-tab="feet"]').click(); })(); 1`); await sleep(200);
  await A.ev(`(() => { const d = ${frame}.contentDocument; d.querySelector('[data-equip="windrunner_boots"]').click(); })(); 1`); await sleep(200);

  // Back closes it and the hero is wearing them, with no reload in between
  await A.ev(`window.__noReload = true; 1`);
  await A.ev(`${frame}.contentDocument.getElementById('armBack').click(); 1`);
  await sleep(800);
  assert.equal(await A.ev(`!document.getElementById('armoryFrame')`), true, 'Back closes the overlay');
  assert.equal(await A.ev(`window.__noReload === true`), true, 'the world did not reload');
  assert.equal(await A.ev(`__world3d.gearOf('feet')`), 'windrunner_boots', 'the hero is wearing what you picked');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
