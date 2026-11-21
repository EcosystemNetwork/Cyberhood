-- Robinhood Chain: linked wallets, withdrawals (server-signed vouchers) and deposits.
-- The game API (supabase/functions/game/wallet.js) is the only client: every table is closed to
-- the anon key (RLS on, no policies) and every function is service-role only.
-- Run once on the game's Supabase project. Safe to re-run.

-- One wallet per account, one account per wallet. Addresses are stored lower-case.
create table if not exists public.game_wallets (
  address   text        primary key check (address ~ '^0x[0-9a-f]{40}$'),
  player_id uuid        not null unique references public.game_players(id) on delete cascade,
  linked_at timestamptz not null default now()
);
alter table public.game_wallets enable row level security;

-- A withdrawal: the player's balance was debited and a Claim voucher signed. It ends either
-- 'claimed' (the voucher was used on-chain) or 'refunded' (its deadline passed unused).
create table if not exists public.game_withdrawals (
  nonce      text        primary key,            -- uint256, decimal
  player_id  uuid        not null references public.game_players(id) on delete cascade,
  wallet     text        not null,
  kind       text        not null check (kind in ('gold', 'item', 'plot', 'resource')),
  item       text,                               -- the game's item / resource id
  token_id   text        not null,               -- uint256, decimal
  amount     bigint      not null check (amount > 0),
  deadline   bigint      not null,               -- unix seconds, as signed
  status     text        not null default 'pending' check (status in ('pending', 'claimed', 'refunded')),
  tx         text,
  created_at timestamptz not null default now()
);
create index if not exists game_withdrawals_pending on public.game_withdrawals (deadline) where status = 'pending';
create index if not exists game_withdrawals_player on public.game_withdrawals (player_id);
alter table public.game_withdrawals enable row level security;

-- A Deposited event seen on-chain. credited_to is set once the linked account got it; deposits
-- from a wallet that isn't linked yet wait until it is.
create table if not exists public.game_deposits (
  id          text        primary key,           -- '<tx hash>:<log index>'
  wallet      text        not null,
  kind        smallint    not null,
  token_id    text        not null,
  amount      text        not null,              -- uint256, decimal
  block       bigint      not null,
  credited_to uuid        references public.game_players(id),
  created_at  timestamptz not null default now()
);
create index if not exists game_deposits_uncredited on public.game_deposits (wallet) where credited_to is null;
alter table public.game_deposits enable row level security;

-- The chain sync's cursor (last block read) and anything else it needs to remember.
create table if not exists public.game_chain_state (
  key   text  primary key,
  value jsonb not null
);
alter table public.game_chain_state enable row level security;

-- Debits the player (compare-and-swap on econ_rev, like every economy write) and records the
-- withdrawal, in one transaction: a voucher is never signed without the debit, or the reverse.
create or replace function public.game_withdraw(
  p_id public.game_players.id%type, p_rev integer, p_econ jsonb, p_inventory jsonb, p_character jsonb, w jsonb)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  update game_players set econ = p_econ, econ_rev = p_rev + 1, inventory = p_inventory, character = p_character
  where id = p_id and econ_rev = p_rev;
  if not found then return false; end if;
  insert into game_withdrawals (nonce, player_id, wallet, kind, item, token_id, amount, deadline)
  values (w->>'nonce', p_id, w->>'wallet', w->>'kind', w->>'item', w->>'token_id', (w->>'amount')::bigint, (w->>'deadline')::bigint);
  return true;
end $$;

-- Credits a deposit to the player, once. 'ok', 'stale' (econ_rev moved on: reload, retry) or
-- 'done' (already credited).
create or replace function public.game_credit(
  p_id public.game_players.id%type, p_rev integer, p_econ jsonb, p_inventory jsonb, p_deposit text)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  perform 1 from game_deposits where id = p_deposit and credited_to is null for update;
  if not found then return 'done'; end if;
  update game_players set econ = p_econ, econ_rev = p_rev + 1, inventory = p_inventory
  where id = p_id and econ_rev = p_rev;
  if not found then return 'stale'; end if;
  update game_deposits set credited_to = p_id where id = p_deposit;
  return 'ok';
end $$;

-- Gives an expired, never-used withdrawal back, once. Same answers as game_credit.
create or replace function public.game_refund(
  p_id public.game_players.id%type, p_rev integer, p_econ jsonb, p_inventory jsonb, p_nonce text)
returns text
language plpgsql security definer set search_path = public
as $$
begin
  perform 1 from game_withdrawals where nonce = p_nonce and player_id = p_id and status = 'pending' for update;
  if not found then return 'done'; end if;
  update game_players set econ = p_econ, econ_rev = p_rev + 1, inventory = p_inventory
  where id = p_id and econ_rev = p_rev;
  if not found then return 'stale'; end if;
  update game_withdrawals set status = 'refunded' where nonce = p_nonce;
  return 'ok';
end $$;

-- Only the API (service key) may call them.
do $$
declare f record;
begin
  for f in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('game_withdraw', 'game_credit', 'game_refund')
  loop
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f.proname, f.args);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%I(%s) to service_role', f.proname, f.args);
    end if;
  end loop;
end $$;

-- The chain sync runs every minute. With pg_cron + pg_net enabled on the project, schedule it
-- like this (fill in the project ref and the CHAIN_SYNC_KEY secret; kept out of this file):
--
--   select cron.schedule('game-chain-sync', '* * * * *', $cron$
--     select net.http_post(
--       url := 'https://<ref>.supabase.co/functions/v1/game/chainsync',
--       headers := jsonb_build_object('Content-Type', 'application/json', 'x-chain-sync-key', '<CHAIN_SYNC_KEY>'),
--       body := '{}'::jsonb);
--   $cron$);
