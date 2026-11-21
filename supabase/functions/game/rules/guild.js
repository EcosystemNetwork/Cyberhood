/* ============================================================================
   The Guild: companion heroes you recruit, send on expeditions, train and
   summon from. Edit freely.

   - CLASSES: what a companion can be. The first four come from the tavern;
     the rest only come from a summon whose parents' classes pair up (MUTATE).
     `main` are the two stats the class grows on every level-up, `look` is
     the kit it wears in the 3D world.
   - PROFS: the four trades. A companion whose trade matches an expedition
     finishes it faster and finds more.
   - EXPEDITIONS: where companions go. Each attempt costs every companion in
     the party `stamina` and takes `minutes`; `loot` is rolled per companion
     per attempt as [bag id, chance, [min, max]].
   - GUILD_ITEMS: what expeditions bring home (sell prices are in shops.js SELL).

   Pure logic, no DOM or Three.js: economy.js's applyAction() runs these
   actions on the server, and /game/world3d plays them out in the browser.
   Anything rolled (a recruit, a summon, an expedition's haul) is rolled with
   ctx.rand, so when signed in the server's roll is the one that counts.
   ============================================================================ */

export const STATS = ['str', 'dex', 'agi', 'vit', 'end', 'int', 'wis', 'lck'];
export const STAT_NAMES = { str: 'Strength', dex: 'Dexterity', agi: 'Agility', vit: 'Vitality', end: 'Endurance', int: 'Intellect', wis: 'Wisdom', lck: 'Luck' };

export const CLASSES = {
  warden:  { name: 'Warden',  emoji: '\u{1F6E1}️', main: ['str', 'vit'], base: { str: 11, dex: 7, agi: 6, vit: 10, end: 9, int: 4, wis: 5, lck: 5 },
    look: { head: 'iron_helm', body: 'chainmail', rhand: 'iron_sword', lhand: 'wooden_shield', feet: 'iron_greaves' } },
  ranger:  { name: 'Ranger',  emoji: '\u{1F3F9}', main: ['dex', 'agi'], base: { str: 7, dex: 11, agi: 10, vit: 7, end: 7, int: 5, wis: 6, lck: 6 },
    look: { body: 'leather_vest', rhand: 'boomerang', feet: 'leather_boots' } },
  sage:    { name: 'Sage',    emoji: '\u{1F52E}', main: ['int', 'wis'], base: { str: 4, dex: 6, agi: 6, vit: 6, end: 6, int: 12, wis: 11, lck: 6 },
    look: { head: 'wizard_hat', body: 'mage_robe', rhand: 'oak_staff' } },
  rogue:   { name: 'Rogue',   emoji: '\u{1F5E1}️', main: ['agi', 'lck'], base: { str: 7, dex: 10, agi: 11, vit: 6, end: 6, int: 6, wis: 5, lck: 10 },
    look: { body: 'rogue_tunic', rhand: 'cutlass', feet: 'leather_boots' } },
  // only from summoning
  corsair: { name: 'Corsair', emoji: '\u{1F3F4}‍☠️', main: ['str', 'lck'], base: { str: 12, dex: 10, agi: 9, vit: 9, end: 8, int: 5, wis: 5, lck: 11 },
    look: { head: 'pirate_tricorn', body: 'rogue_tunic', rhand: 'cutlass', lhand: 'lantern', feet: 'leather_boots' } },
  oracle:  { name: 'Oracle',  emoji: '\u{2728}',   main: ['wis', 'lck'], base: { str: 5, dex: 7, agi: 8, vit: 8, end: 7, int: 12, wis: 14, lck: 10 },
    look: { eyes: 'round_specs', body: 'mage_robe', lhand: 'crystal_orb' } },
  paladin: { name: 'Paladin', emoji: '\u{2694}️', main: ['vit', 'wis'], base: { str: 12, dex: 7, agi: 6, vit: 13, end: 11, int: 7, wis: 10, lck: 5 },
    look: { head: 'iron_helm', body: 'steel_armor', rhand: 'iron_sword', lhand: 'tower_shield', feet: 'iron_greaves' } },
};
export const BASE_CLASSES = ['warden', 'ranger', 'sage', 'rogue'];
// Two parents of these classes may (MUTATE_CHANCE) give a child of an advanced class.
export const MUTATE = { 'rogue+warden': 'corsair', 'ranger+sage': 'oracle', 'sage+warden': 'paladin' };
export const MUTATE_CHANCE = 0.2;

