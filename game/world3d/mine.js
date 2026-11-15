/* ============================================================================
   The Mine, three floors deep: 1F (the old cave, made bigger), B1 Crystal
   Tunnels and B2 The Hollow, where the two giants live.

   Plain logic, no Three.js and no DOM, so node tests can check the maps.
   Maps are rows of '#' rock, '.' floor and '~' water, the same as the old
   cave_map.json. A ladder is a tile (x, y); you climb it from the floor beside it.
   ============================================================================ */

export const FLOORS = {
  cave: { code: '1F', name: 'The Mine', depth: 0 },
  cave_b1: { code: 'B1', name: 'Crystal Tunnels', depth: 1 },
  cave_b2: { code: 'B2', name: 'The Hollow', depth: 2 },
};
// which floor a ladder leads to
export const BELOW = { cave: 'cave_b1', cave_b1: 'cave_b2' };
export const ABOVE = { cave_b1: 'cave', cave_b2: 'cave_b1' };

// the old 48x36 cave sits in the bottom-left of 1F, moved down this many rows
export const SHIFT_1F = 18;

const grid = (w, h) => Array.from({ length: h }, () => Array(w).fill('#'));
const inside = (g, x, y) => y > 0 && y < g.length - 1 && x > 0 && x < g[0].length - 1;
const dig = (g, x, y) => { if (inside(g, x, y) && g[y][x] === '#') g[y][x] = '.'; };
// an oval chamber; the wobble keeps the walls from looking drawn with a compass
function cavern(g, cx, cy, rx, ry, seed = 0) {
  for (let y = cy - ry - 2; y <= cy + ry + 2; y++) for (let x = cx - rx - 2; x <= cx + rx + 2; x++) {
    const a = Math.atan2(y - cy, x - cx);
    const wob = 1 + 0.12 * Math.sin(a * 3 + seed) + 0.07 * Math.sin(a * 7 + seed * 2);
    if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= wob * wob) dig(g, x, y);
  }
}
// a tunnel `w` tiles wide between two points
function tunnel(g, x0, y0, x1, y1, w = 3) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 || 1, r = (w - 1) / 2;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
      if (dx * dx + dy * dy <= r * r + 0.5) dig(g, Math.round(x + dx), Math.round(y + dy));
  }
}
const path = (g, pts, w) => pts.slice(1).forEach((p, i) => tunnel(g, ...pts[i], ...p, w));
const rows = (g) => g.map((r) => r.join(''));

// 1F: the old cave at the bottom left, unchanged; new chambers north and east,
// and the ladder down at the far east end
function floor1(base) {
  const g = grid(72, 54);
  base.forEach((r, y) => [...r].forEach((ch, x) => { g[y + SHIFT_1F][x] = ch; }));
  // north: up out of the old top-left room into a long gallery
  path(g, [[8, 21], [9, 14], [16, 8]], 3);
  cavern(g, 22, 8, 9, 5, 1);
  path(g, [[30, 8], [42, 6], [52, 9]], 3);
  cavern(g, 56, 11, 7, 6, 2);
  // east: out of the pool room, into the deep chamber with the ladder
  path(g, [[45, 38], [52, 37], [58, 32]], 3);
  cavern(g, 61, 30, 7, 9, 3);
  path(g, [[58, 17], [60, 22]], 3);
  return { rows: rows(g), down: { x: 64, y: 25 }, start: { x: 22, y: 31 + SHIFT_1F } };
}

// B1: one long winding tunnel. You come down at the east end and cross the
// whole floor to the ladder down in the far west; a side cave hangs off it
function floorB1() {
  const g = grid(72, 54);
  const way = [[63, 41], [55, 45], [44, 38], [40, 27], [28, 31], [19, 41], [10, 34], [12, 21], [8, 12]];
  path(g, way, 3);
  way.forEach(([x, y], i) => cavern(g, x, y, i % 3 ? 4 : 6, i % 2 ? 4 : 5, i));
  path(g, [[40, 27], [46, 16], [56, 12]], 3);
  cavern(g, 58, 12, 6, 5, 9);
  return { rows: rows(g), up: { x: 64, y: 39 }, down: { x: 7, y: 10 } };
}

// B2: one huge round cavern, the ladder up at its south-west edge
function floorB2() {
  const g = grid(56, 56);
  cavern(g, 28, 27, 22, 22, 4);
  return { rows: rows(g), up: { x: 18, y: 40 }, center: { x: 28, y: 27 } };
}

export function floorMap(id, base) {
  if (id === 'cave') return floor1(base);
  if (id === 'cave_b1') return floorB1();
  if (id === 'cave_b2') return floorB2();
  throw new Error(`no mine floor ${id}`);
}
