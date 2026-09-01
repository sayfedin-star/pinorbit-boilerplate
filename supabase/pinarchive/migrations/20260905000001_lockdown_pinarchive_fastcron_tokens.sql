-- Migration: 20260905000001_lockdown_pinarchive_fastcron_tokens.sql
-- Project: Project 4 (PinArchive Data Lake)
-- Description: Lockdown pinarchive_fastcron_tokens RLS to service_role only, drop broken cross-DB helper functions referencing workspace_memberships

-- 1. Drop broken authenticated policies referencing cross-project workspace_memberships
DROP POLICY IF EXISTS "Members read pinarchive_fastcron_tokens" ON public.pinarchive_fastcron_tokens;
DROP POLICY IF EXISTS "Admins insert pinarchive_fastcron_tokens" ON public.pinarchive_fastcron_tokens;
DROP POLICY IF EXISTS "Admins update pinarchive_fastcron_tokens" ON public.pinarchive_fastcron_tokens;
DROP POLICY IF EXISTS "Admins delete pinarchive_fastcron_tokens" ON public.pinarchive_fastcron_tokens;
DROP POLICY IF EXISTS "pinarchive_fastcron_tokens_service_role_all" ON public.pinarchive_fastcron_tokens;

-- 2. Drop broken cross-project helper functions
DROP FUNCTION IF EXISTS public.is_workspace_member(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.is_workspace_admin(UUID) CASCADE;

-- 3. Ensure RLS is enabled
ALTER TABLE public.pinarchive_fastcron_tokens ENABLE ROW LEVEL SECURITY;

-- 4. Create strict service_role only policy (matching P2 / P4 proven architecture)
CREATE POLICY "pinarchive_fastcron_tokens_service_role_all"
  ON public.pinarchive_fastcron_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
