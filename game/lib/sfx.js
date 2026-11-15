// Sound effects drawn in code, like the art: every sound is a few oscillators and noise bursts
// through the Web Audio API, so there are no audio files to load.
//
//   import { sfx } from '/game/lib/sfx.js';
//   sfx.play('hit');                 // by name (see SOUNDS)
//   sfx.play('boom', { dist: 9 });   // quieter with distance (silent past ~28 units)
//   sfx.toggle();                    // mute / unmute, remembered across visits
//
// Browsers only allow sound after a click, tap or key press: the first one starts the audio,
// and anything played before it is dropped.

const KEY = 'taproot_sfx';
let ctx = null, master = null, noiseBuf = null;
let muted = false, volume = 0.6;
try {
  const s = JSON.parse(localStorage.getItem(KEY) || '{}');
  if (typeof s.muted === 'boolean') muted = s.muted;
  if (typeof s.volume === 'number') volume = Math.min(1, Math.max(0, s.volume));
} catch (e) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ muted, volume })); } catch (e) {} };

function boot() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  const comp = ctx.createDynamicsCompressor(); // keeps a pile of hits from clipping
  comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  master.connect(comp).connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}
for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, boot, { capture: true, passive: true });

// A voice: a gain envelope (quick attack, exponential fall) feeding the master.
function env(t, dur, gain, attack = 0.004) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(out);
  return g;
}
let out = null; // where the current sound's voices go (a per-play gain, for distance)

// tone: an oscillator sliding from f0 to f1.
function tone(at, type, f0, f1, dur, gain, attack) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  o.connect(env(t, dur, gain, attack));
  o.start(t); o.stop(t + dur + 0.02);
}
// hiss: filtered noise, the filter sweeping from f0 to f1.
function hiss(at, filter, f0, f1, dur, gain, q = 1, attack) {
  const t = ctx.currentTime + at;
  const n = ctx.createBufferSource();
  n.buffer = noiseBuf; n.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = filter; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  n.connect(f).connect(env(t, dur, gain, attack));
  n.start(t, Math.random() * 0.9); n.stop(t + dur + 0.02);
}
const notes = (type, list, step, dur, gain) => list.forEach((f, i) => tone(i * step, type, f, f, dur, gain));

