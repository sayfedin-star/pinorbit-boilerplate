-- Migration: 20260831000000_harden_scheduling_security.sql
-- Description: Revoke public execution of purge function on P1, and deduplicate fastcron_tokens policies

-- 1. Tier 2: Revoke RPC execution from anon & authenticated
REVOKE EXECUTE ON FUNCTION public.purge_system_logs_and_old_pins() FROM PUBLIC, anon, authenticated;

-- 2. Tier 3: Hygiene - Deduplicate fastcron_tokens policies
DROP POLICY IF EXISTS "fastcron_tokens_delete_workspace_admin" ON public.fastcron_tokens;
DROP POLICY IF EXISTS "fastcron_tokens_insert_workspace_admin" ON public.fastcron_tokens;
DROP POLICY IF EXISTS "fastcron_tokens_select_workspace_member" ON public.fastcron_tokens;
DROP POLICY IF EXISTS "fastcron_tokens_service_role_all" ON public.fastcron_tokens;
DROP POLICY IF EXISTS "fastcron_tokens_update_workspace_admin" ON public.fastcron_tokens;

-- 3. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
