// The Sendy portal in the middle of the Avenues' big plot: you can walk to it from the plot's
// gate, standing at it shows the prompt, and F sends the tab to sendy.gg.
import assert from 'node:assert/strict';
import { launch, ready, sleep, near, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Visitor');
  await A.go(`${BASE}/game/world3d/?area=avenues&from=city`);
  assert.ok(await ready(A), 'the world boots');
  await sleep(900);
  // plot 1 is local (12..37) in the Avenues, which sit at (96, 0) in the big map; its gate is south
  assert.ok(await A.ev('__world3d.walkable(120, 39, 120, 25)'), 'you can walk from outside the plot gate to the portal');
  await A.ev('__world3d.tp(120.5, 26.3, 0); __world3d.cam(6, 0.3); 1');
  await sleep(600);
  assert.match(await near(A), /Press F to go through the portal to Sendy/, 'the prompt shows at the portal');
  await A.shot('portal.png');
  await A.key('KeyF', 'f');
  for (let i = 0; i < 40 && !(await A.ev('location.href').catch(() => '')).includes('sendy.gg'); i++) await sleep(150);
  assert.match(await A.ev('location.href'), /sendy\.gg\/#world/, 'F goes to sendy.gg');
  console.log('portal: ok');
} finally { await kill(); }
