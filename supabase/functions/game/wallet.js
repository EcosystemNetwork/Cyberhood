/* Robinhood Chain for the game API: linked wallets, withdrawals and deposits.

   Gameplay stays on the server (api.js); the chain is where players can take what they own.

   Link:     the player signs a Sign-In with Ethereum message (EIP-4361) with their wallet; the
             wallet is then tied to their account (one each way). A linked wallet can also sign in.
   Withdraw: gold, a resource (C.RESOURCES) or a piece of gear leaves the account and the server signs an EIP-712 Claim for
             it (GameBridge.sol). The player submits the claim on-chain and the token is minted.
             The debit and the withdrawal record are one database transaction (game_withdraw).
   Deposit:  the player burns a token at the bridge. The chain sync sees the Deposited event and
             credits the account linked to the sending wallet (game_credit, once per event).
   Refund:   a claim not used by its deadline is given back (game_refund), after checking on-chain
             that its nonce really is unused. The contract refuses it after the deadline, so a
             refunded claim can never also be minted.

   Plots (ERC-721) are supported by the contracts; withdrawing one also has to move the farm that
   sits on it, so the server doesn't offer it yet (deposits of plots wait, uncredited).

   Tables and functions: supabase/migrations/20261120_chain_bridge.sql.
   Shared chain data (networks, ABI, the Claim type): ./rules/chain.js (= game/lib/chain.js). */
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer'; // a global in node, but not in Deno (the Edge Function)
import { createPublicClient, http, keccak256, toBytes, getAddress, isAddress, verifyMessage, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import * as C from './rules/chain.js';

// An item's ERC-1155 token id: keccak256 of its game id (GameItems.sol).
export const itemTokenId = (id) => BigInt(keccak256(toBytes(id)));

const NONCE_MS = 10 * 60 * 1000;   // a SIWE nonce is good for this long
const SYNC_RANGE = 2000n;          // blocks per getLogs
const MAX_GOLD = 1e9;              // per withdrawal
const PAGE = 100;                  // deposits / refunds handled per sync
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/* cfg: {
     chainId      Robinhood Chain id (CHAIN_ID; default testnet 46630)
     rpc          JSON-RPC URL for the server (CHAIN_RPC; default the chain's public RPC)
     bridge       GameBridge address (CHAIN_BRIDGE). Without it and the signer, chain features are off.
     signerKey    the voucher signer's private key (CHAIN_SIGNER_KEY), holder of SIGNER_ROLE
     syncKey      shared secret the scheduler sends to /chainsync (CHAIN_SYNC_KEY)
     confirmations blocks to wait before reading events (CHAIN_CONFIRMATIONS; default 2)
     startBlock   the bridge's deploy block, where the first sync starts (CHAIN_START_BLOCK)
     domains      hosts SIWE messages may come from (CHAIN_SIWE_DOMAINS, comma-separated)
     linkLockHours how long a newly linked wallet waits before withdrawing (CHAIN_LINK_LOCK_HOURS; default 72)
     dailyValue   most an account can withdraw a day, in gold worth (CHAIN_DAILY_VALUE; default 10000)
     dex          JSON { router, stocks: { TSLA: address, ... } } overriding the network's
                  Uniswap router and stock tokens in rules/chain.js (CHAIN_DEX; tests use it) }
   deps: from api.js: { G, E, DEV, BASE_URL, SERVICE_KEY, ROW, within, ownedItems, cleanCharacter,
     stateOf, loginAs } */
export function makeWallet(cfg, deps) {
  const { G, E, DEV, BASE_URL, SERVICE_KEY, ROW, within, ownedItems, cleanCharacter, stateOf, loginAs } = deps;
  const net = C.chainById(cfg.chainId || C.CHAINS[C.DEFAULT_NETWORK].id);
  const CHAIN_ID = net ? net.id : Number(cfg.chainId);
  const RPC = cfg.rpc || (net && net.rpcUrls.default.http[0]) || null;
  const BRIDGE = cfg.bridge && isAddress(cfg.bridge) ? getAddress(cfg.bridge) : null;
  const signer = cfg.signerKey && /^0x[0-9a-fA-F]{64}$/.test(cfg.signerKey) ? privateKeyToAccount(cfg.signerKey) : null;
  const ENABLED = !!(BRIDGE && signer);
  const CONFIRMATIONS = BigInt(cfg.confirmations ?? 2);
  const START_BLOCK = BigInt(cfg.startBlock || 0);
  const DOMAINS = String(cfg.domains || 'taproot.love,www.taproot.love').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  // cacheTime 0: each sync must see the real head, not one cached from a few seconds ago
  let dexCfg = null;
  try { dexCfg = cfg.dex ? (typeof cfg.dex === 'string' ? JSON.parse(cfg.dex) : cfg.dex) : null; } catch (e) { dexCfg = null; }
  const DEX = {
    router: (dexCfg && dexCfg.router) || (net && net.dex && net.dex.router) || null,
    stocks: (dexCfg && dexCfg.stocks) || (net && net.stocks) || {},
  };
  const client = RPC ? createPublicClient({ transport: http(RPC, { retryCount: 1 }), cacheTime: 0 }) : null;

  // token id -> game item id, for deposits
  const TOKEN_ITEM = new Map(Object.keys(G.ITEMS).map((id) => [itemTokenId(id).toString(), id]));
  // token id -> resource id (the bridge's resource id is the same keccak256 of the game id)
  const TOKEN_RESOURCE = new Map(Object.keys(C.RESOURCES).map((id) => [itemTokenId(id).toString(), id]));
  const BAG_MAX = E.BAG_MAX || 99999;
  const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  const LINK_LOCK_MS = num(cfg.linkLockHours, 72) * 3600000;
  const DAILY_VALUE = num(cfg.dailyValue, 10000);
  // what a withdrawal is worth in gold, for the daily cap (gear no shop sells counts as UNPRICED_GEAR)
  const UNPRICED_GEAR = 500;
  const valueOut = (kind, item, n) => (kind === 'gold' ? n : n * (E.valueOf(item) ?? (kind === 'item' ? UNPRICED_GEAR : 0)));

  /* ---- the database (PostgREST, service key) ---- */
  async function rest(table, query = '', init = {}) {
    const res = await fetch(`${BASE_URL}/rest/v1/${table}${query}`, {
      ...init,
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    return { status: res.status, data };
  }
  async function rpc(fn, args) {
    const r = await rest('rpc/' + fn, '', { method: 'POST', body: JSON.stringify(args) });
    if (r.status === 404) throw new NotReady();
    if (r.status >= 300) throw new Error(fn + ' failed: ' + r.status);
    return r.data;
  }
  async function player(id) {
    const r = await rest('game_players', `?id=eq.${encodeURIComponent(id)}&select=${ROW}`);
    return (r.data && r.data[0]) || null;
  }
  async function linkOf(playerId) { // { address, linked_at } or null
    const r = await rest('game_wallets', `?player_id=eq.${encodeURIComponent(playerId)}&select=address,linked_at`);
    if (r.status === 404) throw new NotReady();
    return (r.data && r.data[0]) || null;
  }
  async function walletOf(playerId) {
    const r = await rest('game_wallets', `?player_id=eq.${encodeURIComponent(playerId)}&select=address`);
    if (r.status === 404) throw new NotReady();
    return (r.data && r.data[0] && r.data[0].address) || null;
  }
  async function ownerOf(address) {
    const r = await rest('game_wallets', `?address=eq.${address}&select=player_id`);
    if (r.status === 404) throw new NotReady();
    return (r.data && r.data[0] && r.data[0].player_id) || null;
  }

  /* ---- Sign-In with Ethereum ----
     The nonce carries its own proof: time + random + an HMAC over (purpose, account, time, random),
     so the server keeps nothing until it's used; then game_hit() makes each one single-use. */
  const nonceKey = crypto.createHash('sha256').update('siwe-nonce\0' + SERVICE_KEY).digest();
  const mac = (purpose, uid, body) => crypto.createHmac('sha256', nonceKey).update(`${purpose}|${uid}|${body}`).digest('hex').slice(0, 24);
  function makeNonce(purpose, uid = '') {
    const body = Date.now().toString(16).padStart(12, '0') + crypto.randomBytes(8).toString('hex');
    return body + mac(purpose, uid, body);
  }
  function nonceOk(nonce, purpose, uid = '') {
    if (!/^[0-9a-f]{52}$/.test(nonce)) return false;
    const body = nonce.slice(0, 28), at = parseInt(body.slice(0, 12), 16);
    const want = Buffer.from(mac(purpose, uid, body)), got = Buffer.from(nonce.slice(28));
    return crypto.timingSafeEqual(want, got) && Date.now() - at < NONCE_MS && at - Date.now() < 60000;
  }
  const domainOk = (d) => {
    const host = String(d || '').toLowerCase();
    if (DOMAINS.includes(host)) return true;
    return DEV && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host); // local play
  };
  // The wallet address (lower-case) that signed a valid message for this purpose, or null.
  async function verifySiwe(message, signature, purpose, uid = '') {
    if (typeof message !== 'string' || message.length > 2000 || typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) return null;
    let m;
    try { m = parseSiweMessage(message); } catch (e) { return null; }
    if (!m.address || !isAddress(m.address) || m.chainId !== CHAIN_ID || m.statement !== C.SIWE_STATEMENT[purpose]) return null;
    if (!domainOk(m.domain) || !nonceOk(String(m.nonce || ''), purpose, String(uid))) return null;
    if (!validateSiweMessage({ message: m, time: new Date() })) return null; // expiry / not-before
    let ok = false;
    try {
      // through the chain when we can: also accepts smart-contract wallets (ERC-1271 / ERC-6492)
      ok = client && !DEV ? await client.verifyMessage({ address: m.address, message, signature })
        : await verifyMessage({ address: m.address, message, signature });
    } catch (e) { ok = false; }
    if (!ok) return null;
    if (!(await within('siwe', m.nonce))) return null; // already used
    return getAddress(m.address).toLowerCase();
  }
  const siweInfo = (purpose, uid) => ({ nonce: makeNonce(purpose, uid), chainId: CHAIN_ID, statement: C.SIWE_STATEMENT[purpose] });

  /* ---- vouchers ---- */
  async function voucherOf(w) {
    const message = {
      to: getAddress(w.wallet), kind: C.KIND[w.kind], id: BigInt(w.token_id), amount: BigInt(w.amount),
      nonce: BigInt(w.nonce), deadline: BigInt(w.deadline),
    };
    const signature = await signer.signTypedData({ domain: C.claimDomain(CHAIN_ID, BRIDGE), types: C.CLAIM_TYPES, primaryType: 'Claim', message });
    const claim = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
    return { claim, signature, bridge: BRIDGE, chainId: CHAIN_ID, item: w.item || null, status: w.status || 'pending' };
  }

  // The account's real gear list (never the dev "owns everything" list, which isn't stored).
  const inventoryOf = (user) => (Array.isArray(user.inventory) ? user.inventory.filter((id) => typeof id === 'string') : []);

  /* Gives `n` of an asset to an account (deposit or refund). Gear goes to the gear list; extra
     copies of gear the player already owns wait in econ.stash and can be withdrawn again.
     Resources go to the bag; whatever doesn't fit under BAG_MAX waits in econ.stash too (the
     tokens are already burned, so nothing may be dropped).
     Returns { econ, inventory } or null if it can't be credited here. */
  function credit(user, kind, item, n) {
    const econ = E.normEcon(user.econ);
    let inventory = inventoryOf(user);
    if (kind === 'gold') {
      if (!Number.isSafeInteger(n) || n < 1) return null;
      econ.gold += n;
    } else if (kind === 'item') {
      if (!item || !has(G.ITEMS, item) || !Number.isSafeInteger(n) || n < 1) return null;
      if (!inventory.includes(item)) { inventory = [...inventory, item]; n -= 1; }
      if (n > 0) econ.stash = { ...(econ.stash || {}), [item]: ((econ.stash || {})[item] || 0) + n };
    } else if (kind === 'resource') {
      if (!item || !has(C.RESOURCES, item) || !Number.isSafeInteger(n) || n < 1) return null;
      const have = econ.bag[item] || 0, fits = Math.min(n, Math.max(0, BAG_MAX - have));
      if (fits) econ.bag[item] = have + fits;
      if (n > fits) econ.stash = { ...(econ.stash || {}), [item]: ((econ.stash || {})[item] || 0) + n - fits };
    } else return null;
    return { econ, inventory };
  }

  /* ---- withdraw ---- */
  async function withdraw(user, body) {
    if (!ENABLED) return [503, { error: 'Withdrawals are not open yet' }];
    const link = await linkOf(user.id), wallet = link && link.address;
    if (!wallet) return [409, { error: 'Link a wallet first' }];
    /* A newly linked wallet waits before anything can leave: someone who got into the account
       (a guessed password) can't link their own wallet and drain it before the owner notices. */
    if (Date.now() - Date.parse(link.linked_at) < LINK_LOCK_MS) {
      return [423, { error: `A newly linked wallet can withdraw ${LINK_LOCK_MS / 3600000} hours after linking`, until: Date.parse(link.linked_at) + LINK_LOCK_MS }];
    }
    const kind = String(body.kind || '');
    if (kind === 'plot') return [501, { error: 'Plot withdrawals are coming soon' }];
    if (kind !== 'gold' && kind !== 'item' && kind !== 'resource') return [400, { error: 'Invalid withdrawal' }];
    if (!(await within('withdraw', String(user.id)))) return [429, { error: 'Too many withdrawals. Try again later' }];

    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) { user = await player(user.id); if (!user) throw new Error('account vanished'); }
      const econ = E.normEcon(user.econ), rev = user.econ_rev || 0;
      let inventory = inventoryOf(user), character = user.character || null, item = null, tokenId = 0n, amount;
      if (kind === 'gold') {
        amount = body.amount;
        if (!Number.isInteger(amount) || amount < 1 || amount > MAX_GOLD) return [400, { error: 'Invalid amount' }];
        if (econ.gold < amount) return [409, { error: "You don't have that much gold" }];
        if (E.freeGold(econ) < amount) return [409, { error: 'Imported gold stays in the game' }];
        econ.gold -= amount;
      } else if (kind === 'resource') {
        item = String(body.item || '');
        amount = body.amount;
        if (!has(C.RESOURCES, item)) return [400, { error: "That can't leave the game" }];
        if (!Number.isInteger(amount) || amount < 1 || amount > BAG_MAX) return [400, { error: 'Invalid amount' }];
        const stash = { ...(econ.stash || {}) }, spare = stash[item] || 0, bag = econ.bag[item] || 0;
        if (spare + bag < amount) return [409, { error: "You don't have that many" }];
        const fromStash = Math.min(spare, amount); // the overflow first, then the bag
        if (fromStash) { stash[item] = spare - fromStash; if (!stash[item]) delete stash[item]; econ.stash = stash; }
        if (amount > fromStash) { econ.bag[item] = bag - (amount - fromStash); if (!econ.bag[item]) delete econ.bag[item]; }
        tokenId = itemTokenId(item);
      } else {
        item = String(body.item || '');
        if (!has(G.ITEMS, item)) return [400, { error: 'Invalid item' }];
        amount = 1;
        const stash = { ...(econ.stash || {}) };
        if (stash[item] > 0) { // a spare copy first
          if (--stash[item] === 0) delete stash[item];
          econ.stash = stash;
        } else if (inventory.includes(item)) {
          if ((econ.boundGear || []).includes(item)) return [409, { error: 'Imported gear stays in the game' }];
          inventory = inventory.filter((id) => id !== item);
          if (character) character = cleanCharacter(character, ownedItems({ ...user, inventory })) || character; // takes it off
        } else return [409, { error: "You don't own that" }];
        tokenId = itemTokenId(item);
      }
      // a daily cap on what leaves, in gold: bounds what a botted or stolen account can take out
      const day = Math.floor(Date.now() / 86400000), worth = valueOut(kind, item, amount);
      const sent = Array.isArray(econ.wd) && econ.wd[0] === day ? econ.wd[1] : 0;
      if (sent + worth > DAILY_VALUE) return [429, { error: `That's over today's withdrawal limit (${DAILY_VALUE - sent} gold worth left)` }];
      econ.wd = [day, sent + worth];
      const w = {
        nonce: BigInt('0x' + crypto.randomBytes(16).toString('hex')).toString(),
        wallet, kind, item, token_id: tokenId.toString(), amount,
        deadline: Math.floor(Date.now() / 1000) + C.CLAIM_TTL_S,
      };
      const ok = await rpc('game_withdraw', { p_id: user.id, p_rev: rev, p_econ: econ, p_inventory: inventory, p_character: character, w });
      if (ok === true) {
        const saved = { ...user, econ, econ_rev: rev + 1, inventory, character };
        return [200, { voucher: await voucherOf(w), state: stateOf(saved), character, inventory: ownedItems(saved) }];
      }
      // econ_rev moved on (another request saved first): reload and try again
    }
    return [409, { error: 'Busy, try again' }];
  }

  // Settles one deposit or refund against its account, retrying on econ_rev clashes.
  async function settle(fn, playerId, kind, item, n, key) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const user = await player(playerId);
      if (!user) return 'gone';
      const c = credit(user, kind, item, n);
      if (!c) return 'skip';
      const res = await rpc(fn, { p_id: user.id, p_rev: user.econ_rev || 0, p_econ: c.econ, p_inventory: c.inventory, ...key });
      if (res !== 'stale') return res;
    }
    return 'stale';
  }
  const depositKind = (d) => C.KIND_NAME[Number(d.kind)] || null;
  async function creditDeposit(d, playerId) {
    const kind = depositKind(d);
    const item = kind === 'item' ? TOKEN_ITEM.get(String(d.token_id)) : kind === 'resource' ? TOKEN_RESOURCE.get(String(d.token_id)) : null;
    const n = Number(d.amount);
    if (!Number.isSafeInteger(n)) return 'skip';
    return settle('game_credit', playerId, kind, item, n, { p_deposit: d.id });
  }
  // Credits whatever has been waiting for this wallet (after linking, or each sync).
  async function creditWaiting(wallet, playerId) {
    const r = await rest('game_deposits', `?wallet=eq.${wallet}&credited_to=is.null&select=*&limit=${PAGE}`);
    let n = 0;
    for (const d of r.data || []) if ((await creditDeposit(d, playerId)) === 'ok') n++;
    return n;
  }

  /* ---- chain sync ----
     Called every minute by the scheduler (see the migration). Reads new bridge events up to
     `confirmations` blocks behind the head, records them, credits deposits, and refunds claims
     that expired unused. Safe to run twice at once: every step is idempotent. */
  async function sync() {
    const out = { from: null, to: null, claimed: 0, deposits: 0, credited: 0, refunded: 0 };
    const head = await client.getBlockNumber();
    const safe = head - CONFIRMATIONS;
    const cur = await rest('game_chain_state', '?key=eq.cursor&select=value');
    const hadCursor = !!(cur.data && cur.data[0]);
    let from = hadCursor ? BigInt(cur.data[0].value.block) + 1n : START_BLOCK;
    while (from <= safe) {
      const to = from + SYNC_RANGE - 1n < safe ? from + SYNC_RANGE - 1n : safe;
      const raw = await client.request({ method: 'eth_getLogs', params: [{ address: BRIDGE, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }] });
      const logs = parseEventLogs({ abi: C.BRIDGE_ABI, logs: raw, strict: false });
      for (const l of logs) {
        if (l.eventName === 'Claimed') {
          const r = await rest('game_withdrawals', `?nonce=eq.${l.args.nonce}&status=eq.pending`, { method: 'PATCH', body: JSON.stringify({ status: 'claimed', tx: l.transactionHash }) });
          if (r.data && r.data.length) out.claimed++;
        } else if (l.eventName === 'Deposited') {
          const r = await rest('game_deposits', '', {
            method: 'POST',
            headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
            body: JSON.stringify({
              id: `${l.transactionHash}:${Number(l.logIndex)}`, wallet: l.args.from.toLowerCase(), kind: Number(l.args.kind),
              token_id: l.args.id.toString(), amount: l.args.amount.toString(), block: Number(l.blockNumber),
            }),
          });
          if (r.status < 300 && r.data && r.data.length) out.deposits++;
        }
      }
      const save = { key: 'cursor', value: { block: to.toString() } };
      const w = await rest('game_chain_state', '', { method: 'POST', headers: { Prefer: 'return=minimal,resolution=merge-duplicates' }, body: JSON.stringify(save) });
      if (w.status >= 300) throw new Error('cursor write failed: ' + w.status);
      if (out.from === null) out.from = from.toString();
      out.to = to.toString();
      from = to + 1n;
    }

    // deposits waiting for a linked account
    const waiting = await rest('game_deposits', `?credited_to=is.null&select=*&limit=${PAGE}`);
    for (const d of waiting.data || []) {
      const pid = await ownerOf(d.wallet);
      if (pid && (await creditDeposit(d, pid)) === 'ok') out.credited++;
    }

    /* claims that expired unused: check the chain, then give them back. Expired by the CHAIN's
       clock, not just ours: an Arbitrum sequencer's block timestamps can trail real time, and the
       contract judges the deadline by block.timestamp. Block times never go backwards, so once the
       latest block is past the deadline no later block can accept the claim. */
    const chainNow = Number((await client.getBlock({ blockTag: 'latest' })).timestamp);
    const cutoff = Math.min(Math.floor(Date.now() / 1000) - C.REFUND_SLACK_S, chainNow - 1);
    const late = await rest('game_withdrawals', `?status=eq.pending&deadline=lt.${cutoff}&select=*&limit=${PAGE}`);
    for (const w of late.data || []) {
      const used = await client.readContract({ address: BRIDGE, abi: C.BRIDGE_ABI, functionName: 'used', args: [BigInt(w.nonce)] });
      if (used) { // claimed, its event not read yet (or read on a reorged block)
        await rest('game_withdrawals', `?nonce=eq.${w.nonce}&status=eq.pending`, { method: 'PATCH', body: JSON.stringify({ status: 'claimed' }) });
        continue;
      }
      if ((await settle('game_refund', w.player_id, w.kind, w.item, Number(w.amount), { p_nonce: w.nonce })) === 'ok') out.refunded++;
    }
    return out;
  }

  const syncKeyOk = (headers) => {
    if (!cfg.syncKey) return false;
    const a = crypto.createHash('sha256').update(String(headers['x-chain-sync-key'] || '')).digest();
    const b = crypto.createHash('sha256').update(String(cfg.syncKey)).digest();
    return crypto.timingSafeEqual(a, b);
  };

  return {
    GETS: ['chain', 'wallet'],

    // Actions anyone may call. Returns [status, body], or null if the action isn't ours.
    async public(action, { body, headers, ip }) {
      if (action === 'chain') {
        return [200, {
          enabled: ENABLED, chainId: CHAIN_ID, name: net ? net.name : null, bridge: BRIDGE,
          rpc: net ? net.rpcUrls.default.http[0] || null : null,
          explorer: net && net.blockExplorers ? net.blockExplorers.default.url : null,
          // where withdrawn resources trade for stock tokens (Uniswap V2), and which pairs exist
          dex: DEX.router ? { router: DEX.router, stocks: DEX.stocks, pools: C.STOCK_POOLS.map((p) => ({ resource: p.resource, stock: p.stock })) } : null,
        }];
      }
      if (action === 'loginnonce') return [200, siweInfo('login', '')];
      if (action === 'walletlogin') {
        if (!(await within('login', ip))) return [429, { error: 'Too many attempts. Try again in a few minutes' }];
        const address = await verifySiwe(body.message, body.signature, 'login');
        if (!address) return [401, { error: 'Wallet sign-in failed' }];
        const pid = await ownerOf(address);
        const user = pid && (await player(pid));
        if (!user) return [404, { error: 'No account is linked to this wallet' }];
        return [200, await loginAs(user)];
      }
      if (action === 'chainsync') {
        if (!syncKeyOk(headers)) return [401, { error: 'Not allowed' }];
        if (!ENABLED || !client) return [503, { error: 'Chain is not set up' }];
        return [200, await sync()];
      }
      return null;
    },

    // Actions for a signed-in player.
    async user(action, user, { body }) {
      if (action === 'linknonce') return [200, siweInfo('link', user.id)];
      if (action === 'link') {
        const address = await verifySiwe(body.message, body.signature, 'link', user.id);
        if (!address) return [401, { error: 'Wallet check failed' }];
        const mine = await walletOf(user.id);
        if (mine === address) return [200, { wallet: address }];
        if (mine) return [409, { error: 'Your account already has a wallet' }];
        const r = await rest('game_wallets', '', { method: 'POST', body: JSON.stringify({ address, player_id: user.id }) });
        if (r.status === 409) return [409, { error: 'That wallet is linked to another account' }];
        if (r.status === 404) throw new NotReady();
        if (r.status >= 300) throw new Error('link failed: ' + r.status);
        const credited = await creditWaiting(address, user.id);
        const fresh = credited ? await player(user.id) : null;
        return [200, { wallet: address, credited, ...(fresh ? { state: stateOf(fresh), inventory: ownedItems(fresh) } : {}) }];
      }
      if (action === 'unlink') {
        const pending = await rest('game_withdrawals', `?player_id=eq.${encodeURIComponent(user.id)}&status=eq.pending&select=nonce&limit=1`);
        if (pending.data && pending.data.length) return [409, { error: 'Finish or wait out your pending withdrawals first' }];
        await rest('game_wallets', `?player_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE' });
        return [200, { wallet: null }];
      }
      if (action === 'wallet') { // the linked wallet, spare gear, and claims still to submit
        const wallet = await walletOf(user.id);
        const r = await rest('game_withdrawals', `?player_id=eq.${encodeURIComponent(user.id)}&status=eq.pending&select=*`);
        const now = Math.floor(Date.now() / 1000);
        let live = (r.data || []).filter((w) => Number(w.deadline) > now);
        // a claim sent since the last chain sync: ask the bridge, so it isn't offered again
        if (client && BRIDGE && live.length) {
          const used = await Promise.all(live.map((w) => client.readContract({ address: BRIDGE, abi: C.BRIDGE_ABI, functionName: 'used', args: [BigInt(w.nonce)] }).catch(() => false)));
          for (const [n, w] of live.entries()) if (used[n]) await rest('game_withdrawals', `?nonce=eq.${w.nonce}&status=eq.pending`, { method: 'PATCH', body: JSON.stringify({ status: 'claimed' }) });
          live = live.filter((w, n) => !used[n]);
        }
        return [200, {
          wallet, enabled: ENABLED, stash: E.normEcon(user.econ).stash || {},
          pending: ENABLED ? await Promise.all(live.map(voucherOf)) : [],
        }];
      }
      if (action === 'withdraw') return withdraw(user, body);
      return null;
    },
  };
}

export class NotReady extends Error {}
