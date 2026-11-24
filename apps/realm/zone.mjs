/* A zone: one map's live world, simulated here and nowhere else.

   The realm owns every position, every monster and every HP count. Players send what they want
   to do (move here, hit that); the zone checks it against what it knows and either applies it
   or corrects the player. Monsters think here, so no player's browser decides where they are or
   when they die, and nobody "hosts" the area.

   Each player is sent only what is within `view` tiles (grid.mjs), and in a crowd only the
   nearest `maxView` of those, as:
     { t: 's', at, you: [x, z, hp], e: entered, u: updates, g: gone }
       e: ['p', sid, name] | ['m', id, type, maxHp]   first sight of something
       u: [id, x, z, face, hp]                        what changed since the last snapshot
       g: [id]                                        left view (walked off, died, logged out)
   The socket is ordered and reliable, so anything not in `u` is where it was. A snapshot with
   nothing new isn't sent at all.
   plus events near them as they happen: hit, ouch, die, ko, say.

   Time is passed in (ms), never read, so tests drive it tick by tick. Units are map tiles. */

import { Grid } from './grid.mjs';
import * as R from './rules.mjs';

const r2 = (n) => Math.round(n * 100) / 100;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const MAX_TARGETS = { swing: 3, shot: 1 };
// quickselect: moves the k nearest (smallest _d) to the front of `a`, in no particular order
function selectNearest(a, k) {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1]._d;
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i]._d < pivot) i++;
      while (a[j]._d > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k - 1 <= j) hi = j; else if (k - 1 >= i) lo = i; else return;
  }
}
const CHAT = { max: 5, windowMs: 5000, len: 200 };

export class Zone {
  /* cfg: { id, w, h, start: { x, z }, spawns: [{ type, count, box: [x1, z1, x2, z2] } | { type, spot: [x, z] }],
            blocked: rows of booleans/0-1, [z][x] (optional) }
     opts: { rand, view, onKill({ zone, id, type, xp, credits: [sid], at }) } */
  constructor(cfg, { rand = Math.random, view = 32, maxView = 48, onKill = () => {} } = {}) {
    Object.assign(this, { id: cfg.id, w: cfg.w, h: cfg.h, start: cfg.start, blocked: cfg.blocked || null });
    this.rand = rand;
    this.view = view;
    this.maxView = maxView;
    this.onKill = onKill;
    this.grid = new Grid(16);
    this.players = new Map();
    this.mobs = new Map();
    this.now = 0;
    this.seq = 0;
    for (const sp of cfg.spawns || []) for (let i = 0; i < (sp.count || 1); i++) this.spawnMob(sp);
  }

  walkable(x, z) {
    if (!(x >= 0 && z >= 0 && x < this.w && z < this.h)) return false;
    const row = this.blocked && this.blocked[Math.floor(z)];
    return !(row && row[Math.floor(x)]);
  }
  // the straight line from a to (x, z) never crosses a wall (sampled every half tile)
  clear(a, x, z) {
    const steps = Math.ceil(Math.hypot(x - a.x, z - a.z) / 0.5);
    for (let i = 1; i <= steps; i++) if (!this.walkable(a.x + ((x - a.x) * i) / steps, a.z + ((z - a.z) * i) / steps)) return false;
    return true;
  }

