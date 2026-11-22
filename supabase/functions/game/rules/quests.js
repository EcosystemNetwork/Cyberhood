/* ============================================================================
   Quests: jobs you pick up from the Quest Board, finish by playing, and hand
   in for gold, XP and items.

   - A starter road walks a new player through every part of Taproot: fighting,
     crafting, farming, sailing, the Guild, then the Mine's giants. Each pays
     once. Its gold is BOUND (see economy.js freeGold): spendable in the game,
     never traded, pooled or withdrawn, so fresh accounts can't be farmed for it.
   - Daily jobs reset at 00:00 UTC and pay free gold, for the same effort the
     gold would take to earn anyway.

   Progress only moves on things the server has already accepted (a kill it
   paid, a harvest it allowed, a craft it made): economy.js calls questEvent
   from those spots, so a quest can never be faster than the game itself.
   The same file runs in the browser (solo, and to show progress at once) and
   on the server (supabase/functions/game/rules, via tools/sync-edge-rules.mjs).

   Plain logic, no Three.js and no DOM.
   ============================================================================ */

export const DAY_MS = 86400000;
export const MAX_ACTIVE = 6;

/* goal: { ev, key, n }
     ev   what counts: 'kill' (key: monster), 'craft' (recipe id), 'plant' / 'harvest' (crop),
          'sold' (gold earned selling to shops; n is gold), 'barrel' (sea barrels), 'recruit' (Guild hire)
     key  one id, a list of ids, or '*' for any
   reward: { gold, xp, items: { bag id: n } }
   after: a quest that must be handed in first. daily: repeats once per UTC day. */
export const QUESTS = {
  // ---- the starter road ----
  first_steps: {
    name: 'Slime Season', giver: 'Warden Pell', icon: '\u{1F7E2}',
    text: 'Slimes are oozing over the Fields paths again. Knock out three.',
    goal: { ev: 'kill', key: 'slime', n: 3 }, reward: { gold: 20, xp: 30, items: { health_potion: 1 } },
  },
  mushroom_watch: {
    name: 'Mushroom Watch', giver: 'Warden Pell', icon: '\u{1F344}', after: 'first_steps',
    text: 'Shrooms are creeping up from the woods line. Thin them out: four of them.',
    goal: { ev: 'kill', key: 'shroom', n: 4 }, reward: { gold: 25, xp: 40 },
  },
  first_brew: {
    name: 'First Brew', giver: 'Tilda', icon: '\u{1F9EA}', after: 'first_steps',
    text: 'Bring slime gel and a spore cap to my crafting table and brew a health potion.',
    goal: { ev: 'craft', key: 'health_potion', n: 1 }, reward: { gold: 20, xp: 30 },
  },
  goblin_trouble: {
    name: 'Goblin Trouble', giver: 'Warden Pell', icon: '\u{1F47A}', after: 'mushroom_watch',
    text: 'Goblins have been raiding carts. Five of them should get the message.',
    goal: { ev: 'kill', key: 'goblin', n: 5 }, reward: { gold: 50, xp: 80 },
  },
  green_thumb: {
    name: 'Green Thumb', giver: 'Farmer Odo', icon: '\u{1F331}',
    text: 'Claim a plot on the Avenues and put three seeds in the ground. Any seeds will do.',
    goal: { ev: 'plant', key: '*', n: 3 }, reward: { gold: 30, xp: 30, items: { wheat_seed: 3 } },
  },
  first_harvest: {
    name: 'First Harvest', giver: 'Farmer Odo', icon: '\u{1F33E}', after: 'green_thumb',
    text: 'Bring in three ripe crops. Carrots are the quickest.',
    goal: { ev: 'harvest', key: '*', n: 3 }, reward: { gold: 30, xp: 40 },
  },
  sea_legs: {
    name: 'Sea Legs', giver: 'Captain Wren', icon: '\u{26F5}',
    text: 'Take a boat out of the Docks and fish five floating barrels out of the bay.',
    goal: { ev: 'barrel', key: '*', n: 5 }, reward: { gold: 30, xp: 40 },
  },
  hired_help: {
    name: 'Hired Help', giver: 'Guild Clerk', icon: '\u{1F3F0}', after: 'first_steps',
    text: 'Every hero needs a friend. Hire a companion at the tavern.',
    goal: { ev: 'recruit', key: '*', n: 1 }, reward: { xp: 40, items: { root_dew: 2 } },
  },
  royal_jelly: {
    name: 'The Slime King', giver: 'Warden Pell', icon: '\u{1F451}', after: 'goblin_trouble',
    text: 'The big one wobbles somewhere in the Fields. Bring him down.',
    goal: { ev: 'kill', key: 'king', n: 1 }, reward: { gold: 80, xp: 150, items: { big_potion: 1 } },
  },
  into_the_hollow: {
    name: 'Into the Hollow', giver: 'Warden Pell', icon: '\u{1F48E}', after: 'royal_jelly',
    text: 'Two giants sleep three floors under the Mine. Beat either one.',
    goal: { ev: 'kill', key: ['golem_crystal', 'spider_queen'], n: 1 }, reward: { gold: 200, xp: 300 },
  },

  // ---- daily jobs (once per UTC day) ----
  d_slimes: {
    name: 'Daily: Slime Sweep', giver: 'Quest Board', icon: '\u{1F4C5}', daily: true, after: 'first_steps',
    text: 'Keep the paths clear: fifteen slimes.',
    goal: { ev: 'kill', key: 'slime', n: 15 }, reward: { gold: 40, xp: 60 },
  },
  d_goblins: {
    name: 'Daily: Goblin Patrol', giver: 'Quest Board', icon: '\u{1F4C5}', daily: true, after: 'goblin_trouble',
    text: 'Eight goblins, before they regroup.',
    goal: { ev: 'kill', key: 'goblin', n: 8 }, reward: { gold: 50, xp: 100 },
  },
  d_harvest: {
    name: 'Daily: Market Garden', giver: 'Quest Board', icon: '\u{1F4C5}', daily: true, after: 'first_harvest',
    text: 'The market wants fresh produce: harvest ten crops.',
    goal: { ev: 'harvest', key: '*', n: 10 }, reward: { gold: 40, xp: 50 },
  },
  d_trader: {
    name: 'Daily: Trade Run', giver: 'Quest Board', icon: '\u{1F4C5}', daily: true, after: 'first_steps',
    text: 'Sell 100 gold worth of goods to the town shops.',
    goal: { ev: 'sold', key: '*', n: 100 }, reward: { gold: 30, xp: 40 },
  },
  d_sailor: {
    name: 'Daily: Salvage', giver: 'Quest Board', icon: '\u{1F4C5}', daily: true, after: 'sea_legs',
    text: 'Ten barrels out of the bay.',
    goal: { ev: 'barrel', key: '*', n: 10 }, reward: { gold: 35, xp: 50 },
  },
};

