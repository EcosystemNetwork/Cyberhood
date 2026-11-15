#!/usr/bin/env node
// Checks a deployed game: is the new API live, has the database update been run, are the keys
// set? Prints what's missing and how to fix it. Read-only unless you pass --signup.
//
//   node tools/healthcheck.js                     (the domain in CNAME)
//   node tools/healthcheck.js https://example.com
//   node tools/healthcheck.js --signup            also make a throwaway account and play a little
//
// Exit code 0 when everything passes, 1 otherwise.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const SIGNUP = args.includes('--signup');
let base = args.find((a) => /^https?:\/\//.test(a));
if (!base) {
  try { base = 'https://' + fs.readFileSync(path.join(__dirname, '..', 'CNAME'), 'utf8').trim(); } catch (e) {}
}
if (!base) { console.error('Usage: node tools/healthcheck.js https://your-site'); process.exit(2); }
base = base.replace(/\/+$/, '');

const results = [];
const check = (ok, name, fix) => { results.push({ ok, name, fix }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !fix ? '' : `\n      -> ${fix}`}`); return ok; };
const warn = (name, fix) => console.log(`WARN  ${name}\n      -> ${fix}`);

async function get(p, init) {
  try {
    const r = await fetch(base + p, { ...init, signal: AbortSignal.timeout(15000) });
    let body = null;
    try { body = await r.json(); } catch (e) {}
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: null, err: e.message }; }
}

(async () => {
  console.log(`Checking ${base}\n`);

  const page = await get('/game/');
  check(page.status === 200, 'the game page loads', page.status ? `got HTTP ${page.status}` : `can't reach the site (${page.err})`);

  const ledger = await get('/game/lib/ledger.js');
  const economy = await get('/game/world3d/economy.js');
  check(ledger.status === 200 && economy.status === 200, 'the new game files are deployed (ledger.js, economy.js)',
    'deploy the branch with the server economy (PR #4)');

  const cfg = await get('/api/game/config');
  const newApi = check(cfg.status === 200, 'the new game API is live', cfg.status === 405
    ? 'the site still runs the old API: merge PR #4 and redeploy'
    : cfg.status === 500 ? 'the API says it is not set up: set SUPABASE_SERVICE_KEY in Netlify' : `got HTTP ${cfg.status}`);
  if (newApi) {
    if (cfg.body && cfg.body.realtime) check(true, `multiplayer uses the accounts' Supabase project (${cfg.body.realtime.url})`);
    else warn('multiplayer still uses the old Supabase project', "set SUPABASE_ANON_KEY in Netlify (the accounts project's public anon key) and redeploy");
  }

  const farms = await get('/api/game/farms');
  if (newApi) {
    check(farms.status === 200, 'the database update has been run', farms.status === 503
      ? 'run supabase/migrations/20261114_server_economy.sql in the Supabase SQL editor (and any newer files in supabase/migrations)'
      : farms.status === 500 ? 'the API failed: check the function logs in Netlify, and that SUPABASE_SERVICE_KEY is right'
        : `got HTTP ${farms.status}`);
    if (farms.status === 200) console.log(`      ${farms.body.farms.length} claimed plot(s)`);
  }

  const me = await get('/api/game/me');
  check(me.status === 401, 'signed-out requests are refused', `expected 401, got ${me.status}`);

  if (SIGNUP && newApi && farms.status === 200) {
    const username = 'hc_' + Date.now().toString(36);
    const post = (a, body, key) => get('/api/game/' + a, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });
    const su = await post('signup', { username, password: 'healthcheck-' + Math.random().toString(36).slice(2) });
    if (check(su.status === 200, `sign-up works (made ${username})`, su.body && su.body.error)) {
      const key = su.body.key;
      check(Array.isArray(su.body.inventory) && su.body.inventory.length === 0, 'a new account owns no gear (dev perks are off)',
        'GAME_DEV is set on the live site: remove it from the Netlify environment');
      const sv = await post('save', { character: { name: 'Health', cls: 'knight', skin: 1, hs: 'short', hc: 0 } }, key);
      check(sv.status === 200 && sv.body.inventory.includes('iron_sword'), 'the first character gets its class kit', sv.body && sv.body.error);
      const act = await post('act', { actions: [{ t: 'chest', id: 'wreck' }, { t: 'kill', m: 'slime' }] }, key);
      check(act.status === 200 && act.body.results[0] === '' && act.body.state.econ.gold > 0, 'actions are saved to the account', act.body && act.body.error);
      check(act.status === 200 && act.body.results[1] !== '', 'kills reported without hits are refused', 'GAME_DEV is set on the live site');
      await post('logout', {}, key);
      console.log(`      (the test account ${username} was left in place; delete it from game_players if you like)`);
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed ? `${failed} check(s) failed` : 'All checks passed'}${SIGNUP ? '' : ' (add --signup to also test sign-up and saving)'}`);
  process.exit(failed ? 1 : 0);
})();
