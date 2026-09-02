-- Migration: 20260904000003_harden_dispatch_and_webhooks.sql
-- Atomic webhook execution increment and capacity sync

CREATE OR REPLACE FUNCTION public.increment_webhook_execution(
  p_webhook_id UUID,
  p_count INTEGER DEFAULT 1
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.account_webhooks
  SET executions_used = COALESCE(executions_used, 0) + p_count,
      monthly_usage = COALESCE(monthly_usage, 0) + p_count,
      remaining_capacity = GREATEST(0, COALESCE(remaining_capacity, monthly_capacity) - p_count),
      last_used_at = now(),
      updated_at = now()
  WHERE id = p_webhook_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.increment_webhook_execution(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_webhook_execution(UUID, INTEGER) TO authenticated, service_role;
