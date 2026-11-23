/* ============================================================================
   combat.js: Revenants (the showcase's foes), hit resolution, sparks, nameplates, numbers.

   Readability rules (the Jedi Academy / soulslike lesson: a fight is only fair if it can be read):
     - one attack token: only one revenant swings at a time; the rest circle and wait
     - every strike is telegraphed: the wind-up plays slow (glbhero's swing scrubbed over 0.55 s)
       and the eyes flare; then the strike snaps through in 0.4 s
     - the hit lands on one frame (swing progress 0.42), inside a 70° arc, and only then
     - guard blocks from the front; a guard raised ≤ 0.2 s before the hit is a parry, which
       staggers the attacker open for a heavy riposte
   ============================================================================ */
import * as THREE from 'three';
import { makeKnight, LOOKS } from './knight.js';
import { sfx } from '/game/lib/sfx.js';
import { animEvery } from './remotes.js';

export const RULES = {
  hitAt: 0.42, reach: 2.15, arc: Math.cos((75 * Math.PI) / 180),
  enemy: { hp: 100, dmg: 18, wind: 0.55, strike: 0.42, recover: 0.75, reach: 2.05, arc: Math.cos((70 * Math.PI) / 180), speed: 2.1, keep: 2.5, aggro: 16 },
  parryWindow: 0.2, blockCost: 16, parryStun: 1.3,
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/* ---------------- sparks: one pooled points system ---------------- */
export function makeSparks(scene, R, n = 320) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), vel = new Float32Array(n * 3), life = new Float32Array(n), size = new Float32Array(n);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const u = { uPx: { value: R.renderer.getPixelRatio() } };
  const mat = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, vertexColors: true,
    vertexShader: `attribute float size; uniform float uPx; varying vec3 vC;
      void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = size * uPx * 900.0 / -mv.z; }`,
    fragmentShader: `varying vec3 vC; void main(){ float a = smoothstep(0.5, 0.05, length(gl_PointCoord - 0.5)); gl_FragColor = vec4(vC * a, 1.0); }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  R.noAO.add(pts);
  let next = 0;
  const C = { hit: [5, 1.6, 0.4], block: [6, 5.2, 3.6], parry: [3.5, 5.5, 9], ichor: [0.9, 0.12, 0.05], dust: [0.5, 0.45, 0.4] };
  return {
    burst(p, kind = 'hit', count = 24, dir = null) {
      const c = C[kind];
      for (let k = 0; k < count; k++) {
        const i = next; next = (next + 1) % n;
        pos.set([p.x, p.y, p.z], i * 3);
        const s = kind === 'dust' ? 1.2 : 4 + Math.random() * 4;
        let vx = (Math.random() - 0.5) * s, vy = Math.random() * s * 0.8, vz = (Math.random() - 0.5) * s;
        if (dir) { vx += dir.x * s * 0.6; vz += dir.z * s * 0.6; }
        vel.set([vx, vy, vz], i * 3);
        life[i] = kind === 'dust' ? 0.7 : 0.25 + Math.random() * 0.35;
        size[i] = kind === 'dust' ? 0.16 : kind === 'ichor' ? 0.045 : 0.022 + Math.random() * 0.02;
        const b = 0.6 + Math.random() * 0.6;
        col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
      }
    },
    update(dt) {
      for (let i = 0; i < n; i++) {
        if (life[i] <= 0) { size[i] = 0; continue; }
        life[i] -= dt;
        const k = i * 3;
        vel[k + 1] -= 9.8 * dt;
        pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt; pos[k + 2] += vel[k + 2] * dt;
        const f = Math.max(0, Math.min(1, life[i] * 3));
        col[k] *= 0.9 + 0.1 * f; col[k + 1] *= 0.86 + 0.14 * f; col[k + 2] *= 0.8 + 0.2 * f;
      }
      g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = g.attributes.size.needsUpdate = true;
    },
  };
}

/* ---------------- HTML overlays: nameplates and damage numbers ---------------- */
export function makeOverlay(camera) {
  const host = document.getElementById('plates');
  const nums = [];
  const _v = new THREE.Vector3();
  const project = (p) => { _v.copy(p).project(camera); return { x: (_v.x * 0.5 + 0.5) * innerWidth, y: (-_v.y * 0.5 + 0.5) * innerHeight, front: _v.z < 1 }; };
  return {
    // kind: 'enemy' (red, always a bar) or 'ally' (blue name, guild line, a thin green bar)
    plate(name, kind = 'enemy', guild = null) {
      const el = document.createElement('div');
      el.className = 'plate ' + kind;
      el.innerHTML = `<div class="say"></div>${guild ? `<div class="g">&laquo; ${guild} &raquo;</div>` : ''}<div class="n"></div><div class="hb"><i></i></div>`;
      el.querySelector('.n').textContent = name;
      host.appendChild(el);
      const bar = el.querySelector('.hb i'), bubble = el.querySelector('.say');
      let sayT = 0;
      return {
        el,
        hide() { el.style.opacity = '0'; },
        remove() { el.remove(); },
        say(msg) { bubble.textContent = msg; bubble.classList.add('on'); clearTimeout(sayT); sayT = setTimeout(() => bubble.classList.remove('on'), 4000); },
        set(p, hp, dist, threat, alive) {
          const s = project(p);
          const vis = alive && s.front && dist < 24;
          el.style.opacity = vis ? String(Math.min(1, (24 - dist) / 6)) : '0';
          if (!vis) return;
          el.style.left = s.x + 'px'; el.style.top = s.y + 'px';
          bar.style.transform = `scaleX(${Math.max(0, hp)})`;
          el.classList.toggle('threat', threat);
        },
      };
    },
    number(p, text, kind = '') {
      const el = document.createElement('div');
      el.className = 'dmg ' + kind;
      el.textContent = text;
      host.appendChild(el);
      nums.push({ el, p: p.clone(), t: 0, dx: (Math.random() - 0.5) * 30 });
    },
    update(dt) {
      for (let i = nums.length - 1; i >= 0; i--) {
        const n = nums[i];
        n.t += dt;
        const s = project(n.p);
        n.el.style.left = s.x + n.dx * n.t + 'px';
        n.el.style.top = s.y - 50 * n.t - 20 * n.t * n.t + 'px';
        n.el.style.opacity = String(Math.max(0, 1 - Math.max(0, n.t - 0.5) * 2.2));
        if (n.t > 1 || !s.front) { n.el.remove(); nums.splice(i, 1); }
      }
    },
  };
}

/* ---------------- revenants ---------------- */
export function makeRevenants(scene, world, overlay, sparks, spots) {
  const token = { holder: null, cool: 0 };
  const list = spots.map((sp, i) => {
    const k = makeKnight(scene, LOOKS.revenant);
    const e = {
      k, i, home: sp.clone(), pos: sp.clone(), yaw: Math.PI * 0.1 * (i - 1), hp: 1, state: 'idle', t: Math.random() * 2,
      p: -1, hitDone: false, strafe: i % 2 ? 1 : -1, stun: 0, downT: 0, plate: overlay.plate('Hollow Revenant'), wander: Math.random() * 6,
    };
    k.root.position.copy(e.pos);
    return e;
  });

  function reset() {
    token.holder = null;
    for (const e of list) {
      Object.assign(e, { pos: e.home.clone(), hp: 1, state: 'idle', p: -1, stun: 0, downT: 0 });
      e.k.root.visible = true;
    }
  }

  const _to = new THREE.Vector3(), _tip = new THREE.Vector3();
  function update(dt, t, player, hooks) {
    token.cool = Math.max(0, token.cool - dt);
    for (const e of list) {
      const E = RULES.enemy;
      e.t += dt;
      _to.subVectors(player.pos, e.pos); _to.y = 0;
      const d = _to.length();
      const face = Math.atan2(_to.x, _to.z);
      let move = 0, side = 0, faceTo = null;

      if (e.state === 'dead') {
        e.downT += dt;
        if (e.downT > 3.2) e.k.root.position.y -= dt * 0.35; // sinks back into the earth
        if (e.downT > 9) { Object.assign(e, { pos: e.home.clone(), hp: 1, state: 'rise', t: 0, downT: 0, p: -1 }); e.k.root.visible = true; }
      } else if (e.state === 'rise') {
        if (e.t > 1.0) e.state = 'idle';
      } else if (e.state === 'stun') {
        e.stun -= dt;
        if (e.stun <= 0) e.state = 'stalk';
      } else if (player.dead) {
        e.state = 'idle';
      } else if (e.state === 'idle') {
        // drift around home until the warden comes near
        e.wander += dt * 0.25;
        const goal = e.home.clone().add(new THREE.Vector3(Math.cos(e.wander + e.i) * 1.5, 0, Math.sin(e.wander * 0.7 + e.i) * 1.5));
        const g = goal.sub(e.pos); g.y = 0;
        if (g.length() > 0.4) { faceTo = Math.atan2(g.x, g.z); move = 0.35; }
        if (d < E.aggro) e.state = 'stalk';
      } else if (e.state === 'stalk') {
        faceTo = face;
        if (d > E.keep + 0.6) move = 1;
        else if (d < E.keep - 0.6) move = -0.6;
        else side = e.strafe * 0.55;
        if (Math.random() < dt * 0.35) e.strafe *= -1;
        if (!token.holder && token.cool <= 0 && d < E.keep + 0.9 && Math.abs(wrap(face - e.yaw)) < 0.5) { token.holder = e; e.state = 'wind'; e.t = 0; e.p = 0; e.hitDone = false; }
        if (d > E.aggro * 1.6) e.state = 'idle';
      } else if (e.state === 'wind') {
        faceTo = face;
        e.p = 0.3 * (e.t / E.wind);
        e.k.setEyes(1 + 2.5 * (e.t / E.wind));
        if (e.t >= E.wind) { e.state = 'strike'; e.t = 0; sfx.play('swing', { dist: d }); }
      } else if (e.state === 'strike') {
        e.p = 0.3 + 0.7 * (e.t / E.strike);
        move = e.p < 0.5 ? 1.6 : 0; // commit forward into the blow
        if (!e.hitDone && e.p >= RULES.hitAt) {
          e.hitDone = true;
          const fwd = new THREE.Vector3(Math.sin(e.yaw), 0, Math.cos(e.yaw));
          if (d < E.reach && _to.clone().normalize().dot(fwd) > E.arc) hooks.hitPlayer(e, E.dmg);
        }
        if (e.t >= E.strike) { e.state = 'recover'; e.t = 0; e.p = -1; e.k.setEyes(1); }
      } else if (e.state === 'recover') {
        faceTo = face; move = -0.25;
        if (e.t >= E.recover) { e.state = 'stalk'; if (token.holder === e) { token.holder = null; token.cool = 0.5 + Math.random() * 0.6; } }
      }
      if (token.holder === e && !['wind', 'strike', 'recover'].includes(e.state)) { token.holder = null; token.cool = 0.4; }

      // turn and move
      if (faceTo !== null) e.yaw += wrap(faceTo - e.yaw) * (1 - Math.exp(-dt * (e.state === 'strike' ? 2 : 7)));
      if (move || side) {
        const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
        e.pos.x += (fx * move + fz * side) * RULES.enemy.speed * dt;
        e.pos.z += (fz * move - fx * side) * RULES.enemy.speed * dt;
      }
      // keep apart from each other and from the warden
      for (const o of list) if (o !== e && o.state !== 'dead') {
        const dx = e.pos.x - o.pos.x, dz = e.pos.z - o.pos.z, L = Math.hypot(dx, dz);
        if (L < 1.1 && L > 1e-4) { e.pos.x += (dx / L) * (1.1 - L) * 0.5; e.pos.z += (dz / L) * (1.1 - L) * 0.5; }
      }
      if (e.state !== 'dead' && !player.dead && d < 0.95 && d > 1e-4) { e.pos.x -= (_to.x / d) * (0.95 - d); e.pos.z -= (_to.z / d) * (0.95 - d); }
      if (e.state !== 'dead') {
        world.collide(e.pos, 0.38);
        e.pos.y = world.heightAt(e.pos.x, e.pos.z);
        e.k.root.position.copy(e.pos);
        if (e.state === 'rise') e.k.root.position.y -= (1 - Math.min(1, e.t)) * 1.6;
      }
      e.k.root.rotation.y = e.yaw;
      // animation LOD (remotes.js): a foe that isn't fighting you right now can step less often
      e.acc = (e.acc || 0) + dt; e.frame = (e.frame || 0) + 1;
      const busy = e.state === 'wind' || e.state === 'strike' || token.holder === e;
      if (busy || e.frame % animEvery(d) === 0) {
        e.k.update(e.acc, { atk: e.p, down: e.state === 'dead', lookAt: e.state !== 'idle' && e.state !== 'dead' ? player.pos : null });
        e.acc = 0;
      }

      const head = e.k.root.position.clone(); head.y += 1.95;
      e.plate.set(head, e.hp, d, token.holder === e, e.state !== 'dead' && e.state !== 'rise');
    }
  }

  // the warden's blade meets a revenant
  function strike(e, dmg, crit, dir, heavy = false) {
    if (e.state === 'dead' || e.state === 'rise') return false;
    e.hp -= dmg / RULES.enemy.hp;
    e.k.tipWorld(_tip);
    const at = e.k.root.position.clone(); at.y += 1.15;
    sparks.burst(at, 'ichor', 16, dir);
    sparks.burst(at, 'hit', crit ? 30 : 18, dir);
    overlay.number(at.clone().setY(at.y + 0.5), String(Math.round(dmg)), crit ? 'crit' : '');
    if (e.hp <= 0) {
      e.state = 'dead'; e.downT = 0; e.p = -1; e.k.setEyes(0.15);
      if (token.holder === e) token.holder = null;
      sfx.play('kill');
      return 'kill';
    }
    e.k.hit(e.pos.clone().sub(dir)); // the reaction follows where the blow came from
    if (heavy) { // a heavy breaks anything short of death, even a swing already coming
      e.state = 'stun'; e.stun = 0.8; e.p = -1; e.k.setEyes(1); e.k.play('guardBreak');
      if (token.holder === e) { token.holder = null; token.cool = 0.8; }
    } else if (e.state === 'wind' || e.state === 'stalk' || e.state === 'idle') { e.state = 'stun'; e.stun = 0.45; e.p = -1; e.k.setEyes(1); }
    e.pos.addScaledVector(dir, heavy ? 0.6 : 0.25);
    sfx.play('hit');
    return 'hit';
  }
  function parried(e) {
    e.state = 'stun'; e.stun = RULES.parryStun; e.p = -1; e.k.setEyes(0.3); e.k.play('guardBreak');
    if (token.holder === e) { token.holder = null; token.cool = 1.2; }
  }

  // an area's revenants sleep while the warden is elsewhere: hidden, plates off, not updated
  function setActive(on) {
    for (const e of list) { e.k.root.visible = on && e.state !== 'dead'; if (e.k.trail) e.k.trail.visible = false; e.plate.hide(); }
  }
  return { list, update, strike, parried, reset, token, setActive };
}
