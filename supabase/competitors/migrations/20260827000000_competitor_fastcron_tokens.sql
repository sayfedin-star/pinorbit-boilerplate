-- Migration: 20260827000000_competitor_fastcron_tokens.sql
-- Project: Project 2 (Competitor Intelligence)
-- Target Ref: guycnhvwfzdzbpgsnavg

CREATE TABLE IF NOT EXISTS public.competitor_fastcron_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  token_masked TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitor_fastcron_tokens_ws ON public.competitor_fastcron_tokens(workspace_id);

ALTER TABLE public.competitor_fastcron_tokens ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'competitor_fastcron_tokens' 
    AND policyname = 'Allow service_role full access on competitor_fastcron_tokens'
  ) THEN
    CREATE POLICY "Allow service_role full access on competitor_fastcron_tokens"
      ON public.competitor_fastcron_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

ALTER TABLE public.competitor_pipeline_settings
  ADD COLUMN IF NOT EXISTS cron_expression TEXT,
  ADD COLUMN IF NOT EXISTS fastcron_job_id TEXT,
  ADD COLUMN IF NOT EXISTS cron_provider TEXT DEFAULT 'fastcron',
  ADD COLUMN IF NOT EXISTS schedule_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS dispatch_token TEXT DEFAULT gen_random_uuid()::text,
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC';
