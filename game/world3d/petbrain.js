/* ============================================================================
   The pet that walks with you (Guild pets, guild.js g_walk): a small
   Diablo-style companion brain. Edit the numbers in TUNE freely.

   Every frame it picks one mode, in this order:
     warp    far behind (or stuck behind a wall for a moment): pops up behind you
     return  beyond the leash: sprints back to you
     wary    a monster near you: hops to your far side and faces it, yipping
     fetch   gold or an item on the ground near you: runs over and grabs it for
             you (the pickup goes through the game's own collect(), so the
             server checks it like any other)
     follow  you're moving: trots after you, a little behind and to one side
     idle    you've stopped: noses about near you, sits, looks up at you
   It walks around obstacles (tries a fan of headings, then gives up and warps).
   A flying pet (the fish) ignores walls.

   No DOM, no Three.js: it moves a group handed to it by makePet().
   ============================================================================ */

export const TUNE = {
  trail: 1.5,       // tiles behind you while following
  side: 0.75,       // and this far to one side
  leash: 8,         // beyond this it drops everything and runs back
  warp: 16,         // beyond this (or stuck) it appears behind you
  stuckSecs: 1.5,  // not getting any closer to where it's going for this long: warp
  lostSecs: 2.5,   // hanging back from you without closing in for this long: warp
  fetch: 6,         // picks up drops this close to you...
  fetchPet: 9,      // ...and this close to itself
  grab: 0.6,
  wary: 4.5,        // a monster this close to you makes it wary
  walk: 2.0, trot: 5.2, sprint: 9.5, // tiles a second
  idleWander: 2.4,  // how far from you it noses about
};
const FAN = [0, 0.55, -0.55, 1.1, -1.1, 1.65, -1.65]; // headings tried around an obstacle

