// The game API as a Supabase Edge Function (all the logic is in ./api.js).
// Deploy: supabase functions deploy game --no-verify-jwt
// (--no-verify-jwt: the game signs in with its own session key, not a Supabase JWT.)
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are provided by Supabase.
import { serveGame } from './api.js';

Deno.serve((req) => serveGame(req, {
  url: Deno.env.get('SUPABASE_URL'),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
  // Robinhood Chain (wallet.js). Secrets: supabase secrets set CHAIN_SIGNER_KEY=... CHAIN_SYNC_KEY=...
  chain: {
    chainId: Deno.env.get('CHAIN_ID'),
    rpc: Deno.env.get('CHAIN_RPC'),
    bridge: Deno.env.get('CHAIN_BRIDGE'),
    signerKey: Deno.env.get('CHAIN_SIGNER_KEY'),
    syncKey: Deno.env.get('CHAIN_SYNC_KEY'),
    confirmations: Deno.env.get('CHAIN_CONFIRMATIONS'),
    startBlock: Deno.env.get('CHAIN_START_BLOCK'),
    domains: Deno.env.get('CHAIN_SIWE_DOMAINS'),
    dex: Deno.env.get('CHAIN_DEX'),
    linkLockHours: Deno.env.get('CHAIN_LINK_LOCK_HOURS'),
    dailyValue: Deno.env.get('CHAIN_DAILY_VALUE'),
  },
}));
