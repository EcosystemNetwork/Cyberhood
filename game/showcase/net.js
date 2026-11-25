/* ============================================================================
   net.js: what the showcase hears about other players, in the realm's own message shapes
   (apps/realm on feat/realm, protocol 2), so the renderer in remotes.js plugs straight into it.

     { t: 's', zone, at, e: [['p', sid, name, look]], u: [[sid, x, z, face, hp]], g: [sid] }
     { t: 'ouch', id, dmg, hp, from: [x, z] }   { t: 'ko', id }   { t: 'say', id, msg }
   plus one addition the realm doesn't send yet (proposed for protocol 3), because combat can't be
   read without it: what each player's body is doing.
     { t: 'act', id, a: 'swing' | 'heavy' | 'guard' | 'unguard' | 'roll' | 'emote', i?, dur?, name? }
   Positions are metres in the area's frame; y is never sent (the client knows the ground).

   Transports here, all serverless:
     tabs   BroadcastChannel: every open showcase tab publishes itself; open two and fight side by side
     bots   simulated wardens: walk the courtyard, spar in pairs, wave, talk; sent at 10 Hz through a
            jittered 40-140 ms "network", so interpolation is exercised as it would be live
   The realm's WebSocket (ticket sign-in, then the same messages) is the third transport to add.
   ============================================================================ */

const SNAP_MS = 100;
const NAMES = [['Aldric', 'Ashen Vow'], ['Maren', 'Ashen Vow'], ['Corvin', 'Grey Lantern'], ['Isolde', 'Grey Lantern'], ['Theron', null], ['Wenna', 'Ashen Vow']];
const LINES = ['Hold the line!', 'Guard up.', 'Again!', 'The chapel bells, do you hear them?', 'Good blade.', 'Revenants, near the door.', 'Watch the parry.'];

