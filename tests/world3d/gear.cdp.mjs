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

  /* ---------- any hand item goes in either hand ---------- */
  await A.ev(`document.getElementById('gearBtn').click(); 1`);
  open = false;
  for (let i = 0; i < 60 && !open; i++) {
    await sleep(200);
    open = await A.ev(`(() => { const f = ${frame}; const d = f && f.contentDocument; return !!(d && d.getElementById('armory') && !d.getElementById('armory').hidden && d.querySelector('[data-equip]')); })()`);
  }
  const cards = (tab) => A.ev(`(() => { const d = ${frame}.contentDocument; d.querySelector('[data-tab="${tab}"]').click(); return [...d.querySelectorAll('#aItems [data-equip]')].map((b) => b.dataset.equip).filter(Boolean); })()`);
  const right = await cards('rhand'), left = await cards('lhand');
  assert.ok(right.includes('mirror_shield') && right.includes('iron_sword'), 'R.Hand lists shields as well as weapons');
  assert.ok(left.includes('thunder_staff') && left.includes('wooden_shield'), 'L.Hand lists weapons as well as shields');
  // a thunder staff in the left hand, a sword in the right; then move the sword across
  const pick = (tab, id) => A.ev(`(() => { const d = ${frame}.contentDocument; d.querySelector('[data-tab="${tab}"]').click(); d.querySelector('#aItems [data-equip="${id}"]').click(); })(); 1`);
  await pick('rhand', 'iron_sword'); await sleep(150);
  await pick('lhand', 'thunder_staff'); await sleep(150);
  await A.ev(`${frame}.contentDocument.getElementById('armBack').click(); 1`);
  await sleep(800);
  assert.equal(await A.ev(`__world3d.gearOf('lhand')`), 'thunder_staff', 'a staff goes in the left hand');
  assert.ok(await A.ev(`!!__world3d.hero().casterL`), 'and fires from the left hand');
  // the same item can't be in both hands: picking the sword for the left takes it out of the right
  await A.ev(`document.getElementById('gearBtn').click(); 1`);
  for (let i = 0; i < 60 && !(await A.ev(`(() => { const d = ${frame} && ${frame}.contentDocument; return !!(d && d.querySelector('#aItems [data-equip]')); })()`)); i++) await sleep(200);
  await pick('lhand', 'iron_sword'); await sleep(150);
  await A.ev(`${frame}.contentDocument.getElementById('armBack').click(); 1`);
  await sleep(800);
  assert.equal(await A.ev(`__world3d.gearOf('lhand')`), 'iron_sword', 'the sword moved to the left hand');
  assert.notEqual(await A.ev(`__world3d.gearOf('rhand')`), 'iron_sword', 'and is no longer in the right');

  // a mirror shield in the RIGHT hand still blocks, on the right-hand key
  await A.ev(`__world3d.equip('mirror_shield', 'rhand'); 1`); await sleep(300);
  assert.equal(await A.ev(`__world3d.gearOf('rhand')`), 'mirror_shield');
  await A.key('Quote', "'");
  assert.equal(await A.ev(`__world3d.parrying()`), true, 'a shield in the right hand raises on the right-hand key');

  /* ---------- the shops show each item's picture, not a generic slot emoji ---------- */
  await A.ev(`__world3d.openShop('The Armoury'); 1`); await sleep(800);
  const pics = await A.ev(`(() => { const ims = [...document.querySelectorAll('#shopList .row .ico img')]; return { n: ims.length, broken: ims.filter((im) => !im.complete || im.naturalWidth === 0).map((im) => im.src.split('/').pop()) }; })()`);
  assert.ok(pics.n >= 10, `the Armoury shows item pictures (${pics.n})`);
  assert.deepEqual(pics.broken, [], 'and none of them are broken');
  const mirrorRow = await A.ev(`[...document.querySelectorAll('#shopList .row')].find((r) => r.textContent.includes('Mirror Shield')).innerHTML`);
  assert.ok(/Equip R|In R/.test(mirrorRow) && /Equip L|In L/.test(mirrorRow), 'a shield can be put in either hand from the shop too');

  console.log('PASS');
} finally { kill(); }
process.exit(0);
