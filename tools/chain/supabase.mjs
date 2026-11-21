/* Puts the Robinhood Chain build of the game API on Supabase, through the Management API (no
   Supabase CLI needed). The access token is read from the environment only, never saved.

     export SUPABASE_ACCESS_TOKEN=sbp_...      (supabase.com > Account > Access Tokens)
     node tools/chain/supabase.mjs migrate     runs supabase/migrations/20261120_chain_bridge.sql
     node tools/chain/supabase.mjs secrets     sets the CHAIN_* secrets (from .env.chain.<net> and
                                               contracts/deployments/<chainId>.json)
     node tools/chain/supabase.mjs deploy      deploys supabase/functions/game as the function SLUG,
                                               from git commit FROM (default HEAD), or from the
                                               checkout at directory FROM: never whatever happens
                                               to be in progress in a shared working tree
     node tools/chain/supabase.mjs schedule    runs /chainsync every minute (pg_cron + pg_net)
     node tools/chain/supabase.mjs check       calls the deployed function's /chain and /chainsync

   [PROJECT_REF=rxplfcuhsdvqposhpzyp] [SLUG=game-chain] [NETWORK=testnet]
   SLUG defaults to game-chain, NOT the live `game` function: the live site's client keeps
   talking to `game` until you choose to move it over. */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHAINS } from '../../game/lib/chain.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const die = (m) => { console.error(m); process.exit(1); };
const REF = env.PROJECT_REF || 'rxplfcuhsdvqposhpzyp';
const SLUG = env.SLUG || 'game-chain';
const NETWORK = env.NETWORK || 'testnet';
const net = CHAINS[NETWORK] || die('NETWORK must be testnet or mainnet');
const FN_URL = `https://${REF}.supabase.co/functions/v1/${SLUG}/`;
const API = `https://api.supabase.com/v1/projects/${REF}`;

function token() {
  const t = env.SUPABASE_ACCESS_TOKEN;
  if (!t) die('Set SUPABASE_ACCESS_TOKEN (it is only read from the environment)');
  return t;
}
async function mgmt(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { Authorization: 'Bearer ' + token(), ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) die(`${init.method || 'GET'} ${path}: ${res.status} ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch (e) { return text; }
}
const sql = (query) => mgmt('/database/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });

// .env.chain.<network>: KEY=value lines
function keys() {
  const f = join(ROOT, `.env.chain.${NETWORK}`);
  if (!existsSync(f)) die(`Missing .env.chain.${NETWORK}`);
  const out = {};
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function deployment() {
  const f = join(ROOT, `contracts/deployments/${net.id}.json`);
  if (!existsSync(f)) die(`No deployment for chain ${net.id}: run tools/chain/deploy.mjs first`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

const cmd = process.argv[2];

if (cmd === 'migrate') {
  const file = process.argv[3] || 'supabase/migrations/20261120_chain_bridge.sql';
  await sql(readFileSync(join(ROOT, file), 'utf8'));
  const t = await sql("select table_name from information_schema.tables where table_schema = 'public' and table_name like 'game_%' order by 1");
  console.log('ran ' + file + '\ntables: ' + t.map((r) => r.table_name).join(', '));
} else if (cmd === 'secrets') {
  const k = keys(), d = deployment();
  const secrets = {
    CHAIN_ID: String(d.chainId),
    CHAIN_BRIDGE: d.contracts.bridge,
    CHAIN_START_BLOCK: String(d.startBlock),
    CHAIN_SIGNER_KEY: k.CHAIN_SIGNER_KEY,
    CHAIN_SYNC_KEY: k.CHAIN_SYNC_KEY,
    CHAIN_CONFIRMATIONS: '2',
    // testnet: the local test bench (localhost:8137) may sign in too
    CHAIN_SIWE_DOMAINS: NETWORK === 'testnet' ? 'taproot.love,www.taproot.love,localhost:8137,127.0.0.1:8137' : 'taproot.love,www.taproot.love',
    ...(env.CHAIN_RPC ? { CHAIN_RPC: env.CHAIN_RPC } : {}),
  };
  for (const [n, v] of Object.entries(secrets)) if (!v) die('missing value for ' + n);
  await mgmt('/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.entries(secrets).map(([name, value]) => ({ name, value }))) });
  console.log('set ' + Object.keys(secrets).join(', '));
} else if (cmd === 'deploy') {
  const FROM = env.FROM || 'HEAD';
  const DIR = 'supabase/functions/game/';
  let files, read, commit;
  if (existsSync(FROM) && statSync(FROM).isDirectory()) { // a checkout on disk
    const base = join(FROM, DIR);
    files = [];
    const walk = (d) => { for (const f of readdirSync(join(base, d))) { const p = d + f; if (statSync(join(base, p)).isDirectory()) walk(p + '/'); else files.push(DIR + p); } };
    walk('');
    read = (p) => readFileSync(join(FROM, p));
    commit = FROM;
  } else {
    const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 64 << 20 });
    commit = git('rev-parse', '--short', FROM).toString().trim();
    files = git('ls-tree', '-r', '--name-only', FROM, DIR).toString().split('\n').filter(Boolean);
    read = (p) => git('show', `${FROM}:${p}`);
  }
  if (!files.includes(DIR + 'wallet.js')) die(`${FROM} has no ${DIR}wallet.js: commit the chain work first`);
  const form = new FormData();
  form.append('metadata', JSON.stringify({ name: SLUG, entrypoint_path: 'index.ts', import_map_path: 'deno.json', verify_jwt: false }));
  for (const p of files) form.append('file', new Blob([read(p)]), p.slice(DIR.length));
  const r = await mgmt(`/functions/deploy?slug=${SLUG}`, { method: 'POST', body: form });
  console.log(`deployed ${SLUG} from ${commit} (version ${r.version}, ${files.length} files): ${FN_URL}`);
} else if (cmd === 'schedule') {
  const k = keys();
  await sql('create extension if not exists pg_cron; create extension if not exists pg_net;');
  const job = `${SLUG}-chain-sync`;
  const call = `select net.http_post(url := '${FN_URL}chainsync', headers := jsonb_build_object('Content-Type', 'application/json', 'x-chain-sync-key', '${k.CHAIN_SYNC_KEY}'), body := '{}'::jsonb);`;
  await sql(`select cron.unschedule(jobid) from cron.job where jobname = '${job}'; select cron.schedule('${job}', '* * * * *', $cron$ ${call} $cron$);`);
  console.log(`scheduled ${job}: every minute -> ${FN_URL}chainsync`);
} else if (cmd === 'check') {
  const k = keys();
  const c = await (await fetch(FN_URL + 'chain')).json();
  console.log('chain:', JSON.stringify(c));
  const s = await fetch(FN_URL + 'chainsync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-chain-sync-key': k.CHAIN_SYNC_KEY }, body: '{}' });
  console.log('chainsync:', s.status, await s.text());
} else {
  die('usage: node tools/chain/supabase.mjs migrate|secrets|deploy|schedule|check');
}
