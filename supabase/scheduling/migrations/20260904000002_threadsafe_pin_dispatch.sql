-- Migration: 20260904000002_threadsafe_pin_dispatch.sql
-- Harden dispatch engine: add schedule-level lease, per-schedule pin ownership, and atomic claim

-- 1. Add claimed_by_schedule_id to pins
ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS claimed_by_schedule_id UUID REFERENCES public.posting_schedules(id) ON DELETE SET NULL;

-- 2. Add locked_until to posting_schedules for concurrency lease management
ALTER TABLE public.posting_schedules ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- 3. Atomic lease acquisition function for FastCron / schedule dispatch
CREATE OR REPLACE FUNCTION public.acquire_schedule_dispatch_lease(
  p_schedule_id UUID,
  p_lease_seconds INTEGER DEFAULT 45
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row_count INTEGER;
BEGIN
  UPDATE public.posting_schedules
  SET locked_until = now() + (COALESCE(p_lease_seconds, 45) || ' seconds')::INTERVAL,
      updated_at = now()
  WHERE id = p_schedule_id
    AND (locked_until IS NULL OR locked_until <= now());

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RETURN v_row_count > 0;
END; $$;

REVOKE EXECUTE ON FUNCTION public.acquire_schedule_dispatch_lease(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acquire_schedule_dispatch_lease(UUID, INTEGER) TO authenticated, service_role;

-- 4. Release schedule dispatch lease
CREATE OR REPLACE FUNCTION public.release_schedule_dispatch_lease(p_schedule_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.posting_schedules
  SET locked_until = NULL,
      updated_at = now()
  WHERE id = p_schedule_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.release_schedule_dispatch_lease(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_schedule_dispatch_lease(UUID) TO authenticated, service_role;

-- 5. Drop old claim_due_pins_simple signature to avoid ambiguous overloading
DROP FUNCTION IF EXISTS public.claim_due_pins_simple(UUID, INTEGER);

-- 6. Harden claim_due_pins_simple to atomically set claimed_at and claimed_by_schedule_id
CREATE OR REPLACE FUNCTION public.claim_due_pins_simple(
  p_account_id UUID,
  p_limit INTEGER DEFAULT 1,
  p_schedule_id UUID DEFAULT NULL
)
RETURNS TABLE (id UUID, account_id UUID, workspace_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
      AND (q.next_retry_at IS NULL OR q.next_retry_at <= now())
    ORDER BY q.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING p.id, p.account_id, p.workspace_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.claim_due_pins_simple(UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_pins_simple(UUID, INTEGER, UUID) TO service_role;

-- 7. Performance index for per-schedule orphan sweep
CREATE INDEX IF NOT EXISTS idx_pins_schedule_orphan_sweep
ON public.pins (claimed_by_schedule_id, status, claimed_at);
