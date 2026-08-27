-- Migration: 20260827000000_analytics_fastcron_tokens.sql
-- Project: Project 3 (Analytics Data Warehouse & Control Plane)
-- Target Ref: jxdkbwnwtjelznmauwpc

CREATE TABLE IF NOT EXISTS public.analytics_fastcron_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  token_masked TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_fastcron_tokens_ws ON public.analytics_fastcron_tokens(workspace_id);

ALTER TABLE public.analytics_fastcron_tokens ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'analytics_fastcron_tokens' 
    AND policyname = 'Allow service_role full access on analytics_fastcron_tokens'
  ) THEN
    CREATE POLICY "Allow service_role full access on analytics_fastcron_tokens"
      ON public.analytics_fastcron_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

ALTER TABLE public.workspace_analytics_settings 
  ADD COLUMN IF NOT EXISTS cron_provider TEXT DEFAULT 'fastcron';

-- 1) Migrate from workspace_analytics_settings.fastcron_token
INSERT INTO public.analytics_fastcron_tokens (workspace_id, name, token_encrypted, token_masked, is_default)
SELECT 
  workspace_id, 
  'Migrated Workspace Token', 
  fastcron_token, 
  CASE WHEN length(fastcron_token) > 4 THEN '••••' || right(fastcron_token, 4) ELSE '••••' END, 
  true
FROM public.workspace_analytics_settings
WHERE fastcron_token IS NOT NULL AND trim(fastcron_token) != ''
ON CONFLICT DO NOTHING;

-- 2) Migrate from analytics_connections.analytics_fastcron_token
INSERT INTO public.analytics_fastcron_tokens (workspace_id, name, token_encrypted, token_masked, is_default)
SELECT 
  workspace_id, 
  display_name || ' (Analytics Token)', 
  analytics_fastcron_token, 
  CASE WHEN length(analytics_fastcron_token) > 4 THEN '••••' || right(analytics_fastcron_token, 4) ELSE '••••' END, 
  false
FROM public.analytics_connections
WHERE analytics_fastcron_token IS NOT NULL AND trim(analytics_fastcron_token) != ''
  AND analytics_fastcron_token NOT IN (SELECT token_encrypted FROM public.analytics_fastcron_tokens)
ON CONFLICT DO NOTHING;

-- 3) Migrate from analytics_connections.top_pins_fastcron_token
INSERT INTO public.analytics_fastcron_tokens (workspace_id, name, token_encrypted, token_masked, is_default)
SELECT 
  workspace_id, 
  display_name || ' (Top Pins Token)', 
  top_pins_fastcron_token, 
  CASE WHEN length(top_pins_fastcron_token) > 4 THEN '••••' || right(top_pins_fastcron_token, 4) ELSE '••••' END, 
  false
FROM public.analytics_connections
WHERE top_pins_fastcron_token IS NOT NULL AND trim(top_pins_fastcron_token) != ''
  AND top_pins_fastcron_token NOT IN (SELECT token_encrypted FROM public.analytics_fastcron_tokens)
ON CONFLICT DO NOTHING;

-- 4) Migrate from analytics_connections.fastcron_token (legacy)
INSERT INTO public.analytics_fastcron_tokens (workspace_id, name, token_encrypted, token_masked, is_default)
SELECT 
  workspace_id, 
  display_name || ' (Legacy Token)', 
  fastcron_token, 
  CASE WHEN length(fastcron_token) > 4 THEN '••••' || right(fastcron_token, 4) ELSE '••••' END, 
  false
FROM public.analytics_connections
WHERE fastcron_token IS NOT NULL AND trim(fastcron_token) != ''
  AND fastcron_token NOT IN (SELECT token_encrypted FROM public.analytics_fastcron_tokens)
ON CONFLICT DO NOTHING;
