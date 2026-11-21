-- Old Fenn's liquidity pools: one gold <-> resource pool per tradeable resource
-- (rules: game/world3d/pools.js). A pool is shared by every player, so it gets its own row and
-- its own rev; a player's shares live in their economy (game_players.econ -> lp).
-- The game API (supabase/functions/game/api.js, action `pool`) works out the new pool and the
-- new economy; game_pool() writes both only if neither changed since they were read
-- (compare-and-swap on each rev), so a swap never takes from one side without giving to the other.
-- Run once on the game's Supabase project. Safe to re-run.

create table if not exists public.game_pools (
  id         text        primary key check (id ~ '^[a-z0-9_]{1,40}$'),
  gold       bigint      not null default 0 check (gold >= 0),
  res        bigint      not null default 0 check (res >= 0),
  shares     bigint      not null default 0 check (shares >= 0),
  rev        integer     not null default 0,
  updated_at timestamptz not null default now()
);
-- Closed to the anon key (RLS on, no policies): the API reads it with the service key and
-- serves it at GET /pools.
alter table public.game_pools enable row level security;

create or replace function public.game_pool(
  p_id public.game_players.id%type, p_rev integer, p_econ jsonb,
  pool_id text, pool_rev integer, pool jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- a pool nobody has touched has no row yet: rev 0
  insert into game_pools (id) values (pool_id) on conflict (id) do nothing;
  -- lock the pool first, then the player, always in that order, so two swaps can't deadlock
  perform 1 from game_pools where id = pool_id and rev = pool_rev for update;
  if not found then return false; end if;
  update game_players set econ = p_econ, econ_rev = p_rev + 1 where id = p_id and econ_rev = p_rev;
  if not found then return false; end if;
  update game_pools
     set gold = (pool->>'gold')::bigint, res = (pool->>'res')::bigint, shares = (pool->>'shares')::bigint,
         rev = pool_rev + 1, updated_at = now()
   where id = pool_id;
  return true;
end $$;

-- Only the API (service key) may call it.
do $$
declare sig text;
begin
  select pg_get_function_identity_arguments(p.oid) into sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'game_pool' limit 1;
  execute format('revoke all on function public.game_pool(%s) from public, anon, authenticated', sig);
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('grant execute on function public.game_pool(%s) to service_role', sig);
  end if;
end $$;
