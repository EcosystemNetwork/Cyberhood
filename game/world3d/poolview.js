/* ============================================================================
   Old Fenn's liquidity pools in the 3D world: the panel he opens by the
   fountain (press F next to him). Rules live in pools.js and run on the
   server; pools are shared by every player, so this panel shows what the
   server last said and waits for its answer on every action.

   Tabs: Swap (gold for goods or goods for gold), Provide (put both in, earn
   the 0.3% fee on every swap) and Shares (what yours are worth, take them out).
   ============================================================================ */
import { POOLS, POOL_IDS, FEE_BPS, MIN_SHARES, normPool, isOpen, priceOf, quote, resFor, valueOfShares } from './pools.js';

const SLIPPAGE = 0.02; // a swap goes through only if it pays at least 98% of the quote
const TABS = [['swap', 'Swap'], ['add', 'Provide'], ['shares', 'Shares']];
const REASONS = {
  'not enough gold': 'Not enough gold', 'not enough': "You don't have that many", 'not enough shares': "You don't hold that many shares",
  'price moved': 'Someone traded first and the price moved. Check the new quote', 'bag full': 'Your bag has no room for that many',
  'pool empty': 'That pool has nothing in it yet. Provide some first!', 'too small': 'Too small to trade', 'too big': 'The pool is too small for that',
  'bad amount': 'Enter a whole number', 'Busy, try again': 'Old Fenn is busy. Try again',
};