export function createPetBrain(d) {
  /* d = { player: P, free(x, z), monsters(), drops(), collect(drop), makePet(kind), isFlyer(kind) } */
  let pet = null; // { id, kind, g, x, z, heading, mode, ... }
  let clock = 0;
  const last = { x: d.player.x, z: d.player.z, still: 0, speed: 0 };

  function spawn(p) {
    const P = d.player;
    pet = {
      id: p.id, kind: p.kind, g: d.makePet(p.kind), fly: d.isFlyer(p.kind),
      x: P.x - Math.sin(P.heading) * TUNE.trail, z: P.z - Math.cos(P.heading) * TUNE.trail,
      heading: P.heading, mode: 'follow', stuck: 0, lost: 0, best: 0, wait: 0, wx: 0, wz: 0, sit: 0, yip: 0, hop: 0, side: Math.random() < 0.5 ? -1 : 1,
      target: null, grabbed: 0,
    };
  }
  function remove() { if (pet) { pet.g.removeFromParent(); pet = null; } }

  // A free spot near (x, z), for warping and idling.
  function spotNear(x, z, r) {
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2, dist = r * (0.5 + Math.random() * 0.5);
      const px = x + Math.cos(a) * dist, pz = z + Math.sin(a) * dist;
      if (d.free(px, pz)) return [px, pz];
    }
    return [x, z];
  }
  function warpBehind() {
    const P = d.player;
    const bx = P.x - Math.sin(P.heading) * 1.2, bz = P.z - Math.cos(P.heading) * 1.2;
    [pet.x, pet.z] = d.free(bx, bz) ? [bx, bz] : spotNear(P.x, P.z, 1.4);
    pet.stuck = 0; pet.lost = 0; pet.best = 0; pet.hop = 1; pet.mode = 'follow';
  }
  // Step toward (tx, tz), steering around walls. Returns the distance left.
  function steer(tx, tz, speed, stop, dt) {
    const dx = tx - pet.x, dz = tz - pet.z, dist = Math.hypot(dx, dz);
    if (dist <= stop) { pet.stuck = 0; return dist; }
    const step = Math.min(dist - stop, speed * dt), base = Math.atan2(dx, dz);
    if (pet.fly) { pet.x += Math.sin(base) * step; pet.z += Math.cos(base) * step; pet.heading = base; return dist - step; }
    for (const off of FAN) {
      const a = base + off, nx = pet.x + Math.sin(a) * step, nz = pet.z + Math.cos(a) * step;
      if (d.free(nx, nz)) {
        pet.x = nx; pet.z = nz; pet.heading = turn(pet.heading, a, dt * 14);
        // stuck = not getting closer: a detour that gains little (sliding along a wall) counts
        const now = Math.hypot(tx - pet.x, tz - pet.z);
        pet.stuck = dist - now > step * 0.4 ? Math.max(0, pet.stuck - dt) : pet.stuck + dt;
        return now;
      }
    }
    pet.stuck += dt;
    return dist;
  }
  const wrap = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const turn = (from, to, k) => from + wrap(to - from) * Math.min(1, k);

  function nearestFoe() {
    const P = d.player;
    let foe = null, best = TUNE.wary;
    for (const m of d.monsters()) {
      if (m.dead || m.hp <= 0) continue;
      const dm = Math.min(Math.hypot(m.x - P.x, m.z - P.z), Math.hypot(m.x - pet.x, m.z - pet.z) + 1.2);
      if (dm < best) { best = dm; foe = m; }
    }
    return foe;
  }
  function nearestDrop(foe) {
    const P = d.player;
    let drop = null, best = Infinity;
    for (const o of d.drops()) {
      if (!o.ready || o.taken || o.gone) continue;
      if (Math.hypot(o.x - P.x, o.z - P.z) > TUNE.fetch) continue;
      const dp = Math.hypot(o.x - pet.x, o.z - pet.z);
      if (dp > TUNE.fetchPet || (foe && Math.hypot(o.x - foe.x, o.z - foe.z) < 2.5)) continue; // not under a monster's nose
      if (dp < best) { best = dp; drop = o; }
    }
    return drop;
  }

  function think(dt) {
    const P = d.player, far = Math.hypot(P.x - pet.x, P.z - pet.z);
    // lost: hanging back from you without closing in (cut off by a wall, a fence, water...)
    if (far < TUNE.idleWander + 0.5 || far < pet.best - 0.3) { pet.best = far; pet.lost = 0; } else pet.lost += dt;
    if (far > TUNE.warp || pet.stuck > TUNE.stuckSecs || pet.lost > TUNE.lostSecs) { warpBehind(); return; }
    if (far > TUNE.leash) { pet.mode = 'return'; steer(P.x, P.z, TUNE.sprint, 1.2, dt); return; }
    const foe = nearestFoe();
    if (foe) { // between you and it is no place for a pet: tuck in on your far side and yip
      pet.mode = 'wary';
      const ax = P.x - foe.x, az = P.z - foe.z, al = Math.hypot(ax, az) || 1;
      const left = steer(P.x + (ax / al) * 1.1, P.z + (az / al) * 1.1, TUNE.sprint, 0.25, dt);
      if (left <= 0.3) pet.heading = turn(pet.heading, Math.atan2(foe.x - pet.x, foe.z - pet.z), dt * 10);
      if ((pet.yip -= dt) <= 0) { pet.yip = 0.55 + Math.random() * 0.4; pet.hop = 0.6; }
      return;
    }
    const drop = nearestDrop(null);
    if (drop) {
      pet.mode = 'fetch';
      const left = steer(drop.x, drop.z, TUNE.sprint * 0.8, 0, dt);
      if (left <= TUNE.grab) { d.collect(drop); pet.hop = 1; pet.grabbed += 1; }
      return;
    }
    if (last.still < 1.2) { // you're on the move: follow, behind and to one side
      pet.mode = 'follow';
      const tx = P.x - Math.sin(P.heading) * TUNE.trail + Math.cos(P.heading) * TUNE.side * pet.side;
      const tz = P.z - Math.cos(P.heading) * TUNE.trail - Math.sin(P.heading) * TUNE.side * pet.side;
      const gap = Math.hypot(tx - pet.x, tz - pet.z);
      steer(tx, tz, gap > 2.5 ? TUNE.sprint : Math.max(TUNE.trot, last.speed * 1.1), 0.2, dt);
      pet.wait = 0;
      return;
    }
    // you've stopped: wander about near you, now and then sit and look up at you
    pet.mode = 'idle';
    if (far > TUNE.idleWander + 1.5) { pet.sit = 0; pet.wait = 0; steer(P.x, P.z, TUNE.trot, 1, dt); return; } // come over first (a wall in the way gets it stuck, then warped)
    if ((pet.wait -= dt) <= 0) {
      if (pet.stuck < 0.2 && Math.random() < 0.35) { pet.sit = 1.6 + Math.random() * 2; pet.wait = pet.sit + 0.5; pet.wx = pet.x; pet.wz = pet.z; }
      else { [pet.wx, pet.wz] = spotNear(P.x, P.z, TUNE.idleWander); pet.wait = 2 + Math.random() * 3; if (Math.random() < 0.3) pet.side = -pet.side; }
    }
    if (pet.sit > 0) { pet.sit -= dt; pet.heading = turn(pet.heading, Math.atan2(P.x - pet.x, P.z - pet.z), dt * 5); }
    else if (steer(pet.wx, pet.wz, TUNE.walk, 0.15, dt) <= 0.15) pet.stuck = 0;
  }

  // Each frame, with the pet that should be out (or null).
  function tick(dt, p) {
    clock += dt;
    const P = d.player;
    const moved = Math.hypot(P.x - last.x, P.z - last.z);
    last.speed = last.speed * 0.8 + (dt > 0 ? moved / dt : 0) * 0.2;
    last.still = moved > 0.02 ? 0 : last.still + dt;
    last.x = P.x; last.z = P.z;
    if (pet && (!p || p.id !== pet.id)) remove();
    if (!p) return;
    if (!pet) spawn(p);
    const x0 = pet.x, z0 = pet.z;
    think(dt);
    // the look of it: a hop when it runs or yips, breathing when it sits, a sway when it sniffs
    const moving = Math.hypot(pet.x - x0, pet.z - z0) > 0.2 * dt;
    pet.hop = Math.max(0, pet.hop - dt * 3);
    const y = pet.fly ? 0.55 + Math.sin(clock * 3 + pet.id) * 0.08
      : (moving ? Math.abs(Math.sin(clock * 12 + pet.id)) * 0.13 : 0) + Math.sin(pet.hop * Math.PI) * 0.25;
    pet.g.position.set(pet.x, y + (d.groundY ? d.groundY(pet.x, pet.z) : 0), pet.z);
    pet.g.rotation.y = pet.heading;
    pet.g.rotation.z = pet.mode === 'idle' && !moving && pet.sit <= 0 ? Math.sin(clock * 5 + pet.id) * 0.12 : 0;
    pet.g.scale.y = pet.sit > 0 ? 0.88 + Math.sin(clock * 2.5) * 0.03 : 1;
  }

  return { tick, remove, get state() { return pet && { mode: pet.mode, x: pet.x, z: pet.z, grabbed: pet.grabbed, kind: pet.kind }; } };
}
