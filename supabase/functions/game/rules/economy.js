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
import { GUILD_ITEMS, newGuild, normGuild, guildAction, heroById, heroBusy, allyKit, petOf, ALLY, ALLY_CD_SLACK } from './guild.js';

// Each monster's HP and walking speed (tiles a second), and what it pays out: XP on the kill,
// then a gold drop and an item drop to pick up. (Damage and the rest of how it fights are in
// /game/world3d MONSTERS.)
export const MONSTER_LOOT = {
  slime:     { hp: 30,  speed: 1.5,  xp: 5,  gold: [1, 2],   drop: 'slime_gel' },
  shroom:    { hp: 45,  speed: 1.1,  xp: 8,  gold: [1, 3],   drop: 'spore_cap' },
  bat:       { hp: 24,  speed: 2.75, xp: 7,  gold: [1, 2],   drop: 'bat_fang' },
  goblin:    { hp: 60,  speed: 2,    xp: 15, gold: [3, 5],   drop: 'goblin_ear' },
  king:      { hp: 200, speed: 1,    xp: 60, gold: [15, 25], drop: 'royal_jelly' },
  gladiator: { hp: 150, speed: 2.1,  xp: 45, gold: [10, 18], drop: 'laurel' },
  // the two giants of the Mine's deepest floor (B2, The Hollow). The queen lunges (12 tiles a
  // second for 0.45 s): `dash` is how far that carries her past her walking speed.
  golem_crystal: { hp: 1000, speed: 0.9, xp: 400, gold: [120, 160], drop: 'golem_core' },
  spider_queen:  { hp: 800,  speed: 2.0, dash: 5.4, xp: 350, gold: [100, 140], drop: 'queen_silk' },
};
// ---- Gear (Diablo-style) drops ------------------------------------------------
// Each monster has a chance to drop a randomly-rolled gear piece when killed.
// chance: probability per kill. ilvl: [min, max] item level (1–10).
export const GEAR_DROPS = {
  slime:        { chance: 0.05, ilvl: [1, 2] },
  shroom:       { chance: 0.06, ilvl: [1, 2] },
  bat:          { chance: 0.05, ilvl: [1, 2] },
  goblin:       { chance: 0.14, ilvl: [3, 5] },
  king:         { chance: 0.80, ilvl: [5, 7] },
  gladiator:    { chance: 0.70, ilvl: [4, 7] },
  golem_crystal:{ chance: 1.00, ilvl: [8, 10] },
  spider_queen: { chance: 1.00, ilvl: [8, 10] },
};
// All catalog items grouped by slot → [common[], uncommon[], rare[], legendary[]].
const GEAR_BY_SLOT = {
  head:  [['iron_helm','wizard_hat','ranger_hood','rogue_hood'],['chain_coif','pirate_tricorn'],['gold_crown','horned_helm'],['dragon_crown']],
  eyes:  [['round_specs','eyepatch'],['shadow_visor','sun_goggles'],['mystic_monocle'],['dragons_gaze']],
  body:  [['steel_armor','mage_robe','ranger_tunic','rogue_tunic'],['leather_vest','chainmail'],['pirate_coat'],['phoenix_plate']],
  rhand: [['iron_sword','oak_staff','hunter_bow','shadow_dagger','apprentice_wand'],['composite_bow','cutlass','boomerang','fire_wand','ice_wand'],['ember_blade','trident','thunder_staff'],['void_blade','inferno_staff']],
  lhand: [['wooden_shield','iron_buckler','tome_of_sparks','lantern'],['tower_shield','ships_compass'],['crystal_orb','captains_hook','mirror_shield'],['aegis']],
  feet:  [['leather_boots','sea_boots'],['swift_sandals','iron_greaves'],['winged_boots','shadow_treads','hermes_sandals','windrunner_boots'],['dragons_stride']],
};
const GEAR_SLOTS = Object.keys(GEAR_BY_SLOT);
// Max bonus per stat (at ilvl 10, legendary). Scales down with ilvl and rarity.
const BONUS_MAX = { hp: 20, atk: 8, def: 6, mag: 8, spd: 4 };
// Rarity weights [common, uncommon, rare, legendary] for ilvl 1–10.
const RAR_W = [
  [0.90,0.09,0.01,0.00],[0.80,0.16,0.04,0.00],[0.65,0.25,0.09,0.01],[0.50,0.33,0.14,0.03],
  [0.35,0.38,0.20,0.07],[0.22,0.38,0.28,0.12],[0.12,0.35,0.35,0.18],[0.05,0.28,0.42,0.25],
  [0.02,0.18,0.45,0.35],[0.00,0.10,0.45,0.45],
];
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
// Roll a gear instance deterministically from a uid and ilvl.
// Called on the client when a drop lands; re-called on the server on pickup — same uid → same item.
export function rollGearDrop(uid, ilvl) {
  const r = rng(hashStr(uid));
  const li = Math.max(0, Math.min(9, (ilvl | 0) - 1));
  const w = RAR_W[li], rv = r();
  const ri = rv < w[3] ? 3 : rv < w[3]+w[2] ? 2 : rv < w[3]+w[2]+w[1] ? 1 : 0;
  const rarity = ['common','uncommon','rare','legendary'][ri];
  const slot = GEAR_SLOTS[Math.floor(r() * GEAR_SLOTS.length)];
  const pool = GEAR_BY_SLOT[slot][ri] || GEAR_BY_SLOT[slot][0];
  const base = pool[Math.floor(r() * pool.length)];
  const nBonus = ri + 1; // 1 for common, up to 4 for legendary
  const mult = [1, 1.5, 2.5, 4][ri];
  const stats = ['hp','atk','def','mag','spd'];
  for (let i = stats.length-1; i > 0; i--) { const j = Math.floor(r()*(i+1)); [stats[i],stats[j]]=[stats[j],stats[i]]; }
  const bonus = {};
  for (let i = 0; i < nBonus; i++) {
    bonus[stats[i]] = Math.max(1, Math.round(r() * BONUS_MAX[stats[i]] * mult * (0.5 + (li+1)*0.08)));
  }
  return { uid, base, rarity, bonus, ilvl };
}
// -------------------------------------------------------------------------------


