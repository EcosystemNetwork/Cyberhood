/* ============================================================================
   The game economy's rules, and the one function that applies them.

   The server (api/game/[action].js) runs every reward and purchase through
   applyAction() below, using these same tables, so what a player owns is
   decided on the server and can't be edited in the browser. The browser
   still plays everything out straight away (and the 3D world reads its
   monster, island and plot numbers from here too); the server's answer then
   corrects it if the two ever disagree.

   Pure logic, no DOM or Three.js, so it runs in node as well.
   ============================================================================ */

import { SHOPS, SELL, RECIPES, CONSUMABLES } from './shops.js';
import { CROPS, BUILDS, ALTAR } from './farm.js';
import { BLOCKS, unpack, pack, canPlace } from './blocks.js';

// What each monster pays out: XP on the kill, then a gold drop and an item drop to pick up.
export const MONSTER_LOOT = {
  slime:     { xp: 5,  gold: [1, 2],   drop: 'slime_gel' },
  shroom:    { xp: 8,  gold: [1, 3],   drop: 'spore_cap' },
  bat:       { xp: 7,  gold: [1, 2],   drop: 'bat_fang' },
  goblin:    { xp: 15, gold: [3, 5],   drop: 'goblin_ear' },
  king:      { xp: 60, gold: [15, 25], drop: 'royal_jelly' },
  gladiator: { xp: 45, gold: [10, 18], drop: 'laurel' },
};

// Sea chests (one per island, once per player) and floating barrels.
export const SEA_TREASURE = { wreck: 40, lonely: 25, gull: 25, doubloon: 30 };
export const BARREL_GOLD = 3;

// Soil size (tiles) of each player plot in the Avenues, by plot id.
export const PLOT_SOIL = { 1: [24, 24], 2: [8, 8], 3: [8, 8] };

/* How fast rewards can come in, as token buckets: [burst, seconds per refill]. Monsters
   respawn 12-18 s after a kill (King Slime 45 s, the Gladiator 25 s) and no area has more
   than five of one kind, so a real player can't beat these; a script can't go faster. */
export const LIMITS = {
  kill: [8, 2.4],
  'kill:king': [2, 40],
  'kill:gladiator': [2, 22],
  barrel: [4, 8],
};
export const MAX_PENDING = 30;   // uncollected drops kept per kind
export const BAG_MAX = 99999;
export const MAX_MEMBERS = 20;
export const HARVEST_SLACK_MS = 5000; // client and server clocks / latency

// A first upload of progress saved in the browser before cloud saves existed is accepted
// once per account, within these limits.
export const IMPORT_CAPS = { gold: 5000, xp: 20000, kills: 5000, bag: 99 };

// What a shop charges for an item, or undefined if it doesn't stock it.
export const shopPrice = (shop, id) => {
  const row = SHOPS[shop] && SHOPS[shop].stock.find(([x]) => x === id);
  return row ? row[1] : undefined;
};
// Everything that can sit in the bag: drops, consumables, seeds, crops, blocks.
export const BAG_ITEMS = new Set([
  ...Object.values(MONSTER_LOOT).map((m) => m.drop),
  ...Object.keys(CONSUMABLES),
  ...Object.keys(CROPS), ...Object.keys(CROPS).map((k) => k + '_seed'),
  ...Object.keys(BLOCKS).map((k) => 'block_' + k),
]);

export function newEcon() {
  return { gold: 0, xp: 0, kills: 0, bag: {}, loot: [], pending: { gold: {}, item: {} }, rl: {}, imported: false };
}
// Fills in anything missing from a saved economy (older rows, new fields).
export function normEcon(e) {
  const n = newEcon();
  if (!e || typeof e !== 'object') return n;
  return {
    ...n, ...e,
    bag: { ...(e.bag || {}) },
    loot: Array.isArray(e.loot) ? [...e.loot] : [],
    pending: { gold: { ...((e.pending && e.pending.gold) || {}) }, item: { ...((e.pending && e.pending.item) || {}) } },
    rl: { ...(e.rl || {}) },
  };
}

