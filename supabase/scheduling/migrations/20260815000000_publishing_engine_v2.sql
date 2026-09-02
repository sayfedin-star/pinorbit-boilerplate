ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS pinterest_pin_id TEXT;
ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS pinterest_pin_created_at TIMESTAMPTZ;
ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 2;
ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS failure_type TEXT;
ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS last_failure_reason TEXT;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS auto_create_missing_boards BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS board_creation_webhook_id UUID;
ALTER TABLE public.boards ADD COLUMN IF NOT EXISTS pinterest_board_id TEXT;
ALTER TABLE public.boards ADD COLUMN IF NOT EXISTS created_via TEXT;
ALTER TABLE public.boards ADD COLUMN IF NOT EXISTS created_via_webhook_id UUID;
ALTER TABLE public.logs ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;
UPDATE public.logs l SET workspace_id = a.workspace_id FROM public.accounts a WHERE l.account_id = a.id AND l.workspace_id IS NULL;

CREATE TABLE IF NOT EXISTS public.board_provisioning_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  board_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','completed','failed')),
  webhook_id UUID,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT ux_board_prov_key UNIQUE (idempotency_key)
);
ALTER TABLE public.board_provisioning_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read provisioning requests" ON public.board_provisioning_requests FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY "Service writes provisioning requests" ON public.board_provisioning_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.claim_due_pins_simple(p_account_id UUID, p_limit INTEGER DEFAULT 1)
RETURNS TABLE (id UUID, account_id UUID, workspace_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  UPDATE public.pins p
  SET status='processing', processing_started_at=now(), claimed_at=now(), attempts=p.attempts+1, last_attempt_at=now(), updated_at=now()
  WHERE p.id IN (
    SELECT q.id FROM public.pins q
    WHERE q.status='pending' AND q.account_id=p_account_id
      AND (q.next_retry_at IS NULL OR q.next_retry_at <= now())
    ORDER BY q.created_at ASC LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  RETURNING p.id, p.account_id, p.workspace_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.claim_due_pins_simple(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_pins_simple(UUID, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.reschedule_account_pending_pins(target_account_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE acc RECORD; r RECORD; curr TIMESTAMPTZ; local_ts TIMESTAMP; step_min INTEGER; n INTEGER := 0; guard INTEGER;
  start_t TIME; end_t TIME; in_window BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts a
    JOIN public.workspace_memberships wm ON wm.workspace_id = a.workspace_id
    WHERE a.id = target_account_id AND wm.user_id = auth.uid()
  ) THEN RETURN 0; END IF;
  SELECT * INTO acc FROM public.accounts WHERE id = target_account_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  curr := GREATEST(now(), COALESCE((SELECT max(posted_at) FROM public.pins
          WHERE account_id = target_account_id AND status='posted'), now()))
          + (COALESCE(acc.posting_interval_minutes,30) || ' minutes')::INTERVAL;
  FOR r IN SELECT id FROM public.pins WHERE account_id=target_account_id AND status='pending' ORDER BY created_at ASC LOOP
    step_min := COALESCE(acc.posting_interval_minutes,30) +
      CASE WHEN COALESCE(acc.random_delay_minutes,0) > 0 THEN floor(random()*(acc.random_delay_minutes+1))::INTEGER ELSE 0 END;
    guard := 0;
    LOOP
      guard := guard + 1; IF guard > 2000 THEN EXIT; END IF;
      local_ts := curr AT TIME ZONE COALESCE(acc.timezone,'UTC');
      start_t := COALESCE(acc.posting_window_start, TIME '00:00');
      end_t   := COALESCE(acc.posting_window_end,   TIME '23:59');
      in_window := CASE WHEN start_t <= end_t
        THEN (local_ts::time BETWEEN start_t AND end_t)
        ELSE (local_ts::time >= start_t OR local_ts::time <= end_t) END;
      IF in_window AND (array_length(acc.active_days,1) IS NULL OR to_char(local_ts,'Dy') = ANY(acc.active_days)) THEN EXIT; END IF;
      curr := curr + INTERVAL '10 minutes';
    END LOOP;
    UPDATE public.pins SET scheduled_for = curr, updated_at = now() WHERE id = r.id;
    n := n + 1; curr := curr + (step_min || ' minutes')::INTERVAL;
  END LOOP;
  RETURN n;
END; $$;
REVOKE EXECUTE ON FUNCTION public.reschedule_account_pending_pins(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reschedule_account_pending_pins(UUID) TO authenticated, service_role;