export const dayOf = (ms) => Math.floor(ms / DAY_MS);

// on: { quest id: progress }   done: { quest id: UTC day handed in (dailies) or true (once) }
export const newQuests = () => ({ on: {}, done: {} });
export function normQuests(q) {
  const n = newQuests();
  if (!q || typeof q !== 'object') return n;
  for (const [id, v] of Object.entries(q.on || {})) if (QUESTS[id] && Number.isSafeInteger(v) && v >= 0) n.on[id] = Math.min(v, QUESTS[id].goal.n);
  for (const [id, v] of Object.entries(q.done || {})) if (QUESTS[id] && (v === true || Number.isSafeInteger(v))) n.done[id] = v;
  return n;
}

const handedIn = (q, id) => q.done[id] !== undefined;
/** Whether a quest is handed in for good (once) or for today (daily). */
export function isDone(q, id, now) {
  const v = q.done[id];
  if (v === undefined) return false;
  return QUESTS[id].daily ? v === dayOf(now) : true;
}
/** Can this quest be picked up right now? '' if so, else why not. */
export function canTake(q, id, now) {
  const Q = QUESTS[id];
  if (!Q) return 'no such quest';
  if (q.on[id] !== undefined) return 'already taken';
  if (isDone(q, id, now)) return Q.daily ? 'done today' : 'already done';
  if (Q.after && !handedIn(q, Q.after)) return 'not yet';
  if (Object.keys(q.on).length >= MAX_ACTIVE) return 'quest log full';
  return '';
}
/** Quests on the board for this player now: takeable ones, in table order. */
export const available = (q, now) => Object.keys(QUESTS).filter((id) => !canTake(q, id, now));
export const ready = (q, id) => q.on[id] !== undefined && q.on[id] >= QUESTS[id].goal.n;

const keyMatch = (want, key) => want === '*' || want === key || (Array.isArray(want) && want.includes(key));

/** Something happened that quests may count. Returns the ids that just became ready. */
export function questEvent(q, ev, key, n = 1) {
  const fresh = [];
  if (!q || !(n > 0)) return fresh;
  for (const id of Object.keys(q.on)) {
    const g = QUESTS[id] && QUESTS[id].goal;
    if (!g || g.ev !== ev || !keyMatch(g.key, key)) continue;
    const was = q.on[id];
    q.on[id] = Math.min(g.n, was + Math.floor(n));
    if (was < g.n && q.on[id] >= g.n) fresh.push(id);
  }
  return fresh;
}

/**
 * q_take { id } · q_claim { id } · q_drop { id }
 * `e` is the economy (server) or the browser's save: gold, xp, bag, bound.
 * Returns '' when it went through, else why not.
 */
export function questAction(q, e, a, ctx, add) {
  const id = String(a.id || ''), Q = QUESTS[id], now = ctx.now;
  if (!Q) return 'no such quest';
  if (a.t === 'q_take') {
    const why = canTake(q, id, now);
    if (why) return why;
    q.on[id] = 0;
    return '';
  }
  if (a.t === 'q_drop') {
    if (q.on[id] === undefined) return 'not taken';
    delete q.on[id];
    return '';
  }
  if (a.t === 'q_claim') {
    if (q.on[id] === undefined) return 'not taken';
    if (!ready(q, id)) return 'not finished';
    const r = Q.reward, gold = r.gold || 0;
    e.gold = (e.gold || 0) + gold;
    if (!Q.daily && gold) e.bound = (e.bound || 0) + gold; // the starter road's gold stays in the game
    e.xp = (e.xp || 0) + (r.xp || 0);
    if (!e.bag) e.bag = {};
    for (const [item, n] of Object.entries(r.items || {})) add(e.bag, item, n);
    delete q.on[id];
    q.done[id] = Q.daily ? dayOf(now) : true;
    return '';
  }
  return 'unknown action';
}
