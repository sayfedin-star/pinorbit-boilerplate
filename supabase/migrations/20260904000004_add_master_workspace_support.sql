-- ==============================================================================
-- Migration: 20260904000004_add_master_workspace_support.sql
-- Project: Project 1 (Scheduling / Master DB)
-- Domain: Multi-Tenant Master Workspace Orchestrator
-- ==============================================================================

-- 1. Add is_master column to workspaces table
ALTER TABLE public.workspaces 
ADD COLUMN IF NOT EXISTS is_master BOOLEAN NOT NULL DEFAULT false;

-- 2. Partial unique index to ensure at most one active master workspace exists
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_single_master_idx 
ON public.workspaces (is_master) 
WHERE is_master = true;

-- 3. Documentation comment
COMMENT ON COLUMN public.workspaces.is_master IS 'Designates this workspace as the Master Workspace (Global Orchestrator for all sub-workspaces)';

-- 4. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');