  /* ---- monsters ---- */
  spawnPoint(sp) {
    if (sp.spot) return { x: sp.spot[0], z: sp.spot[1] };
    const [x1, z1, x2, z2] = sp.box || [0, 0, this.w, this.h];
    for (let i = 0; i < 50; i++) {
      const x = x1 + this.rand() * (x2 - x1), z = z1 + this.rand() * (z2 - z1);
      if (this.walkable(x, z)) return { x, z };
    }
    return { ...this.start };
  }
  spawnMob(sp) {
    const id = 'm' + ++this.seq, cfg = R.MONSTERS[sp.type];
    if (!cfg) throw new Error(`unknown monster ${sp.type}`);
    const at = this.spawnPoint(sp);
    const m = { kind: 'm', id, type: sp.type, cfg, sp, x: at.x, z: at.z, home: at, hp: cfg.hp, face: 0,
      target: null, evade: false, atkAt: 0, dealt: new Map(), dead: false, respawnAt: 0, wander: null, _d: 0, _cell: null };
    this.mobs.set(id, m);
    this.grid.add(m);
    return m;
  }
  respawn(m) {
    const at = this.spawnPoint(m.sp);
    Object.assign(m, { x: at.x, z: at.z, home: at, hp: m.cfg.hp, face: 0, target: null, evade: false, dead: false, wander: null });
    m.dealt.clear();
    this.grid.add(m);
  }
  step(e, tx, tz, speed, dt) {
    const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    const s = Math.min(d, speed * dt), nx = e.x + (dx / d) * s, nz = e.z + (dz / d) * s;
    e.face = Math.atan2(dx, dz);
    if (!this.walkable(nx, nz)) return; // pathfinding is a later step: blocked monsters wait
    e.x = nx; e.z = nz;
    this.grid.move(e);
  }
  think(m, now, dt) {
    const cfg = m.cfg;
    let t = m.target && this.players.get(m.target);
    if (t && (dist(m, m.home) > R.LEASH || dist(m, t) > cfg.aggro * 3)) {
      // led too far from home, or the player got away: walk back and heal, like every MMO
      t = null; m.target = null; m.evade = true; m.hp = cfg.hp; m.dealt.clear();
    }
    if (!t && !m.evade) {
      let best = null, bd = Infinity;
      for (const e of this.grid.near(m.x, m.z, cfg.aggro)) if (e.kind === 'p') { const d = dist(m, e); if (d < bd) { bd = d; best = e; } }
      if (best) { t = best; m.target = best.id; }
    }
    if (t) {
      if (dist(m, t) > R.MOB_REACH + (cfg.size || 0)) this.step(m, t.x, t.z, cfg.speed, dt);
      else if (now >= m.atkAt) { m.atkAt = now + R.MOB_ATTACK_MS; this.hurt(t, m, cfg.dmg); }
      return;
    }
    if (dist(m, m.home) > 0.3 && (m.evade || !m.wander)) { this.step(m, m.home.x, m.home.z, cfg.speed * (m.evade ? 1.5 : 1), dt); return; }
    m.evade = false;
    if (!m.wander && this.rand() < dt * 0.2) m.wander = { x: m.home.x + (this.rand() - 0.5) * 6, z: m.home.z + (this.rand() - 0.5) * 6 };
    if (m.wander) {
      this.step(m, m.wander.x, m.wander.z, cfg.speed * 0.5, dt);
      if (dist(m, m.wander) < 0.2 || this.rand() < dt * 0.1) m.wander = null;
    }
  }
  hurt(p, m, dmg) {
    p.hp -= dmg;
    this.emit(p, { t: 'ouch', id: p.id, by: m.id, dmg, hp: Math.max(0, p.hp) });
    if (p.hp > 0) return;
    // knocked out: back to the zone's start, full HP, and every monster forgets you
    this.emit(p, { t: 'ko', id: p.id });
    this.place(p, this.start.x, this.start.z);
    p.hp = R.PLAYER_HP;
    for (const q of this.mobs.values()) if (q.target === p.id) q.target = null;
    p.send({ t: 'ko', x: p.x, z: p.z, hp: p.hp });
  }
  kill(m, now) {
    m.dead = true;
    m.hp = 0;
    m.respawnAt = now + R.respawnMs(m.type, this.rand);
    this.emit(m, { t: 'die', id: m.id, type: m.type });
    this.grid.remove(m);
    // a group kill: everyone still here who did real damage gets the full kill
    const need = Math.ceil(m.cfg.hp * R.ASSIST_SHARE);
    const credits = [...m.dealt].filter(([sid, d]) => d >= need && this.players.has(sid)).map(([sid]) => sid);
    m.dealt.clear();
    this.onKill({ zone: this.id, id: m.id, type: m.type, xp: m.cfg.xp, credits, at: now });
  }

