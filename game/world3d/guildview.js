/* ============================================================================
   The Guild in the 3D world: the panel (Hero Hall, Glowcap Tavern, or Y
   anywhere) and your companions walking about.

   Idle companions hang around Hero Hall in the city; companions out on an
   expedition can be found at work where they were sent (miners in the Mine,
   anglers on the Docks, ...). Rules live in guild.js; this file only shows
   them and sends the actions.

   Signed in, anything rolled (a recruit, a summon, an expedition's haul, a
   level-up) waits for the server's roll; offline and in solo it's rolled here.
   ============================================================================ */
import {
  CLASSES, PROFS, RARITY, EXPEDITIONS, GUILD_ITEMS, STATS, STAT_NAMES, MUTATE,
  ROSTER_MAX, PARTY_MAX, ATTEMPTS_MAX, STAMINA_MAX, RECRUIT_GOLD, PROF_SPEED,
  normGuild, guildAction, staminaOf, heroBusy, heroById, heroLook, levelXp, levelGold,
  maxSummons, summonGold, summonDew, ALLY, allyKit, allyHit,
  PETS, PET_MAX, HATCH_GOLD, TONICS, petBonus, petOf,
} from './guild.js';
import { createPetBrain } from './petbrain.js';

const ROLLED = new Set(['g_recruit', 'g_claim', 'g_train', 'g_summon', 'g_hatch']);
const SHOWN_MAX = 8;

