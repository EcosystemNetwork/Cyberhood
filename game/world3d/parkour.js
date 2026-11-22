// Parkour on built blocks, and the dodge roll. Pure functions: the page feeds them a cell
// query and a clock, and they say where the body goes. node --test tests/parkour.test.mjs

// Ledges: jump at a wall and your hands catch its top edge if it is within reach.
export const REACH = 2.3;      // how far above your feet your hands catch an edge
export const MIN_LEDGE = 0.6;  // anything lower is walked or jumped onto, never climbed
export const BODY = 2;         // free cells a body needs above the ledge to stand on it
export const CLIMB = { hang: 0.16, pull: 0.3, step: 0.14 }; // seconds: catch, pull up, step on
export const CLIMB_TIME = CLIMB.hang + CLIMB.pull + CLIMB.step;
const HANG_DROP = 1.6;         // feet below the edge while hanging from it

/* The ledge in front of (x, feetY, z) when moving along (dx, dz), or null.
   solid(x, y, z) says whether the cell holding that world point is a solid block.
   The direction snaps to the nearer grid axis: you climb a block's face, not its corner.
   Returns where the climb starts and lands, the ledge's height and the heading to face. */
export function findLedge(solid, x, z, feetY, dx, dz) {
  if (Math.hypot(dx, dz) < 1e-6) return null;
  if (Math.abs(dx) >= Math.abs(dz)) { dx = Math.sign(dx); dz = 0; } else { dz = Math.sign(dz); dx = 0; }
  // half a tile ahead: past the hitbox (0.28 x 0.2) and into the wall's cell
  const fx = x + dx * 0.5, fz = z + dz * 0.5;
  const i = Math.floor(fx), j = Math.floor(fz);
  if (i === Math.floor(x) && j === Math.floor(z)) return null; // still inside your own tile
  const cx = i + 0.5, cz = j + 0.5;
  const lo = Math.ceil(feetY + MIN_LEDGE) - 1, hi = Math.floor(feetY + REACH) - 1;
  for (let k = Math.max(0, lo); k <= hi; k++) {
    if (!solid(cx, k + 0.5, cz)) continue;
    let room = true;
    for (let b = 1; b <= BODY; b++) if (solid(cx, k + b + 0.5, cz)) room = false;
    if (!room) continue;
    const top = k + 1;
    // your own column has to be open up to the edge, or you'd pull yourself through a ceiling
    let open = true;
    for (let y = Math.ceil(feetY); y < top + BODY - 1; y++) if (solid(x, y + 0.5, z)) open = false;
    if (!open) return null;
    // land well onto the top: the hitbox is 0.28 deep along x, 0.2 along z
    const x1 = dx ? (dx > 0 ? i + 0.4 : i + 0.6) : x;
    const z1 = dz ? (dz > 0 ? j + 0.3 : j + 0.7) : z;
    return { top, x0: x, z0: z, y0: feetY, x1, z1, face: Math.atan2(dx, dz), hangY: Math.max(top - HANG_DROP, Math.min(feetY, top - MIN_LEDGE)) };
  }
  return null;
}

const ease = (u) => u * u * (3 - 2 * u);

/* Where the body is `t` seconds into a climb: catch the edge (settle to the hang), pull up
   until the feet clear it, then step forward onto the top. lean tips the body into the wall. */
export function climbPose(c, t) {
  const { hang, pull, step } = CLIMB;
  if (t < hang) {
    const u = ease(t / hang);
    return { x: c.x0, z: c.z0, y: c.y0 + (c.hangY - c.y0) * u, lean: 0.15 * u, phase: 'hang', done: false };
  }
  if (t < hang + pull) {
    const u = ease((t - hang) / pull);
    return { x: c.x0, z: c.z0, y: c.hangY + (c.top - c.hangY) * u, lean: 0.15 + Math.sin(Math.PI * u) * 0.35, phase: 'pull', done: false };
  }
  const u = Math.min(1, (t - hang - pull) / step), e = ease(u);
  return { x: c.x0 + (c.x1 - c.x0) * e, z: c.z0 + (c.z1 - c.z0) * e, y: c.top, lean: 0.15 * (1 - e), phase: 'step', done: u >= 1 };
}

/* Dodge roll: a burst along the ground with a window where hits miss you. The speed fades as
   you come out of it, so the whole roll covers about ROLL_DIST tiles: under what the server's
   sprint check allows for that time (economy.js couldReach slack), even rolled back to back. */
export const ROLL = { time: 0.42, speed: 10.5, fade: 0.65, cd: 0.62, cost: 0.16, safe: [0.03, 0.34] };
export const rollSpeed = (t) => ROLL.speed * (1 - ROLL.fade * Math.min(1, Math.max(0, t / ROLL.time)));
export const ROLL_DIST = ROLL.speed * ROLL.time * (1 - ROLL.fade / 2);
export const rollSafe = (t) => t >= ROLL.safe[0] && t <= ROLL.safe[1];

/* The body during a roll, t seconds in: one forward somersault around the hips. Returns the
   tumble angle and how far to move the root (up, and back along the heading) so it turns
   about a point `hip` above the feet instead of about the feet. */
export function rollPose(t, hip = 0.55) {
  const u = Math.min(1, Math.max(0, t / ROLL.time));
  const a = ease(u) * Math.PI * 2;
  return { spin: a, up: hip - hip * Math.cos(a), back: hip * Math.sin(a), done: u >= 1 };
}
