/* ============================================================================
   remotes.js: other players, drawn so a crowded fight stays readable.

   Feed it the realm's messages (net.js); every frame it places each remote warden from a buffer of
   snapshots, rendered INTERP_MS in the past so there are always two to blend between (10 Hz updates
   look like 60), briefly extrapolating if the stream stalls. Their bodies run the same animation
   stack as yours (glbhero + moves.js), driven by `act` events: swings walk the same combo, guards
   raise, rolls tuck, hits push them the way they came from.

   Readability: allies wear a cool blue rim (enemies an ember one) and a blue nameplate with their
   guild; their sword trails burn at half your brightness, their damage numbers are small and grey,
   so your own blows always read first. Cost: they skip the AO pass, cast shadows only within
   SHADOW_NEAR, drop their armour past ARMOR_NEAR, step their animation at a third of the frame
   rate past LOD_FAR (dt accumulated, so it keeps time), and past LOD_CULL aren't drawn.
   ============================================================================ */
import * as THREE from 'three';
import { makeKnight, LOOKS } from './knight.js';

const INTERP_MS = 120, EXTRAP_MS = 160, LOD_FAR = 28, LOD_CULL = 70, SHADOW_NEAR = 14, ARMOR_NEAR = 22;
const CLOAKS = [null, new THREE.Color(1.5, 0.55, 0.5), new THREE.Color(0.7, 0.85, 1.4), new THREE.Color(1.5, 1.2, 0.55)]; // green (as made), crimson, slate, ochre
const ARMOR = [['pauldrons', 'vambraces', 'greaves'], ['helm', 'gorget', 'pauldrons', 'breastplate', 'vambraces'], ['greaves', 'vambraces']];
const ALLY_RIM = new THREE.Color(0.08, 0.16, 0.38);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const animEvery = (d) => (d < 8 ? 1 : d < 16 ? 2 : d < LOD_FAR ? 3 : 4);

