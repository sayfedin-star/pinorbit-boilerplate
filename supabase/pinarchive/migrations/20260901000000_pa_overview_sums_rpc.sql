-- PinArchive: KPI sums via SQL RPC (replaces paginated JS scan in overview.ts)
create or replace function public.pa_workspace_sums(p_workspace_id uuid)
returns table (sum_saves numeric, sum_shares numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(saves), 0)::numeric, coalesce(sum(share_count), 0)::numeric
  from public.pa_pins
  where workspace_id = p_workspace_id;
$$;

revoke all on function public.pa_workspace_sums(uuid) from public;
grant execute on function public.pa_workspace_sums(uuid) to service_role;