/* ---- combat ----
   The server can't see the fight, but it checks every hit: the monster must exist (the game
   registers each one as it spawns) and still have HP, the attack must match a weapon the
   player really has in that hand, attacks can't come faster than the weapon's cooldown, and
   a hit can't do more damage than the player's real stats allow. Only the server's own HP
   count makes a kill. So nobody can out-damage a perfect player with the same gear. */
// Wands, staffs and the boomerang shoot instead of swinging (same numbers as /game/lib/hero3d.js).
export const CASTERS = {
  oak_staff:       { cd: 0.55, range: 14 },
  apprentice_wand: { cd: 0.4,  range: 12 },
  fire_wand:       { cd: 0.45, range: 14 },
  inferno_staff:   { cd: 0.6,  range: 16, aoe: 1.8 },
  ice_wand:        { cd: 0.5,  range: 15 },
  thunder_staff:   { cd: 0.8,  range: 16, chain: 2 },
  boomerang:       { cd: 1.1,  range: 9, boomerang: true },
};
/* Where things are. Each hit says where the player and the monster stood (tiles, on the map's
   grid). The player can't have moved faster than a sprint since their last hit, the monster
   faster than it walks, and the monster must be within reach of the weapon. Fainting sends
   you back to the map's start: that's a 'warp', allowed a couple of times a minute. */
export const PLAYER_SPEED = 7.4;  // sprinting, tiles a second
export const KNOCKBACK = 1.6;     // how far a hit can shove someone
export const MOVE_SLACK = 1.25;   // frame timing, lag, monsters synced from another player
export const JITTER = 1.5;        // tiles of slack on every distance
export const SWING_REACH = 4;     // a swing reaches about 1.1 tiles past the body, big monsters are wider, and other players' monsters lag a little
export const MIRROR_RANGE = 16;
export const SHOT_EXTRA = 8;      // you keep moving while a shot is in the air
export const CHAIN_HOP = 4.5;     // a thunder bolt's jump
export function reachOf(kind, item) {
  const c = CASTERS[item] || {};
  if (kind === 'swing') return SWING_REACH;
  if (kind === 'mirror') return MIRROR_RANGE + SHOT_EXTRA;
  if (kind === 'aoe') return (c.range || 0) + (c.aoe || 0) + SHOT_EXTRA;
  if (kind === 'chain') return (c.range || 0) + CHAIN_HOP * 2 + SHOT_EXTRA;
  return (c.range || 0) + SHOT_EXTRA; // shot, boom
}
// Could something at `from` ([x, z, ms]) be at (x, z) at `ms`, moving at most `speed`?
function couldReach(from, x, z, ms, speed, dash = 0) {
  if (!from) return true;
  const secs = Math.abs(ms - from[2]) / 1000;
  return Math.hypot(x - from[0], z - from[1]) <= secs * speed * MOVE_SLACK + JITTER + KNOCKBACK + dash;
}
export const SWING_CD = 0.36;   // seconds between swings of one hand
export const MIRROR_CD = 0.5;   // a mirror shield's reflected shot
export const HIT_RAND = 4;      // a hit does its power plus up to this much
export const ARENA_BUFF = 1.7;  // the biggest arena buff (Focus); only gladiators fight there
export const CD_SLACK = 0.85;   // frame timing: an attack may come this fraction of a cooldown early
export const CLOCK_SLACK_MS = 3000;
export const MAX_FOES = 40;
/* Group kills, the way modern open-world MMOs tag monsters: everyone who did real damage to a
   monster gets the full kill (XP and their own drops) when it goes down, whoever finished it.
   The server can't see other players' hits, so it takes the player's word that the monster died,
   but only for one they've hit for at least this share of its HP, and the kill-rate limits
   below still apply: helping out can never pay faster than killing alone. */
