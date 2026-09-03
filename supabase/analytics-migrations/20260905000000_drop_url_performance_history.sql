-- ==============================================================================
-- Migration: 20260905000000_drop_url_performance_history.sql
-- Project: Project 3 (Analytics: jxdkbwnwtjelznmauwpc)
-- Description:
--   1. Drops unused url_performance_history table and associated triggers/indexes
--   2. Replaces purge_analytics_data RPC with cleaned version without url references
--   3. Deduplicates analytics_fastcron_tokens and creates partial unique index
-- ==============================================================================

-- 1. Drop unused table
DROP TABLE IF EXISTS public.url_performance_history CASCADE;

-- 2. Cleaned purge_analytics_data RPC (MD5: 8beeb8e19673ff87070de4aa2742dae8)
CREATE OR REPLACE FUNCTION public.purge_analytics_data(p_workspace uuid, p_connection uuid, p_from date, p_to date, p_daily boolean, p_top_pins boolean, p_performed_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from_ts timestamptz;
  v_excl timestamptz;
  c_daily int := 0;
  c_sum int := 0;
  c_roll_del int := 0;
  c_roll_rebuilt int := 0;
  c_pins int := 0;
  v_targets text[] := ARRAY[]::text[];
  v_log_id uuid;
BEGIN
  v_from_ts := p_from::timestamptz;
  v_excl := (p_to + 1)::timestamptz;

  IF p_daily THEN
    v_targets := array_append(v_targets, 'daily');

    WITH del AS (
      DELETE FROM public.account_analytics_daily
      WHERE workspace_id = p_workspace AND connection_id = p_connection
        AND metric_date BETWEEN p_from AND p_to
      RETURNING id
    ) SELECT count(*) INTO c_daily FROM del;

    WITH del AS (
      DELETE FROM public.account_analytics_summaries
      WHERE workspace_id = p_workspace AND connection_id = p_connection
        AND window_end >= v_from_ts AND window_start < v_excl
      RETURNING id
    ) SELECT count(*) INTO c_sum FROM del;

    WITH del AS (
      DELETE FROM public.daily_workspace_metrics
      WHERE workspace_id = p_workspace AND metric_date BETWEEN p_from AND p_to
      RETURNING id
    ) SELECT count(*) INTO c_roll_del FROM del;

    WITH agg AS (
      SELECT
        workspace_id,
        metric_date,
        COALESCE(SUM(impressions), 0)::bigint AS total_impressions,
        COALESCE(SUM(engagements), 0)::bigint AS total_engagements,
        COALESCE(SUM(saves), 0)::bigint AS total_saves,
        COALESCE(SUM(outbound_clicks), 0)::bigint AS total_outbound_clicks,
        COALESCE(SUM(pin_clicks), 0)::bigint AS total_pin_clicks,
        COALESCE(SUM(profile_visits), 0)::bigint AS total_profile_visits,
        0::bigint AS top_pin_impressions,
        0::bigint AS top_pin_outbound_clicks,
        0::bigint AS top_pin_saves,
        0::integer AS active_top_pins_count,
        now() AS recorded_at
      FROM public.account_analytics_daily
      WHERE workspace_id = p_workspace AND metric_date BETWEEN p_from AND p_to
      GROUP BY workspace_id, metric_date
    ),
    ins AS (
      INSERT INTO public.daily_workspace_metrics (
        workspace_id, metric_date, total_impressions, total_engagements, total_saves,
        total_outbound_clicks, total_pin_clicks, total_profile_visits, top_pin_impressions,
        top_pin_outbound_clicks, top_pin_saves, active_top_pins_count, recorded_at
      )
      SELECT * FROM agg
      RETURNING id
    ) SELECT count(*) INTO c_roll_rebuilt FROM ins;
  END IF;

  IF p_top_pins THEN
    v_targets := array_append(v_targets, 'top_pins');

    WITH del AS (
      DELETE FROM public.top_pins_snapshots
      WHERE workspace_id = p_workspace AND connection_id = p_connection
        AND window_end >= v_from_ts AND window_start < v_excl
      RETURNING id
    ) SELECT count(*) INTO c_pins FROM del;
  END IF;

  -- Insert audit log matching live analytics_purge_log schema (deleted_counts jsonb)
  INSERT INTO public.analytics_purge_log (
    workspace_id,
    connection_id,
    targets,
    from_date,
    to_date,
    performed_by,
    deleted_counts
  ) VALUES (
    p_workspace,
    p_connection,
    v_targets,
    p_from,
    p_to,
    p_performed_by,
    jsonb_build_object(
      'daily_deleted', c_daily,
      'summaries_deleted', c_sum,
      'rollups_rebuilt', c_roll_rebuilt,
      'top_pins_deleted', c_pins
    )
  ) RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'purge_log_id', v_log_id,
    'counts', jsonb_build_object(
      'daily_deleted', c_daily,
      'summaries_deleted', c_sum,
      'rollups_rebuilt', c_roll_rebuilt,
      'top_pins_deleted', c_pins
    )
  );
END; $function$;

-- 3. Partial Unique Index on analytics_fastcron_tokens (default token)
WITH ranked_defaults AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY updated_at DESC, created_at DESC) as rn
  FROM public.analytics_fastcron_tokens
  WHERE is_default = true
)
UPDATE public.analytics_fastcron_tokens
SET is_default = false
WHERE id IN (
  SELECT id FROM ranked_defaults WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_fastcron_tokens_default
  ON public.analytics_fastcron_tokens (workspace_id)
  WHERE (is_default = true);

-- 4. Permissions
REVOKE ALL ON FUNCTION public.purge_analytics_data(uuid, uuid, date, date, boolean, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_analytics_data(uuid, uuid, date, date, boolean, boolean, uuid) TO service_role;
