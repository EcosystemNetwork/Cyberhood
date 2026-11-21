// The game API for node: a (req, res) adapter onto the same code the Supabase Edge Function runs
// (supabase/functions/game/api.js). Used by game-dev-server.js (local play and the tests) and
// the Docker image. The live game calls the Edge Function directly.
const path = require('path');
const { pathToFileURL } = require('url');

let handle = null;
const api = async () => {
  if (handle) return handle;
  const { makeGameApi } = await import(pathToFileURL(path.join(__dirname, '../../supabase/functions/game/api.js')).href);
  handle = makeGameApi({
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY,
    dev: process.env.GAME_DEV === '1', // local testing: every account owns every item
    chain: { // Robinhood Chain (supabase/functions/game/wallet.js)
      chainId: process.env.CHAIN_ID,
      rpc: process.env.CHAIN_RPC,
      bridge: process.env.CHAIN_BRIDGE,
      signerKey: process.env.CHAIN_SIGNER_KEY,
      syncKey: process.env.CHAIN_SYNC_KEY,
      confirmations: process.env.CHAIN_CONFIRMATIONS,
      startBlock: process.env.CHAIN_START_BLOCK,
      domains: process.env.CHAIN_SIWE_DOMAINS,
      dex: process.env.CHAIN_DEX,
      linkLockHours: process.env.CHAIN_LINK_LOCK_HOURS,
      dailyValue: process.env.CHAIN_DAILY_VALUE,
    },
  });
  return handle;
};

// The caller's IP behind a proxy: x-forwarded-for's last entry is the one the nearest proxy added.
function clientIp(req) {
  const h = req.headers || {};
  const xff = String(h['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return String(h['x-nf-client-connection-ip'] || h['x-real-ip'] || xff[xff.length - 1] || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}

module.exports = async (req, res) => {
  const out = await (await api())({
    method: req.method,
    action: req.query.action,
    headers: req.headers || {},
    body: typeof req.body === 'object' && req.body ? req.body : {},
    ip: clientIp(req),
  });
  res.status(out.status).json(out.body);
};