export const SOUNDS = {
  // combat
  swing: () => hiss(0, 'bandpass', 900, 3200, 0.14, 0.35, 1.2, 0.03),
  hit: () => { hiss(0, 'lowpass', 2400, 300, 0.09, 0.5); tone(0, 'square', 190, 70, 0.1, 0.25); },
  kill: () => { tone(0, 'square', 260, 50, 0.28, 0.3); hiss(0, 'lowpass', 1800, 150, 0.3, 0.4); tone(0.06, 'triangle', 660, 990, 0.16, 0.2); },
  hurt: () => { tone(0, 'sawtooth', 240, 90, 0.2, 0.32); hiss(0, 'lowpass', 900, 200, 0.12, 0.35); },
  faint: () => notes('triangle', [392, 330, 262, 196], 0.16, 0.3, 0.3),
  cast: () => { tone(0, 'sawtooth', 320, 900, 0.16, 0.14); hiss(0, 'bandpass', 600, 2400, 0.2, 0.3, 2, 0.02); },
  boom: () => { tone(0, 'sine', 120, 30, 0.5, 0.7); hiss(0, 'lowpass', 1400, 80, 0.55, 0.7); },
  parry: () => { tone(0, 'triangle', 1500, 1480, 0.3, 0.25); tone(0, 'triangle', 2240, 2200, 0.24, 0.16); hiss(0, 'highpass', 5000, 5000, 0.05, 0.25); },
  splat: () => { hiss(0, 'lowpass', 900, 150, 0.16, 0.5); tone(0, 'sine', 160, 60, 0.12, 0.3); },
  throw: () => hiss(0, 'bandpass', 500, 1500, 0.2, 0.25, 1.5, 0.05),
  crate: () => { hiss(0, 'bandpass', 1200, 300, 0.2, 0.55, 0.8); tone(0, 'square', 140, 60, 0.12, 0.25); tone(0.03, 'square', 210, 90, 0.1, 0.15); },
  chill: () => notes('sine', [1760, 1320, 990], 0.05, 0.22, 0.18),
  poof: () => hiss(0, 'lowpass', 500, 1600, 0.4, 0.4, 0.7, 0.08),
  // movement
  jump: () => tone(0, 'square', 240, 520, 0.13, 0.13),
  jump2: () => { tone(0, 'square', 380, 820, 0.13, 0.13); tone(0.02, 'sine', 760, 1640, 0.12, 0.1); },
  land: () => hiss(0, 'lowpass', 400, 100, 0.08, 0.3),
  step: () => hiss(0, 'lowpass', 520 + Math.random() * 220, 140, 0.05, 0.11),
  sprint: () => hiss(0, 'bandpass', 400, 2000, 0.22, 0.2, 1.4, 0.06),
  // rewards
  coin: () => { tone(0, 'square', 988, 988, 0.07, 0.14); tone(0.06, 'square', 1319, 1319, 0.2, 0.14); },
  pickup: () => { tone(0, 'triangle', 520, 780, 0.09, 0.22); tone(0.07, 'triangle', 780, 1170, 0.1, 0.18); },
  levelup: () => { notes('square', [523, 659, 784, 1047], 0.09, 0.2, 0.15); notes('triangle', [1047, 1319, 1568], 0.09, 0.4, 0.12); },
  heal: () => notes('sine', [440, 554, 659, 880], 0.07, 0.22, 0.2),
  win: () => notes('square', [523, 523, 523, 698, 880], 0.11, 0.24, 0.14),
  // town and farm
  buy: () => { tone(0, 'square', 1175, 1175, 0.06, 0.12); tone(0.07, 'square', 1568, 1568, 0.16, 0.12); },
  craft: () => { hiss(0, 'highpass', 3000, 3000, 0.04, 0.3); tone(0, 'triangle', 880, 860, 0.25, 0.22); tone(0.14, 'triangle', 1320, 1300, 0.3, 0.2); },
  equip: () => { hiss(0, 'bandpass', 2600, 1400, 0.07, 0.3, 2); tone(0.03, 'triangle', 620, 640, 0.1, 0.16); },
  dig: () => hiss(0, 'lowpass', 700, 200, 0.12, 0.45),
  plant: () => { hiss(0, 'lowpass', 600, 250, 0.08, 0.3); tone(0.04, 'sine', 300, 460, 0.1, 0.18); },
  water: () => { hiss(0, 'bandpass', 1800, 900, 0.3, 0.22, 3, 0.05); tone(0.05, 'sine', 900, 500, 0.08, 0.06); },
  harvest: () => { hiss(0, 'bandpass', 1500, 700, 0.08, 0.3, 1.5); notes('triangle', [660, 880], 0.07, 0.14, 0.2); },
  build: () => { tone(0, 'square', 150, 110, 0.07, 0.3); hiss(0, 'lowpass', 1600, 400, 0.06, 0.4); },
  break: () => { hiss(0, 'bandpass', 900, 350, 0.12, 0.45, 0.9); tone(0, 'square', 110, 70, 0.08, 0.2); },
  claim: () => notes('triangle', [523, 784, 1047], 0.1, 0.3, 0.2),
  // interface
  ui: () => tone(0, 'triangle', 660, 700, 0.05, 0.12),
  open: () => { tone(0, 'triangle', 440, 660, 0.08, 0.13); },
  close: () => { tone(0, 'triangle', 660, 440, 0.08, 0.11); },
  chat: () => { tone(0, 'sine', 880, 880, 0.06, 0.12); tone(0.07, 'sine', 1175, 1175, 0.1, 0.1); },
  ask: () => notes('sine', [784, 988, 784, 988], 0.11, 0.14, 0.16),
  nope: () => { tone(0, 'square', 170, 150, 0.12, 0.16); },
};

const last = {};
const GAP = { step: 0.12, hit: 0.03, coin: 0.05, pickup: 0.05 }; // seconds between repeats of one sound
export const sfx = {
  get muted() { return muted; },
  get volume() { return volume; },
  get ready() { return !!ctx && ctx.state === 'running'; },
  count: 0, // sounds actually started (tests read this)
  log: [], // names of the last few sounds started, newest last
  play(name, { dist = 0, vol = 1 } = {}) {
    const make = SOUNDS[name];
    if (!make || muted || !ctx || ctx.state !== 'running') return false;
    const k = Math.max(0, 1 - dist / 28) ** 2 * vol;
    if (k < 0.02) return false;
    const t = ctx.currentTime;
    if (t - (last[name] ?? -1) < (GAP[name] ?? 0.04)) return false;
    last[name] = t;
    out = ctx.createGain();
    out.gain.value = k;
    out.connect(master);
    try { make(); } catch (e) { return false; }
    this.count++;
    this.log.push(name); if (this.log.length > 24) this.log.shift();
    return true;
  },
  setMuted(m) {
    muted = !!m; save();
    if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.02);
    return muted;
  },
  toggle() { return this.setMuted(!muted); },
  setVolume(v) {
    volume = Math.min(1, Math.max(0, +v || 0)); save();
    if (master && !muted) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
  },
};
