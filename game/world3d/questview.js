/* ============================================================================
   The quest log in the browser: the Quests panel (your log, the board, what
   you've finished) and the tracker under your portrait.

   The rules are quests.js, the same file the server runs. Here they're run at
   once so progress shows without waiting; online, the server's state (Ledger
   'state') replaces ours, so it always has the last word. Offline (solo) this
   is the only copy.
   ============================================================================ */
import { QUESTS, MAX_ACTIVE, normQuests, questEvent, questAction, available, ready, isDone, canTake } from './quests.js';

export function createQuestView(d) {
  /* d = { field, serverNow(), act(a), save(), refresh(), toast(msg), sfx, trackEl, nameOf(id), badge(on) } */
  d.field.qlog = normQuests(d.field.qlog);
  const L = () => d.field.qlog;
  const now = () => d.serverNow();
  let panel = null, tab = 'log';
  const add = (bag, id, n) => { bag[id] = (bag[id] || 0) + n; if (bag[id] <= 0) delete bag[id]; };
  const REASONS = {
    'quest log full': `Your quest log is full (${MAX_ACTIVE}). Hand one in or drop one.`,
    'not finished': 'Not finished yet', 'not yet': 'Finish the quest before it first',
    'done today': 'Done for today: it comes back at midnight UTC', 'already done': 'Already done',
  };

  const goalText = (Q, have) => {
    const n = Q.goal.n;
    return Q.goal.ev === 'sold' ? `${Math.min(have, n)}/${n} gold sold` : `${Math.min(have, n)}/${n}`;
  };
  const rewardText = (Q) => {
    const r = Q.reward, bits = [];
    if (r.gold) bits.push(`\u{1F4B0} ${r.gold}${Q.daily ? '' : ' (in-game only)'}`);
    if (r.xp) bits.push(`\u{2B50} ${r.xp} XP`);
    for (const [id, n] of Object.entries(r.items || {})) bits.push(`${n}\u{00D7} ${d.nameOf ? d.nameOf(id) : id.replace(/_/g, ' ')}`);
    return bits.join(' \u{00B7} ');
  };
  const readyIds = () => Object.keys(L().on).filter((id) => ready(L(), id));

  /** Something happened in the game that a quest may count (the same events the server counts). */
  function note(ev, key, n = 1) {
    const fresh = questEvent(L(), ev, key, n);
    if (!Object.keys(L().on).length) return;
    for (const id of fresh) { d.toast(`\u{2705} ${QUESTS[id].name}: done! Hand it in from the Quests panel.`); d.sfx && d.sfx.play('craft'); }
    d.save(); track(); render();
  }

  function act(a) {
    const before = d.field.gold;
    const why = questAction(L(), d.field, a, { now: now() }, add);
    if (why) { d.toast(REASONS[why] || why); return; }
    d.act(a); d.save();
    if (a.t === 'q_claim') {
      const Q = QUESTS[a.id];
      d.toast(`${Q.icon} ${Q.name} handed in: ${rewardText(Q)}`);
      d.sfx && d.sfx.play('coin');
      if (d.field.gold !== before) d.refresh();
    }
    if (a.t === 'q_take') d.sfx && d.sfx.play('ui');
    d.refresh(); track(); render();
  }

  // The server's word came in: take its quest log.
  function sync(qlog) { d.field.qlog = normQuests(qlog); track(); render(); }

  /* ---------- the tracker under the portrait ---------- */
  function track() {
    const el = d.trackEl;
    if (!el) return;
    const ids = Object.keys(L().on);
    el.hidden = !ids.length;
    el.innerHTML = ids.slice(0, 4).map((id) => {
      const Q = QUESTS[id], ok = ready(L(), id);
      return `<div class="${ok ? 'ok' : ''}"><b>${Q.icon} ${Q.name}</b> <span>${ok ? 'ready to hand in' : goalText(Q, L().on[id])}</span></div>`;
    }).join('') + (ids.length > 4 ? `<div><span>+${ids.length - 4} more</span></div>` : '');
    if (d.badge) d.badge(readyIds().length > 0);
  }

  /* ---------- the panel ---------- */
  const row = (ico, title, small, btns = '') => `<div class="row"><div class="ico">${ico}</div><div class="txt"><b>${title}</b><small>${small}</small></div>${btns}</div>`;
  const views = {
    log() {
      const ids = Object.keys(L().on);
      if (!ids.length) return '<p class="empty">No quests yet. Pick one from the Board tab.</p>';
      return ids.map((id) => {
        const Q = QUESTS[id], ok = ready(L(), id);
        return row(Q.icon, `${Q.name} <small>${ok ? '\u{2705}' : goalText(Q, L().on[id])}</small>`,
          `${Q.giver}: "${Q.text}"<br>Reward: ${rewardText(Q)}`,
          ok ? `<button data-act="q_claim" data-id="${id}">Hand in</button>` : `<button class="alt" data-act="q_drop" data-id="${id}">Drop</button>`);
      }).join('');
    },
    board() {
      const ids = available(L(), now());
      const full = Object.keys(L().on).length >= MAX_ACTIVE;
      if (!ids.length) return full ? `<p class="empty">Your log is full (${MAX_ACTIVE}).</p>` : '<p class="empty">Nothing new on the board. Finish what you have, or come back after midnight UTC for the dailies.</p>';
      return ids.map((id) => {
        const Q = QUESTS[id];
        return row(Q.icon, Q.name, `${Q.giver}: "${Q.text}"<br>Reward: ${rewardText(Q)}`, `<button data-act="q_take" data-id="${id}">Take</button>`);
      }).join('');
    },
    done() {
      const ids = Object.keys(QUESTS).filter((id) => isDone(L(), id, now()));
      if (!ids.length) return '<p class="empty">Nothing handed in yet.</p>';
      return ids.map((id) => row(QUESTS[id].icon, QUESTS[id].name, QUESTS[id].daily ? 'Done today' : 'Done')).join('');
    },
  };
  function render(els) {
    if (els) panel = els;
    if (!panel || !panel.open()) return;
    const n = Object.keys(L().on).length, nb = available(L(), now()).length;
    panel.title.textContent = 'Quests';
    panel.greet.textContent = `Quest log ${n}/${MAX_ACTIVE}. Take jobs from the board, play, then hand them in here.`;
    panel.tabs.innerHTML = [['log', `Log (${n})${readyIds().length ? ' \u{2757}' : ''}`], ['board', `Board (${nb})`], ['done', 'Done']]
      .map(([t, label]) => `<button data-tab="q:${t}" class="${tab === t ? 'on' : ''}">${label}</button>`).join('');
    panel.list.innerHTML = views[tab]();
  }
  const setTab = (t) => { if (views[t]) { tab = t; render(); } };
  const click = (b) => { if (/^q_/.test(b.dataset.act)) act({ t: b.dataset.act, id: b.dataset.id }); };

  track();
  return { note, sync, render, setTab, click, track, act, canTake: (id) => canTake(L(), id, now()), get tab() { return tab; } };
}
