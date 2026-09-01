-- Migration: 20260905000000_lockdown_competitor_fastcron_tokens.sql
-- Project: Project 2 (Competitor Intelligence)
-- Description: Lockdown competitor_fastcron_tokens RLS to service_role only, drop broken cross-DB helper functions referencing workspace_memberships

-- 1. Drop broken authenticated policies referencing cross-project workspace_memberships
DROP POLICY IF EXISTS "Members read competitor_fastcron_tokens" ON public.competitor_fastcron_tokens;
DROP POLICY IF EXISTS "Admins insert competitor_fastcron_tokens" ON public.competitor_fastcron_tokens;
DROP POLICY IF EXISTS "Admins update competitor_fastcron_tokens" ON public.competitor_fastcron_tokens;
DROP POLICY IF EXISTS "Admins delete competitor_fastcron_tokens" ON public.competitor_fastcron_tokens;
DROP POLICY IF EXISTS "competitor_fastcron_tokens_service_role_all" ON public.competitor_fastcron_tokens;

-- 2. Drop broken cross-project helper functions
DROP FUNCTION IF EXISTS public.is_workspace_member(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.is_workspace_admin(UUID) CASCADE;

-- 3. Ensure RLS is enabled
ALTER TABLE public.competitor_fastcron_tokens ENABLE ROW LEVEL SECURITY;

-- 4. Create strict service_role only policy (matching P2 / P4 proven architecture)
CREATE POLICY "competitor_fastcron_tokens_service_role_all"
  ON public.competitor_fastcron_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
