/* ============================================================================
   The Taproot Arena: the spectator stand surface, the hazard schedule, the
   tomato lob and the drop-crate buffs.

   Everything here is plain logic with no Three.js and no DOM, so it runs in
   node tests too. The page keeps its own ARENA_X / ARENA_Z / ARENA_R
   constants; the ones here are copies, and the test pins them equal.

   Coordinates are map tiles, the same ones the page uses: x across, z down,
   y up. The pit is a circle of radius ARENA_RADIUS around ARENA_CENTER.
   ============================================================================ */

export const ARENA_CENTER = [18, 17];
export const ARENA_RADIUS = 14;

const [CX, CZ] = ARENA_CENTER, R = ARENA_RADIUS;

/* ---------- the stands ----------
   Three rings of seating outside the pit wall, matching the geometry the page
   builds (rad = R + 1.6 + t * 1.6, top = 2.6 + t * 1.2). Each band is flat and
   a step up from the one inside it; the page's frame loop snaps the player up
   to groundAt every frame, so the steps are walked up with no jump logic. */
export const STAND_TIERS = [0, 1, 2].map((t) => ({
  r0: R + 0.8 + t * 1.6,
  r1: R + 2.4 + t * 1.6,
  top: 2.6 + t * 1.2,
}));

// the spectators' own way in, opposite the fighters' gatehouse (which faces south, +z)
export const STAND_GATE_ANGLE = -Math.PI / 2;
const GATE_HALF = 0.3; // radians either side of the gate angle that stay open

const radiusAt = (x, z) => Math.hypot(x - CX, z - CZ);
const inGate = (x, z) => {
  const a = Math.atan2(z - CZ, x - CX), d = Math.abs(((a - STAND_GATE_ANGLE + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  return d < GATE_HALF;
};

// the walkable height at (x, z), or 0 where there is no seating
export function standY(x, z) {
  const r = radiusAt(x, z);
  const tier = STAND_TIERS.find((t) => r >= t.r0 && r < t.r1);
  return tier ? tier.top : 0;
}

// the rail: spectators cannot drop into the pit, and cannot wander off the back,
// except through the gate they came in by
export function standBlocked(x, z) {
  const r = radiusAt(x, z);
  if (r < STAND_TIERS[0].r0) return true;
  if (r > STAND_TIERS[2].r1) return !inGate(x, z);
  return false;
}
