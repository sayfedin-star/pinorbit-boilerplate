-- ==============================================================================
-- Migration: 20260829000000_fix_workspace_membership_recursion_and_security_definer.sql
-- Project: Project 1 (Scheduling / Auth Authority)
-- Domain: Auth, Workspaces, Memberships RLS and Helper Functions Hardening
-- ==============================================================================

-- 1. Helper Functions (SECURITY DEFINER with restricted access & search_path)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 
        FROM public.admin_users 
        WHERE user_id = (SELECT auth.uid())
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_member(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_workspace_id IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN (
        (SELECT public.is_admin()) 
        OR EXISTS (
            SELECT 1 
            FROM public.workspace_memberships 
            WHERE workspace_id = p_workspace_id 
              AND user_id = (SELECT auth.uid())
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_owner(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_workspace_id IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN (
        (SELECT public.is_admin()) 
        OR EXISTS (
            SELECT 1 
            FROM public.workspace_memberships 
            WHERE workspace_id = p_workspace_id 
              AND user_id = (SELECT auth.uid()) 
              AND role = 'owner'
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_admin(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_workspace_id IS NULL THEN
        RETURN FALSE;
    END IF;
    RETURN (
        (SELECT public.is_admin()) 
        OR EXISTS (
            SELECT 1 
            FROM public.workspace_memberships 
            WHERE workspace_id = p_workspace_id 
              AND user_id = (SELECT auth.uid()) 
              AND role IN ('owner', 'admin')
        )
    );
END;
$$;

-- Security Hardening: Revoke execute from public and anon
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_workspace_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_workspace_owner(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_workspace_owner(UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_workspace_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_workspace_admin(UUID) TO authenticated, service_role;

-- 2. Non-recursive, clean RLS Policies for workspace_memberships
DROP POLICY IF EXISTS "Users can read own workspace memberships" ON public.workspace_memberships;
DROP POLICY IF EXISTS "Owners or Admins can insert workspace memberships" ON public.workspace_memberships;
DROP POLICY IF EXISTS "Owners or Admins can update workspace memberships" ON public.workspace_memberships;
DROP POLICY IF EXISTS "Owners or Admins or self can delete workspace memberships" ON public.workspace_memberships;
DROP POLICY IF EXISTS "Allow service_role full access on workspace_memberships" ON public.workspace_memberships;

CREATE POLICY "Allow service_role full access on workspace_memberships"
    ON public.workspace_memberships
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Users can read own workspace memberships"
    ON public.workspace_memberships
    FOR SELECT
    TO authenticated
    USING ((user_id = (SELECT auth.uid())) OR public.is_workspace_member(workspace_id));

CREATE POLICY "Owners or Admins can insert workspace memberships"
    ON public.workspace_memberships
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.is_workspace_owner(workspace_id)
        OR (user_id = (SELECT auth.uid()))
    );

CREATE POLICY "Owners or Admins can update workspace memberships"
    ON public.workspace_memberships
    FOR UPDATE
    TO authenticated
    USING (public.is_workspace_owner(workspace_id))
    WITH CHECK (public.is_workspace_owner(workspace_id));

CREATE POLICY "Owners or Admins or self can delete workspace memberships"
    ON public.workspace_memberships
    FOR DELETE
    TO authenticated
    USING ((user_id = (SELECT auth.uid())) OR public.is_workspace_owner(workspace_id));
