-- Migration: 20260827000000_pinarchive_fastcron_tokens.sql
-- Project: Project 4 (PinArchive Data Lake)
-- Target Ref: kuuugffvyokywtgmdrfk

CREATE TABLE IF NOT EXISTS public.pinarchive_fastcron_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  token_masked TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pinarchive_fastcron_tokens_ws ON public.pinarchive_fastcron_tokens(workspace_id);

ALTER TABLE public.pinarchive_fastcron_tokens ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'pinarchive_fastcron_tokens' 
    AND policyname = 'Allow service_role full access on pinarchive_fastcron_tokens'
  ) THEN
    CREATE POLICY "Allow service_role full access on pinarchive_fastcron_tokens"
      ON public.pinarchive_fastcron_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

ALTER TABLE public.pa_workspace_settings
  ADD COLUMN IF NOT EXISTS cron_expression TEXT,
  ADD COLUMN IF NOT EXISTS fastcron_job_id TEXT,
  ADD COLUMN IF NOT EXISTS cron_provider TEXT DEFAULT 'fastcron',
  ADD COLUMN IF NOT EXISTS schedule_status TEXT DEFAULT 'pending';

ALTER TABLE public.pa_accounts
  ADD COLUMN IF NOT EXISTS last_refresh_at TIMESTAMPTZ;

UPDATE public.pa_accounts
  SET last_refresh_at = last_run_at
  WHERE last_refresh_at IS NULL AND last_run_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pa_accounts_ws_refresh ON public.pa_accounts(workspace_id, last_refresh_at);

UPDATE public.pa_accounts
  SET next_run_at = COALESCE(last_refresh_at, last_run_at, now()) + (interval_days || ' days')::interval
  WHERE (last_refresh_at IS NOT NULL OR last_run_at IS NOT NULL);