export const ASSIST_SHARE = 0.1;
// Most targets one attack of each kind can hit.
export const MAX_TARGETS = { swing: 3, shot: 1, aoe: 8, chain: 2, boom: 6, mirror: 1 };
// How hard each kind of hit is, from the player's attack and magic (the game's own formulas).
export const POWER = {
  swing: (s) => s.atk,
  shot: (s) => s.atk * 0.6 + s.mag * 1.4,
  mirror: (s) => s.atk * 0.6 + s.mag * 1.4,
  aoe: (s) => s.atk * 0.5 + s.mag * 0.8,
  chain: (s) => (s.atk * 0.6 + s.mag * 1.4) * 0.6,
  boom: (s) => s.atk * 1.1 + 4,
};
export const maxHit = (kind, stats, foe) => Math.round(POWER[kind](stats) * (foe === 'gladiator' ? ARENA_BUFF : 1) + HIT_RAND);

// Sea chests (one per island, once per player) and floating barrels.
export const SEA_TREASURE = { wreck: 40, lonely: 25, gull: 25, doubloon: 30 };
export const BARREL_GOLD = 3;

/* ---- the sea, as the server sees it ----
   Islands (centre and radius; /game/sea3d/world.js builds them from these) and where every
   floating barrel bobs. A barrel's spot comes from its slot and how many times it has been
   taken, the same way in the browser and on the server, so a claim can be checked: the slot
   must have floated back since it was last taken, and the boat must have had time to sail
   there from the last barrel at full sail. */
export const SEA_R = 420; // the sea ends here
export const SEA_ISLES = {
  harbor: [0, -40, 24], fort: [170, -150, 28], skull: [-180, -120, 18], arch: [-90, 110, 12],
  wreck: [120, 130, 14], village: [-250, 60, 26], lonely: [55, 45, 8], gull: [-70, -210, 9],
  verde: [270, 70, 32], doubloon: [230, -290, 8], beacon: [40, -240, 12],
};
export const BARREL_SLOTS = 26;
export const BARREL_RESPAWN_MS = 25000;
export const BARREL_REACH = 3;      // the boat picks up a barrel this close
export const BOAT_MAX_SPEED = 19.6; // full sail (14) with a gust (x1.4); the joystick tops out at 14
export const SAIL_SLACK = 1.15;     // waves, frame timing and latency
// A small seeded generator, so both sides roll the same numbers.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Where barrel `slot` floats after being taken `gen` times: open water, clear of every island.
export function barrelSpot(slot, gen) {
  const r = rng(Math.imul(slot + 1, 0x9e3779b1) ^ Math.imul(gen + 1, 0x85ebca77));
  for (let i = 0; i < 300; i++) {
    const a = r() * Math.PI * 2, d = 30 + r() * (SEA_R - 60), x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (!Object.values(SEA_ISLES).some(([ix, iz, ir]) => Math.hypot(x - ix, z - iz) < ir + 16)) return [x, z];
  }
  return [0, 60];
}

// Soil size (tiles) of each player plot in the Avenues, by plot id.
export const PLOT_SOIL = { 1: [24, 24], 2: [8, 8], 3: [8, 8] };

/* How fast rewards can come in, as token buckets: [burst, seconds per refill]. Monsters
   respawn 12-18 s after a kill (King Slime 45 s, the Gladiator 25 s, the giants 120 s) and no area has more
   than five of one kind, so a real player can't beat these; a script can't go faster. */
export const LIMITS = {
  kill: [8, 2.4],
  'kill:king': [2, 40],
  'kill:gladiator': [2, 22],
  'kill:golem_crystal': [2, 110], // the giants come back after 120 s
  'kill:spider_queen': [2, 110],
  warp: [2, 20],
  barrel: [4, 8],
  zone: [4, 30], // moving between zones (below): a visit to the Hollow is two moves
};

/* Zones: which monsters can be met where. A player is in one zone at a time (the last 'area'
   said which), and the server only lets monsters of that zone spawn, so a script can't farm the
   giants, the gladiators and the wilds at once, or summon a giant in a field. (The browser still
   says which zone it's in: server-run zones are the real fix.) */
export const ZONES = {
  wild: ['slime', 'shroom', 'bat', 'goblin', 'king'],
  arena: ['gladiator'],
  hollow: ['golem_crystal', 'spider_queen'],
};
// The zone for a map with these monster types.
export const zoneOf = (types) => Object.keys(ZONES).find((z) => z !== 'wild' && types.some((t) => ZONES[z].includes(t))) || 'wild';
export const MAX_PENDING = 30;   // uncollected drops kept per kind
export const BAG_MAX = 99999;
export const MAX_MEMBERS = 20;
/* The two taps on farm and loot income. Shops buying from players is where new gold comes from
   (crops, drops, ores), so each account can sell shops at most SELL_DAY_GOLD a day; past that,
   Old Fenn's pools (pools.js) trade with other players, which makes no new gold. And a plot holds
   at most MAX_CROPS crops at once, so the big plot farms like a small one and keeps its room for
   building. (Without these, a full 24x24 plot of carrots made about 27,000 gold an hour.) */
export const SELL_DAY_GOLD = 1500;
export const MAX_CROPS = 96;
export const HARVEST_SLACK_MS = 5000; // client and server clocks / latency