export const PROFS = {
  mining:   { name: 'Miner',    emoji: '⛏️' },
  farming:  { name: 'Farmer',   emoji: '\u{1F33E}' },
  fishing:  { name: 'Angler',   emoji: '\u{1F3A3}' },
  foraging: { name: 'Forager',  emoji: '\u{1F344}' },
};

export const RARITY = [
  { name: 'Common',    color: '#9a95a8', bonus: 0,  weight: 60 },
  { name: 'Uncommon',  color: '#4ac46a', bonus: 3,  weight: 25 },
  { name: 'Rare',      color: '#3a8aff', bonus: 6,  weight: 10 },
  { name: 'Legendary', color: '#ff9a1a', bonus: 10, weight: 4 },
  { name: 'Mythic',    color: '#c050ff', bonus: 15, weight: 1 },
];

export const GUILD_ITEMS = {
  copper_ore:  { name: 'Copper Ore',  emoji: '\u{1FAA8}', info: 'From mining expeditions' },
  silver_ore:  { name: 'Silver Ore',  emoji: '\u{1F311}', info: 'From mining expeditions' },
  sun_gem:     { name: 'Sun Gem',     emoji: '\u{1F48E}', info: 'A rare find in the Mine' },
  minnow:      { name: 'Minnow',      emoji: '\u{1F41F}', info: 'From fishing expeditions' },
  river_bass:  { name: 'River Bass',  emoji: '\u{1F420}', info: 'From fishing expeditions' },
  goldfin:     { name: 'Goldfin',     emoji: '\u{1F421}', info: 'A rare catch off the Docks' },
  moonleaf:    { name: 'Moonleaf',    emoji: '\u{1F33F}', info: 'From foraging expeditions' },
  glowcap:     { name: 'Glowcap',     emoji: '\u{1F344}', info: 'A rare find in the Woods' },
  root_dew:    { name: 'Root Dew',    emoji: '\u{1F4A7}', info: 'Needed to summon a new companion' },
};

export const EXPEDITIONS = {
  mine: { name: 'Mine Shafts', prof: 'mining', area: 'cave', minutes: 6, stamina: 5,
    loot: [['copper_ore', 0.7, [1, 3]], ['silver_ore', 0.3, [1, 2]], ['sun_gem', 0.04, [1, 1]], ['root_dew', 0.12, [1, 1]]], gold: [1, 4] },
  fields: { name: 'Field Rows', prof: 'farming', area: 'fields', minutes: 6, stamina: 5,
    loot: [['wheat', 0.6, [1, 3]], ['carrot', 0.5, [1, 3]], ['pumpkin', 0.06, [1, 1]], ['root_dew', 0.12, [1, 1]]], gold: [0, 2] },
  docks: { name: 'Harbour Nets', prof: 'fishing', area: 'docks', minutes: 6, stamina: 5,
    loot: [['minnow', 0.75, [1, 3]], ['river_bass', 0.3, [1, 2]], ['goldfin', 0.04, [1, 1]], ['root_dew', 0.12, [1, 1]]], gold: [0, 3] },
  woods: { name: 'Deep Woods', prof: 'foraging', area: 'woods', minutes: 6, stamina: 5,
    loot: [['moonleaf', 0.7, [1, 3]], ['spore_cap', 0.4, [1, 2]], ['glowcap', 0.05, [1, 1]], ['root_dew', 0.12, [1, 1]]], gold: [0, 2] },
};

export const ROSTER_MAX = 12;
export const PARTY_MAX = 3;
export const ATTEMPTS_MAX = 5;
export const STAMINA_MAX = 25;
export const STAMINA_MINUTES = 20;   // one stamina back every this many minutes
export const RECRUIT_GOLD = 80;
export const PROF_SPEED = 0.7;       // a party all of the matching trade takes 70% of the time
export const PROF_LUCK = 1.5;        // and each of them rolls its loot this much more often
export const XP_PER_ATTEMPT = 12;
export const LOG_MAX = 12;
export const levelXp = (lv) => 60 + 40 * lv * lv;              // XP from `lv` to lv + 1
export const levelGold = (lv) => 25 * lv;                      // the trainer's fee
export const maxSummons = (gen) => Math.max(0, 8 - 2 * gen);    // gen 0: 8 ... gen 4: none
export const summonGold = (a, b) => 60 + 30 * (a.sums + b.sums);
export const summonDew = (a, b) => 1 + Math.max(a.gen, b.gen);
export const summonRestMinutes = (h) => 60 * (1 + h.sums);     // a parent rests before summoning again

