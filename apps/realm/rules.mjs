/* The numbers the realm fights with.

   Copied from the game so the realm and the economy agree: HP/speed/XP from
   game/world3d/economy.js MONSTER_LOOT, damage/aggro/respawn from game/world3d/index.html MONSTERS,
   and the hit rules (cooldowns, power, assist share) from economy.js. The realm ships as its own
   container, so it can't import them; when either side changes, change both. */

export const MONSTERS = {
  slime:         { hp: 30,   speed: 1.5,  xp: 5,   dmg: 6,  aggro: 4.4 },
  shroom:        { hp: 45,   speed: 1.1,  xp: 8,   dmg: 8,  aggro: 3.8 },
  bat:           { hp: 24,   speed: 2.75, xp: 7,   dmg: 5,  aggro: 6 },
  goblin:        { hp: 60,   speed: 2,    xp: 15,  dmg: 12, aggro: 5.5 },
  king:          { hp: 200,  speed: 1,    xp: 60,  dmg: 18, aggro: 5,  size: 0.6, respawn: 45000 },
  gladiator:     { hp: 150,  speed: 2.1,  xp: 45,  dmg: 8,  aggro: 11, respawn: 25000 },
  golem_crystal: { hp: 1000, speed: 0.9,  xp: 400, dmg: 20, aggro: 11, size: 1.6, respawn: 120000 },
  spider_queen:  { hp: 800,  speed: 2.0,  xp: 350, dmg: 16, aggro: 12, size: 1.6, respawn: 120000 },
};

export const PLAYER_SPEED = 7.4;   // sprinting, tiles a second (economy.js)
export const MOVE_SLACK = 1.25;    // frame timing and lag
export const MOVE_BURST_S = 1.5;   // movement a player may bank: messages arrive in clumps
export const PLAYER_HP = 100;

export const SWING_CD = 0.36;      // seconds between swings (economy.js)
export const SHOT_CD = 0.4;        // the fastest caster (apprentice wand)
export const CD_SLACK = 0.85;      // an attack may come this fraction of a cooldown early
export const HIT_RAND = 4;         // a hit does its power plus up to this much
export const ASSIST_SHARE = 0.1;   // damage share that earns a group kill
export const POWER = {
  swing: (s) => s.atk,
  shot: (s) => s.atk * 0.6 + s.mag * 1.4,
};
export const COOLDOWN = { swing: SWING_CD, shot: SHOT_CD };
// The realm holds both positions, so reach needs only a little slack for what the player saw
// ~100 ms ago. A swing reaches ~1.1 tiles past the body; the longest staff shoots 16.
export const REACH = { swing: 2.6, shot: 17 };
export const DEFAULT_STATS = { atk: 10, mag: 2 }; // until the realm reads real stats from the API

export const MOB_ATTACK_MS = 1000; // a monster's bite, once a second
export const MOB_REACH = 1.2;      // plus its size
export const LEASH = 18;           // tiles from home before a monster gives up and heals
export const respawnMs = (type, rand) => MONSTERS[type].respawn || 12000 + Math.floor(rand() * 6000);
export const maxHit = (kind, stats) => Math.ceil(POWER[kind](stats)) + HIT_RAND;