/* A first upload of progress saved in the browser before cloud saves existed is accepted
   once per account, within these limits. Gold, bag items and gear all come out of one budget
   (`value`, in gold): gear at its shop price, bag items at what they sell for (or cost), then
   gold with whatever is left. Gear no shop sells can't be imported, and neither can anything
   that would go over the budget, so the most any account can get from an import is the same
   as earning 5000 gold. */
export const IMPORT_CAPS = { value: 5000, xp: 20000, kills: 5000, bag: 99 };
// What an item is worth in gold: its lowest shop price, else what a shop pays for it.
export const valueOf = (id) => {
  let best;
  for (const s of Object.values(SHOPS)) for (const [x, p] of s.stock) if (x === id && (best === undefined || p < best)) best = p;
  return best !== undefined ? best : SELL[id];
};

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
  ...Object.keys(GUILD_ITEMS),
]);

export function newEcon() {
  return { gold: 0, xp: 0, kills: 0, bag: {}, loot: [], gearInv: [], pending: { gold: {}, item: {} }, rl: {}, imported: false, foes: {}, hands: {}, clock: null,
    sea: { gen: {}, back: {}, last: null }, guild: newGuild() };
}
// Fills in anything missing from a saved economy (older rows, new fields).
export function normEcon(e) {
  const n = newEcon();
  if (!e || typeof e !== 'object') return n;
  return {
    ...n, ...e,
    bag: { ...(e.bag || {}) },
    loot: Array.isArray(e.loot) ? [...e.loot] : [],
    gearInv: Array.isArray(e.gearInv) ? e.gearInv.filter((g) => g && typeof g.uid === 'string').slice(0, 60) : [],
    pending: { gold: { ...((e.pending && e.pending.gold) || {}) }, item: { ...((e.pending && e.pending.item) || {}) } },
    rl: { ...(e.rl || {}) },
    foes: { ...(e.foes || {}) },
    hands: { ...(e.hands || {}) },
    sea: { gen: { ...((e.sea && e.sea.gen) || {}) }, back: { ...((e.sea && e.sea.back) || {}) }, last: (e.sea && e.sea.last) || null },
    pos: Array.isArray(e.pos) ? [...e.pos] : null,
    guild: normGuild(e.guild),
    lp: Object.fromEntries(Object.entries((e.lp && typeof e.lp === 'object' && e.lp) || {}).filter(([, n]) => Number.isSafeInteger(n) && n > 0)), // pool shares (pools.js)
    bound: Number.isSafeInteger(e.bound) && e.bound > 0 ? e.bound : 0,
    boundGear: Array.isArray(e.boundGear) ? e.boundGear.filter((id) => typeof id === 'string') : [],
  };
}

/* Bound value: what the one-time import handed out (see 'import') can be used in the game but
   never leaves the account, so fresh accounts can't be farmed for it. `bound` gold is spent
   first (applyAction lowers it whenever gold goes down); only gold above it can be traded,
   withdrawn or swapped in a pool. `boundGear` lists imported gear that can't be withdrawn. */
export const freeGold = (e) => Math.max(0, (e.gold || 0) - (e.bound || 0));
export const NON_IMPORTABLE = new Set([ // anything that can leave the game (chain.js RESOURCES) or be pooled
  ...Object.values(MONSTER_LOOT).map((m) => m.drop), ...Object.keys(CROPS), ...Object.keys(GUILD_ITEMS),
]);

