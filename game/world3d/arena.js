/* ============================================================================
   The Taproot Arena: the spectator stand surface, the hazard schedule, the
   tomato lob and the drop-crate buffs.

   Everything here is plain logic with no Three.js and no DOM, so it runs in
   node tests too. The page keeps its own ARENA_X / ARENA_Z / ARENA_R
   constants; the ones here are copies, and the test pins them equal.

   Coordinates are map tiles, the same ones the page uses: x across, z down,
   y up. The pit is a circle of radius ARENA_RADIUS around ARENA_CENTER.
   ============================================================================ */

// The pit sits here in both the fighters' area and the spectators' one: the two
// share a coordinate frame so a spectator sees a fighter where the fighter is.
// The stands reach R + 5.6 tiles out, which is why the centre is not nearer a corner.
export const ARENA_CENTER = [22, 22];
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

// `center` defaults to the pit, but the stands are served as their own, larger map
// whose pit sits elsewhere, so both take it as an argument
const radiusAt = (x, z, c) => Math.hypot(x - c[0], z - c[1]);
const inGate = (x, z, c) => {
  const a = Math.atan2(z - c[1], x - c[0]), d = Math.abs(((a - STAND_GATE_ANGLE + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  return d < GATE_HALF;
};

// the walkable height at (x, z), or 0 where there is no seating
export const GATE_RAMP = 2.4; // tiles the gate wedge takes to fall from the back row to the ground

export function standY(x, z, c = ARENA_CENTER) {
  const r = radiusAt(x, z, c);
  const tier = STAND_TIERS.find((t) => r >= t.r0 && r < t.r1);
  if (tier) return tier.top;
  // the way in: a ramp in the gate wedge, so arriving and leaving is a walk and
  // not a five-unit snap up onto the back row
  const back = STAND_TIERS[STAND_TIERS.length - 1];
  if (r >= back.r1 && r < back.r1 + GATE_RAMP && inGate(x, z, c)) {
    return back.top * (1 - (r - back.r1) / GATE_RAMP);
  }
  return 0;
}

// the rail: spectators cannot drop into the pit, and cannot wander off the back,
// except through the gate they came in by
export function standBlocked(x, z, c = ARENA_CENTER) {
  const r = radiusAt(x, z, c);
  if (r < STAND_TIERS[0].r0) return true;
  if (r > STAND_TIERS[2].r1) return !inGate(x, z, c);
  return false;
}

/* ---------- the hazard schedule ----------
   Every client works out which hazard is due, where it lands and when, from the
   clock alone. There is no host and nothing to agree on: eventAt(n) is a pure
   function of n, so two browsers minutes apart compute the same pit.

   Events are numbered from the epoch, one per PERIOD_MS. The jitter alternates
   sign with n on purpose: consecutive jitters then pull in opposite directions,
   so the realised gap is PERIOD_MS plus or minus the sum of the two magnitudes,
   which lands in 1-10 s by construction. Same-sign jitter would let two
   neighbours cancel and produce a gap of exactly 60.000 s. */

export const PERIOD_MS = 60000;
export const TELL_MS = 2500; // warning on the sand before a hazard commits

export const HAZARD_IDS = ['fireball', 'quicksand', 'boulder', 'spikes', 'crate'];
export const HAZARDS = {
  fireball:  { name: 'Falling fireball', tell: TELL_MS, life: 400 },
  quicksand: { name: 'Quicksand',        tell: TELL_MS, life: 10000 },
  boulder:   { name: 'Rolling boulder',  tell: TELL_MS, life: 3000 },
  spikes:    { name: 'Stone spikes',     tell: TELL_MS, life: 12000 },
  crate:     { name: 'Drop crate',       tell: TELL_MS, life: 20000 },
};

// deterministic [0, 1) from an integer and a salt — no Math.random anywhere here
function hash01(n, salt) {
  let h = (Math.trunc(n) | 0) * 374761393 + salt * 668265263;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const floorDiv = (a, b) => Math.floor(a / b);
const K = HAZARD_IDS.length;

// a shuffled run of all five kinds per block of K events, so nothing repeats
// inside a block and every kind gets used
function blockOrder(b) {
  const p = HAZARD_IDS.slice();
  for (let i = p.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(b * 16 + i, 7) * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

// the block's order, with the seam fix applied the same way for every n in the
// block — fixing it only at i === 0 would give index 1 two different answers
function orderFor(b) {
  const p = blockOrder(b);
  if (p[0] === blockOrder(b - 1)[K - 1]) [p[0], p[1]] = [p[1], p[0]];
  return p;
}

function kindAt(n) {
  const b = floorDiv(n, K);
  return orderFor(b)[n - b * K];
}

const jitterMs = (n) => (n % 2 ? 1 : -1) * (500 + hash01(n, 1) * 4500);

export function eventAt(n) {
  const kind = kindAt(n);
  const fireMs = n * PERIOD_MS + jitterMs(n);
  const a = hash01(n, 3) * Math.PI * 2, rad = hash01(n, 4) * (R - 1.5);
  return {
    n,
    kind,
    fireMs,
    tellMs: fireMs - TELL_MS,
    endMs: fireMs + HAZARDS[kind].life,
    x: CX + Math.cos(a) * rad,
    z: CZ + Math.sin(a) * rad,
    angle: hash01(n, 5) * Math.PI * 2, // the lane direction, used by the boulder
  };
}

// whatever is on screen at tMs — never a backlog, so a tab that was asleep for
// ten minutes wakes into at most the current event
export function eventsNear(tMs) {
  const n = Math.round(tMs / PERIOD_MS), out = [];
  for (let i = n - 1; i <= n + 1; i++) {
    const e = eventAt(i);
    if (tMs >= e.tellMs && tMs <= e.endMs) out.push(e);
  }
  return out;
}

/* ---------- tomatoes ----------
   A spectator's throw is a lob, not a shot: it leaves the hand rising and drops
   onto the spot they aimed at. Fixed flight time keeps the arc readable and
   makes the maths a closed form. Gravity matches the page's own (P.vy -= 22).
   Tomatoes never damage, slow, stun or push anyone — they are decoration. */

export const TOMATO_FLIGHT_MS = 900;
export const TOMATO_COOLDOWN_MS = 700;
export const TOMATO_GRAVITY = 22;

export function tomatoArc(from, to) {
  const t = TOMATO_FLIGHT_MS / 1000;
  return {
    vx: (to.x - from.x) / t,
    vy: (to.y - from.y + TOMATO_GRAVITY * t * t / 2) / t,
    vz: (to.z - from.z) / t,
    flightMs: TOMATO_FLIGHT_MS,
  };
}

/* ---------- the drop crate's prize ----------
   Smashing the crate does not hand you anything: it lets the prize out, and whoever
   touches it first claims it. The buff only scales a stat the hit model already reads
   (atk, mag or def), because the page rebuilds `stats` from equipment whenever gear
   changes and anything else would need a second system. */

export const BUFFS = {
  fury:  { name: 'Fury',  stat: 'atk', mul: 1.6, ms: 15000, color: '#ff6a3a' },
  focus: { name: 'Focus', stat: 'mag', mul: 1.7, ms: 15000, color: '#6ad0ff' },
  guard: { name: 'Guard', stat: 'def', mul: 2.2, ms: 18000, color: '#c8ff2e' },
};
const BUFF_IDS = Object.keys(BUFFS);

export const buffAt = (n) => BUFF_IDS[Math.floor(hash01(n, 6) * BUFF_IDS.length)];
