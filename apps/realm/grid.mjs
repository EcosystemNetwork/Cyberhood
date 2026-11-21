/* A spatial hash: which entities are near a point, without looking at all of them.
   This is what makes a crowded zone affordable: each player is sent only what is in view,
   so traffic grows with local density, not with the square of the zone's population. */

export class Grid {
  constructor(cell = 16) {
    this.cell = cell;
    this.cells = new Map(); // "cx,cz" -> Set of entities
  }
  key(x, z) { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }
  add(e) {
    e._cell = this.key(e.x, e.z);
    let s = this.cells.get(e._cell);
    if (!s) this.cells.set(e._cell, (s = new Set()));
    s.add(e);
  }
  remove(e) {
    const s = this.cells.get(e._cell);
    if (s) { s.delete(e); if (!s.size) this.cells.delete(e._cell); }
    e._cell = null;
  }
  move(e) {
    if (this.key(e.x, e.z) === e._cell) return;
    this.remove(e);
    this.add(e);
  }
  // every entity within r of (x, z)
  *near(x, z, r) {
    const c = this.cell, r2 = r * r;
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++) {
      for (let cz = Math.floor((z - r) / c); cz <= Math.floor((z + r) / c); cz++) {
        const s = this.cells.get(`${cx},${cz}`);
        if (!s) continue;
        for (const e of s) { const dx = e.x - x, dz = e.z - z; if (dx * dx + dz * dz <= r2) yield e; }
      }
    }
  }
}
