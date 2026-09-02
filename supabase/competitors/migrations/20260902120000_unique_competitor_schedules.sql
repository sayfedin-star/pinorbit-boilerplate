-- ============================================================================
-- Migration: 20260902120000_unique_competitor_schedules.sql
-- Project 2 (Competitors)
--
-- Adds unique partial index to prevent concurrent duplicate schedule insertions
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_competitor_schedules_ws_job
ON public.competitor_schedules (workspace_id, fastcron_job_id)
WHERE fastcron_job_id IS NOT NULL;