export function newFarm(plot, owner, now) {
  return { id: plot, owner, claimed: now, crops: {}, builds: [], blocks: '', boost: [0, 0], members: [] };
}

const int = (v) => (Number.isInteger(v) ? v : NaN);
const add = (bag, id, n) => { bag[id] = Math.min(BAG_MAX, (bag[id] || 0) + n); if (bag[id] <= 0) delete bag[id]; };
const has = (bag, id, n) => (bag[id] || 0) >= n;

function take(econ, key, now) {
  const [burst, every] = LIMITS[key];
  const [tokens, at] = econ.rl[key] || [burst, now];
  const t = Math.min(burst, tokens + (now - at) / 1000 / every);
  if (t < 1) { econ.rl[key] = [t, now]; return false; }
  econ.rl[key] = [t - 1, now];
  return true;
}

export function cropProgress(farm, crop, now, minute = 60000) {
  const [b0, b1] = farm.boost || [0, 0];
  const extra = Math.max(0, Math.min(now, b1) - Math.max(crop.t, b0)) * (ALTAR.speed - 1);
  return Math.min(1, (now - crop.t + extra) / (CROPS[crop.k].grow * minute));
}
const buildAt = (farm, i, j) => (farm.builds || []).find((b) => {
  const s = BUILDS[b.k].size;
  return i >= b.i && i < b.i + s && j >= b.j && j < b.j + s;
});

/* Applies one action to a player's state, in place. Returns '' if it went through, or why not
   (and then nothing was changed).
     s   = { econ, owned: [gear ids], farm: farm or null }
     a   = { t: action type, ...its fields }
     ctx = { now: ms, isGear: (id) => bool, owner: character name, dev: local testing,
             minute: ms per crop/altar minute (60000, less with ?farmfast in local testing) } */