/* ---- a companion at your side ----
   One companion can follow you (g_follow) everywhere and fight: it walks after you and attacks
   monsters near you. Its hits go to the server as 'ahit' (economy.js), which checks it really is
   your follower, the cooldown, the damage cap below, and that the monster was near you. */
export const ALLY = { leash: 7, aggro: 7 }; // tiles from you it will go to fight / looks for monsters
export const ALLY_CD_SLACK = 0.85; // a hit may come this fraction of its cooldown early (frame timing)
const MELEE = { range: 1.4, cd: 1.0 }, RANGED = { range: 7, cd: 1.3 };
export function allyKit(h) {
  const c = CLASSES[h.cls], ranged = ['ranger', 'sage', 'oracle'].includes(h.cls);
  const power = c.main.reduce((n, k) => n + h.stats[k], 0) / 2; // the class's two main stats
  return { ...(ranged ? RANGED : MELEE), ranged, dmg: Math.round(3 + power * 0.6 + h.lv * 1.5) }; // dmg: the most one hit can do
}
export const allyHit = (h, roll) => Math.max(1, Math.round(allyKit(h).dmg * (0.75 + 0.25 * roll)));

const NAMES_A = ['Bram', 'Tess', 'Odo', 'Fenna', 'Rook', 'Lio', 'Maeve', 'Garr', 'Sable', 'Wick', 'Hazel', 'Quill', 'Juno', 'Pell', 'Rusk', 'Ivy', 'Corin', 'Nell', 'Tamsin', 'Barley'];
const NAMES_B = ['Thorn', 'Brook', 'Ashby', 'Moss', 'Fernley', 'Holt', 'Marrow', 'Reed', 'Stone', 'Briar', 'Dale', 'Wren', 'Hollow', 'Cole', 'Burrow'];

export function newGuild() { return { heroes: [], next: 1, quests: [], qnext: 1, log: [], follow: 0 }; }
export function normGuild(g) {
  const n = newGuild();
  if (!g || typeof g !== 'object') return n;
  return {
    heroes: Array.isArray(g.heroes) ? g.heroes.map((h) => ({ ...h, stats: { ...h.stats }, genes: { cls: [...h.genes.cls], prof: [...h.genes.prof] } })) : [],
    next: Number.isInteger(g.next) ? g.next : 1,
    quests: Array.isArray(g.quests) ? g.quests.map((q) => ({ ...q, party: [...q.party] })) : [],
    qnext: Number.isInteger(g.qnext) ? g.qnext : 1,
    log: Array.isArray(g.log) ? g.log.map((l) => ({ ...l })) : [],
    follow: Number.isInteger(g.follow) ? g.follow : 0,
  };
}