  /* ---- players ---- */
  place(p, x, z) {
    p.x = x; p.z = z;
    p.budget = R.PLAYER_SPEED * R.MOVE_SLACK * R.MOVE_BURST_S;
    this.grid.move(p);
  }
  // info: { sid, name, guest, stats? }. send(msg): to that player's socket.
  addPlayer(info, send, now = this.now) {
    this.removePlayer(info.sid);
    const p = { kind: 'p', id: info.sid, name: info.name, guest: !!info.guest, stats: info.stats || R.DEFAULT_STATS,
      x: this.start.x, z: this.start.z, face: 0, hp: R.PLAYER_HP, send,
      budget: R.PLAYER_SPEED * R.MOVE_SLACK * R.MOVE_BURST_S, budgetAt: now, seen: new Set(), sent: new Map(), you: null, atk: {}, chat: [], _d: 0, _cell: null };
    this.players.set(p.id, p);
    this.grid.add(p);
    send({ t: 'zone', id: this.id, w: this.w, h: this.h, you: [p.x, p.z, p.hp] });
    return p;
  }
  removePlayer(sid) {
    const p = this.players.get(sid);
    if (!p) return;
    this.grid.remove(p);
    this.players.delete(sid);
    for (const m of this.mobs.values()) if (m.target === sid) m.target = null;
  }
  // a move the player asks for: applied if a sprinting player could have made it, else corrected
  move(sid, msg, now = this.now) {
    const p = this.players.get(sid);
    if (!p) return 'not here';
    const x = Number(msg.x), z = Number(msg.z), face = Number(msg.face) || 0;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 'bad move';
    const rate = R.PLAYER_SPEED * R.MOVE_SLACK;
    p.budget = Math.min(rate * R.MOVE_BURST_S, p.budget + ((now - p.budgetAt) / 1000) * rate);
    p.budgetAt = now;
    const d = Math.hypot(x - p.x, z - p.z);
    if (d > p.budget || !this.clear(p, x, z)) {
      p.send({ t: 'fix', x: r2(p.x), z: r2(p.z) });
      return d > p.budget ? 'too fast' : 'blocked';
    }
    p.budget -= d;
    p.x = x; p.z = z; p.face = face;
    this.grid.move(p);
    return '';
  }
  // { id: monster, k: 'swing' | 'shot', a: attack id (one swing can cleave up to 3), dmg }
  hit(sid, msg, now = this.now) {
    const p = this.players.get(sid), m = this.mobs.get(msg.id), k = msg.k;
    if (!p) return 'not here';
    if (!R.POWER[k]) return 'bad hit';
    if (!m || m.dead) return 'no such monster';
    const a = String(msg.a || '').slice(0, 16);
    if (!a) return 'bad hit';
    let cur = p.atk[k];
    if (!cur || cur.a !== a) {
      if (cur && now - cur.at < R.COOLDOWN[k] * 1000 * R.CD_SLACK) return 'too fast';
      cur = p.atk[k] = { a, at: now, n: 0 };
    }
    if (cur.n >= MAX_TARGETS[k]) return 'too many targets';
    if (dist(p, m) > R.REACH[k] + (m.cfg.size || 0)) return 'out of reach';
    cur.n++;
    const dmg = Math.min(Math.max(1, Math.floor(Number(msg.dmg)) || 1), R.maxHit(k, p.stats));
    m.hp -= dmg;
    m.dealt.set(sid, (m.dealt.get(sid) || 0) + dmg);
    if (!m.target && !m.evade) m.target = sid;
    this.emit(m, { t: 'hit', id: m.id, by: sid, dmg, hp: Math.max(0, m.hp) });
    if (m.hp <= 0) this.kill(m, now);
    return '';
  }
  say(sid, text, now = this.now) {
    const p = this.players.get(sid);
    if (!p) return 'not here';
    const msg = String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, CHAT.len);
    if (!msg) return 'empty';
    p.chat = p.chat.filter((at) => now - at < CHAT.windowMs);
    if (p.chat.length >= CHAT.max) return 'too fast';
    p.chat.push(now);
    this.emit(p, { t: 'say', id: sid, name: p.name, msg });
    return '';
  }

  /* ---- the loop ---- */
  // tell everyone who can see `at`
  emit(at, msg) {
    for (const e of this.grid.near(at.x, at.z, this.view)) if (e.kind === 'p') e.send(msg);
  }
  tick(now) {
    const dt = this.now ? Math.min(0.1, Math.max(0, (now - this.now) / 1000)) : 0;
    this.now = now;
    for (const m of this.mobs.values()) {
      if (m.dead) { if (now >= m.respawnAt) this.respawn(m); continue; }
      this.think(m, now, dt);
    }
  }
  /* Snapshots for every player, or, with (part, parts), for one slice of them: the realm sends a
     third of the zone's snapshots on each tick, so a crowd's cost is spread over the ticks
     instead of landing on one. Each player still gets one every `parts` ticks. */
  snapshot(part = 0, parts = 1) {
    let i = -1;
    for (const p of this.players.values()) {
      if (parts > 1 && ++i % parts !== part) continue;
      const near = this.grid.near(p.x, p.z, this.view);
      const self = near.indexOf(p);
      if (self >= 0) { near[self] = near[near.length - 1]; near.pop(); }
      if (near.length > this.maxView) { // a crowd: only the nearest matter (selected, not fully sorted)
        selectNearest(near, this.maxView);
        near.length = this.maxView;
        near.sort((a, b) => a._d - b._d);
      }
      const e = [], u = [], seen = new Set();
      for (const o of near) {
        seen.add(o.id);
        if (!p.seen.has(o.id)) e.push(o.kind === 'p' ? ['p', o.id, o.name] : ['m', o.id, o.type, o.cfg.hp]);
        const x = r2(o.x), zz = r2(o.z), f = r2(o.face), hp = Math.max(0, Math.round(o.hp)), last = p.sent.get(o.id);
        if (!last || last[1] !== x || last[2] !== zz || last[3] !== f || last[4] !== hp) { const row = [o.id, x, zz, f, hp]; u.push(row); p.sent.set(o.id, row); }
      }
      const g = [];
      for (const id of p.seen) if (!seen.has(id)) { g.push(id); p.sent.delete(id); }
      p.seen = seen;
      const you = [r2(p.x), r2(p.z), p.hp], was = p.you;
      if (!e.length && !u.length && !g.length && was && was[0] === you[0] && was[1] === you[1] && was[2] === you[2]) continue; // nothing new
      p.you = you;
      const msg = { t: 's', at: this.now, you, u };
      if (e.length) msg.e = e;
      if (g.length) msg.g = g;
      p.send(msg);
    }
  }
  stats() {
    let alive = 0;
    for (const m of this.mobs.values()) if (!m.dead) alive++;
    return { players: this.players.size, mobs: alive };
  }
}
