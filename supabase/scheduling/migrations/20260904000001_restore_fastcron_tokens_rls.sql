-- ==============================================================================
-- Migration: 20260904000001_restore_fastcron_tokens_rls.sql
-- Project: Project 1 (Scheduling / Auth Authority)
-- Domain: Auth, FastCron Tokens RLS Restoration (Bug 2b)
-- ==============================================================================

-- 1. Ensure RLS is active on fastcron_tokens
ALTER TABLE public.fastcron_tokens ENABLE ROW LEVEL SECURITY;

-- 2. Drop any conflicting existing policies
DROP POLICY IF EXISTS "fastcron_tokens_select_workspace_member" ON public.fastcron_tokens;
DROP POLICY IF EXISTS "fastcron_tokens_insert_workspace_admin" ON public.fastcron_tokens;
DROP POLICY IF EXISTS "fastcron_tokens_update_workspace_admin" ON public.fastcron_tokens;
DROP POLICY IF EXISTS "fastcron_tokens_delete_workspace_admin" ON public.fastcron_tokens;
DROP POLICY IF EXISTS "fastcron_tokens_service_role_all" ON public.fastcron_tokens;

-- 3. Restore tenant-isolated policies

-- SELECT: Workspace members can view tokens in their workspace
CREATE POLICY "fastcron_tokens_select_workspace_member"
  ON public.fastcron_tokens
  FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id));

-- INSERT: Workspace admins/owners can insert tokens in their workspace
CREATE POLICY "fastcron_tokens_insert_workspace_admin"
  ON public.fastcron_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_workspace_admin(workspace_id));

-- UPDATE: Workspace admins/owners can update tokens in their workspace
CREATE POLICY "fastcron_tokens_update_workspace_admin"
  ON public.fastcron_tokens
  FOR UPDATE
  TO authenticated
  USING (public.is_workspace_admin(workspace_id))
  WITH CHECK (public.is_workspace_admin(workspace_id));

-- DELETE: Workspace admins/owners can delete tokens in their workspace
CREATE POLICY "fastcron_tokens_delete_workspace_admin"
  ON public.fastcron_tokens
  FOR DELETE
  TO authenticated
  USING (public.is_workspace_admin(workspace_id));

-- ALL: Service role full access for backend jobs
CREATE POLICY "fastcron_tokens_service_role_all"
  ON public.fastcron_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 4. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
