/* ============================================================================
   Weather: rain fronts that roll over the overworld's districts.

   Ideas taken from World of ClaudeCraft (MIT, levy-street/world-of-claudecraft,
   src/render/weather.ts and weather_field_core.ts), rewritten for Cyberhood:
   - one pooled cloud of rain streaks rides a box around the camera, so a small
     fixed pool covers the whole view;
   - rain belongs to a district, not to the player: standing in the dry City
     you still see it pouring over the Woods next door, because the box is
     scanned for the nearest wet district and every drop respawns over it.
   - Cyberhood's own twist: the weather follows the real UTC clock (like our
     day/night), so everyone online sees the same storm at the same time.

   Render-only. Rain never changes what you can do or what the server
   decides, and it never hides a monster, a hazard or a telegraph. The plain
   functions here have no Three.js and no DOM, so node tests can drive them.
   ============================================================================ */

// How often a front can change (ms). A slot either has a storm in it or not.
export const SLOT_MS = 15 * 60 * 1000;
// The weather eases from one slot to the next over this long, so a storm
// rolls in and out instead of switching on.
export const BLEND_MS = 90 * 1000;

// How likely each district is to catch a passing storm. One storm roll is
// shared by every district in a slot, so the wettest districts rain first and
// a heavy storm soaks the whole map: fronts look like fronts, not confetti.
export const DISTRICT_RAIN = {
  'Taproot Woods': 0.45,
  'Taproot Docks': 0.38,
  'Taproot Shore': 0.38,
  'Taproot Fields': 0.32,
  'Taproot City': 0.26,
  'Taproot Avenues': 0.26,
};
const DEFAULT_RAIN = 0.2;