// The client's game clock may not run ahead of the server's (no speeding up the game).
// Combat and barrels share it. Returns false if `at` is ahead.
// The baseline pairs the time the browser sent a request (`sent`, its clock) with when the server
// got it, so it holds only network delay, never time an action waited in the queue (a slow
// machine or a lost connection). Actions from before the baseline are fine; an action can't be
// stamped further ahead of it than the server's clock has moved.
function clockOk(e, at, now, sent) {
  if (!e.clock || now - e.clock[1] > 120000) e.clock = [Number.isFinite(sent) ? sent : at, now];
  return at - e.clock[0] <= now - e.clock[1] + CLOCK_SLACK_MS;
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

// Pays out a kill (XP now, drops once picked up), within the respawn-rate limits.
function credit(e, type, now, rand = Math.random) {
  const m = MONSTER_LOOT[type];
  if (!take(e, LIMITS['kill:' + type] ? 'kill:' + type : 'kill', now)) return 'too fast';
  e.xp += m.xp; e.kills += 1;
  e.pending.gold[type] = Math.min(MAX_PENDING, (e.pending.gold[type] || 0) + 1);
  e.pending.item[m.drop] = Math.min(MAX_PENDING, (e.pending.item[m.drop] || 0) + 1);
  const gd = GEAR_DROPS[type];
  if (gd && rand() < gd.chance) {
    if (!e.pending.gear) e.pending.gear = {};
    e.pending.gear[type] = Math.min(5, (e.pending.gear[type] || 0) + 1);
  }
  return '';
}

// What attack kinds a hand allows, given the item in it (and the other hand, for the mirror).
function handAllows(kind, item, other) {
  const c = CASTERS[item];
  if (kind === 'mirror') return item === 'mirror_shield' || other === 'mirror_shield';
  if (kind === 'swing') return !c && item !== 'mirror_shield';
  if (kind === 'shot') return !!c && !c.boomerang;
  if (kind === 'aoe') return !!(c && c.aoe);
  if (kind === 'chain') return !!(c && c.chain);
  if (kind === 'boom') return !!(c && c.boomerang);
  return false;
}
const cooldownOf = (kind, item) => (kind === 'swing' ? SWING_CD : kind === 'mirror' ? MIRROR_CD : CASTERS[item].cd);

export function cropProgress(farm, crop, now, minute = 60000) {
  const [b0, b1] = farm.boost || [0, 0];
  const extra = Math.max(0, Math.min(now, b1) - Math.max(crop.t, b0)) * (ALTAR.speed - 1);
  return Math.min(1, (now - crop.t + extra) / (CROPS[crop.k].grow * minute));
}
const buildAt = (farm, i, j) => (farm.builds || []).find((b) => {
  const s = BUILDS[b.k].size;
  return i >= b.i && i < b.i + s && j >= b.j && j < b.j + s;
});

/* A farm from before farms were kept on the server, rebuilt under the plot rules and paid for out
   of the import budget: buildings at their price, then crops at a seed each, then blocks at
   their price. Anything that breaks a rule or doesn't fit the budget is left out. Returns
   what's left of the budget. */
function importFarm(s, f, budget, ctx) {
  const soil = PLOT_SOIL[f.id], now = ctx.now;
  const farm = newFarm(f.id, String(ctx.owner || '').slice(0, 16) || 'Wanderer', now);
  const inSoil = (i, j, n = 1) => i >= 0 && j >= 0 && i + n <= soil[0] && j + n <= soil[1];
  for (const b of (Array.isArray(f.builds) ? f.builds : []).slice(0, 20)) {
    const B = b && BUILDS[b.k], i = int(b && b.i), j = int(b && b.j), r = int((b && b.r) ?? 0);
    if (!B || !(r >= 0 && r < 4) || !inSoil(i, j, B.size) || B.cost > budget) continue;
    if (farm.builds.filter((q) => q.k === b.k).length >= B.max) continue;
    let clear = true;
    for (let y = j; y < j + B.size; y++) for (let x = i; x < i + B.size; x++) if (buildAt(farm, x, y)) clear = false;
    if (!clear) continue;
    budget -= B.cost; farm.builds.push({ k: b.k, i, j, r });
  }
  for (const [key, c] of Object.entries(f.crops && typeof f.crops === 'object' ? f.crops : {}).slice(0, MAX_CROPS)) {
    const m = /^(\d+),(\d+)$/.exec(key), seed = c && CROPS[c.k] ? valueOf(c.k + '_seed') : undefined;
    if (!m || seed === undefined || seed > budget) continue;
    const i = +m[1], j = +m[2];
    if (!inSoil(i, j) || buildAt(farm, i, j)) continue;
    const t = Number(c.t);
    budget -= seed;
    // planted now: an old planting time would make every crop ripe at once, and crops can be withdrawn
    farm.crops[`${i},${j}`] = { k: c.k, t: now };
  }
  const old = unpack(typeof f.blocks === 'string' ? f.blocks.slice(0, 40000) : '', soil[0], soil[1]), vox = unpack('', soil[0], soil[1]);
  old.forEach((i, j, k, t, r) => {
    const cost = BLOCKS[t].price;
    if (cost > budget || (k === 0 && (farm.crops[`${i},${j}`] || buildAt(farm, i, j)))) return;
    if (canPlace(vox, i, j, k, t, { crops: new Set(), builds: [], players: [] })) return;
    vox.set(i, j, k, t, r); budget -= cost;
  });
  farm.blocks = pack(vox);
  farm.members = [...new Set((Array.isArray(f.members) ? f.members : []).filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim().slice(0, 16)))].slice(0, MAX_MEMBERS);
  s.farm = farm;
  return budget;
}

/* Applies one action to a player's state, in place. Returns '' if it went through, or why not
   (and then nothing was changed).
     s   = { econ, owned: [gear ids], farm: farm or null }
     a   = { t: action type, ...its fields }
     ctx = { now: ms, isGear: (id) => bool, owner: character name, dev: local testing,
             minute: ms per crop/altar minute (60000, less with ?farmfast in local testing) } */
