-- PinArchive Persisted Pin Filter Settings Migration (P4)
alter table public.pa_workspace_settings
  add column if not exists pin_filter_min_saves int not null default 0,
  add column if not exists pin_filter_min_repins int not null default 0,
  add column if not exists pin_filter_max_age_days int not null default 0;
