-- Migration: 20260831000000_lockdown_competitors_rls.sql
-- Description: Lockdown P2 Competitors RLS policies, revoke anon RPC execution, clean stale references

-- 1. Drop open allow_all_* policies
DROP POLICY IF EXISTS allow_all_competitors ON public.competitors;
DROP POLICY IF EXISTS allow_all_competitor_boards ON public.competitor_boards;
DROP POLICY IF EXISTS allow_all_competitor_snapshots ON public.competitor_snapshots;
DROP POLICY IF EXISTS allow_all_competitor_daily_snapshots ON public.competitor_daily_snapshots;
DROP POLICY IF EXISTS allow_all_competitor_ingestion_jobs ON public.competitor_ingestion_jobs;

-- 2. Create service_role only policies (matching P4 proven isolation model)
CREATE POLICY competitors_sr ON public.competitors TO service_role USING (true) WITH CHECK (true);
CREATE POLICY competitor_boards_sr ON public.competitor_boards TO service_role USING (true) WITH CHECK (true);
CREATE POLICY competitor_snapshots_sr ON public.competitor_snapshots TO service_role USING (true) WITH CHECK (true);
CREATE POLICY competitor_daily_snapshots_sr ON public.competitor_daily_snapshots TO service_role USING (true) WITH CHECK (true);
CREATE POLICY competitor_ingestion_jobs_sr ON public.competitor_ingestion_jobs TO service_role USING (true) WITH CHECK (true);

-- 3. Tier 2: Revoke RPC execution from anon & authenticated
REVOKE EXECUTE ON FUNCTION public.purge_competitor_retention(integer, integer, uuid) FROM PUBLIC, anon, authenticated;

-- 4. Tier 3: Hygiene - Remove stale/dummy workspace references
DELETE FROM public.competitor_pipeline_settings WHERE workspace_id = '8fef7c7e-d3d0-4786-a4ca-2ce6455929be';
DELETE FROM public.pinterest_cookies WHERE workspace_id IN ('8fef7c7e-d3d0-4786-a4ca-2ce6455929be', '00000000-0000-0000-0000-000000000001');

-- 5. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
