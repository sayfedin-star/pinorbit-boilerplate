-- Migration: 20260830000000_analytics_fastcron_tokens_rls.sql
-- Project: Project 3 (Analytics Data Warehouse & Control Plane)
-- Description: Authenticated tenant-isolation RLS policies for analytics_fastcron_tokens

CREATE OR REPLACE FUNCTION public.is_workspace_member(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships
    WHERE workspace_id = p_workspace_id
      AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_admin(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships
    WHERE workspace_id = p_workspace_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_workspace_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_workspace_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_workspace_admin(UUID) TO authenticated, service_role;

ALTER TABLE public.analytics_fastcron_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read analytics_fastcron_tokens" ON public.analytics_fastcron_tokens;
CREATE POLICY "Members read analytics_fastcron_tokens" 
  ON public.analytics_fastcron_tokens FOR SELECT TO authenticated 
  USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Admins insert analytics_fastcron_tokens" ON public.analytics_fastcron_tokens;
CREATE POLICY "Admins insert analytics_fastcron_tokens" 
  ON public.analytics_fastcron_tokens FOR INSERT TO authenticated 
  WITH CHECK (public.is_workspace_admin(workspace_id));

DROP POLICY IF EXISTS "Admins update analytics_fastcron_tokens" ON public.analytics_fastcron_tokens;
CREATE POLICY "Admins update analytics_fastcron_tokens" 
  ON public.analytics_fastcron_tokens FOR UPDATE TO authenticated 
  USING (public.is_workspace_admin(workspace_id)) 
  WITH CHECK (public.is_workspace_admin(workspace_id));

DROP POLICY IF EXISTS "Admins delete analytics_fastcron_tokens" ON public.analytics_fastcron_tokens;
CREATE POLICY "Admins delete analytics_fastcron_tokens" 
  ON public.analytics_fastcron_tokens FOR DELETE TO authenticated 
  USING (public.is_workspace_admin(workspace_id));

SELECT pg_notify('pgrst', 'reload schema');
