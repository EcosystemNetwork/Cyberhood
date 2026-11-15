// The Mine, three floors deep: climb 1F → B1 → B2 and back up by pressing F at each ladder,
// check you can walk from where you arrive to the next ladder, the floor badge, the minimap
// label, and that the two giants are in the Hollow with their bars and fight back.
import assert from 'node:assert/strict';
import { launch, ready, sleep, near, BASE } from './harness.mjs';

const canMove = (p) => p.ev(`(() => {
  const x = __world3d.P.x, z = __world3d.P.z;
  const open = [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].filter(([dx, dz]) => __world3d.free(x + dx, z + dz)).length;
  return __world3d.free(x, z) && open >= 2;
})()`);
const here = (p) => p.ev('JSON.stringify({ area: new URLSearchParams(location.search).get("area"), x: Math.floor(__world3d.P.x), y: Math.floor(__world3d.P.z) })').then(JSON.parse);
const ladder = (p, dir) => p.ev(`JSON.stringify(__world3d.ladders.find((l) => l.dir === '${dir}'))`).then((s) => s && JSON.parse(s));
// stand on the tile beside a ladder and press F; wait for the next floor to load
async function climb(p, dir, to) {
  const l = await ladder(p, dir);
  assert.ok(l, `there is a ladder ${dir}`);
  await p.ev(`__world3d.tp(${l.x + 0.5}, ${l.y + 1.6}); 1`);
  await sleep(400);
  const prompt = await near(p);
  assert.match(prompt, new RegExp(`Press F to climb ${dir}`), `the prompt says climb ${dir}: "${prompt}"`);
  assert.match(prompt, new RegExp(l.floor.name), `the prompt says where it goes: "${prompt}"`);
  await p.key('KeyF', 'f');
  for (let i = 0; i < 40 && !(await p.ev('location.search')).includes(`area=${to}`); i++) await sleep(150);
  assert.ok(await ready(p), `boots ${to}`);
  await sleep(900);
  const at = await here(p);
  assert.equal(at.area, to, `arrived in ${to}`);
  assert.equal(await canMove(p), true, `can move after arriving in ${to} (${JSON.stringify(at)})`);
}

const { player, kill } = await launch();
try {
  const A = await player('Digger');
  await A.go(`${BASE}/game/world3d/?area=cave&from=fields`);
  assert.ok(await ready(A), 'the mine boots');
  await sleep(900);
  assert.deepEqual(await A.ev('__world3d.size'), [72, 54], '1F is bigger');
  assert.equal(await canMove(A), true, 'can move coming in from the fields');
  assert.match(await A.ev('__world3d.floorBadge()'), /^1F/, 'the badge says 1F');
  // from the door in, you can walk to the ladder down
  let at = await here(A), l = await ladder(A, 'down');
  assert.ok(await A.ev(`__world3d.walkable(${at.x}, ${at.y}, ${l.x}, ${l.y + 1})`), '1F: the entrance reaches the ladder down');
  await A.shot('mine-1f.png');

  await climb(A, 'down', 'cave_b1');
  assert.match(await A.ev('__world3d.floorBadge()'), /^B1/, 'the badge says B1');
  assert.match(await A.ev('document.getElementById("miniLabel").textContent'), /B1 · Crystal Tunnels/);
  at = await here(A); l = await ladder(A, 'down');
  assert.ok(await A.ev(`__world3d.walkable(${at.x}, ${at.y}, ${l.x}, ${l.y + 1})`), 'B1: the ladder up reaches the ladder down');
  assert.equal(await A.ev('__world3d.bossBars().length'), 0, 'no boss bars on B1');
  await A.shot('mine-b1.png');

  await climb(A, 'down', 'cave_b2');
  assert.match(await A.ev('__world3d.floorBadge()'), /^B2.*DEEPEST/, 'the badge says B2, deepest');
  assert.equal(await ladder(A, 'down'), undefined, 'no way further down');
  const bars = await A.ev('__world3d.bossBars()');
  assert.equal(bars.length, 2, `two boss bars: ${bars}`);
  assert.match(bars.join('|'), /Crystal Golem.*1000 \/ 1000/);
  assert.match(bars.join('|'), /Spider Queen.*800 \/ 800/);
  // nothing jumps you the moment you come down
  const nearest = await A.ev('Math.min(...__world3d.monsters.filter((m) => !m.dead).map((m) => Math.hypot(m.x - __world3d.P.x, m.z - __world3d.P.z)))');
  assert.ok(nearest > 12, `the giants start well away from the ladder (${nearest.toFixed(1)})`);
  await A.shot('mine-b2.png');

  // the golem's slam: stand next to him, he winds up, the ring shows, and you get hit
  const g = await A.ev('__world3d.monsters.findIndex((m) => m.type === "golem_crystal")');
  await A.ev(`(() => { const m = __world3d.monsters[${g}]; __world3d.tp(m.x, m.z + 2.2); __world3d.setHp(500); return 1; })()`);
  await sleep(500);
  assert.ok(await A.ev(`__world3d.monsters[${g}].slamAt !== undefined || __world3d.hp() < 500`), 'the golem winds up a slam');
  await A.shot('mine-slam.png');
  await sleep(1600);
  assert.ok(await A.ev('__world3d.hp() < 500'), 'the slam lands if you stay in the ring');

  // the queen's lunge: stand at range, she crouches then dashes at you
  const q = await A.ev('__world3d.monsters.findIndex((m) => m.type === "spider_queen")');
  await A.ev(`(() => { const m = __world3d.monsters[${q}]; __world3d.tp(m.x - 6, m.z); __world3d.setHp(500); return 1; })()`);
  const x0 = await A.ev(`__world3d.monsters[${q}].x`);
  await sleep(1400);
  assert.ok(await A.ev(`__world3d.monsters[${q}].x`) < x0 - 2, 'the queen lunges at you');

  // and back up, floor by floor
  await A.ev('__world3d.setHp(500); 1');
  await climb(A, 'up', 'cave_b1');
  await climb(A, 'up', 'cave');
  assert.match(await A.ev('__world3d.floorBadge()'), /^1F/);
  console.log('mine: PASS');
} finally { kill(); }
