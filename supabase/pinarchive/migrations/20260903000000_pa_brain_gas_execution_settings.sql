-- Migration: 20260903000000_pa_brain_gas_execution_settings.sql
-- Description: Tier 0 - Execution settings columns, pa_promote_candidates RPC, and extended pa_account_pin_counts

-- ============================================================================
-- 1. Migration A: ALTER pa_workspace_settings ADD 5 nullable columns
-- ============================================================================
ALTER TABLE public.pa_workspace_settings
  ADD COLUMN IF NOT EXISTS discovery_stop_pages int DEFAULT 3,
  ADD COLUMN IF NOT EXISTS audit_sweep_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS candidates_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS sheet_write_mode text DEFAULT 'append_only',
  ADD COLUMN IF NOT EXISTS daily_sheet_sync_enabled boolean DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pa_workspace_settings_sheet_write_mode_check'
  ) THEN
    ALTER TABLE public.pa_workspace_settings
      ADD CONSTRAINT pa_workspace_settings_sheet_write_mode_check
      CHECK (sheet_write_mode IS NULL OR sheet_write_mode IN ('append_only', 'full_update'));
  END IF;
END $$;

COMMENT ON COLUMN public.pa_workspace_settings.discovery_stop_pages IS 'Consecutive all-known pages before discovery stops (default 3)';
COMMENT ON COLUMN public.pa_workspace_settings.audit_sweep_enabled IS 'Enable monthly full audit sweep workflow (default true)';
COMMENT ON COLUMN public.pa_workspace_settings.candidates_enabled IS 'Save non-qualifying pins as candidates with archived_at IS NULL (default true)';
COMMENT ON COLUMN public.pa_workspace_settings.sheet_write_mode IS 'GAS sheet write mode: append_only or full_update';
COMMENT ON COLUMN public.pa_workspace_settings.daily_sheet_sync_enabled IS 'Enable daily sheet sync (default false)';

-- ============================================================================
-- 2. Migration B: RPC pa_promote_candidates
-- ============================================================================
CREATE OR REPLACE FUNCTION public.pa_promote_candidates(p_workspace_id uuid)
RETURNS TABLE (promoted int, checked int)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_min_saves int := 0;
  v_min_repins int := 0;
  v_rising_age_days int := 14;
  v_rising_saves int := 34;
  v_checked int := 0;
  v_promoted int := 0;
BEGIN
  -- 1. Read workspace filter settings (use defaults if row not found or null)
  SELECT
    coalesce(s.pin_filter_min_saves, 0),
    coalesce(s.pin_filter_min_repins, 0),
    coalesce(s.pin_filter_rising_age_days, 14),
    coalesce(s.pin_filter_rising_saves, 34)
  INTO
    v_min_saves,
    v_min_repins,
    v_rising_age_days,
    v_rising_saves
  FROM public.pa_workspace_settings s
  WHERE s.workspace_id = p_workspace_id;

  -- 2. Count candidates (pins where archived_at is null)
  SELECT count(*)::int
  INTO v_checked
  FROM public.pa_pins
  WHERE workspace_id = p_workspace_id
    AND archived_at IS NULL;

  -- 3. If no candidates exist, return early
  IF v_checked = 0 THEN
    RETURN QUERY SELECT 0 AS promoted, 0 AS checked;
    RETURN;
  END IF;

  -- 4. Apply OR rules if at least one rule is active (> 0)
  IF v_min_saves > 0 OR v_min_repins > 0 OR (v_rising_age_days > 0 AND v_rising_saves > 0) THEN
    WITH promoted_rows AS (
      UPDATE public.pa_pins
      SET archived_at = now()
      WHERE workspace_id = p_workspace_id
        AND archived_at IS NULL
        AND (
          (v_min_saves > 0 AND saves >= v_min_saves)
          OR
          (v_min_repins > 0 AND repins >= v_min_repins)
          OR
          (
            v_rising_age_days > 0
            AND v_rising_saves > 0
            AND created_at_pinterest IS NOT NULL
            AND created_at_pinterest >= (now() - (v_rising_age_days || ' days')::interval)
            AND saves >= v_rising_saves
          )
        )
      RETURNING 1
    )
    SELECT count(*)::int INTO v_promoted FROM promoted_rows;
  ELSE
    v_promoted := 0;
  END IF;

  RETURN QUERY SELECT v_promoted AS promoted, v_checked AS checked;
END;
$$;

REVOKE ALL ON FUNCTION public.pa_promote_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_promote_candidates(uuid) TO service_role;

-- ============================================================================
-- 3. Migration C: Extend pa_account_pin_counts to return archived count
-- ============================================================================
DROP FUNCTION IF EXISTS public.pa_account_pin_counts(uuid);

CREATE OR REPLACE FUNCTION public.pa_account_pin_counts(p_workspace_id uuid)
RETURNS TABLE (account_id uuid, pins bigint, archived bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    account_id,
    count(*)::bigint AS pins,
    count(archived_at)::bigint AS archived
  FROM public.pa_pins
  WHERE workspace_id = p_workspace_id
  GROUP BY account_id;
$$;

REVOKE ALL ON FUNCTION public.pa_account_pin_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_account_pin_counts(uuid) TO service_role;