export function createNet({ me, bots = 0, zone = () => 'glade', collide = null }) {
  const listeners = new Set();
  const emit = (m) => { for (const f of listeners) f(m); };
  const bc = 'BroadcastChannel' in self ? new BroadcastChannel('cyberhood-showcase') : null;
  if (bc) bc.onmessage = (ev) => { const m = ev.data; if (m && m.id !== me.sid && !(m.u && m.u[0]?.[0] === me.sid)) emit(m); };
  const send = (m) => bc?.postMessage(m);
  let lastIntro = 0;
  addEventListener('pagehide', () => send({ t: 's', zone: zone(), g: [me.sid] }));

  /* ---- simulated players ---- */
  const B = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < bots; i++) {
    const [name, guild] = NAMES[i % NAMES.length], a = (i / bots) * Math.PI * 2;
    B.push({ sid: 'bot' + i, name, look: { guild, cloak: i % 4, armor: i % 3 }, x: Math.cos(a) * 7, z: Math.sin(a) * 7 + 2, face: 0, hp: 100,
      goal: null, wait: rnd(0.5, 3), mode: 'idle', foe: null, tAct: 0, speed: rnd(2.0, 3.3), guard: false, combo: 0 });
  }
  const lag = (m) => setTimeout(() => emit(m), rnd(40, 140)); // the "network"
  function stepBots(dt) {
    for (const b of B) {
      if (collide) collide(b); // bots keep out of walls, plinths and each other's statues
      b.tAct -= dt;
      if (b.mode === 'spar') {
        const f = b.foe, dx = f.x - b.x, dz = f.z - b.z, d = Math.hypot(dx, dz);
        b.face = Math.atan2(dx, dz);
        if (d > 2.1) { b.x += (dx / d) * 1.6 * dt; b.z += (dz / d) * 1.6 * dt; }
        if (b.tAct <= 0) {
          const r = Math.random();
          if (b.guard) { b.guard = false; lag({ t: 'act', id: b.sid, a: 'unguard' }); }
          if (r < 0.55) { // a combo of 1-3 swings
            const n = 1 + Math.floor(Math.random() * 3);
            for (let k = 0; k < n; k++) setTimeout(() => lag({ t: 'act', id: b.sid, a: 'swing', i: k, dur: [0.62, 0.58, 0.78][k] }), k * 640);
            setTimeout(() => { if (f.guard) lag({ t: 'ouch', id: f.sid, dmg: 0, hp: f.hp, from: [b.x, b.z], blocked: true }); else { f.hp = Math.max(20, f.hp - 8); lag({ t: 'ouch', id: f.sid, dmg: 8, hp: f.hp, from: [b.x, b.z] }); } }, 300);
            b.tAct = n * 0.66 + rnd(0.6, 1.4);
          } else if (r < 0.8) { b.guard = true; lag({ t: 'act', id: b.sid, a: 'guard' }); b.tAct = rnd(0.8, 1.6); }
          else if (r < 0.9) { lag({ t: 'act', id: b.sid, a: 'roll' }); b.x += Math.sin(b.face + Math.PI / 2) * 1.8; b.z += Math.cos(b.face + Math.PI / 2) * 1.8; b.tAct = 0.9; }
          else { lag({ t: 'act', id: b.sid, a: 'heavy', dur: 0.5 }); b.tAct = 1.6; }
        }
        if ((b.sparT -= dt) <= 0) { b.mode = 'idle'; b.wait = rnd(1, 3); if (b.guard) { b.guard = false; lag({ t: 'act', id: b.sid, a: 'unguard' }); } f.hp = 100; b.hp = 100; }
      } else if (b.mode === 'walk') {
        const dx = b.goal[0] - b.x, dz = b.goal[1] - b.z, d = Math.hypot(dx, dz);
        b.face = Math.atan2(dx, dz);
        if (d < 0.3) { b.mode = 'idle'; b.wait = rnd(1.5, 4); }
        else { const s = Math.min(d, b.speed * dt); b.x += (dx / d) * s; b.z += (dz / d) * s; }
      } else {
        b.wait -= dt;
        if (b.wait <= 0) {
          const r = Math.random(), free = B.filter((o) => o !== b && o.mode !== 'spar');
          if (r < 0.35 && free.length) { // challenge someone to spar: both turn to it
            const o = free[Math.floor(Math.random() * free.length)];
            b.mode = o.mode = 'spar'; b.foe = o; o.foe = b; b.sparT = o.sparT = rnd(8, 14); b.tAct = 0.6; o.tAct = 1.2;
            lag({ t: 'say', id: b.sid, msg: o.name + ', a bout?' });
          } else if (r < 0.45) { lag({ t: 'act', id: b.sid, a: 'emote', name: Math.random() < 0.5 ? 'wave' : 'cheer' }); b.wait = rnd(2, 4); if (Math.random() < 0.5) lag({ t: 'say', id: b.sid, msg: LINES[Math.floor(Math.random() * LINES.length)] }); }
          else { const a = Math.random() * Math.PI * 2, r2 = rnd(3, 10); b.goal = [Math.cos(a) * r2, Math.sin(a) * r2 + 1]; b.mode = 'walk'; }
        }
      }
    }
  }
  let acc = 0, botAcc = 0;
  return {
    on(f) { listeners.add(f); return () => listeners.delete(f); },
    bots: B,
    // the local player: 10 Hz state, plus its actions as they happen
    act(a) { send({ t: 'act', zone: zone(), id: me.sid, ...a }); },
    hurt(m) { send({ t: 'ouch', zone: zone(), id: me.sid, ...m }); },
    say(msg) { send({ t: 'say', zone: zone(), id: me.sid, msg }); },
    update(dt, state) {
      acc += dt * 1000;
      if (acc >= SNAP_MS) {
        acc %= SNAP_MS;
        const now = performance.now(), intro = now - lastIntro > 2000; // re-introduce every 2 s for tabs that open later
        if (intro) lastIntro = now;
        send({ t: 's', zone: zone(), at: now, e: intro ? [['p', me.sid, me.name, me.look]] : undefined, u: [[me.sid, +state.x.toFixed(2), +state.z.toFixed(2), +state.face.toFixed(3), Math.round(state.hp)]] });
      }
      if (!B.length) return;
      stepBots(dt);
      botAcc += dt * 1000;
      if (botAcc >= SNAP_MS) {
        botAcc %= SNAP_MS;
        const intro = (this._botIntro = (this._botIntro || 0) + 1) % 20 === 1;
        lag({ t: 's', zone: 'glade', at: performance.now(), e: intro ? B.map((b) => ['p', b.sid, b.name, b.look]) : undefined,
          u: B.map((b) => [b.sid, +b.x.toFixed(2), +b.z.toFixed(2), +b.face.toFixed(3), b.hp]) });
      }
    },
  };
}
