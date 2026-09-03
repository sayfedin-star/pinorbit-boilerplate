-- ==============================================================================
-- Migration: 20260905000000_harden_leases_and_webhook_quotas.sql
-- Project: Project 1 (Scheduling: eygdoetdwqllvsxpvoex)
-- Description:
--   1. Deduplicates fastcron_tokens default flags and creates partial unique index
--   2. Hardens acquire_schedule_dispatch_lease with workspace_id guard and COALESCE
--   3. Hardens release_schedule_dispatch_lease with workspace_id guard
--   4. Fixes increment_webhook_execution to avoid writing generated remaining_capacity
--   5. Hardens claim_due_pins_simple with LEAST(p_limit, 50) and workspace boundary
--   6. Strictly revokes PUBLIC/anon/authenticated execute grants on operational RPCs
-- ==============================================================================

-- 1. Partial Unique Index on fastcron_tokens (default token)
WITH ranked_defaults AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY updated_at DESC, created_at DESC) as rn
  FROM public.fastcron_tokens
  WHERE is_default = true
)
UPDATE public.fastcron_tokens
SET is_default = false
WHERE id IN (
  SELECT id FROM ranked_defaults WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fastcron_tokens_default
  ON public.fastcron_tokens (workspace_id)
  WHERE (is_default = true);

-- 2. Drop old signatures to avoid signature collisions
DROP FUNCTION IF EXISTS public.acquire_schedule_dispatch_lease(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.acquire_schedule_dispatch_lease(UUID);
DROP FUNCTION IF EXISTS public.release_schedule_dispatch_lease(UUID);

-- 3. acquire_schedule_dispatch_lease (MD5: 1b4d4af77417021abac87f6468921c2c)
CREATE OR REPLACE FUNCTION public.acquire_schedule_dispatch_lease(p_schedule_id uuid, p_lease_seconds integer DEFAULT 45, p_workspace_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row_count INTEGER;
BEGIN
  UPDATE public.posting_schedules
  SET locked_until = now() + (COALESCE(p_lease_seconds, 45) || ' seconds')::INTERVAL,
      updated_at = now()
  WHERE id = p_schedule_id
    AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id)
    AND (locked_until IS NULL OR locked_until <= now());

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RETURN v_row_count > 0;
END; $function$;

-- 4. release_schedule_dispatch_lease (MD5: 4f514b754d1c2a26f3c293d8b3a2c5a7)
CREATE OR REPLACE FUNCTION public.release_schedule_dispatch_lease(p_schedule_id uuid, p_workspace_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.posting_schedules
  SET locked_until = NULL,
      updated_at = now()
  WHERE id = p_schedule_id
    AND (p_workspace_id IS NULL OR workspace_id = p_workspace_id);
END; $function$;

-- 5. increment_webhook_execution (MD5: 555f06e412a6c00c3abbb971eacd0987)
CREATE OR REPLACE FUNCTION public.increment_webhook_execution(p_webhook_id uuid, p_count integer DEFAULT 1, p_workspace_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.account_webhooks w
  SET executions_used = COALESCE(w.executions_used, 0) + p_count,
      monthly_usage = COALESCE(w.monthly_usage, 0) + p_count,
      last_used_at = now(),
      updated_at = now()
  FROM public.accounts a
  WHERE w.id = p_webhook_id
    AND w.account_id = a.id
    AND (p_workspace_id IS NULL OR a.workspace_id = p_workspace_id);
END; $function$;

-- 6. claim_due_pins_simple (MD5: ffba412634f6cb3961f0277c48b5f7f4)
CREATE OR REPLACE FUNCTION public.claim_due_pins_simple(p_account_id uuid, p_limit integer DEFAULT 1, p_schedule_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, account_id uuid, workspace_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_clamped_limit INTEGER := LEAST(COALESCE(p_limit, 1), 50);
BEGIN
  RETURN QUERY
  UPDATE public.pins p
  SET status = 'processing',
      processing_started_at = now(),
      claimed_at = now(),
      claimed_by_schedule_id = COALESCE(p_schedule_id, p.claimed_by_schedule_id),
      attempts = p.attempts + 1,
      last_attempt_at = now(),
      updated_at = now()
  WHERE p.id IN (
    SELECT q.id FROM public.pins q
    WHERE q.status = 'pending'
      AND q.account_id = p_account_id
      AND q.workspace_id = (SELECT a.workspace_id FROM public.accounts a WHERE a.id = p_account_id)
      AND (q.next_retry_at IS NULL OR q.next_retry_at <= now())
    ORDER BY q.created_at ASC
    LIMIT v_clamped_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING p.id, p.account_id, p.workspace_id;
END; $function$;

-- 7. Secure execution privileges
REVOKE ALL ON FUNCTION public.acquire_schedule_dispatch_lease(UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_schedule_dispatch_lease(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_webhook_execution(UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_due_pins_simple(UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.acquire_schedule_dispatch_lease(UUID, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_schedule_dispatch_lease(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_webhook_execution(UUID, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_pins_simple(UUID, INTEGER, UUID) TO service_role;
