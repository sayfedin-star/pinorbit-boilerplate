-- Migration: 20260830000000_competitor_fastcron_tokens_rls.sql
-- Project: Project 2 (Competitor Intelligence)
-- Description: Authenticated tenant-isolation RLS policies for competitor_fastcron_tokens

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

ALTER TABLE public.competitor_fastcron_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read competitor_fastcron_tokens" ON public.competitor_fastcron_tokens;
CREATE POLICY "Members read competitor_fastcron_tokens" 
  ON public.competitor_fastcron_tokens FOR SELECT TO authenticated 
  USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Admins insert competitor_fastcron_tokens" ON public.competitor_fastcron_tokens;
CREATE POLICY "Admins insert competitor_fastcron_tokens" 
  ON public.competitor_fastcron_tokens FOR INSERT TO authenticated 
  WITH CHECK (public.is_workspace_admin(workspace_id));

DROP POLICY IF EXISTS "Admins update competitor_fastcron_tokens" ON public.competitor_fastcron_tokens;
CREATE POLICY "Admins update competitor_fastcron_tokens" 
  ON public.competitor_fastcron_tokens FOR UPDATE TO authenticated 
  USING (public.is_workspace_admin(workspace_id)) 
  WITH CHECK (public.is_workspace_admin(workspace_id));

DROP POLICY IF EXISTS "Admins delete competitor_fastcron_tokens" ON public.competitor_fastcron_tokens;
CREATE POLICY "Admins delete competitor_fastcron_tokens" 
  ON public.competitor_fastcron_tokens FOR DELETE TO authenticated 
  USING (public.is_workspace_admin(workspace_id));

SELECT pg_notify('pgrst', 'reload schema');
