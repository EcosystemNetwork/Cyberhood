# Cyberhood art direction: the Hollow Chapel standard

`/game/showcase/` is the vertical slice that sets the quality bar: one knight, one sword, a melee
loop, one ruined chapel at dusk. Every new character, prop and environment is judged against it
before it goes into the world.

## 1. Audit: the styles that compete today

| Where | What it is | Style | Verdict |
| --- | --- | --- | --- |
| `game/lib/hero3d.js` | procedural chibi heroes, toon shading | stylized / chibi | Prototype. Keep it for the 2D-era Taproot world; don't extend it. |
| `game/lib/stylized3d.js` | toon prop kit | stylized | Same. Its geometry helpers are still useful. |
| `game/lib/blenderhero.js`, `assets3d/hero_*.glb` | early Blender hero parts | low-poly toon | Superseded by the GLB human. |
| `game/lib/glbhero.js` + `characterart/human_game.glb` | Tripo human, mocap clips, fitted gear | **realistic-stylized PBR** | **The standard.** The showcase builds on it without editing it. |
| `assets/3ditems/*_game.glb` | tunic, pants, boots, hooded cloak | realistic PBR | Standard. The 60 MB source scans next to them must never ship. |
| `assets3d/tree_*.glb`, `cottage.glb` | low-poly stylized props | toon | Clash with the standard; replace them as the world moves over. |
| world3d's toon lighting | lift materials with emissive fill | toon | The showcase replaces it with sky light (IBL) and a real sun. |

**Decision:** one art style, *realistic-stylized dark fantasy*. That means realistic human
proportions, PBR materials, a restrained palette, and light that comes from the sky and from fire.
Toon and chibi stay only where Taproot still needs them.

## 2. The look

- **Palette:** weathered sandstone and grey ashlar, dark blue-green firs, dry straw grass, iron
  and aged brass. Saturated colour is reserved for fire (warm), spirit magic (cold blue) and
  enemy eyes (ember red). Those are also the only things that glow.
- **Light:** one HDR sky (`belfast_sunset_puresky`) lights everything (IBL), and its sun is a
  low, raking directional light that casts long shadows. The sky is rotated at load so the sun
  rakes across the chapel front instead of lighting it flat.
- **Colour pipeline:** linear working space, sRGB output, AgX tone mapping, exposure 0.8. Albedo
  textures are sRGB; normal and ARM maps are linear.
- **Bloom:** threshold 1.05 on the HDR buffer. Only emissives brighter than 1.0 glow. Sunlit
  stone never does.
- **Atmosphere:** distance fog takes the horizon's hue at a fixed dim luminance, plus a ground
  mist under 1.4 m. Fog must darken the distance, never wash it out.
- **Readability:** heroes get a faint cool rim light and enemies a faint ember rim. Every enemy
  strike is telegraphed (a slow wind-up and an eye flare). One attacker swings at a time.

All the numbers live in `render.js` → `LOOK`. Tune them there and nowhere else.

## 3. Asset pipeline

1. **Concept**, then a style check against this page.
2. **Blender** for modelling, retopology, UVs and rigging (Mixamo skeleton names, so gear and
   clips fit `glbhero`). Script it where possible: `tools/blender/longsword.py` is the template,
   and `rogue_anims.py` / `wear_fit.py` handle clips and clothing.
3. **Materials:** PBR metal/rough. Pack AO/rough/metal into one ARM texture. Prefer factor-only
   materials for small hard-surface props (the sword is 25 KB).
4. **Animation:** Mixamo or mocap, baked onto the shared skeleton. Combat clips need wind-up and
   hit keys listed in glbhero's `ATTACK` table.
5. **Optimisation:** `gltf-transform optimize` with meshopt and WebP, plus a per-asset triangle
   budget (`tools/showcase/fetch_assets.py` → `MODELS`). KTX2/Basis comes next, once `toktx` is
   installed; the loader is already wired for Meshopt and ready for KTX2.
6. **Integration:** check it in the showcase under its sky first (`?cam=` fixed shots, `?stats`),
   then bring it into the world.

Third-party assets must be CC0 or have their licence checked first. See `assets/CREDITS.md`.

