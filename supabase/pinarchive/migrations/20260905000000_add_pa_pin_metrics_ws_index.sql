-- Migration: 20260905000000_add_pa_pin_metrics_ws_index.sql
-- Description: Add composite performance index on pa_pin_metrics(workspace_id, recorded_at DESC) for high-performance tenant filtering

CREATE INDEX IF NOT EXISTS idx_pa_pin_metrics_ws_rec 
  ON public.pa_pin_metrics (workspace_id, recorded_at DESC);
