-- ==============================================================================
-- Migration: 20260905000000_competitor_tokens_unique_default.sql
-- Project: Project 2 (Competitors: guycnhvwfzdzbpgsnavg)
-- Description:
--   1. Deduplicates competitor_fastcron_tokens default flags
--   2. Creates partial unique index on (workspace_id) WHERE is_default = true
-- ==============================================================================

WITH ranked_defaults AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY updated_at DESC, created_at DESC) as rn
  FROM public.competitor_fastcron_tokens
  WHERE is_default = true
)
UPDATE public.competitor_fastcron_tokens
SET is_default = false
WHERE id IN (
  SELECT id FROM ranked_defaults WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_competitor_fastcron_tokens_default
  ON public.competitor_fastcron_tokens (workspace_id)
  WHERE (is_default = true);