// Stamina is kept as the time it will be full again, so it refills without anyone ticking it.
export function staminaOf(h, now, minute) {
  const left = Math.max(0, (h.full || 0) - now);
  return Math.max(0, STAMINA_MAX - Math.ceil(left / (STAMINA_MINUTES * minute)));
}
function spendStamina(h, n, now, minute) {
  const from = Math.max(now, h.full || 0);
  h.full = from + n * STAMINA_MINUTES * minute;
}
export const heroBusy = (g, id) => g.quests.some((q) => q.party.includes(id));
export const heroById = (g, id) => g.heroes.find((h) => h.id === id);
export const heroLook = (h) => ({ skin: h.skin, hc: h.hc, hs: h.hs, equipment: { ...CLASSES[h.cls].look } });
export const heroTitle = (h) => `${h.name} · Lv ${h.lv} ${RARITY[h.rar].name} ${CLASSES[h.cls].name}`;
export const heroPower = (h) => STATS.reduce((n, k) => n + h.stats[k], 0);

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const between = (rand, [a, b]) => a + Math.floor(rand() * (b - a + 1));
function rollRarity(rand, boost = 0) {
  const total = RARITY.reduce((n, r) => n + r.weight, 0);
  let x = rand() * total * (1 - boost);
  for (let i = RARITY.length - 1; i >= 0; i--) { x -= RARITY[i].weight; if (x < 0) return i; }
  return 0;
}
function makeStats(cls, rar, rand) {
  const s = { ...CLASSES[cls].base };
  for (let i = 0; i < RARITY[rar].bonus; i++) s[pick(rand, [...STATS, ...CLASSES[cls].main])] += 1;
  return s;
}
function makeHero(g, { cls, prof, genes, rar, gen, parents }, rand, now) {
  const h = {
    id: g.next++, name: `${pick(rand, NAMES_A)} ${pick(rand, NAMES_B)}`, cls, prof, genes, rar, gen, sums: 0,
    lv: 1, xp: 0, stats: makeStats(cls, rar, rand), full: 0, rest: 0, born: now,
    skin: Math.floor(rand() * 5), hc: Math.floor(rand() * 6), hs: pick(rand, ['short', 'long', 'bald']),
    ...(parents ? { parents } : {}),
  };
  g.heroes.push(h);
  return h;
}

// Which of two genes shows: the dominant one 3 times in 4.
const express = (rand, [d, r]) => (rand() < 0.75 ? d : r);
// A child's gene pair from two parents' pairs: each slot comes from one parent, dominant more often.
const inherit = (rand, a, b) => {
  const from = () => { const p = rand() < 0.5 ? a : b; return rand() < 0.75 ? p[0] : p[1]; };
  return [from(), from()];
};

const log = (g, entry) => { g.log.unshift(entry); g.log.length = Math.min(g.log.length, LOG_MAX); };

/* The guild's actions. Each returns '' if it went through (and changed s), or why not.
     g    = the guild (econ.guild), e = the economy (gold, bag), ctx = { now, minute, rand } */
