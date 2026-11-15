-- Player-to-player trading: swaps two players' economies in one transaction, so a trade can
-- never take from one side without giving to the other. The API (api/game/[action].js, trade)
-- works out both new economies; this writes them only if neither account saved anything since
-- it read them (compare-and-swap on econ_rev, like every other economy write).
-- Run once in the SQL editor of the Supabase project the game API uses. Safe to re-run.

create or replace function public.game_trade(
  a_id public.game_players.id%type, a_rev integer, a_econ jsonb,
  b_id public.game_players.id%type, b_rev integer, b_econ jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if a_id = b_id then return false; end if;
  -- lock both rows, lowest id first, so two trades at once can't deadlock
  perform 1 from game_players where id in (a_id, b_id) order by id for update;
  if (select count(*) from game_players
      where (id = a_id and econ_rev = a_rev) or (id = b_id and econ_rev = b_rev)) <> 2 then
    return false;
  end if;
  update game_players set econ = a_econ, econ_rev = a_rev + 1 where id = a_id;
  update game_players set econ = b_econ, econ_rev = b_rev + 1 where id = b_id;
  return true;
end $$;

-- Only the API (service key) may call it.
do $$
declare sig text;
begin
  select pg_get_function_identity_arguments(p.oid) into sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'game_trade' limit 1;
  execute format('revoke all on function public.game_trade(%s) from public, anon, authenticated', sig);
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('grant execute on function public.game_trade(%s) to service_role', sig);
  end if;
end $$;
