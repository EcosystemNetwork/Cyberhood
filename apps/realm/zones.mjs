/* The zones this realm runs.

   Stand-ins for now: sizes, starts and spawn boxes in map tiles, without walls. The real maps'
   walkable grids (the `blocked` arrays game/world3d builds from each map) get exported into
   here when the client moves onto the realm; until then monsters and players can walk anywhere
   inside the bounds. */

export const ZONES = [
  {
    id: 'world', w: 160, h: 120, start: { x: 80, z: 60 },
    spawns: [
      { type: 'slime', count: 12, box: [10, 10, 70, 50] },
      { type: 'shroom', count: 8, box: [90, 10, 150, 50] },
      { type: 'goblin', count: 6, box: [20, 70, 140, 110] },
      { type: 'king', spot: [40, 30] },
    ],
  },
  {
    id: 'mine-b2', w: 60, h: 60, start: { x: 30, z: 55 },
    spawns: [
      { type: 'bat', count: 6, box: [5, 5, 55, 40] },
      { type: 'golem_crystal', spot: [18, 15] },
      { type: 'spider_queen', spot: [42, 15] },
    ],
  },
  { id: 'arena', w: 40, h: 40, start: { x: 20, z: 34 }, spawns: [{ type: 'gladiator', spot: [20, 12] }] },
];
