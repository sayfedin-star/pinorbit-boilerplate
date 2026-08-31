-- ==============================================================================
-- Migration: 20260904000003_add_competitors_github_schedule_enabled.sql
-- Project: Project 2 (Competitors Intelligence)
-- Domain: Automation & Scheduling Controls
-- ==============================================================================

-- 1. Add github_schedule_enabled column to competitor_pipeline_settings
ALTER TABLE public.competitor_pipeline_settings 
ADD COLUMN IF NOT EXISTS github_schedule_enabled BOOLEAN NOT NULL DEFAULT true;

-- 2. Add documentation comment
COMMENT ON COLUMN public.competitor_pipeline_settings.github_schedule_enabled IS 'Enables or disables GitHub Actions built-in scheduled pipeline runs (02:00 UTC) for this workspace';

-- 3. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');