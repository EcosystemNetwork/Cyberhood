// Sound effects: nothing plays before the first key press (browsers forbid it), then actions
// make their sounds, footsteps follow the run, and M mutes and is remembered.
import assert from 'node:assert/strict';
import { launch, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red');
  await A.ev(`localStorage.removeItem('taproot_sfx'); 1`);
  const boot = async () => {
    await A.go(`${BASE}/game/world3d/?area=fields&hour=13&nomp=1`);
    await A.ev(`new Promise((r) => { const t = setInterval(() => { if (window.__world3d) { clearInterval(t); r(1); } }, 200); })`);
    await sleep(1500);
    await A.ev('__world3d.monsters.forEach((m) => { m.dead = true; }); __world3d.tp(120, 104, Math.PI); 1');
  };
  // headless frames can be slow, so wait on the game rather than the clock
  const until = async (name, n = 1) => { for (let i = 0; i < 300 && (await log()).filter((x) => x === name).length < n; i++) await sleep(100); };
  const log = async () => JSON.parse(await A.ev('JSON.stringify(__world3d.sfx.log)'));
  await boot();
  assert.equal(await A.ev('__world3d.sfx.count'), 0, 'silent until the first input');
  assert.equal(await A.ev(`document.getElementById('soundBtn').classList.contains('off')`), false, 'sound starts on');

  await A.key('Space', ' ');
  await sleep(300);
  assert.ok(await A.ev('__world3d.sfx.ready'), 'the first key press starts the audio');
  await A.ev(`new Promise((r) => { const t = setInterval(() => { if (__world3d.P.grounded === 0) { clearInterval(t); r(1); } }, 100); })`); // back on the ground
  await A.key('Space', ' ');
  await until('land');
  assert.ok((await log()).includes('jump'), `jumping makes a sound (${await log()})`);
  assert.ok((await log()).includes('land'), `and so does landing (${await log()})`);

  await A.key('KeyJ', 'j');
  await until('swing');
  assert.ok((await log()).includes('swing'), `a swing makes a sound (${await log()})`);

  await A.down('KeyW', 'w'); await until('step', 2); await A.up('KeyW', 'w');
  const steps = (await log()).filter((n) => n === 'step').length;
  assert.ok(steps >= 2, `running makes footsteps (${steps})`);

  await A.key('KeyB', 'b'); await until('open'); await A.key('KeyB', 'b'); await until('close');
  assert.ok((await log()).includes('open') && (await log()).includes('close'), 'the bag opens and closes with a sound');

  // M opens the full map (and doesn't touch the sound); M again closes it
  await A.key('KeyM', 'm');
  assert.equal(await A.ev(`document.getElementById('worldMap').hidden`), false, 'M opens the map');
  assert.equal(await A.ev('__world3d.sfx.muted'), false, 'M no longer mutes');
  await sleep(300); await A.shot('map-1.png');
  await A.key('KeyM', 'm');
  assert.equal(await A.ev(`document.getElementById('worldMap').hidden`), true, 'M closes the map');

  // O mutes: nothing more plays, the button shows it, and a reload keeps it
  await A.key('KeyO', 'o');
  assert.equal(await A.ev('__world3d.sfx.muted'), true, 'O mutes');
  assert.equal(await A.ev(`document.getElementById('soundBtn').classList.contains('off')`), true, 'the button shows muted');
  const n = await A.ev('__world3d.sfx.count');
  await A.key('Space', ' '); await sleep(300);
  assert.equal(await A.ev('__world3d.sfx.count'), n, 'muted: a jump is silent');
  await boot();
  assert.equal(await A.ev('__world3d.sfx.muted'), true, 'still muted after a reload');
  await A.key('KeyO', 'o');
  assert.equal(await A.ev('__world3d.sfx.muted'), false, 'O again turns it back on');
  await sleep(200);
  assert.ok((await log()).includes('ui'), 'with a blip to say so');
  await A.shot('sound-1.png');
  console.log('sound: ok');
} finally { kill(); }
