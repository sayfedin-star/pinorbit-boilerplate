-- Migration: 20260831000000_lockdown_analytics_rls.sql
-- Description: Lockdown P3 Analytics RLS policies and revoke anon RPC execution

-- 1. Drop open allow_all_* policies
DROP POLICY IF EXISTS allow_all_account_analytics_daily ON public.account_analytics_daily;
DROP POLICY IF EXISTS allow_all_account_analytics_summaries ON public.account_analytics_summaries;
DROP POLICY IF EXISTS allow_all_analytics_connections ON public.analytics_connections;
DROP POLICY IF EXISTS allow_all_analytics_ingestion_runs ON public.analytics_ingestion_runs;
DROP POLICY IF EXISTS allow_all_board_analytics_rollups ON public.board_analytics_rollups;
DROP POLICY IF EXISTS allow_all_daily_workspace_metrics ON public.daily_workspace_metrics;
DROP POLICY IF EXISTS allow_all_pin_metrics_history ON public.pin_metrics_history;
DROP POLICY IF EXISTS allow_all_top_pins_snapshots ON public.top_pins_snapshots;
DROP POLICY IF EXISTS allow_all_url_performance_history ON public.url_performance_history;
DROP POLICY IF EXISTS allow_all_workspace_analytics_settings ON public.workspace_analytics_settings;

-- 2. Create service_role only policies (matching P4 proven isolation model)
CREATE POLICY account_analytics_daily_sr ON public.account_analytics_daily TO service_role USING (true) WITH CHECK (true);
CREATE POLICY account_analytics_summaries_sr ON public.account_analytics_summaries TO service_role USING (true) WITH CHECK (true);
CREATE POLICY analytics_connections_sr ON public.analytics_connections TO service_role USING (true) WITH CHECK (true);
CREATE POLICY analytics_ingestion_runs_sr ON public.analytics_ingestion_runs TO service_role USING (true) WITH CHECK (true);
CREATE POLICY board_analytics_rollups_sr ON public.board_analytics_rollups TO service_role USING (true) WITH CHECK (true);
CREATE POLICY daily_workspace_metrics_sr ON public.daily_workspace_metrics TO service_role USING (true) WITH CHECK (true);
CREATE POLICY pin_metrics_history_sr ON public.pin_metrics_history TO service_role USING (true) WITH CHECK (true);
CREATE POLICY top_pins_snapshots_sr ON public.top_pins_snapshots TO service_role USING (true) WITH CHECK (true);
CREATE POLICY url_performance_history_sr ON public.url_performance_history TO service_role USING (true) WITH CHECK (true);
CREATE POLICY workspace_analytics_settings_sr ON public.workspace_analytics_settings TO service_role USING (true) WITH CHECK (true);

-- 3. Tier 2: Revoke RPC execution from anon & authenticated
REVOKE EXECUTE ON FUNCTION public.purge_analytics_data(uuid, uuid, date, date, boolean, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_old_analytics_ingestion_runs(integer, uuid) FROM PUBLIC, anon, authenticated;

-- 4. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
