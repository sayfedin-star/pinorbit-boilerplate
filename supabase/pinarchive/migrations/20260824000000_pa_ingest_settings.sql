-- PinArchive Ingestion Controls Migration
-- 1. Workspace-level ingestion settings
create table if not exists public.pa_workspace_settings (
  workspace_id uuid primary key,
  ingest_enabled boolean not null default true,
  paused_account_policy text not null default 'reject'
    check (paused_account_policy in ('reject','accept')),
  default_interval_days int not null default 3 check (default_interval_days between 1 and 30),
  max_batch_pins int not null default 500 check (max_batch_pins between 1 and 5000),
  updated_at timestamptz not null default now()
);

-- 2. Per-account ingest toggle
alter table public.pa_accounts
  add column if not exists ingest_enabled boolean not null default true;

-- 3. RLS and Service Role Policy (exact pa_* pattern)
alter table public.pa_workspace_settings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'pa_workspace_settings'
      and policyname = 'pa_workspace_settings_sr'
  ) then
    create policy pa_workspace_settings_sr on public.pa_workspace_settings
      for all to service_role using (true) with check (true);
  end if;
end $$;