## 4. Budgets (desktop high / mobile low)

| | High | Low |
| --- | --- | --- |
| Draw calls (all passes) | < 450 | < 250 |
| Triangles (all passes) | < 3.2 M | < 2 M |
| Shadow map | 2048, 34 m | 1024, 26 m |
| Point lights | 4 | 2 |
| AO / AA | GTAO + 4× MSAA | none + SMAA |
| Scattered prop | ≤ 1.5 k tris | same |
| Hero prop / large rock | ≤ 10 k tris | same |
| Texture | 1 k WebP (ARM packed) | same |
| Showcase download | ~18 MB total, of which the hero + gear is ~8 MB | same |

Factor-only props (sword, armour) are baked at load into one mesh with per-vertex colour,
roughness and metalness (`bake.js`): one draw per piece instead of one per material. With five
armoured characters that took the chapel from 664 draw calls to 468.

How the budgets are kept: static stone is merged into two meshes. Repeated props are
`InstancedMesh`. Trees use `InstancedLOD`, with hi and lo meshes re-sorted by distance. Grass is
chunked and thins out with distance by drawing fewer of its shuffled instances. Alpha-cut foliage
and effects are kept out of the AO pass.

## 5. Roadmap from here

1. **Hero:** modular armour is in (`armor.js`, `tools/blender/armor_kit.py`): six slots (sallet,
   gorget, pauldrons, breastplate, vambraces, greaves) on bone sockets, checked in the Armoury
   (`preview.html`). Next: a body-build option, and armour variants per slot (the kit's script
   is parametric, so a heavier set is a new function, not a new pipeline).
2. **Combat animation:** in (`moves.js`): hand-keyed moves layered over the mocap at runtime, in
   rogue_anims.py's own op vocabulary (so they can be baked into the GLB unchanged): hit reactions
   from four directions, block recoil, a parry beat, a guard break with stagger, and a charged
   heavy (hold E) that breaks a foe's swing. Next: bake them into the human GLB once the hero-art
   branch lands (its mocap `roll` replaces the flip-based roll), plus weapon-specific sets.
3. **Environment kit:** in (`kit.js`): walls with arch holes and doorways, arch-ring mouldings,
   columns, buttresses, barrel vaults and ribs, stairs, chest tombs, all box-UV'd and merged into
   two draws per place. The chapel, a graveyard mausoleum and the Undercroft (`crypt.js`, a
   vaulted crypt under the mausoleum, 166 draw calls) are all built from it. Underground light:
   no sun, a dim gradient-room image light so PBR still has something to reflect, torches, and
   the relic's cold blue. Next: a city district from the same kit.
4. **Monsters, bosses, loot:** in. The Ossuary Warden (`boss.js`): a six-legged crawler of
   grave bones, rigid bone pieces on procedural animation (two-bone IK legs, alternating-tripod
   gait), a rearing impale and a spinning sweep, both telegraphed, a faster second phase. Loot
   (`loot.js`): drops arc out of the kill into rarity-coloured light pillars (rare: ember gold,
   legendary: grave blue); blades read by their glowing fuller and trail (Ember Blade, Grave Edge).
   Next: weapon models beyond the longsword (axe, spear), and a second monster family.
5. **Multiplayer polish:** in, client side. `net.js` speaks the realm's message shapes (protocol 2
   snapshots e/u/g, ouch / ko / say) plus a proposed `act` event (swing, heavy, guard, roll,
   emote) that combat readability needs; transports today are other tabs (BroadcastChannel) and
   simulated wardens (`?bots=N`, jittered 40-140 ms). `remotes.js` draws other players from
   snapshots 120 ms in the past (interpolated, short extrapolation), with replicated swings,
   guards, rolls and hit reactions; allies get a blue rim, guild nameplates, speech bubbles, half-
   bright trails and small grey numbers so your own fight reads first. Cost LOD: remotes skip AO,
   cast shadows within 14 m, drop armour past 22 m, and animate every 1st-4th frame by distance
   (an animated hero is ~2 ms of JS). Next: the realm WebSocket transport, and `act` in protocol 3.
