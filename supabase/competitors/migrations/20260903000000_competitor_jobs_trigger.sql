-- Migration: 20260903000000_competitor_jobs_trigger.sql
-- Description: Add trigger column to competitor_ingestion_jobs mirroring pa_runs naming.

ALTER TABLE public.competitor_ingestion_jobs
  ADD COLUMN IF NOT EXISTS "trigger" TEXT NOT NULL DEFAULT 'manual' CHECK ("trigger" IN ('cron','manual','run_now','full'));

COMMENT ON COLUMN public.competitor_ingestion_jobs."trigger" IS 'Origin trigger of ingestion job: cron, manual, run_now, full';

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
