-- PinArchive Relay-HTML Enrichment Layer
-- Adds annotations, SEO metadata, social signals, board context, follower count, archived marker.
-- All new columns are NULLABLE; existing rows stay valid.

ALTER TABLE public.pa_accounts
  ADD COLUMN IF NOT EXISTS follower_count int NOT NULL DEFAULT 0;

ALTER TABLE public.pa_pins
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS annotations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS seo_category text,
  ADD COLUMN IF NOT EXISTS canonical_pin_id text,
  ADD COLUMN IF NOT EXISTS seo_alt_text text,
  ADD COLUMN IF NOT EXISTS share_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS board_pin_count int,
  ADD COLUMN IF NOT EXISTS board_last_modified_at timestamptz;

ALTER TABLE public.pa_pin_metrics
  ADD COLUMN IF NOT EXISTS shares bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reactions_total bigint NOT NULL DEFAULT 0;

-- Expand pa_runs trigger to include 'refresh'
ALTER TABLE public.pa_runs DROP CONSTRAINT IF EXISTS pa_runs_trigger_check;
ALTER TABLE public.pa_runs ADD CONSTRAINT pa_runs_trigger_check
  CHECK (trigger IN ('cron','manual','backfill','refresh'));

-- Performance indexes for new columns
CREATE INDEX IF NOT EXISTS idx_pa_pins_ws_archived
  ON public.pa_pins (workspace_id, archived_at DESC)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pa_pins_canonical
  ON public.pa_pins (canonical_pin_id)
  WHERE canonical_pin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pa_pins_seo_category
  ON public.pa_pins (seo_category)
  WHERE seo_category IS NOT NULL;