export function createGuildView(d) {
  /* d = { field, minute, online(), serverNow(), act(a), save(), refresh(), toast(msg),
           makeHero(look), toScreen(x, y, z), labelsEl, free(x, z), heroH, player: P, sfx,
           anchors: { hall, fields, woods, docks, cave: {x, z} } — where on this map each place is (missing: not on this map),
           monsters(), canFight(), hitMonster(m, dmg, from, heroId), burst(x, y, z, color, n) — for the companion at your side,
           makePet(kind) -> THREE.Group (a pet trotting after its companion),
           drops(), collect(drop) — for the pet that walks with you (petbrain.js) } */
  d.field.guild = normGuild(d.field.guild);
  const G = () => d.field.guild;
  const brain = createPetBrain({ player: d.player, free: d.free, monsters: d.monsters, drops: d.drops || (() => []), collect: d.collect || (() => {}),
    makePet: d.makePet, isFlyer: (kind) => PETS[kind].shape === 'fish' });
  // the pet out with you, unless its companion is away on an expedition
  const walker = () => { const g = G(), p = g.walk && g.pets.find((x) => x.id === g.walk); return p && !(p.hero && heroBusy(g, p.hero)) ? p : null; };
  let pending = false, seenLog = topKey(G()), ui = { tab: 'roster', sel: [], where: 'mine', n: 1, train: null, petFor: 0 };

  function topKey(g) { const l = g.log[0]; return l ? `${l.k}:${l.at}` : ''; }
  const now = () => d.serverNow();
  const min = () => d.minute;
  const clsOf = (h) => CLASSES[h.cls];
  const rar = (h) => RARITY[h.rar];
  const left = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
  const itemName = (id) => (GUILD_ITEMS[id] ? GUILD_ITEMS[id].name : id.replace(/_/g, ' '));

  /* ---------- actions ---------- */
  const add = (bag, id, n) => { bag[id] = (bag[id] || 0) + n; if (bag[id] <= 0) delete bag[id]; };
  const has = (bag, id, n) => (bag[id] || 0) >= n;
  function act(a) {
    if (pending) return;
    if (d.online() && ROLLED.has(a.t)) { // the server rolls it: wait for its answer
      pending = true; d.act(a); render(); return;
    }
    const why = guildAction(G(), d.field, a, { now: now(), minute: min(), rand: Math.random }, add, has);
    if (why) { d.toast(REASONS[why] || why); return; }
    d.act(a); d.save(); d.refresh(); announce(); render();
    if (d.done) d.done(a); // e.g. a hire counts for a quest (questview.js)
    if (a.t === 'g_quest') { ui.sel = []; d.sfx && d.sfx.play('buy'); }
  }
  const REASONS = {
    'not enough gold': 'Not enough gold', 'too tired': 'Someone in that party is too tired: stamina comes back over time',
    'roster full': `Your guild is full (${ROSTER_MAX})`, 'not enough dew': 'Not enough Root Dew (expeditions find it)',
    'still resting': 'A parent is still resting from their last summon', 'not back yet': 'Not back yet', 'hero busy': 'That companion is busy',
    'no summons left': 'A parent has no summons left', 'not tired': 'Already full of stamina', 'no egg': 'No Pet Egg in your bag',
    'too many pets': 'Your guild has all the pets it can look after', 'pet away': 'That pet is away with its companion',
  };
  // The newest guild log entries since we last looked, as toasts.
  function announce() {
    const g = G(), fresh = [];
    for (const l of g.log) { if (`${l.k}:${l.at}` === seenLog) break; fresh.push(l); }
    seenLog = topKey(g);
    const msg = fresh.reverse().map(describe).filter(Boolean);
    if (msg.length) d.toast(msg.join(' · '));
    if (fresh.some((l) => l.k === 'summon' || l.k === 'recruit')) d.sfx && d.sfx.play('craft');
    if (fresh.some((l) => l.k === 'quest')) d.sfx && d.sfx.play('coin');
  }
  function describe(l) {
    const h = l.hero && heroById(G(), l.hero);
    if (l.k === 'recruit' && h) return `${h.name} joined: ${rar(h).name} ${clsOf(h).name}, ${PROFS[h.prof].name}`;
    if (l.k === 'summon' && h) return `Summoned ${h.name}: ${rar(h).name} ${clsOf(h).name}!`;
    if (l.k === 'train' && h) return `${h.name} reached Lv ${l.lv}`;
    if (l.k === 'hatch') { const p = G().pets.find((x) => x.id === l.pet); return p ? `Hatched ${p.name} the ${RARITY[p.rar].name} ${PETS[p.kind].name}!` : ''; }
    if (l.k === 'quest') return `Back from ${EXPEDITIONS[l.where].name}: ${haul(l) || 'nothing this time'}`;
    return '';
  }
  const haul = (l) => [...Object.entries(l.loot).map(([id, n]) => `${n} ${itemName(id)}`), ...(l.gold ? [`${l.gold}g`] : [])].join(', ');

  /* ---------- the panel (drawn into the shop panel) ---------- */
  let panel = null; // { title, greet, tabs, list } elements, set by render()
  function render(els) {
    if (els) panel = els;
    if (!panel || !panel.open()) return;
    const g = G();
    panel.title.textContent = 'Hero Hall';
    panel.greet.textContent = pending ? 'The guild clerk is writing it down…'
      : `Companions ${g.heroes.length}/${ROSTER_MAX}. Recruit at the tavern, send them out, train them up, summon new ones.`;
    panel.tabs.innerHTML = [['roster', 'Roster'], ['quest', 'Expeditions'], ['summon', 'Summon'], ['pets', 'Pets'], ['recruit', 'Recruit']]
      .map(([t, n]) => `<button data-tab="g:${t}" class="${ui.tab === t ? 'on' : ''}">${n}${t === 'quest' && ready() ? ' \u{2757}' : ''}</button>`).join('');
    panel.list.innerHTML = ({ roster, quest, summon, pets, recruit })[ui.tab]();
  }
  const ready = () => G().quests.some((q) => now() >= q.end);
  const dis = (ok) => (ok && !pending ? '' : 'disabled');
  const row = (ico, title, small, btns = '') => `<div class="row"><div class="ico">${ico}</div><div class="txt"><b>${title}</b><small>${small}</small></div>${btns}</div>`;
  const heroName = (h) => `${h.name} <span style="color:${rar(h).color};font-size:13px">${rar(h).name}</span>`;
  function heroLine(h) {
    const st = staminaOf(h, now(), min());
    const pet = petOf(G(), h);
    return `Lv ${h.lv} ${clsOf(h).name} · ${PROFS[h.prof].emoji} ${PROFS[h.prof].name} · Gen ${h.gen} · \u{26A1}${st}/${STAMINA_MAX} · XP ${h.xp}/${levelXp(h.lv)}`
      + (pet ? ` · \u{1F43E} ${pet.name}` : '');
  }
  const statLine = (h) => STATS.map((k) => `${k.toUpperCase()} ${h.stats[k]}`).join(' · ');
  function status(h) {
    const q = G().quests.find((x) => x.party.includes(h.id));
    if (!q) return '';
    return now() >= q.end ? `<br><small>\u{2705} back from ${EXPEDITIONS[q.where].name}</small>` : `<br><small>${PROFS[EXPEDITIONS[q.where].prof].emoji} at ${EXPEDITIONS[q.where].name} · ${left(q.end - now())}</small>`;
  }

  function roster() {
    const g = G();
    if (!g.heroes.length) return '<p class="shop-empty">No companions yet. Recruit your first one on the Recruit tab (or at the Glowcap Tavern).</p>';
    return g.heroes.map((h) => {
      if (ui.train === h.id) {
        const btns = STATS.map((k) => `<button data-act="g_train" data-id="${h.id}" data-x="${k}" ${dis(true)} title="${STAT_NAMES[k]}">+${k.toUpperCase()}</button>`).join('');
        return `<div class="row" style="flex-wrap:wrap"><div class="ico">${clsOf(h).emoji}</div><div class="txt"><b>Train ${h.name} to Lv ${h.lv + 1} (${levelGold(h.lv)}g)</b>`
          + `<small>Pick a stat for +2. ${clsOf(h).name}s also gain +1 ${clsOf(h).main.map((k) => k.toUpperCase()).join(' and +1 ')}.</small></div>`
          + `<div style="display:flex;flex-wrap:wrap;gap:4px;width:100%">${btns}<button class="alt" data-act="g_untrain">Cancel</button></div></div>`;
      }
      const canTrain = h.xp >= levelXp(h.lv) && !heroBusy(g, h.id);
      const side = g.follow === h.id;
      const btn = `<button data-act="g_follow" data-id="${side ? 0 : h.id}" class="${side ? '' : 'alt'}" ${dis(side || !heroBusy(g, h.id))} title="Fights at your side">${side ? '\u{2714} With you' : 'Bring'}</button>`
        + `<button data-act="g_pick_train" data-id="${h.id}" ${dis(canTrain && d.field.gold >= levelGold(h.lv))}>Train</button>`
        + tonicButton(h);
      return row(clsOf(h).emoji, heroName(h), `${heroLine(h)}<br>${statLine(h)}${status(h)}`, btn);
    }).join('');
  }

  // the smallest tonic in the bag that this companion can use
  function tonicButton(h) {
    if (staminaOf(h, now(), min()) >= STAMINA_MAX) return '';
    const id = Object.keys(TONICS).find((k) => (d.field.bag[k] || 0) > 0);
    return id ? `<button class="alt" data-act="g_tonic" data-id="${h.id}" data-x="${id}" ${dis(true)} title="+${TONICS[id]} stamina">\u{1F9C3} +${TONICS[id]}</button>` : '';
  }
  const petTitle = (p) => `${p.name} the ${PETS[p.kind].name} <span style="color:${RARITY[p.rar].color};font-size:13px">${RARITY[p.rar].name}</span>`;
  const petPerk = (p) => (PETS[p.kind].prof === 'battle' ? `+${petBonus(p)}% damage when its companion fights at your side`
    : `+${petBonus(p)}% finds on ${PROFS[PETS[p.kind].prof].name} expeditions`);
  function pets() {
    const g = G(), eggs = d.field.bag.pet_egg || 0;
    let out = row('\u{1F95A}', `Hatch a Pet Egg (${HATCH_GOLD}g)`, `You have ${eggs} egg${eggs === 1 ? '' : 's'}. Expeditions sometimes find one. Pets ${g.pets.length}/${PET_MAX}.`,
      `<button data-act="g_hatch" ${dis(eggs > 0 && d.field.gold >= HATCH_GOLD && g.pets.length < PET_MAX)}>Hatch</button>`);
    for (const p of g.pets) {
      const owner = p.hero && heroById(g, p.hero);
      if (ui.petFor === p.id) {
        const btns = g.heroes.filter((h) => !heroBusy(g, h.id)).map((h) => `<button class="${p.hero === h.id ? '' : 'alt'}" data-act="g_pet" data-id="${p.id}" data-x="${h.id}" ${dis(true)}>${clsOf(h).emoji} ${h.name}</button>`).join('');
        out += `<div class="row" style="flex-wrap:wrap"><div class="ico">\u{1F43E}</div><div class="txt"><b>Who gets ${p.name}?</b><small>${petPerk(p)}</small></div>`
          + `<div style="display:flex;flex-wrap:wrap;gap:4px;width:100%">${btns}<button class="alt" data-act="g_pet" data-id="${p.id}" data-x="0" ${dis(!owner || !heroBusy(g, owner.id))}>Hall</button><button class="alt" data-act="g_petfor" data-id="0">Cancel</button></div></div>`;
        continue;
      }
      const out_ = g.walk === p.id;
      out += row('\u{1F43E}', petTitle(p), `${petPerk(p)} · ${owner ? `helps ${owner.name}` : 'helps nobody yet'}${out_ ? ' · walking with you' : ''}`,
        `<button data-act="g_walk" data-id="${out_ ? 0 : p.id}" class="${out_ ? '' : 'alt'}" ${dis(out_ || !owner || !heroBusy(g, owner.id))} title="Follows you around the map and fetches loot">${out_ ? '\u{2714} Walking' : 'Walk'}</button>`
        + `<button class="alt" data-act="g_petfor" data-id="${p.id}" ${dis(!owner || !heroBusy(g, owner.id))}>${owner ? 'Move' : 'Give'}</button>`);
    }
    if (!g.pets.length) out += '<p class="shop-empty">No pets yet. Each pet helps one companion: trade pets find more on their trade\'s expeditions, an Emberpup makes its companion hit harder.</p>';
    return out;
  }

  function quest() {
    const g = G();
    let out = '';
    for (const q of g.quests) {
      const X = EXPEDITIONS[q.where], back = now() >= q.end;
      const names = q.party.map((id) => (heroById(g, id) || { name: '?' }).name).join(', ');
      out += row(PROFS[X.prof].emoji, `${X.name} ×${q.n}`, `${names} · ${back ? 'back home!' : left(q.end - now()) + ' left'}`,
        `<button data-act="g_claim" data-id="${q.id}" ${dis(back)}>${back ? 'Collect' : 'Away'}</button>`);
    }
    // a new expedition
    const X = EXPEDITIONS[ui.where];
    out += '<div class="bag-sub" style="margin:6px 2px 0">Send an expedition</div>';
    out += `<div style="display:flex;gap:6px;flex-wrap:wrap">${Object.entries(EXPEDITIONS).map(([k, x]) =>
      `<button class="${ui.where === k ? '' : 'alt'}" data-act="g_where" data-id="${k}" style="flex:1;padding:7px;border:0;border-radius:10px;color:#fff;background:${ui.where === k ? '#3f8a3a' : '#8a5a10'};font:400 14px 'Lilita One',sans-serif;cursor:pointer">${PROFS[x.prof].emoji} ${x.name}</button>`).join('')}</div>`;
    const idle = g.heroes.filter((h) => !heroBusy(g, h.id));
    ui.sel = ui.sel.filter((id) => idle.some((h) => h.id === id));
    out += idle.length ? idle.map((h) => {
      const on = ui.sel.includes(h.id), st = staminaOf(h, now(), min());
      const match = h.prof === X.prof ? ' · <span style="color:#3f8a3a">trade match</span>' : '';
      return row(clsOf(h).emoji, heroName(h), `Lv ${h.lv} ${clsOf(h).name} · ${PROFS[h.prof].emoji} ${PROFS[h.prof].name} · \u{26A1}${st}/${STAMINA_MAX}${match}`,
        `<button data-act="g_sel" data-id="${h.id}" class="${on ? '' : 'alt'}" ${dis(on || ui.sel.length < PARTY_MAX)}>${on ? '\u{2714} In party' : 'Add'}</button>`);
    }).join('') : '<p class="shop-empty">Everyone is out. Recruit more companions, or wait for them to come home.</p>';
    const party = ui.sel.map((id) => heroById(g, id));
    const fast = party.length && party.every((h) => h.prof === X.prof);
    const mins = ui.n * X.minutes * (fast ? PROF_SPEED : 1);
    const ok = party.length && party.every((h) => staminaOf(h, now(), min()) >= X.stamina * ui.n);
    out += row('\u{1F9ED}', `${X.name}: ${ui.n} attempt${ui.n > 1 ? 's' : ''}`,
      `${Math.round(mins * 10) / 10} min${fast ? ' (trade match: faster)' : ''} · costs each ${X.stamina * ui.n} stamina · finds ${X.loot.map(([id]) => itemName(id)).join(', ')}`,
      `<button class="alt" data-act="g_n" data-id="-1" ${dis(ui.n > 1)}>−</button><button class="alt" data-act="g_n" data-id="1" ${dis(ui.n < ATTEMPTS_MAX)}>+</button>`
      + `<button data-act="g_quest" ${dis(ok)}>Send</button>`);
    // reports
    const reports = g.log.filter((l) => l.k === 'quest').slice(0, 4);
    if (reports.length) out += '<div class="bag-sub" style="margin:6px 2px 0">Recent reports</div>'
      + reports.map((l) => row('\u{1F4DC}', EXPEDITIONS[l.where].name, haul(l) || 'came back empty-handed')).join('');
    return out;
  }

  function summon() {
    const g = G();
    if (g.heroes.length < 2) return '<p class="shop-empty">Summoning takes two companions. Recruit another first.</p>';
    ui.sel = ui.sel.filter((id) => heroById(g, id)).slice(0, 2);
    let out = g.heroes.map((h) => {
      const on = ui.sel.includes(h.id), resting = (h.rest || 0) > now(), sums = maxSummons(h.gen) - h.sums;
      const why = heroBusy(g, h.id) ? 'away' : resting ? `resting ${left(h.rest - now())}` : sums <= 0 ? 'no summons left' : `${sums} summons left`;
      const usable = !heroBusy(g, h.id) && !resting && sums > 0;
      return row(clsOf(h).emoji, heroName(h), `Lv ${h.lv} ${clsOf(h).name} · Gen ${h.gen} · genes ${CLASSES[h.genes.cls[0]].name}/${CLASSES[h.genes.cls[1]].name}, ${PROFS[h.genes.prof[0]].name}/${PROFS[h.genes.prof[1]].name} · ${why}`,
        `<button data-act="g_sel" data-id="${h.id}" class="${on ? '' : 'alt'}" ${dis(on || (usable && ui.sel.length < 2))}>${on ? '\u{2714} Parent' : 'Pick'}</button>`);
    }).join('');
    if (ui.sel.length === 2) {
      const [A, B] = ui.sel.map((id) => heroById(g, id));
      const gold = summonGold(A, B), dew = summonDew(A, B), have = d.field.bag.root_dew || 0;
      const pair = [A.genes.cls[0], B.genes.cls[0]].sort().join('+');
      const hint = MUTATE[pair] ? ` · a ${CLASSES[MUTATE[pair]].name} might be born` : '';
      out = row('\u{1F331}', `Summon from ${A.name} and ${B.name}`, `${gold}g + ${dew} Root Dew (you have ${have}) · child is Gen ${Math.max(A.gen, B.gen) + 1}${hint}`,
        `<button data-act="g_summon" ${dis(d.field.gold >= gold && have >= dew && g.heroes.length < ROSTER_MAX)}>Summon</button>`) + out;
    } else out = `<p class="shop-empty">Pick two parents. Each child inherits a class and a trade from the parents' genes, sometimes a hidden one.</p>` + out;
    return out;
  }

  function recruit() {
    const g = G();
    const odds = RARITY.map((r) => `<span style="color:${r.color}">${r.name} ${r.weight}%</span>`).join(' · ');
    return row('\u{1F37A}', `Recruit a companion (${RECRUIT_GOLD}g)`, `Pip knows everyone in town looking for work: a Warden, Ranger, Sage or Rogue, with a trade. Odds: ${odds}`,
      `<button data-act="g_recruit" ${dis(d.field.gold >= RECRUIT_GOLD && g.heroes.length < ROSTER_MAX)}>Recruit</button>`)
      + row('\u{2139}️', 'How the guild works', 'Expeditions cost stamina (1 back every 20 min) and bring home ore, fish, herbs, crops, gold and Root Dew. Companions earn XP; train them here. Two companions can summon a new one with Root Dew.');
  }

  function click(b) {
    const k = b.dataset.act, id = b.dataset.id;
    if (k === 'g_where') { ui.where = id; ui.n = 1; }
    else if (k === 'g_sel') { const n = +id; ui.sel = ui.sel.includes(n) ? ui.sel.filter((x) => x !== n) : [...ui.sel, n]; }
    else if (k === 'g_n') ui.n = Math.max(1, Math.min(ATTEMPTS_MAX, ui.n + +id));
    else if (k === 'g_pick_train') ui.train = +id;
    else if (k === 'g_untrain') ui.train = null;
    else if (k === 'g_train') { ui.train = null; act({ t: 'g_train', hero: +id, stat: b.dataset.x }); }
    else if (k === 'g_claim') act({ t: 'g_claim', quest: +id });
    else if (k === 'g_quest') act({ t: 'g_quest', where: ui.where, party: [...ui.sel], n: ui.n });
    else if (k === 'g_summon') { const [a, c] = ui.sel; ui.sel = []; act({ t: 'g_summon', a, b: c }); }
    else if (k === 'g_recruit') act({ t: 'g_recruit' });
    else if (k === 'g_follow') act({ t: 'g_follow', hero: +id });
    else if (k === 'g_tonic') act({ t: 'g_tonic', hero: +id, id: b.dataset.x });
    else if (k === 'g_hatch') act({ t: 'g_hatch' });
    else if (k === 'g_walk') act({ t: 'g_walk', pet: +id });
    else if (k === 'g_petfor') ui.petFor = +id;
    else if (k === 'g_pet') { ui.petFor = 0; act({ t: 'g_pet', pet: +id, hero: +b.dataset.x }); }
    render();
  }
  const setTab = (t) => { ui.tab = t; ui.sel = []; ui.train = null; render(); };

  // The server's word came in (Ledger 'state'): take its guild.
  function sync(guild) {
    d.field.guild = normGuild(guild);
    pending = false;
    announce();
    render();
  }
  function rejected() { if (pending) { pending = false; render(); } }

  /* ---------- companions in the world ---------- */
  const views = new Map(); // hero id -> { hero, el, small, x, z, tx, tz, wait, anchor }
  function wanted() {
    const g = G(), out = [];
    for (const h of g.heroes) {
      const q = g.quests.find((x) => x.party.includes(h.id));
      if (!q && h.id === g.follow) { out.unshift({ h, q, anchor: d.player, side: true }); continue; } // at your side, wherever you are
      const anchor = d.anchors[q ? EXPEDITIONS[q.where].area : 'hall'];
      if (anchor) out.push({ h, q, anchor });
    }
    return out.slice(0, SHOWN_MAX);
  }
  function spotNear(a, r) {
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * Math.PI * 2, dist = 0.8 + Math.random() * r;
      const x = a.x + Math.cos(ang) * dist, z = a.z + Math.sin(ang) * dist;
      if (d.free(x, z)) return { x, z };
    }
    return { x: a.x, z: a.z };
  }
  // The companion at your side: keeps up with you, and fights whatever comes near you.
  function fight(h, v, dt) {
    const p = d.player, kit = allyKit(h, petOf(G(), h));
    v.cd = Math.max(0, v.cd - dt);
    if (Math.hypot(p.x - v.x, p.z - v.z) > 14) { v.x = p.x - Math.sin(p.heading) * 1.5; v.z = p.z - Math.cos(p.heading) * 1.5; } // fell far behind: catch up
    let foe = null, best = ALLY.aggro;
    if (d.canFight()) for (const m of d.monsters()) {
      if (m.dead || m.hp <= 0) continue;
      const dm = Math.hypot(m.x - p.x, m.z - p.z);
      if (dm < best) { best = dm; foe = m; }
    }
    let tx, tz, stop;
    if (foe) { tx = foe.x; tz = foe.z; stop = kit.range * 0.85; }
    else { tx = p.x - Math.sin(p.heading) * 1.6 + Math.cos(p.heading) * 0.9; tz = p.z - Math.cos(p.heading) * 1.6 - Math.sin(p.heading) * 0.9; stop = 0.3; }
    const dx = tx - v.x, dz = tz - v.z, dist = Math.hypot(dx, dz);
    if (dist > stop) {
      const speed = foe ? 4.5 : Math.min(7, 1.5 + dist * 2.2); // hurries when it falls behind
      const step = Math.min(dist - stop, speed * dt);
      v.x += (dx / dist) * step; v.z += (dz / dist) * step;
      v.heading = Math.atan2(dx, dz);
    } else if (foe) v.heading = Math.atan2(dx, dz);
    else v.heading += ((p.heading - v.heading + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 3);
    // attack: in range and off cooldown
    if (foe && dist <= kit.range + 0.3 && v.cd <= 0) {
      v.cd = kit.cd; v.atk = 0;
      const m = foe, dmg = allyHit(h, petOf(G(), h), Math.random());
      setTimeout(() => {
        if (m.dead) return;
        if (kit.ranged) d.burst(m.x, 0.8, m.z, h.cls === 'ranger' ? '#c8823a' : '#9ae8ff', 8);
        d.hitMonster(m, dmg, v, h.id);
      }, kit.ranged ? 260 : 160);
    }
    if (v.atk >= 0) { v.atk += dt / 0.35; if (v.atk >= 1) v.atk = -1; }
    v.hero.root.position.set(v.x, 0, v.z);
    v.hero.root.rotation.y = v.heading;
    v.hero.update(dt, { atk: v.atk, lookAt: foe || null });
    const pos = d.toScreen(v.x, d.heroH + 0.3, v.z);
    v.el.hidden = !pos;
    if (pos) v.el.style.transform = `translate(${pos[0]}px, ${pos[1]}px) translate(-50%, -100%)`;
    const say = `Lv ${h.lv} ${clsOf(h).name} · ${foe ? '\u{2694}️ fighting' : 'with you'}`;
    if (v.small.textContent !== say) v.small.textContent = say;
  }
  // A companion's pet trots along behind it (a fish swims beside it in the air, a little magic).
  let clock = 0;
  function petFollow(v, h, dt) {
    let pet = petOf(G(), h);
    if (pet && pet.id === G().walk && walker()) pet = null; // it's out walking with you instead
    if (v.pet && (!pet || v.pet.id !== pet.id)) { v.pet.g.removeFromParent(); v.pet = null; }
    if (!pet || !d.makePet) return;
    if (!v.pet) v.pet = { id: pet.id, g: d.makePet(pet.kind), x: v.x - 0.6, z: v.z - 0.6, heading: 0, fly: PETS[pet.kind].shape === 'fish' };
    const P = v.pet, bx = v.x - Math.sin(v.heading) * 0.8 + Math.cos(v.heading) * 0.45, bz = v.z - Math.cos(v.heading) * 0.8 - Math.sin(v.heading) * 0.45;
    const dx = bx - P.x, dz = bz - P.z, dist = Math.hypot(dx, dz);
    const moving = dist > 0.12;
    if (dist > 6) { P.x = bx; P.z = bz; }
    else if (moving) { const step = Math.min(dist, (1 + dist * 3.5) * dt); P.x += (dx / dist) * step; P.z += (dz / dist) * step; P.heading = Math.atan2(dx, dz); }
    const y = P.fly ? 0.55 + Math.sin(clock * 3 + pet.id) * 0.08 : moving ? Math.abs(Math.sin(clock * 11 + pet.id)) * 0.14 : 0;
    P.g.position.set(P.x, y, P.z);
    P.g.rotation.y = P.heading;
    P.g.scale.y = moving || P.fly ? 1 : 1 + Math.sin(clock * 2.5 + pet.id) * 0.04; // breathing
  }
  const drop = (id, v) => { v.hero.root.removeFromParent(); v.el.remove(); if (v.pet) v.pet.g.removeFromParent(); views.delete(id); };
  function tick(dt) {
    clock += dt;
    brain.tick(dt, walker());
    const want = wanted(), ids = new Set(want.map((w) => w.h.id));
    for (const [id, v] of views) if (!ids.has(id)) drop(id, v);
    for (const { h, q, anchor, side } of want) {
      let v = views.get(h.id);
      if (v && v.side !== !!side) { drop(h.id, v); v = null; } // changed role: start afresh
      if (!v) {
        const at = spotNear(anchor, 3);
        const el = document.createElement('div');
        el.className = 'tag';
        el.innerHTML = `<span style="color:${rar(h).color}">\u{25C6}</span> ${h.name}<small></small>`;
        d.labelsEl.appendChild(el);
        v = { hero: d.makeHero(heroLook(h)), el, small: el.querySelector('small'), x: at.x, z: at.z, tx: at.x, tz: at.z, wait: Math.random() * 3, anchor, heading: 0, side: !!side, cd: 0, atk: -1 };
        views.set(h.id, v);
      }
      if (side) { fight(h, v, dt); petFollow(v, h, dt); continue; }
      // amble between spots near the anchor; working companions stop to work
      const dx = v.tx - v.x, dz = v.tz - v.z, dist = Math.hypot(dx, dz);
      if (dist > 0.1) {
        const step = Math.min(dist, 1.5 * dt);
        const nx = v.x + (dx / dist) * step, nz = v.z + (dz / dist) * step;
        if (d.free(nx, nz)) { v.x = nx; v.z = nz; } else { v.tx = v.x; v.tz = v.z; }
        v.heading = Math.atan2(dx, dz);
      } else if ((v.wait -= dt) <= 0) {
        const s = spotNear(v.anchor, q ? 4 : 3.5);
        v.tx = s.x; v.tz = s.z; v.wait = 2 + Math.random() * 4;
        if (q && Math.random() < 0.5) v.hero.emote('happy', 1);
      }
      const p = d.player, near = Math.hypot(p.x - v.x, p.z - v.z);
      if (near < 3 && dist <= 0.1) v.heading = Math.atan2(p.x - v.x, p.z - v.z);
      v.hero.root.position.set(v.x, 0, v.z);
      v.hero.root.rotation.y = v.heading;
      v.hero.update(dt, { lookAt: near < 5 ? p : null });
      const pos = near < 16 ? d.toScreen(v.x, d.heroH + 0.3, v.z) : null;
      v.el.hidden = !pos;
      if (pos) v.el.style.transform = `translate(${pos[0]}px, ${pos[1]}px) translate(-50%, -100%)`;
      const say = q ? (now() >= q.end ? `${PROFS[h.prof].emoji} done! collect at Hero Hall` : `${PROFS[EXPEDITIONS[q.where].prof].emoji} working · ${left(q.end - now())}`)
        : `Lv ${h.lv} ${clsOf(h).name} · \u{26A1}${staminaOf(h, now(), min())}`;
      if (v.small.textContent !== say) v.small.textContent = say;
      petFollow(v, h, dt);
    }
  }

  return { render, click, setTab, sync, rejected, tick, get pending() { return pending; }, ui, views, brain };
}
