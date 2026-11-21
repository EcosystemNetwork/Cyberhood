// The dev server's mock of the Robinhood Chain tables and functions
// (supabase/migrations/20261120_chain_bridge.sql): just the PostgREST subset that
// supabase/functions/game/wallet.js uses. game-dev-server.js routes /rest/v1/game_wallets,
// game_withdrawals, game_deposits, game_chain_state and the game_withdraw / game_credit /
// game_refund RPCs here. Kept in a JSON file next to the main mock DB.
const fs = require('fs');

const TABLES = {
  game_wallets: { pk: 'address', unique: ['player_id'], defaults: () => ({ linked_at: new Date().toISOString() }) },
  game_withdrawals: { pk: 'nonce', unique: [], defaults: () => ({ status: 'pending', tx: null, created_at: new Date().toISOString() }) },
  game_deposits: { pk: 'id', unique: [], defaults: () => ({ credited_to: null, created_at: new Date().toISOString() }) },
  game_chain_state: { pk: 'key', unique: [], defaults: () => ({}) },
};

function makeChainMock(file, players, savePlayers) {
  let db = {};
  try { if (fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  for (const t of Object.keys(TABLES)) db[t] = db[t] || [];
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(db, null, 2)); } catch (e) {} };

  const filtersOf = (params) => {
    const out = [];
    for (const [k, v] of params) {
      if (k === 'select' || k === 'limit' || k === 'order') continue;
      const m = /^(eq|lt|gt|is)\.([\s\S]*)$/.exec(v);
      if (m) out.push([k, m[1], m[2]]);
    }
    return out;
  };
  const num = (x) => (x !== null && x !== '' && !isNaN(Number(x)) ? Number(x) : x);
  const match = (row, fs) => fs.every(([f, op, v]) => {
    const x = row[f];
    if (op === 'eq') return String(x) === v;
    if (op === 'is') return v === 'null' ? x === null || x === undefined : String(x) === v;
    if (op === 'lt') return num(x) < num(v);
    if (op === 'gt') return num(x) > num(v);
    return false;
  });
  const clash = (t, row, other) => {
    const spec = TABLES[t];
    return [spec.pk, ...spec.unique].some((c) => other !== row && String(other[c]) === String(row[c]));
  };

  function table(t, method, params, raw, prefer, respond) {
    const rows = db[t];
    const fs = filtersOf(params);
    if (method === 'GET') {
      let hit = rows.filter((r) => match(r, fs));
      if (params.get('limit')) hit = hit.slice(0, Number(params.get('limit')));
      return respond(200, hit);
    }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) {}
    if (method === 'POST') {
      const row = { ...TABLES[t].defaults(), ...body };
      const dup = rows.find((r) => clash(t, row, r));
      if (dup) {
        if (/resolution=ignore-duplicates/.test(prefer)) return respond(201, []);
        if (/resolution=merge-duplicates/.test(prefer) && String(dup[TABLES[t].pk]) === String(row[TABLES[t].pk])) {
          Object.assign(dup, body); save(); return respond(201, [dup]);
        }
        return respond(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
      }
      rows.push(row); save();
      return respond(201, [row]);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => match(r, fs));
      for (const r of hit) Object.assign(r, body);
      save();
      return respond(200, hit);
    }
    if (method === 'DELETE') {
      const keep = rows.filter((r) => !match(r, fs));
      const gone = rows.length - keep.length;
      db[t] = keep; save();
      return respond(200, gone ? [{}] : []);
    }
    return respond(405, { error: 'method not allowed' });
  }

  // compare-and-swap on the player's econ_rev, like the SQL functions
  const casPlayer = (a) => {
    const p = players().find((r) => String(r.id) === String(a.p_id));
    if (!p || (p.econ_rev || 0) !== a.p_rev) return null;
    return p;
  };
  const write = (p, a, extra = {}) => { Object.assign(p, { econ: a.p_econ, econ_rev: a.p_rev + 1, inventory: a.p_inventory, ...extra }); savePlayers(); };

  const RPC = {
    game_withdraw(a) {
      const p = casPlayer(a);
      if (!p) return false;
      write(p, a, { character: a.p_character });
      db.game_withdrawals.push({ ...TABLES.game_withdrawals.defaults(), ...a.w, player_id: p.id, amount: Number(a.w.amount), deadline: Number(a.w.deadline) });
      save();
      return true;
    },
    game_credit(a) {
      const d = db.game_deposits.find((r) => r.id === a.p_deposit && r.credited_to == null);
      if (!d) return 'done';
      const p = casPlayer(a);
      if (!p) return 'stale';
      write(p, a);
      d.credited_to = p.id; save();
      return 'ok';
    },
    game_refund(a) {
      const w = db.game_withdrawals.find((r) => r.nonce === a.p_nonce && String(r.player_id) === String(a.p_id) && r.status === 'pending');
      if (!w) return 'done';
      const p = casPlayer(a);
      if (!p) return 'stale';
      write(p, a);
      w.status = 'refunded'; save();
      return 'ok';
    },
  };

  // Returns true if it answered the request.
  return function handle(pathname, method, params, raw, prefer, respond) {
    const m = /^\/rest\/v1\/(game_wallets|game_withdrawals|game_deposits|game_chain_state)$/.exec(pathname);
    if (m) { table(m[1], method, params, raw, prefer || '', respond); return true; }
    const r = /^\/rest\/v1\/rpc\/(game_withdraw|game_credit|game_refund)$/.exec(pathname);
    if (r) {
      let a = {};
      try { a = JSON.parse(raw || '{}'); } catch (e) {}
      respond(200, RPC[r[1]](a));
      return true;
    }
    return false;
  };
}

module.exports = { makeChainMock };