export function applyAction(s, a, ctx) {
  const before = s.econ.gold;
  const why = applyOne(s, a, ctx);
  const spent = before - s.econ.gold; // bound gold is spent first (freeGold)
  if (spent > 0 && s.econ.bound) s.econ.bound = Math.max(0, s.econ.bound - spent);
  return why;
}
function applyOne(s, a, ctx) {
  const e = s.econ, now = ctx.now, minute = ctx.minute || 60000;
  if (!a || typeof a !== 'object' || typeof a.t !== 'string') return 'bad action';
  const farm = s.farm, soil = farm && PLOT_SOIL[farm.id];

  switch (a.t) {
    case 'area': { // { z: zone }: a new map loaded: the monsters of the last one are gone, and you're somewhere new
      e.foes = {}; e.hands = {}; e.pos = null;
      const z = a.z === undefined ? 'wild' : a.z;
      if (!Object.prototype.hasOwnProperty.call(ZONES, z)) return 'bad area';
      if (z !== (e.zone || 'wild') && !take(e, 'zone', now)) return 'too fast';
      e.zone = z;
      return '';
    }
    case 'warp': { // { x, z, at }: fainted and woke at the map's start
      const x = Number(a.x), z = Number(a.z), at = Number(a.at);
      if (![x, z, at].every(Number.isFinite)) return 'bad warp';
      if (!take(e, 'warp', now)) return 'too fast';
      e.pos = [x, z, at];
      return '';
    }
    case 'spawn': { // { id, m }: a monster appeared, with full HP
      const m = MONSTER_LOOT[a.m];
      if (!m) return 'unknown monster';
      if (!ZONES[e.zone || 'wild'].includes(a.m)) return 'wrong area';
      if (typeof a.id !== 'string' || !/^[a-z0-9]{4,16}$/.test(a.id) || e.foes[a.id]) return 'bad id';
      const ids = Object.keys(e.foes);
      if (ids.length >= MAX_FOES) delete e.foes[ids[0]]; // the oldest
      e.foes[a.id] = { m: a.m, hp: m.hp, dealt: 0 };
      return '';
    }
    case 'hit': { // { id, k: kind, hand: 'R' | 'L', a: attack id, at: client ms, dmg }
      const foe = e.foes[a.id];
      if (!foe) return 'no such monster';
      if (!POWER[a.k] || (a.hand !== 'R' && a.hand !== 'L')) return 'bad hit';
      const hands = ctx.hands || {}, item = hands[a.hand] || null, other = hands[a.hand === 'R' ? 'L' : 'R'] || null;
      if (!handAllows(a.k, item, other)) return 'wrong weapon';
      const at = Number(a.at), att = typeof a.a === 'string' ? a.a.slice(0, 16) : '';
      if (!Number.isFinite(at) || !att) return 'bad hit';
      if (!clockOk(e, at, now, ctx.sent)) return 'too fast';
      // where everyone stood: { px, pz } the player, { mx, mz } the monster, at `pt` (client ms)
      const px = Number(a.px), pz = Number(a.pz), mx = Number(a.mx), mz = Number(a.mz), pt = a.pt === undefined ? at : Number(a.pt);
      if (![px, pz, mx, mz, pt].every(Number.isFinite)) return 'bad hit';
      if (!ctx.dev) { // local testing teleports around freely
        if (!clockOk(e, pt, now, ctx.sent)) return 'too fast';
        if (!couldReach(e.pos, px, pz, pt, PLAYER_SPEED)) return 'moved too fast';
        if (!couldReach(foe.pos, mx, mz, pt, MONSTER_LOOT[foe.m].speed, MONSTER_LOOT[foe.m].dash)) return 'monster moved too fast';
        if (Math.hypot(mx - px, mz - pz) > reachOf(a.k, item)) return 'out of reach';
      }
      if (!e.pos || pt >= e.pos[2]) e.pos = [px, pz, pt];
      if (!foe.pos || pt >= foe.pos[2]) foe.pos = [mx, mz, pt];
      // one attack per cooldown per hand, and only so many targets per attack
      const h = e.hands[a.hand] || { a: '', at: -Infinity, n: {} };
      if (h.a !== att) {
        if (at - h.at < cooldownOf(a.k, item) * 1000 * CD_SLACK) return 'too fast';
        e.hands[a.hand] = { a: att, at, n: {} };
      }
      const cur = e.hands[a.hand];
      const limit = a.k === 'chain' ? (CASTERS[item] && CASTERS[item].chain) || 0 : MAX_TARGETS[a.k];
      if ((cur.n[a.k] || 0) >= limit) return 'too many targets';
      cur.n[a.k] = (cur.n[a.k] || 0) + 1;
      const dmg = Math.min(Math.max(1, Math.floor(Number(a.dmg)) || 1), maxHit(a.k, ctx.stats || { atk: 10, mag: 2 }, foe.m));
      foe.hp -= dmg;
      foe.dealt = (foe.dealt || 0) + dmg;
      if (foe.hp > 0) return '';
      delete e.foes[a.id];
      return credit(e, foe.m, now, ctx.rand);
    }
    case 'ahit': { // { id, hero, at, dmg, mx, mz }: your companion's hit (guild.js ALLY)
      const foe = e.foes[a.id], g = e.guild;
      if (!foe) return 'no such monster';
      const h = g.follow && heroById(g, g.follow);
      if (!h || h.id !== a.hero || heroBusy(g, h.id)) return 'no companion';
      const at = Number(a.at), mx = Number(a.mx), mz = Number(a.mz);
      if (![at, mx, mz].every(Number.isFinite)) return 'bad hit';
      if (!clockOk(e, at, now, ctx.sent)) return 'too fast';
      const kit = allyKit(h, petOf(g, h));
      if (!ctx.dev) {
        if (!couldReach(foe.pos, mx, mz, at, MONSTER_LOOT[foe.m].speed, MONSTER_LOOT[foe.m].dash)) return 'monster moved too fast';
        if (!couldReach(e.pos, mx, mz, at, PLAYER_SPEED, ALLY.leash + kit.range)) return 'out of reach'; // it fights near you
      }
      if (!foe.pos || at >= foe.pos[2]) foe.pos = [mx, mz, at];
      const last = e.hands.A || -Infinity;
      if (at - last < kit.cd * 1000 * ALLY_CD_SLACK) return 'too fast';
      e.hands.A = at;
      const dmg = Math.min(Math.max(1, Math.floor(Number(a.dmg)) || 1), kit.dmg);
      foe.hp -= dmg;
      foe.dealt = (foe.dealt || 0) + dmg;
      if (foe.hp > 0) return '';
      delete e.foes[a.id];
      h.xp += MONSTER_LOOT[foe.m].xp; // the companion learns from its kills too
      return credit(e, foe.m, now, ctx.rand);
    }
    case 'down': { // { id }: a monster this player helped fight was finished off by someone else
      const foe = e.foes[a.id];
      if (!foe) return 'no such monster';
      if ((foe.dealt || 0) < Math.ceil(MONSTER_LOOT[foe.m].hp * ASSIST_SHARE)) return 'not enough damage';
      delete e.foes[a.id];
      return credit(e, foe.m, now, ctx.rand);
    }
    case 'kill': { // only local testing reports kills directly; the live game kills through hits
      if (!ctx.dev) return 'kills come from hits';
      if (!MONSTER_LOOT[a.m]) return 'unknown monster';
      return credit(e, a.m, now, ctx.rand);
    }
    case 'pickup': { // a drop walked over: { kind: 'gold', m } or { kind: 'item', id }
      if (a.kind === 'gold') { // the server rolls the amount; whatever the browser showed is only a guess
        const m = MONSTER_LOOT[a.m];
        if (!m || !(e.pending.gold[a.m] > 0)) return 'nothing to pick up';
        const roll = ctx.rand || Math.random;
        e.pending.gold[a.m] -= 1;
        e.gold += m.gold[0] + Math.min(m.gold[1] - m.gold[0], Math.floor(roll() * (m.gold[1] - m.gold[0] + 1)));
        return '';
      }
      if (a.kind === 'item') {
        if (!(e.pending.item[a.id] > 0)) return 'nothing to pick up';
        e.pending.item[a.id] -= 1; add(e.bag, a.id, 1);
        return '';
      }
      if (a.kind === 'gear') {
        const mt = String(a.m || '');
        if (!(e.pending.gear && e.pending.gear[mt] > 0)) return 'nothing to pick up';
        e.pending.gear[mt] -= 1;
        if (!e.pending.gear[mt]) delete e.pending.gear[mt];
        if (!e.gearInv) e.gearInv = [];
        if (e.gearInv.length >= 60) return 'inventory full';
        /* The server picks the uid and the item level, never the browser: rollGearDrop is public
           and deterministic, so a chosen uid could be searched offline for a legendary roll. The
           browser's own guess is replaced when the server's state comes back (gearInv). */
        const roll = ctx.rand || Math.random;
        const [lo, hi] = (GEAR_DROPS[mt] || {}).ilvl || [1, 1];
        const ilvl = lo + Math.min(hi - lo, Math.floor(roll() * (hi - lo + 1)));
        let uid = 'g';
        for (let i = 0; i < 4; i++) uid += Math.floor(roll() * 0x10000).toString(16).padStart(4, '0');
        e.gearInv.push(rollGearDrop(uid, ilvl));
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
      const day = Math.floor(now / 86400000), sold = Array.isArray(e.sold) && e.sold[0] === day ? e.sold[1] : 0;
      if (sold + SELL[a.id] * n > SELL_DAY_GOLD) return 'shops are full today';
      e.sold = [day, sold + SELL[a.id] * n];
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
    case 'gdrop': { // discard a gear instance from the stash by uid
      if (!e.gearInv) return 'empty';
      const idx = e.gearInv.findIndex((g) => g.uid === a.uid);
      if (idx < 0) return 'not found';
      e.gearInv.splice(idx, 1);
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
    case 'barrel': { // { slot, at: client ms }: sailed through barrel `slot` where barrelSpot() put it
      const slot = int(a.slot), at = Number(a.at), sea = e.sea;
      if (!(slot >= 0 && slot < BARREL_SLOTS) || !Number.isFinite(at)) return 'bad barrel';
      if (!clockOk(e, at, now, ctx.sent)) return 'too fast';
      if (at < (sea.back[slot] || -Infinity)) return 'not back yet';
      const [x, z] = barrelSpot(slot, sea.gen[slot] || 0);
      if (sea.last) { // could the boat have got here from the last barrel?
        const secs = (at - sea.last[2]) / 1000;
        if (secs < 0) return 'out of order';
        const dist = Math.hypot(x - sea.last[0], z - sea.last[1]) - 2 * BARREL_REACH;
        if (dist > secs * BOAT_MAX_SPEED * SAIL_SLACK) return 'too far';
      }
      if (!take(e, 'barrel', now)) return 'too fast';
      sea.gen[slot] = (sea.gen[slot] || 0) + 1;
      sea.back[slot] = at + BARREL_RESPAWN_MS;
      sea.last = [x, z, at];
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
      if (Object.keys(farm.crops).length >= MAX_CROPS) return 'field is full';
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
      let budget = IMPORT_CAPS.value;
      e.xp += cap(f.xp, IMPORT_CAPS.xp);
      e.kills += cap(f.kills, IMPORT_CAPS.kills);
      // gear first (it's what players miss most), each at its shop price
      if (Array.isArray(a.owned)) for (const id of [...new Set(a.owned)].slice(0, 200)) {
        const v = typeof id === 'string' && ctx.isGear(id) && !s.owned.includes(id) ? valueOf(id) : undefined;
        if (v === undefined || v > budget) continue;
        budget -= v; s.owned.push(id);
        e.boundGear = [...(e.boundGear || []), id]; // imported gear can't be withdrawn
      }
      let bound = 0; // the gold the rest of the import could ever turn into
      // then the bag, as many of each as the budget allows
      if (f.bag && typeof f.bag === 'object') {
        for (const [id, n] of Object.entries(f.bag).slice(0, 200)) {
          // consumables, seeds and blocks only: nothing that can be withdrawn, pooled or traded on
          const v = BAG_ITEMS.has(id) && !NON_IMPORTABLE.has(id) ? valueOf(id) : undefined;
          if (v === undefined) continue;
          const k = Math.min(cap(n, IMPORT_CAPS.bag), v > 0 ? Math.floor(budget / v) : IMPORT_CAPS.bag);
          if (k > 0) { add(e.bag, id, k); budget -= k * v; bound += k * (SELL[id] || 0); }
        }
      }
      // then a farm plot kept in the browser before farms moved to the server, if the plot is free
      if (a.farm && typeof a.farm === 'object' && !s.farm && PLOT_SOIL[a.farm.id] && ctx.plotTaken !== a.farm.id) {
        budget = importFarm(s, a.farm, budget, ctx);
        for (const b of s.farm.builds) bound += BUILDS[b.k].cost; // 'unbuild' pays this back in gold
      }
      const gold = cap(f.gold, budget);
      e.gold += gold; // then gold, with what's left
      // everything but the gear (boundGear) is bound: usable here, never tradeable or withdrawable
      e.bound = (e.bound || 0) + bound + gold;
      if (Array.isArray(a.loot)) for (const id of a.loot) if (SEA_TREASURE[id] && !e.loot.includes(id)) e.loot.push(id);
      e.imported = true;
      return '';
    }
  }
  if (a.t.startsWith('g_')) return guildAction(e.guild, e, a, { now, minute, rand: ctx.rand }, add, has); // the Guild (guild.js)
  return 'unknown action';
}

// What the browser gets to see of the economy (not the rate limits or pending drops).
// barrels: how many times each barrel slot has been taken, so the browser floats them where the server expects.
/* ---- trading between two players ----
   Terms are { gold, items: { bag id: count } }. The first player to confirm leaves an offer on
   their own account (`econ.offer`); the other completes it with the exact mirror of those terms,
   and the server swaps both accounts in one database transaction (api/game/[action].js). Gear
   isn't traded, only gold and bag items. */
export const TRADE_MS = 60000;   // an offer lapses after this
export const TRADE_KINDS = 12;   // different items per side
export function cleanTerms(t) {
  if (!t || typeof t !== 'object') return null;
  const gold = t.gold === undefined ? 0 : t.gold;
  if (!Number.isInteger(gold) || gold < 0 || gold > 1e9) return null;
  const src = t.items && typeof t.items === 'object' && !Array.isArray(t.items) ? t.items : {};
  const ids = Object.keys(src).sort();
  if (ids.length > TRADE_KINDS) return null;
  const items = {};
  for (const id of ids) {
    const n = src[id];
    if (!/^[a-z0-9_]{1,40}$/.test(id) || !Number.isInteger(n) || n < 1 || n > BAG_MAX) return null;
    items[id] = n;
  }
  return { gold, items };
}
export const emptyTerms = (t) => !t.gold && !Object.keys(t.items).length;
export const sameTerms = (a, b) => !!a && !!b && a.gold === b.gold && JSON.stringify(cleanTerms(a).items) === JSON.stringify(cleanTerms(b).items);
export const canGive = (e, t) => freeGold(e) >= t.gold &&Object.entries(t.items).every(([id, n]) => has(e.bag, id, n));
// Moves `give` out of the economy and `get` into it (check canGive first).
export function swapTerms(e, give, get) {
  e.gold += get.gold - give.gold;
  for (const [id, n] of Object.entries(give.items)) add(e.bag, id, -n);
  for (const [id, n] of Object.entries(get.items)) add(e.bag, id, n);
}

export const publicEcon = (e) => ({ gold: e.gold, xp: e.xp, kills: e.kills, bag: e.bag, loot: e.loot, gearInv: e.gearInv || [], imported: e.imported, barrels: (e.sea && e.sea.gen) || {}, guild: e.guild || newGuild(), lp: e.lp || {} });