// Small integer hash -> [0, 1). Same inputs, same answer, on every machine.
function hash01(a, b) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** How hard a district is raining in one slot, 0 (dry) to 1. */
export function slotRain(district, slot) {
  const chance = DISTRICT_RAIN[district] ?? DEFAULT_RAIN;
  const storm = hash01(slot, 7);
  if (storm >= chance) return 0;
  // a storm that only just clears the bar is a drizzle; a deep one pours
  const depth = 1 - storm / chance;
  return Math.min(1, 0.35 + 0.65 * depth);
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Rain in a district at a moment (ms since the epoch), eased between slots. */
export function rainAt(district, ms) {
  if (!district) return 0;
  const slot = Math.floor(ms / SLOT_MS);
  const now = slotRain(district, slot);
  const into = ms - slot * SLOT_MS;
  const left = SLOT_MS - into;
  if (left > BLEND_MS) return now;
  const next = slotRain(district, slot + 1);
  return now + (next - now) * smooth(1 - left / BLEND_MS);
}

// The rain box: half-sizes in world units (1 unit = 1 tile).
export const BOX = { hx: 34, hy: 22, hz: 34 };
// Samples per side when the box is scanned for wet districts. 7 x 7 over a
// 68-tile box is a tap every ~10 tiles, finer than the smallest district.
export const SCAN = 7;

/**
 * What the rain cloud around the camera should do.
 * `districtAt(x, z)` names the district under a point (or null for none).
 * The camera's own district wins when it is wet ("local": the whole box
 * rains, no masking). Otherwise the nearest wet sample in the box sets the
 * amount, and drops are kept over wet ground ("local: false").
 */
export function rainPlan(camX, camZ, districtAt, ms, box = BOX) {
  const own = rainAt(districtAt(camX, camZ), ms);
  if (own > 0.01) return { amount: own, local: true };
  let amount = 0, best = Infinity;
  for (let i = 0; i < SCAN; i++) {
    const x = camX + (((i + 0.5) / SCAN) * 2 - 1) * box.hx;
    for (let j = 0; j < SCAN; j++) {
      const z = camZ + (((j + 0.5) / SCAN) * 2 - 1) * box.hz;
      const r = rainAt(districtAt(x, z), ms);
      if (r <= 0.01) continue;
      const d = (x - camX) ** 2 + (z - camZ) ** 2;
      if (d < best) { best = d; amount = r; }
    }
  }
  return { amount, local: false };
}

export const SPAWN_TRIES = 10;

/**
 * A spot in the box over a wet district, or null if ten tries miss (the drop
 * then stays where it wrapped; the next wrap tries again). `rand` is the
 * caller's own seeded random so this stays repeatable in tests.
 */
export function wetSpawn(rand, camX, camZ, districtAt, ms, box = BOX) {
  for (let t = 0; t < SPAWN_TRIES; t++) {
    const x = camX + (rand() * 2 - 1) * box.hx;
    const z = camZ + (rand() * 2 - 1) * box.hz;
    if (rainAt(districtAt(x, z), ms) > 0.01) return { x, z };
  }
  return null;
}

/** mulberry32: a tiny seeded random, so drop layout never uses Math.random. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How fast the visible rain follows the plan (per second). Slow enough that
// walking across a district line fades the rain rather than snapping it.
const EASE = 0.9;
// Re-scan the box this often (s): district lines pass at walking speed.
const PLAN_EVERY = 0.5;

/**
 * The rain cloud itself. Three.js is passed in so this file stays importable
 * from node. `count` is the drop pool size (the graphics preset sets it).
 * Each frame: update(camera position, dt, ms, districtAt, night 0..1).
 * `wet` is the eased amount (0..1) the sky and fog use to darken.
 */
export function createRain(THREE, scene, { count = 1200 } = {}) {
  const { hx, hy, hz } = BOX;
  const pos = new Float32Array(count * 3);
  const speed = new Float32Array(count);
  const rng = seeded(0x5eed);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (rng() * 2 - 1) * hx;
    pos[i * 3 + 1] = (rng() * 2 - 1) * hy;
    pos[i * 3 + 2] = (rng() * 2 - 1) * hz;
    speed[i] = 30 + rng() * 10;
  }
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  geo.setDrawRange(0, count);
  // the cloud is re-centred on the camera every frame: a fixed big sphere
  // saves recomputing bounds, and culling is off anyway
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(hx, hy, hz) + 200);

  // a vertical streak inside the square point sprite, so a drop reads as a line
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 32);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(13, 0, 6, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;

  const BASE = new THREE.Color('#a8c8e8');
  const mat = new THREE.PointsMaterial({
    map: tex, color: BASE.clone(), size: 0.9, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false, fog: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  points.renderOrder = 3;
  scene.add(points);

  const spawnRng = seeded(0x9e37);
  let wet = 0, plan = { amount: 0, local: true }, planIn = 0, wasLive = false, live = count;

  return {
    get wet() { return wet; },
    get plan() { return plan; },
    points,
    /** Change the pool size (graphics preset) without rebuilding anything. */
    setCount(n) { live = Math.max(0, Math.min(count, n | 0)); geo.setDrawRange(0, live); },
    // `pin` (0..1), when given, overrides the clock: the whole box rains that hard (tests, screenshots)
    update(cam, dt, ms, districtAt, night = 0, pin = null) {
      planIn -= dt;
      if (pin !== null) plan = { amount: Math.max(0, Math.min(1, pin)), local: true };
      else if (planIn <= 0) { planIn = PLAN_EVERY; plan = rainPlan(cam.x, cam.z, districtAt, ms); }
      wet = pin !== null ? plan.amount : wet + (plan.amount - wet) * Math.min(1, dt * EASE);
      if (wet < 0.002 && plan.amount === 0) wet = 0;
      // unlit points: tint them down at night or they glow like confetti
      mat.color.copy(BASE).multiplyScalar(1 - night * 0.6);
      mat.opacity = Math.min(0.9, wet);
      const on = wet > 0.01 && live > 0;
      points.visible = on;
      const masked = !plan.local;
      // first frame of rain seen from a dry district: put every drop over the wet side now,
      // or the storm would open over the player for a second before it drifts across
      if (on && masked && !wasLive) {
        for (let i = 0; i < live; i++) {
          const s = wetSpawn(spawnRng, cam.x, cam.z, districtAt, ms);
          if (s) { pos[i * 3] = s.x; pos[i * 3 + 2] = s.z; }
        }
      }
      wasLive = on;
      if (!on) return;
      for (let i = 0; i < live; i++) {
        const j = i * 3;
        pos[j + 1] -= speed[i] * dt;
        pos[j] += 1.2 * dt; // a faint slant, as if there's wind
        let wrapped = false;
        if (pos[j] - cam.x > hx) { pos[j] -= hx * 2; wrapped = true; } else if (pos[j] - cam.x < -hx) { pos[j] += hx * 2; wrapped = true; }
        if (pos[j + 2] - cam.z > hz) { pos[j + 2] -= hz * 2; wrapped = true; } else if (pos[j + 2] - cam.z < -hz) { pos[j + 2] += hz * 2; wrapped = true; }
        if (pos[j + 1] - cam.y < -hy) { pos[j + 1] += hy * 2; wrapped = true; } else if (pos[j + 1] - cam.y > hy) { pos[j + 1] -= hy * 2; wrapped = true; }
        if (wrapped && masked) {
          const s = wetSpawn(spawnRng, cam.x, cam.z, districtAt, ms);
          if (s) { pos[j] = s.x; pos[j + 2] = s.z; }
        }
      }
      attr.needsUpdate = true;
    },
  };
}
