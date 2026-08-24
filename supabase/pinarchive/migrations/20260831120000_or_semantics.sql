-- PinArchive OR Semantics Migration (P4)
-- Adds configurable rising rule columns (age <= rising_age_days AND saves >= rising_saves)
-- Drops removed pin_filter_max_age_days column

alter table public.pa_workspace_settings
  add column if not exists pin_filter_rising_age_days int not null default 14,
  add column if not exists pin_filter_rising_saves    int not null default 34,
  drop column if exists pin_filter_max_age_days;