export function guildAction(g, e, a, ctx, add, has) {
  const now = ctx.now, minute = ctx.minute || 60000, rand = ctx.rand || Math.random;
  switch (a.t) {
    case 'g_recruit': { // hire a companion at the tavern
      if (g.heroes.length >= ROSTER_MAX) return 'roster full';
      if (e.gold < RECRUIT_GOLD) return 'not enough gold';
      e.gold -= RECRUIT_GOLD;
      const cls = pick(rand, BASE_CLASSES), prof = pick(rand, Object.keys(PROFS));
      const genes = { cls: [cls, pick(rand, BASE_CLASSES)], prof: [prof, pick(rand, Object.keys(PROFS))] };
      const h = makeHero(g, { cls, prof, genes, rar: rollRarity(rand), gen: 0 }, rand, now);
      log(g, { k: 'recruit', at: now, hero: h.id });
      return '';
    }
    case 'g_dismiss': { // { hero }
      const h = heroById(g, a.hero);
      if (!h) return 'no such hero';
      if (heroBusy(g, h.id)) return 'hero busy';
      g.heroes = g.heroes.filter((x) => x !== h);
      if (g.follow === h.id) g.follow = 0;
      return '';
    }
    case 'g_quest': { // { where, party: [hero ids], n: attempts }
      const X = EXPEDITIONS[a.where], n = a.n;
      if (!X) return 'no such expedition';
      if (!Number.isInteger(n) || n < 1 || n > ATTEMPTS_MAX) return 'bad attempts';
      const ids = Array.isArray(a.party) ? [...new Set(a.party)] : [];
      if (!ids.length || ids.length > PARTY_MAX) return 'bad party';
      const party = ids.map((id) => heroById(g, id));
      if (party.some((h) => !h)) return 'no such hero';
      if (ids.some((id) => heroBusy(g, id))) return 'hero busy';
      if (party.some((h) => staminaOf(h, now, minute) < X.stamina * n)) return 'too tired';
      party.forEach((h) => spendStamina(h, X.stamina * n, now, minute));
      if (ids.includes(g.follow)) g.follow = 0; // your companion leaves your side for the expedition
      const fast = party.every((h) => h.prof === X.prof);
      const ms = Math.round(n * X.minutes * minute * (fast ? PROF_SPEED : 1));
      g.quests.push({ id: g.qnext++, where: a.where, party: ids, n, start: now, end: now + ms });
      return '';
    }
    case 'g_claim': { // { quest }: bring a finished expedition home
      const q = g.quests.find((x) => x.id === a.quest);
      if (!q) return 'no such quest';
      if (now < q.end) return 'not back yet';
      const X = EXPEDITIONS[q.where], loot = {};
      let gold = 0;
      for (const id of q.party) {
        const h = heroById(g, id);
        if (!h) continue;
        const skill = (h.prof === X.prof ? PROF_LUCK : 1) * (1 + h.stats.lck / 100);
        for (let i = 0; i < q.n; i++) {
          for (const [item, chance, range] of X.loot) if (rand() < chance * skill) loot[item] = (loot[item] || 0) + between(rand, range);
          gold += between(rand, X.gold);
        }
        h.xp += XP_PER_ATTEMPT * q.n * (h.prof === X.prof ? 2 : 1);
      }
      for (const [item, c] of Object.entries(loot)) add(e.bag, item, c);
      e.gold += gold;
      g.quests = g.quests.filter((x) => x !== q);
      log(g, { k: 'quest', at: now, where: q.where, party: q.party, loot, gold });
      return '';
    }
    case 'g_follow': { // { hero }: this companion comes with you (0: nobody)
      if (a.hero === 0) { g.follow = 0; return ''; }
      const h = heroById(g, a.hero);
      if (!h) return 'no such hero';
      if (heroBusy(g, h.id)) return 'hero busy';
      g.follow = h.id;
      return '';
    }
    case 'g_train': { // { hero, stat }: level up at the trainer, picking one stat to push
      const h = heroById(g, a.hero);
      if (!h) return 'no such hero';
      if (!STATS.includes(a.stat)) return 'bad stat';
      if (heroBusy(g, h.id)) return 'hero busy';
      if (h.xp < levelXp(h.lv)) return 'not enough xp';
      if (e.gold < levelGold(h.lv)) return 'not enough gold';
      e.gold -= levelGold(h.lv);
      h.xp -= levelXp(h.lv); h.lv += 1;
      h.stats[a.stat] += 2;
      for (const k of CLASSES[h.cls].main) h.stats[k] += 1;
      if (rand() < 0.25 + h.rar * 0.1) h.stats[pick(rand, STATS)] += 1; // rarer heroes grow a little extra
      log(g, { k: 'train', at: now, hero: h.id, lv: h.lv });
      return '';
    }
    case 'g_summon': { // { a, b }: two companions summon a third
      const A = heroById(g, a.a), B = heroById(g, a.b);
      if (!A || !B || A === B) return 'bad parents';
      if (g.heroes.length >= ROSTER_MAX) return 'roster full';
      if (heroBusy(g, A.id) || heroBusy(g, B.id)) return 'hero busy';
      if (A.sums >= maxSummons(A.gen) || B.sums >= maxSummons(B.gen)) return 'no summons left';
      if ((A.rest || 0) > now || (B.rest || 0) > now) return 'still resting';
      const gold = summonGold(A, B), dew = summonDew(A, B);
      if (e.gold < gold) return 'not enough gold';
      if (!has(e.bag, 'root_dew', dew)) return 'not enough dew';
      e.gold -= gold; add(e.bag, 'root_dew', -dew);
      const genes = { cls: inherit(rand, A.genes.cls, B.genes.cls), prof: inherit(rand, A.genes.prof, B.genes.prof) };
      let cls = express(rand, genes.cls);
      const pair = [express(rand, A.genes.cls), express(rand, B.genes.cls)].sort().join('+');
      if (MUTATE[pair] && rand() < MUTATE_CHANCE) { cls = MUTATE[pair]; genes.cls[0] = cls; }
      const boost = Math.min(0.5, (A.rar + B.rar) * 0.06); // rarer parents, rarer children
      const h = makeHero(g, { cls, prof: express(rand, genes.prof), genes, rar: rollRarity(rand, boost), gen: Math.max(A.gen, B.gen) + 1, parents: [A.id, B.id] }, rand, now);
      for (const p of [A, B]) { p.sums += 1; p.rest = now + summonRestMinutes(p) * minute; }
      log(g, { k: 'summon', at: now, hero: h.id, parents: [A.id, B.id] });
      return '';
    }
  }
  return 'unknown action';
}
