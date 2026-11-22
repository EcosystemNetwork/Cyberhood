/* ============================================================================
   Graphics presets and the frame-rate governor.

   Ideas taken from World of ClaudeCraft (MIT, levy-street/world-of-claudecraft,
   src/render/dynamic_resolution_core.ts and its graphics presets), rewritten
   for Cyberhood:
   - three presets trade looks for speed;
   - while you play, the governor watches how long frames take and lowers the
     render resolution a step when the game can't keep up, then raises it again
     once there's room. You keep a smooth game instead of a sharp slideshow.

   The fairness rule: a preset or the governor may only change how sharp, how
   soft-shadowed, how glowy or how rainy the picture is. It must never hide or
   shrink anything a player reacts to (monsters, hazards, telegraphs, drops,
   other players). FAIR_KEYS lists everything a preset is allowed to touch,
   and the tests hold every preset to it.

   Plain logic, no Three.js and no DOM, so node tests can check it.
   ============================================================================ */

export const FAIR_KEYS = ['maxPixelRatio', 'shadowMap', 'bloom', 'rain', 'minScale'];

export const PRESETS = {
  // what phones always got: fewer pixels, cheaper shadows, no glow pass
  low: { maxPixelRatio: 1.25, shadowMap: 1024, bloom: false, rain: 400, minScale: 0.6 },
  medium: { maxPixelRatio: 1.5, shadowMap: 2048, bloom: true, rain: 800, minScale: 0.68 },
  // what desktops always got
  high: { maxPixelRatio: 2, shadowMap: 2048, bloom: true, rain: 1400, minScale: 0.68 },
};
export const ORDER = ['low', 'medium', 'high'];
export const STORE_KEY = 'w3d.gfx';

/**
 * Which preset to open with: a ?gfx= in the URL wins (tests, screenshots),
 * then the one the player picked last time, then low on a phone and high on
 * anything else, which is exactly what each got before presets existed.
 */
export function pickPreset({ url = null, saved = null, phone = false } = {}) {
  if (url && PRESETS[url]) return url;
  if (saved && PRESETS[saved]) return saved;
  return phone ? 'low' : 'high';
}

export const nextPreset = (name) => ORDER[(ORDER.indexOf(name) + 1) % ORDER.length];

/** The renderer's pixel ratio for a preset, a screen and a governor scale. */
export function pixelRatio(preset, devicePixelRatio, scale = 1) {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, PRESETS[preset].maxPixelRatio) * scale;
}

/**
 * The governor. Feed it every frame's length (ms) and the time; it answers
 * the render scale (minScale .. 1) to draw at.
 *
 * - It judges a window of frames by their 90th-percentile length, so one
 *   hitch (a GC, a texture upload) never moves it, but a slow patch does.
 * - Too slow (p90 over budget x 1.2): one step down. Plenty of room (p90
 *   under budget x 0.75): a smaller step up. In between it holds, so it never
 *   flickers between two scales.
 * - After any change it waits `cooldownMs` and starts a fresh window, so it
 *   judges the new scale, not frames from the old one.
 * - Frames over 250 ms are a hidden tab or a breakpoint, not a slow GPU: ignored.
 */
export function createGovernor({
  budgetMs = 1000 / 55, min = 0.68, max = 1, window = 45, cooldownMs = 2000,
  down = 0.08, up = 0.04,
} = {}) {
  let scale = max, lastChange = -Infinity;
  const frames = [];
  return {
    get scale() { return scale; },
    setRange(lo, hi = max) { min = lo; max = hi; scale = Math.min(max, Math.max(min, scale)); },
    reset() { scale = max; frames.length = 0; lastChange = -Infinity; },
    push(ms, now) {
      if (!(ms > 0) || ms > 250) return scale;
      frames.push(ms);
      if (frames.length < window || now - lastChange < cooldownMs) {
        if (frames.length > window) frames.shift();
        return scale;
      }
      const p90 = [...frames].sort((a, b) => a - b)[Math.floor(frames.length * 0.9)];
      frames.length = 0;
      let next = scale;
      if (p90 > budgetMs * 1.2) next = Math.max(min, scale - down);
      else if (p90 < budgetMs * 0.75) next = Math.min(max, scale + up);
      next = Math.round(next * 100) / 100;
      if (next !== scale) { scale = next; lastChange = now; }
      return scale;
    },
  };
}
