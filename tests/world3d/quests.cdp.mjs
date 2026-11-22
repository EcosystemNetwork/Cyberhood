// Quests in the browser (solo, so no account): the board, the tracker, progress from kills, handing in.
//   PORT=8137 node game-dev-server.js, then: node tests/world3d/quests.cdp.mjs
import assert from 'node:assert/strict';
import { launch, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red');
  await A.go('about:blank');
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13&nomp=1&solo=1`);
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
  await sleep(1500);
  const $ = (sel, prop = 'textContent') => A.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e && e[${JSON.stringify(prop)}]; })()`);

  assert.equal(await $('#questTrack', 'hidden'), true, 'no tracker before any quest');
  await A.ev(`document.getElementById('questBtn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); 1`);
  assert.equal(await $('#shopTitle'), 'Quests');
  await A.ev(`document.querySelector('#shopTabs [data-tab="q:board"]').click(); 1`);
  assert.match(await $('#shopList'), /Slime Season/);
  assert.doesNotMatch(await $('#shopList'), /Mushroom Watch/, 'later steps stay hidden');
  await A.ev(`document.querySelector('#shopList [data-act="q_take"][data-id="first_steps"]').click(); 1`);
  await A.shot('quests-board.png');
  assert.equal(await $('#questTrack', 'hidden'), false);
  assert.match(await $('#questTrack'), /Slime Season 0\/3/);

  // three slimes, killed the way the game kills them (with enough of your own damage)
  for (let i = 0; i < 3; i++) {
    await A.ev(`(() => { const w = __world3d; const m = w.monsters.find((x) => x.type === 'slime' && !x.dead); m.mine = m.cfg.hp; w.killMonster(m); return 1; })()`);
  }
  await sleep(300);
  assert.match(await $('#questTrack'), /ready to hand in/);
  assert.equal(await $('#questBtn .dot', 'hidden'), false, 'the button gets a dot');
  const gold = await A.ev('__world3d.field().gold');
  await A.ev(`document.querySelector('#shopTabs [data-tab="q:log"]').click(); 1`);
  await A.ev(`document.querySelector('#shopList [data-act="q_claim"]').click(); 1`);
  assert.equal(await A.ev('__world3d.field().gold'), gold + 20);
  assert.equal(await A.ev('__world3d.field().qlog.done.first_steps'), true);
  assert.match(await $('#shopGold'), new RegExp(`${gold + 20} gold`), 'the panel shows the new gold');
  await A.ev(`document.querySelector('#shopTabs [data-tab="q:board"]').click(); 1`);
  assert.match(await $('#shopList'), /Mushroom Watch/, 'the next step opens');
  await A.shot('quests-next.png');
  await A.ev(`document.querySelector('#shopPanel .x, #shopClose, [aria-label="Close"]')?.click(); 1`);
  await A.key('Escape');
  await sleep(200);
  await A.shot('quests-hud.png');

  // it's saved: a reload keeps the log
  await A.go('about:blank');
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13&nomp=1&solo=1`);
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
  assert.equal(await A.ev('__world3d.field().qlog.done.first_steps'), true);
  console.log('quests ok');
} finally {
  kill();
}
