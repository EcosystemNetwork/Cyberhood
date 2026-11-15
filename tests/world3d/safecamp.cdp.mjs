// Mine 1F safe camp + mana: monsters can't get into the ring or hurt you there, you heal inside,
// and staffs spend mana (out of mana = no shot) which refills over time.
import assert from 'node:assert/strict';
import { launch, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Camper');
  await A.go(`${BASE}/game/world3d/?area=cave&from=fields&nomp=1`);
  for (let i = 0; i < 120 && !(await A.ev('!!window.__world3d').catch(() => false)); i++) await sleep(150);
  await sleep(1200);
  const S = await A.ev('__world3d.safe()');
  assert.ok(S, 'the Mine 1F has a safe camp');
  assert.ok(await A.ev(`__world3d.walkable(22, 49, ${Math.floor(S.x)}, ${Math.floor(S.y)})`), 'you can walk from the entrance into the camp');
  // stand in the camp with a goblin and a bat right at the ring
  await A.ev(`__world3d.tp(${S.x}, ${S.y}); __world3d.setHp(40); 1`);
  const g = await A.ev(`__world3d.spawn('goblin', ${S.x + S.r + 0.9}, ${S.y})`), b = await A.ev(`__world3d.spawn('bat', ${S.x - S.r - 0.9}, ${S.y})`);
  await sleep(3000);
  const d = await A.ev(`[${g}, ${b}].map((i) => Math.hypot(__world3d.monsters[i].x - ${S.x}, __world3d.monsters[i].z - ${S.y}))`);
  assert.ok(d.every((v) => v >= S.r), `monsters stay outside the ring: ${d.map((v) => v.toFixed(2))}`);
  const hp = await A.ev('__world3d.hp()');
  assert.ok(hp > 40, `you heal in the camp and nothing hurts you there (hp 40 -> ${hp})`);
  // mana: the thunder staff costs 25 a shot
  await A.ev(`__world3d.equip('thunder_staff', 'rhand'); 1`);
  await sleep(300);
  await A.ev(`__world3d.tp(${S.x + 6}, ${S.y}); 1`);
  const m0 = await A.ev('__world3d.mana()');
  await A.key('KeyJ', 'j'); await sleep(150);
  const m1 = await A.ev('__world3d.mana()');
  assert.ok(m0 - m1 > 15, `a staff shot spends mana (${m0.toFixed(1)} -> ${m1.toFixed(1)})`);
  for (let i = 0; i < 12; i++) { await A.key('KeyJ', 'j'); await sleep(850); }
  const low = await A.ev('__world3d.mana()');
  assert.ok(low < 40, `spamming runs it down (${low.toFixed(1)})`);
  await sleep(3000);
  assert.ok(await A.ev('__world3d.mana()') > low + 25, 'it refills on its own');
  assert.match(await A.ev('document.getElementById("manaText").textContent'), /^MP \d+ \/ 100$/);
  await A.ev(`__world3d.tp(${S.x + 1.6}, ${S.y + 0.8}, 2.4); __world3d.cam(6, 0.45); 1`); await sleep(800);
  await A.shot('safecamp.png');
  console.log('safecamp: ok');
} finally { await kill(); }