export function createRemotes(scene, R, overlay, sparks, heightAt) {
  const players = new Map();
  const now = () => performance.now();

  function ensure(sid, name, look = {}) {
    let p = players.get(sid);
    if (p) return p;
    const cloak = look.cloak ?? 0, armor = look.armor ?? 0;
    const k = makeKnight(scene, { ...LOOKS.warden, key: `remote-${cloak}-${armor}`, cloakTint: CLOAKS[cloak % CLOAKS.length], armor: ARMOR[armor % ARMOR.length],
      rim: ALLY_RIM, trail: new THREE.Color(0.95, 0.85, 3.2) }); // half the brightness of your own trail
    R.noAO.add(k.trail);
    R.noAO.add(k.root); // contact AO is for the scene and you; remotes are grounded by their shadows
    p = { sid, name, k, buf: [], zone: null, shadow: true, armorOn: true, hp: 100, atk: -1, dur: 0.6, queued: null, guard: false, down: false, acc: 0, frame: 0,
      plate: overlay.plate(name, 'ally', look.guild || null), pos: new THREE.Vector3(), yaw: 0 };
    k.root.visible = false;
    players.set(sid, p);
    return p;
  }
  function drop(sid) {
    const p = players.get(sid);
    if (!p) return;
    p.k.root.removeFromParent(); p.k.trail?.removeFromParent(); p.plate.remove();
    players.delete(sid);
  }

  function handle(m) {
    if (m.t === 's') {
      for (const [, sid, name, look] of m.e || []) ensure(sid, name, look);
      const t = now();
      for (const [sid, x, z, face, hp] of m.u || []) {
        const p = players.get(sid);
        if (!p) continue; // not introduced yet (an intro follows within 2 s)
        p.zone = m.zone;
        p.buf.push({ t, x, z, face, hp });
        if (p.buf.length > 20) p.buf.shift();
      }
      for (const sid of m.g || []) drop(sid);
      return;
    }
    const p = players.get(m.id);
    if (!p) return;
    switch (m.t) {
      case 'act':
        if (m.a === 'swing' || m.a === 'heavy') {
          const go = () => { p.atk = 0; p.dur = m.dur || 0.6; if (m.a === 'heavy') p.k.play('heavyStrike'); };
          if (p.atk >= 0) p.queued = go; else go(); // one frame of -1 between swings walks the combo
        } else if (m.a === 'guard') p.guard = true;
        else if (m.a === 'unguard') p.guard = false;
        else if (m.a === 'roll') p.k.roll();
        else if (m.a === 'emote') p.k.hero.emote(m.name || 'wave');
        break;
      case 'ouch': {
        const from = new THREE.Vector3(m.from?.[0] ?? p.pos.x, 0, m.from?.[1] ?? p.pos.z);
        const at = p.pos.clone().setY(p.pos.y + 1.3).lerp(from.setY(p.pos.y + 1.3), 0.3);
        if (m.blocked) { p.k.play('block'); sparks.burst(at, 'block', 10); }
        else { p.k.hit(from); sparks.burst(at, 'hit', 8); if (m.dmg) overlay.number(at, String(m.dmg), 'ally'); }
        p.hp = m.hp ?? p.hp;
        break;
      }
      case 'ko': p.down = true; break;
      case 'say': p.plate.say(String(m.msg).slice(0, 120)); break;
    }
  }

  // where a player is at render time: between the two snapshots around it, else a short extrapolation
  function sample(p, rt) {
    const b = p.buf;
    if (!b.length) return null;
    if (rt <= b[0].t) return b[0];
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1].t <= rt && rt <= b[i].t) {
        const A = b[i - 1], B = b[i], k = (rt - A.t) / Math.max(1, B.t - A.t);
        return { x: A.x + (B.x - A.x) * k, z: A.z + (B.z - A.z) * k, face: A.face + wrap(B.face - A.face) * k, hp: B.hp };
      }
    }
    const L = b[b.length - 1], P = b[b.length - 2];
    if (!P) return L;
    const over = Math.min(rt - L.t, EXTRAP_MS) / Math.max(1, L.t - P.t);
    return { x: L.x + (L.x - P.x) * over, z: L.z + (L.z - P.z) * over, face: L.face, hp: L.hp };
  }

  return {
    players, handle,
    get count() { return players.size; },
    update(dt, camera, zone) {
      const rt = now() - INTERP_MS;
      for (const p of players.values()) {
        const s = sample(p, rt), here = p.zone === zone && s;
        const d = here ? Math.hypot(s.x - camera.position.x, s.z - camera.position.z) : Infinity;
        p.k.root.visible = !!here && d < LOD_CULL;
        if (!p.k.root.visible) { p.plate.hide(); p.k.trail && (p.k.trail.visible = false); continue; }
        p.pos.set(s.x, heightAt(s.x, s.z), s.z);
        p.k.root.position.copy(p.pos);
        p.k.root.rotation.y = s.face;
        // cost LOD: shadows only when near, armour only when it can be made out
        if ((d < SHADOW_NEAR) !== p.shadow) { p.shadow = d < SHADOW_NEAR; p.k.root.traverse((o) => { if (o.isMesh) o.castShadow = p.shadow; }); }
        if ((d < ARMOR_NEAR) !== p.armorOn) { p.armorOn = d < ARMOR_NEAR; for (const ps of Object.values(p.k.armor.pieces)) for (const o of ps) o.userData.lodHidden = !p.armorOn; p.k.armor.applyLod?.(); }
        p.hp = s.hp;
        // swing progress runs on the receiver's clock, from when the act arrived
        if (p.atk >= 0) { p.atk += dt / p.dur; if (p.atk >= 1) p.atk = -1; }
        else if (p.queued) { p.queued(); p.queued = null; }
        // animation LOD: an animated hero costs ~2 ms of JS (glbhero: mixer, layers, cape sim), so
        // bodies step every frame up close, then every 2nd / 3rd / 4th frame with the time they missed
        p.acc += dt; p.frame++;
        if (p.frame % animEvery(d) === 0) {
          p.k.update(p.acc, { atk: p.atk, guard: p.guard && p.atk < 0 ? 1 : 0, down: p.down });
          p.acc = 0;
        }
        const head = p.pos.clone(); head.y += 2.0;
        p.plate.set(head, p.hp / 100, d, false, true);
        p.plate.el.style.opacity = String(Math.min(1, (LOD_CULL * 0.5 - d) / 8)); // allies' plates fade sooner than foes'
      }
    },
  };
}
