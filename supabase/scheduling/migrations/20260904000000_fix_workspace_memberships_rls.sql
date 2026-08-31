-- ==============================================================================
-- Migration: 20260904000000_fix_workspace_memberships_rls.sql
-- Project: Project 1 (Scheduling / Auth Authority)
-- Domain: Auth, Workspaces, Memberships RLS Security Hardening (Bug 18)
-- ==============================================================================

-- 1. Drop the vulnerable open insert policy
DROP POLICY IF EXISTS "Owners or Admins can insert workspace memberships" ON public.workspace_memberships;
DROP POLICY IF EXISTS "Owners can insert or users bootstrap first owner" ON public.workspace_memberships;

-- 2. Create the hardened insert policy
-- Ensures authenticated users can ONLY self-insert if the workspace currently has NO memberships (bootstrapping creator),
-- or if the inserting user is already an owner of that workspace.
CREATE POLICY "Owners can insert or users bootstrap first owner"
    ON public.workspace_memberships
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.is_workspace_owner(workspace_id)
        OR (
            user_id = (SELECT auth.uid())
            AND NOT EXISTS (
                SELECT 1 
                FROM public.workspace_memberships wm 
                WHERE wm.workspace_id = workspace_memberships.workspace_id
            )
        )
    );

-- 3. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
