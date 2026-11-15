// How long a cold load of the world takes, and where the time goes. Usage: node tests/world3d/loadtime.mjs [url]
import { launch, sleep } from './harness.mjs';
const url = process.argv[2] || 'https://taproot.love/game/world3d/?solo=1';
const { player, kill } = await launch();
try {
  const A = await player('Timer');
  await A.go(url);
  for (let i = 0; i < 200 && !(await A.ev('!!window.__world3d').catch(() => false)); i++) await sleep(100);
  const r = await A.ev(`JSON.stringify((() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource').map((e) => ({ n: e.name.replace(location.origin, '').slice(-60), start: Math.round(e.startTime), end: Math.round(e.responseEnd), kb: Math.round((e.transferSize || 0) / 1024) }));
    return { ready: Math.round(performance.now()), html: Math.round(nav.responseEnd), domInteractive: Math.round(nav.domInteractive), lastResource: Math.max(...res.map((e) => e.end)), totalKB: res.reduce((a, e) => a + e.kb, 0), slowest: res.sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 8) };
  })())`);
  console.log(JSON.stringify(JSON.parse(r), null, 1));
} finally { await kill(); }