export function applyAction(s, a, ctx) {
  const e = s.econ, now = ctx.now, minute = ctx.minute || 60000;
  if (!a || typeof a !== 'object' || typeof a.t !== 'string') return 'bad action';
  const farm = s.farm, soil = farm && PLOT_SOIL[farm.id];

  switch (a.t) {
    case 'kill': {
      const m = MONSTER_LOOT[a.m];
      if (!m) return 'unknown monster';
      if (!take(e, LIMITS['kill:' + a.m] ? 'kill:' + a.m : 'kill', now)) return 'too fast';
      e.xp += m.xp; e.kills += 1;
      e.pending.gold[a.m] = Math.min(MAX_PENDING, (e.pending.gold[a.m] || 0) + 1);
      e.pending.item[m.drop] = Math.min(MAX_PENDING, (e.pending.item[m.drop] || 0) + 1);
      return '';
    }
    case 'pickup': { // a drop walked over: { kind: 'gold', m, n } or { kind: 'item', id }
      if (a.kind === 'gold') {
        const m = MONSTER_LOOT[a.m], n = int(a.n);
        if (!m || !(e.pending.gold[a.m] > 0)) return 'nothing to pick up';
        if (!(n >= m.gold[0] && n <= m.gold[1])) return 'bad amount';
        e.pending.gold[a.m] -= 1; e.gold += n;
        return '';
      }
      if (a.kind === 'item') {
        if (!(e.pending.item[a.id] > 0)) return 'nothing to pick up';
        e.pending.item[a.id] -= 1; add(e.bag, a.id, 1);
        return '';
      }
      return 'bad pickup';
    }
    case 'buy': { // { shop: sign name, id, n }
      const price = shopPrice(a.shop, a.id), n = a.n === undefined ? 1 : int(a.n);
      if (price === undefined) return 'not for sale';
      if (ctx.isGear(a.id)) {
        if (n !== 1) return 'bad amount';
        if (s.owned.includes(a.id)) return 'already owned';
        if (e.gold < price) return 'not enough gold';
        e.gold -= price; s.owned.push(a.id);
        return '';
      }
      if (!(n >= 1 && n <= 99)) return 'bad amount';
      if (e.gold < price * n) return 'not enough gold';
      e.gold -= price * n; add(e.bag, a.id, n);
      return '';
    }
    case 'sell': {
      const n = int(a.n);
      if (!(a.id in SELL)) return 'not wanted';
      if (!(n >= 1) || !has(e.bag, a.id, n)) return 'not enough';
      add(e.bag, a.id, -n); e.gold += SELL[a.id] * n;
      return '';
    }
    case 'craft': {
      const r = RECIPES.find((x) => x.id === a.id);
      if (!r) return 'no recipe';
      const gear = ctx.isGear(r.id);
      if (gear && s.owned.includes(r.id)) return 'already owned';
      if (e.gold < (r.gold || 0) || !Object.entries(r.needs).every(([k, n]) => has(e.bag, k, n))) return 'missing ingredients';
      for (const [k, n] of Object.entries(r.needs)) add(e.bag, k, -n);
      e.gold -= r.gold || 0;
      if (gear) s.owned.push(r.id); else add(e.bag, r.id, r.qty || 1);
      return '';
    }
    case 'use': { // drink a potion, eat an apple, throw a smoke bomb
      if (!CONSUMABLES[a.id] || !has(e.bag, a.id, 1)) return 'none left';
      add(e.bag, a.id, -1);
      return '';
    }
    case 'chest': {
      const g = SEA_TREASURE[a.id];
      if (!g) return 'no treasure there';
      if (e.loot.includes(a.id)) return 'already looted';
      e.loot.push(a.id); e.gold += g;
      return '';
    }
    case 'barrel': {
      if (!take(e, 'barrel', now)) return 'too fast';
      e.gold += BARREL_GOLD;
      return '';
    }

    /* ---- the farm ---- */
    case 'claim': {
      if (farm) return 'you already have a plot';
      if (!PLOT_SOIL[a.plot]) return 'no such plot';
      s.farm = newFarm(a.plot, String(ctx.owner || '').slice(0, 16) || 'Wanderer', now);
      return ''; // the database refuses it if someone else holds the plot
    }
    case 'plant': {
      if (!farm) return 'no plot';
      const i = int(a.i), j = int(a.j), key = `${i},${j}`;
      if (!CROPS[a.k] || !(i >= 0 && j >= 0 && i < soil[0] && j < soil[1])) return 'bad spot';
      if (farm.crops[key] || buildAt(farm, i, j) || unpack(farm.blocks, soil[0], soil[1]).get(i, j, 0)) return 'spot taken';
      if (!has(e.bag, a.k + '_seed', 1)) return 'no seeds';
      add(e.bag, a.k + '_seed', -1);
      farm.crops[key] = { k: a.k, t: now };
      return '';
    }
    case 'harvest': {
      if (!farm) return 'no plot';
      const key = `${int(a.i)},${int(a.j)}`, c = farm.crops[key];
      if (!c) return 'nothing growing';
      if (cropProgress(farm, c, now + HARVEST_SLACK_MS, minute) < 1) return 'not ripe';
      add(e.bag, c.k, CROPS[c.k].yield);
      delete farm.crops[key];
      return '';
    }
    case 'offer': {
      if (!farm) return 'no plot';
      if (!(farm.builds || []).some((b) => b.k === 'altar')) return 'no altar';
      if (farm.boost && now < farm.boost[1]) return 'already boosted';
      if (!has(e.bag, ALTAR.offering, 1)) return 'nothing to offer';
      add(e.bag, ALTAR.offering, -1);
      farm.boost = [now, now + ALTAR.minutes * minute];
      return '';
    }
    case 'build': {
      if (!farm) return 'no plot';
      const b = BUILDS[a.k], i = int(a.i), j = int(a.j), r = int(a.r ?? 0);
      if (!b || !(r >= 0 && r < 4)) return 'bad build';
      if (!(i >= 0 && j >= 0 && i + b.size <= soil[0] && j + b.size <= soil[1])) return 'outside your soil';
      const vox = unpack(farm.blocks, soil[0], soil[1]);
      for (let y = j; y < j + b.size; y++) for (let x = i; x < i + b.size; x++) {
        if (vox.get(x, y, 0) || farm.crops[`${x},${y}`] || buildAt(farm, x, y)) return 'something is in the way';
      }
      if (farm.builds.filter((q) => q.k === a.k).length >= b.max) return 'at the max';
      if (e.gold < b.cost) return 'not enough gold';
      e.gold -= b.cost;
      farm.builds.push({ k: a.k, i, j, r });
      return '';
    }
    case 'unbuild': {
      if (!farm) return 'no plot';
      const hit = buildAt(farm, int(a.i), int(a.j));
      if (!hit) return 'nothing there';
      farm.builds.splice(farm.builds.indexOf(hit), 1);
      e.gold += BUILDS[hit.k].cost;
      return '';
    }
    case 'place': {
      if (!farm) return 'no plot';
      const i = int(a.i), j = int(a.j), k = int(a.k), r = int(a.r ?? 0);
      if (!BLOCKS[a.b] || !(r >= 0 && r < 4)) return 'bad block';
      if (!has(e.bag, 'block_' + a.b, 1)) return 'no blocks';
      const vox = unpack(farm.blocks, soil[0], soil[1]);
      const ctxB = { crops: new Set(Object.keys(farm.crops)), builds: farm.builds.map((q) => ({ i: q.i, j: q.j, size: BUILDS[q.k].size })), players: [] };
      const why = canPlace(vox, i, j, k, a.b, ctxB);
      if (why) return why;
      vox.set(i, j, k, a.b, r);
      add(e.bag, 'block_' + a.b, -1);
      farm.blocks = pack(vox);
      return '';
    }
    case 'break': {
      if (!farm) return 'no plot';
      const i = int(a.i), j = int(a.j), k = int(a.k);
      const vox = unpack(farm.blocks, soil[0], soil[1]), c = vox.get(i, j, k);
      if (!c) return 'no block there';
      vox.del(i, j, k);
      add(e.bag, 'block_' + c.t, 1);
      farm.blocks = pack(vox);
      return '';
    }
    case 'invite': case 'kick': {
      if (!farm) return 'no plot';
      const who = String(a.who || '').trim().slice(0, 16);
      if (!who) return 'who?';
      farm.members = (farm.members || []).filter((m) => m !== who);
      if (a.t === 'invite') {
        if (farm.members.length >= MAX_MEMBERS) return 'clubhouse is full';
        farm.members.push(who);
      }
      return '';
    }

    /* ---- one-time upload of pre-cloud-save progress ---- */
    case 'import': {
      if (e.imported) return 'already imported';
      const f = a.field && typeof a.field === 'object' ? a.field : {};
      const cap = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0; };
      e.gold += cap(f.gold, IMPORT_CAPS.gold);
      e.xp += cap(f.xp, IMPORT_CAPS.xp);
      e.kills += cap(f.kills, IMPORT_CAPS.kills);
      if (f.bag && typeof f.bag === 'object') {
        for (const [id, n] of Object.entries(f.bag)) if (BAG_ITEMS.has(id)) add(e.bag, id, cap(n, IMPORT_CAPS.bag));
      }
      if (Array.isArray(a.owned)) for (const id of a.owned) if (ctx.isGear(id) && !s.owned.includes(id)) s.owned.push(id);
      if (Array.isArray(a.loot)) for (const id of a.loot) if (SEA_TREASURE[id] && !e.loot.includes(id)) e.loot.push(id);
      e.imported = true;
      return '';
    }
  }
  return 'unknown action';
}

// What the browser gets to see of the economy (not the rate limits or pending drops).
export const publicEcon = (e) => ({ gold: e.gold, xp: e.xp, kills: e.kills, bag: e.bag, loot: e.loot, imported: e.imported });