export function createPoolView(d) {
  /* d = { field, online(), toast(msg), sfx, iconOf(id), nameOf(id), refresh(), rerender() } */
  const ui = { tab: 'swap', sel: null, side: 'buy', amt: '', amt2: '' };
  let pools = Object.fromEntries(POOL_IDS.map((id) => [id, normPool(null)]));
  let loaded = false, busy = false, els = null;

  const fmt = (n) => (n >= 100 ? Math.round(n).toLocaleString() : n >= 10 ? n.toFixed(1) : n.toFixed(2));
  const lp = () => d.field.lp || {};
  const have = (id) => d.field.bag[id] || 0;
  const num = (v) => (/^\d+$/.test(String(v).trim()) ? Number(v) : 0);

  async function load() {
    const r = await window.Ledger.pools();
    if (r && Array.isArray(r.pools)) { for (const p of r.pools) pools[p.id] = normPool(p); loaded = true; }
    d.rerender();
  }

  /* ---------- the panel ---------- */
  function render(e) {
    els = e;
    e.title.textContent = "Old Fenn's Pools";
    e.greet.textContent = d.online()
      ? `Old Fenn: "Gold on one side, goods on the other. The price is whatever all of you make it. I keep ${FEE_BPS / 100}% of each swap for those who stock my pools."`
      : 'Old Fenn: "My pools are shared by every adventurer. Sign in to trade with them."';
    e.tabs.innerHTML = TABS.map(([k, label]) => `<button data-tab="p_${k}" class="${ui.tab === k ? 'on' : ''}">${label}</button>`).join('');
    if (!d.online()) { e.list.innerHTML = '<p class="shop-empty">Pools need the server. Sign in (not solo) to use them.</p>'; return; }
    if (!loaded) { e.list.innerHTML = '<p class="shop-empty">Old Fenn is counting the pools…</p>'; return; }
    const ids = ui.tab === 'shares' ? POOL_IDS.filter((id) => lp()[id])
      : ui.tab === 'swap' ? [...POOL_IDS].sort((a, b) => isOpen(pools[b]) - isOpen(pools[a])) : POOL_IDS; // open pools first
    if (!ids.length) { e.list.innerHTML = '<p class="shop-empty">You have no shares yet. Provide gold and goods to a pool and earn from every swap.</p>'; return; }
    e.list.innerHTML = ids.map(row).join('');
    if (ui.sel) { const inp = e.list.querySelector('input[data-pool-amt]'); if (inp && document.activeElement !== inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
  }

  function row(id) {
    const p = pools[id], open = isOpen(p), mine = lp()[id] || 0;
    let info;
    if (ui.tab === 'shares') {
      const v = valueOfShares(p, mine);
      info = `${mine.toLocaleString()} shares (${fmt((100 * mine) / p.shares)}% of the pool) · worth ${v.gold}g + ${v.res} ${d.nameOf(id)}`;
    } else info = open ? `${fmt(priceOf(p))}g each · pool: ${p.gold.toLocaleString()}g + ${p.res.toLocaleString()} · you have ${have(id)}` : `No pool yet · you have ${have(id)}`;
    const head = `<div class="row${ui.sel === id ? ' on' : ''}"><div class="ico">${d.iconOf(id)}</div><div class="txt"><b>${d.nameOf(id)}</b><small>${info}</small></div>`
      + (ui.sel === id ? '<button class="alt" data-act="p_close">Close</button>' : `<button data-act="p_pick" data-id="${id}" ${ui.tab === 'swap' && !open ? 'disabled' : ''}>${ui.tab === 'swap' ? 'Trade' : ui.tab === 'add' ? 'Provide' : 'Withdraw'}</button>`)
      + '</div>';
    return head + (ui.sel === id ? `<div class="pool-form">${form(id)}</div>` : '');
  }

  function form(id) {
    const p = pools[id], name = d.nameOf(id);
    const go = (label, ok) => `<button data-act="p_go" ${ok && !busy ? '' : 'disabled'}>${busy ? '…' : label}</button>`;
    if (ui.tab === 'swap') {
      const n = num(ui.amt), out = quote(p, ui.side, n), buy = ui.side === 'buy';
      const ok = n > 0 && out > 0 && (buy ? d.field.gold >= n : have(id) >= n);
      const note = !n ? `Pay with ${buy ? 'gold' : name}` : out < 1 ? 'Too small to trade' : `You get about <b>${out} ${buy ? name : 'gold'}</b> (${fmt(buy ? n / out : out / n)}g each)`
        + (buy ? (d.field.gold < n ? ' · not enough gold' : '') : (have(id) < n ? ` · you have ${have(id)}` : ''));
      return `<div class="pool-side"><button data-act="p_side" data-side="buy" class="${buy ? 'on' : ''}">Buy ${name}</button><button data-act="p_side" data-side="sell" class="${buy ? '' : 'on'}">Sell ${name}</button></div>`
        + `<label>${buy ? 'Gold' : name} in <input data-pool-amt="1" inputmode="numeric" value="${ui.amt}" placeholder="0"></label>`
        + `<button class="alt" data-act="p_max">Max</button><p class="pool-note">${note}</p>${go(buy ? 'Buy' : 'Sell', ok)}`;
    }
    if (ui.tab === 'add') {
      const first = !isOpen(p), g = num(ui.amt);
      if (first) {
        const r = num(ui.amt2), shares = Math.floor(Math.sqrt(g * r));
        const ok = g > 0 && r > 0 && shares > MIN_SHARES && d.field.gold >= g && have(id) >= r;
        return `<p class="pool-note">You're the first! Your deposit sets the price. Shops pay about ${POOLS[id]}g for one.</p>`
          + `<label>Gold <input data-pool-amt="1" inputmode="numeric" value="${ui.amt}" placeholder="0"></label>`
          + `<label>${name} <input data-pool-amt="2" inputmode="numeric" value="${ui.amt2}" placeholder="0"></label>`
          + `<p class="pool-note">${g && r ? `Price: ${fmt(g / r)}g each.${shares <= MIN_SHARES ? ' Too small: put in more.' : ` ${MIN_SHARES} shares stay with Old Fenn for good.`}` : ''}</p>${go('Open the pool', ok)}`;
      }
      const r = resFor(p, g), shares = g ? Math.floor((g * p.shares) / p.gold) : 0;
      const ok = g > 0 && shares > 0 && d.field.gold >= g && have(id) >= r;
      return `<label>Gold <input data-pool-amt="1" inputmode="numeric" value="${ui.amt}" placeholder="0"></label><button class="alt" data-act="p_max">Max</button>`
        + `<p class="pool-note">${g ? `Also takes <b>${r} ${name}</b> (you have ${have(id)}) · you get ${shares.toLocaleString()} shares` : `Goes in at the pool's ratio: ${fmt(priceOf(p))}g per ${name}`}</p>${go('Provide', ok)}`;
    }
    const mine = lp()[id] || 0, s = Math.min(num(ui.amt), mine), v = valueOfShares(p, s);
    return `<label>Shares <input data-pool-amt="1" inputmode="numeric" value="${ui.amt}" placeholder="0"></label><button class="alt" data-act="p_max">All</button>`
      + `<p class="pool-note">${s ? `You get <b>${v.gold}g + ${v.res} ${name}</b>` : `You hold ${mine.toLocaleString()}`}</p>${go('Withdraw', s > 0 && num(ui.amt) <= mine)}`;
  }

  // Typing updates the numbers below the box without rebuilding the input (keeps focus).
  function input(el) {
    if (!el.matches('input[data-pool-amt]')) return;
    const v = el.value.replace(/\D/g, '').slice(0, 10);
    if (el.dataset.poolAmt === '2') ui.amt2 = v; else ui.amt = v;
    if (!els || !ui.sel) return;
    const f = els.list.querySelector('.pool-form');
    if (!f) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = form(ui.sel);
    f.querySelectorAll('.pool-note').forEach((n, i) => { n.innerHTML = tmp.querySelectorAll('.pool-note')[i].innerHTML; });
    const go = f.querySelector('[data-act="p_go"]'), go2 = tmp.querySelector('[data-act="p_go"]');
    if (go && go2) go.disabled = go2.disabled;
  }

  async function submit() {
    const id = ui.sel, p = pools[id], n = num(ui.amt);
    let body;
    if (ui.tab === 'swap') body = { op: 'swap', id, side: ui.side, n, min: Math.max(1, Math.floor(quote(p, ui.side, n) * (1 - SLIPPAGE))) };
    else if (ui.tab === 'add') body = { op: 'add', id, gold: n, res: isOpen(p) ? Math.ceil(resFor(p, n) * (1 + SLIPPAGE)) : num(ui.amt2) };
    else body = { op: 'remove', id, shares: n };
    busy = true; d.rerender();
    const r = await window.Ledger.pool(body);
    busy = false;
    if (r.data && r.data.pool) pools[id] = normPool(r.data.pool);
    if (r.status !== 200) { d.toast(REASONS[r.data.error] || r.data.error || 'Old Fenn shakes his head. Try again'); d.rerender(); return; }
    const done = r.data.done || {}, name = d.nameOf(id);
    if (body.op === 'swap') d.toast(body.side === 'buy' ? `Bought ${done.res} ${name} for ${-done.gold}g` : `Sold ${-done.res} ${name} for ${done.gold}g`);
    else if (body.op === 'add') d.toast(`Added ${-done.gold}g and ${-done.res} ${name}: ${done.shares} shares`);
    else d.toast(`Took out ${done.gold}g and ${done.res} ${name}`);
    if (d.sfx) d.sfx.play(body.op === 'swap' && body.side === 'buy' ? 'buy' : 'coin');
    ui.amt = ''; ui.amt2 = '';
    if (body.op === 'remove' && !lp()[id]) ui.sel = null;
    d.refresh(); d.rerender();
  }

  function click(b) {
    const act = b.dataset.act;
    if (act === 'p_pick') { ui.sel = b.dataset.id; ui.amt = ''; ui.amt2 = ''; }
    else if (act === 'p_close') ui.sel = null;
    else if (act === 'p_side') { ui.side = b.dataset.side; ui.amt = ''; }
    else if (act === 'p_max') {
      const id = ui.sel, p = pools[id];
      if (ui.tab === 'swap') ui.amt = String(ui.side === 'buy' ? d.field.gold : have(id));
      else if (ui.tab === 'add') { // the most gold whose matching goods you also have
        const byRes = isOpen(p) ? Math.floor((have(id) * p.gold) / p.res) : d.field.gold;
        ui.amt = String(Math.max(0, Math.min(d.field.gold, byRes)));
      } else ui.amt = String(lp()[id] || 0);
    } else if (act === 'p_go') { if (!busy && ui.sel) submit(); return; }
    d.rerender();
  }

  return {
    ui,
    open(tab) { if (tab) ui.tab = tab; ui.sel = null; if (d.online()) load(); },
    setTab(t) { ui.tab = t; ui.sel = null; ui.amt = ''; ui.amt2 = ''; d.rerender(); },
    render, click, input,
  };
}
