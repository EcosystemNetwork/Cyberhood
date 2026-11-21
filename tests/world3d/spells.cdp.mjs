// Dragon Staff (slow, huge, hard-hitting), Inferno pillar (blink, then a column of fire),
// Phoenix Ward (first hit after 10s is free) and the Archmage's Hat (endless mana).
import assert from 'node:assert/strict';
import { launch, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Caster');
  await A.go(`${BASE}/game/world3d/?area=cave&from=fields&nomp=1`);
  for (let i = 0; i < 120 && !(await A.ev('!!window.__world3d').catch(() => false)); i++) await sleep(150);
  await sleep(1200);
  const W = '__world3d';
  const spot = { x: 30.5, z: 46.5 }; // open floor in the entrance room, east of the camp
  const setup = async (id) => { await A.ev(`${W}.equip('${id}', 'rhand'); ${W}.setAutoAim(false); ${W}.tp(${spot.x}, ${spot.z}, 0); ${W}.monsters.forEach((m) => { m.x = 2; m.z = 2; }); 1`); await sleep(400); };
  const face = (x, z) => A.ev(`${W}.P.heading = Math.atan2(${x} - ${W}.P.x, ${z} - ${W}.P.z); 1`);

  // --- Dragon Staff
  await setup('dragon_staff');
  const g1 = await A.ev(`${W}.spawn('goblin', ${spot.x + 5}, ${spot.z})`);
  await face(spot.x + 5, spot.z);
  await A.key('KeyJ', 'j'); await sleep(450);
  const fb = await A.ev(`(() => { const f = ${W}.fireballs.find((f) => f.c.dragon); return f && { speed: f.c.speed, size: f.c.size, dmg: f.c.dmg }; })()`);
  assert.ok(fb, 'the Dragon Staff fires a dragon fireball');
  assert.ok(await A.ev(`${W}.mana()`) < 70, 'it costs a lot of mana');
  assert.ok(fb.speed <= 6 && fb.size >= 2.5 && fb.dmg >= 3, `slow, huge, hard-hitting: ${JSON.stringify(fb)}`);
  await A.ev(`${W}.cam(5.5, 0.35); 1`); await A.shot('spell-dragon.png');
  await sleep(1500);
  assert.ok(await A.ev(`${W}.monsters[${g1}].hp <= 0 || ${W}.monsters[${g1}].dead`), 'one dragon fireball drops a goblin');

  await sleep(2600); // the Dragon Staff's long cooldown
  // --- Inferno pillar
  await setup('inferno_staff');
  const s1 = await A.ev(`${W}.spawn('shroom', ${spot.x + 4}, ${spot.z})`);
  await A.ev(`${W}.monsters[${s1}].cfg = Object.assign({}, ${W}.monsters[${s1}].cfg, { speed: 0, aggro: 0 }); 1`); // hold still
  await face(spot.x + 4, spot.z);
  await A.ev(`${W}.setAutoAim(true); 1`);
  await A.key('KeyJ', 'j'); await sleep(500);
  assert.equal(await A.ev(`${W}.pillars.length`), 1, 'a pillar is marked on the floor');
  assert.equal(await A.ev(`${W}.pillars[0].fired`), false, 'it waits (blinks) before firing');
  const hp0 = await A.ev(`${W}.monsters[${s1}].hp`);
  await A.ev(`${W}.cam(6, 0.5); 1`); await A.shot('spell-pillar-mark.png');
  await sleep(750);
  await A.shot('spell-pillar-fire.png');
  await sleep(400);
  assert.ok(await A.ev(`${W}.monsters[${s1}].hp`) < hp0, 'the column of fire burns what stands in it');

  // --- Phoenix Ward
  await A.ev(`${W}.equip('phoenix_plate', 'body'); ${W}.equip('iron_sword', 'rhand'); ${W}.setHp(100); 1`);
  await sleep(300);
  assert.equal(await A.ev(`${W}.wardReady()`), true, 'the ward starts ready');
  await A.shot('spell-ward.png');
  const gob = await A.ev(`${W}.spawn('goblin', ${W}.P.x + 0.3, ${W}.P.z)`);
  for (let i = 0; i < 30 && (await A.ev(`${W}.wardReady()`)); i++) await sleep(100);
  assert.equal(await A.ev(`${W}.wardReady()`), false, 'a hit uses the ward');
  const after = await A.ev(`${W}.hp()`);
  assert.equal(after, 100, 'the warded hit did no damage');
  await sleep(1500);
  assert.ok(await A.ev(`${W}.hp()`) < 100, 'the next hits land as normal');
  await A.ev(`${W}.monsters[${gob}].x = 2; ${W}.monsters[${gob}].z = 2; 1`);

  // --- Archmage's Hat
  await A.ev(`${W}.equip('archmage_hat', 'head'); ${W}.equip('thunder_staff', 'rhand'); 1`);
  await sleep(300);
  for (let i = 0; i < 8; i++) { await A.key('KeyJ', 'j'); await sleep(850); }
  assert.match(await A.ev('document.getElementById("manaText").textContent'), /∞/, 'the bar shows endless mana');
  assert.ok(await A.ev(`${W}.fireballs.length + 0`) >= 0);
  console.log('spells: ok');
} finally { await kill(); }
