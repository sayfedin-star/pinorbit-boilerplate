-- ==============================================================================
-- Migration: 20260904000002_add_github_schedule_enabled.sql
-- Project: Project 4 (PinArchive Intelligence)
-- Domain: Automation & Scheduling Controls
-- ==============================================================================

-- 1. Add github_schedule_enabled column to pa_workspace_settings
ALTER TABLE public.pa_workspace_settings 
ADD COLUMN IF NOT EXISTS github_schedule_enabled BOOLEAN NOT NULL DEFAULT true;

-- 2. Add documentation comment
COMMENT ON COLUMN public.pa_workspace_settings.github_schedule_enabled IS 'Enables or disables GitHub Actions built-in scheduled pipeline runs (07:00 UTC) for this workspace';

-- 3. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');