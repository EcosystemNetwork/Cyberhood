// The pixel portrait (Armory, HUD avatar) draws whatever is in each hand: every hand item, in
// either hand — a sword carried in the left hand shows on the left, a shield in the right on the right.
import assert from 'node:assert/strict';
import { launch, sleep, BASE } from './harness.mjs';

const { player, kill } = await launch();
try {
  const A = await player('Red');
  await A.go(`${BASE}/game/`); await sleep(1200);
  const report = JSON.parse(await A.ev(`(() => {
    const pix = (eq) => { const c = SPRITE.renderDir({ skin: 1, hc: 0, hs: 'short', equipment: eq }, 'down', 0, true); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
    const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++; return n; };
    // which half of the image the item landed in (positive = right side of the picture)
    const side = (a, b, w) => { let s = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 3] !== b[i + 3]) s += ((i / 4) % w) < w / 2 ? -1 : 1; return s; };
    const bare = pix({});
    const w = SPRITE.renderDir({ skin: 1, hc: 0, hs: 'short', equipment: {} }, 'down', 0, true).width;
    const hands = Object.keys(GAME.ITEMS).filter((k) => GAME.ITEMS[k].slot === 'rhand' || GAME.ITEMS[k].slot === 'lhand');
    const out = { missing: [], sides: {} };
    for (const id of hands) for (const hand of ['rhand', 'lhand']) {
      const p = pix({ [hand]: id });
      if (diff(p, bare) < 6) out.missing.push(hand + ':' + id);
      out.sides[hand + ':' + id] = side(p, bare, w);
    }
    return JSON.stringify(out);
  })()`));
  assert.deepEqual(report.missing, [], 'every hand item shows on the portrait, in either hand');
  // the portrait faces you, so your right hand is on the left of the picture and vice versa;
  // whatever the convention, the same item must land on opposite sides for the two hands
  for (const id of ['iron_sword', 'thunder_staff', 'wooden_shield', 'mirror_shield']) {
    const r = report.sides['rhand:' + id], l = report.sides['lhand:' + id];
    assert.ok(Math.sign(r) !== Math.sign(l) && r !== 0 && l !== 0, `${id} switches sides with the hand (${r} / ${l})`);
  }
  console.log('PASS');
} finally { kill(); }
process.exit(0);
