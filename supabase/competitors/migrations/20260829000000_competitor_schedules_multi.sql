-- 20260829000000_competitor_schedules_multi.sql
-- Multi-schedule engine for Competitor Intelligence pipeline

CREATE TABLE IF NOT EXISTS public.competitor_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  label TEXT,
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  fastcron_token_id UUID REFERENCES public.competitor_fastcron_tokens(id) ON DELETE SET NULL,
  dispatch_token TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  fastcron_job_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitor_schedules_ws ON public.competitor_schedules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_competitor_schedules_status ON public.competitor_schedules(status);

ALTER TABLE public.competitor_schedules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='competitor_schedules' AND policyname='Allow service_role full access on competitor_schedules') THEN
    CREATE POLICY "Allow service_role full access on competitor_schedules" ON public.competitor_schedules FOR ALL TO service_role USING(true) WITH CHECK(true);
  END IF;
END $$;

-- Migrate existing singleton settings if fastcron_job_id exists
INSERT INTO public.competitor_schedules (workspace_id, label, cron_expression, timezone, fastcron_job_id, status)
SELECT 
  workspace_id, 
  'Default Daily', 
  COALESCE(cron_expression, '0 2 * * *'), 
  COALESCE(timezone, 'UTC'), 
  fastcron_job_id, 
  CASE WHEN schedule_status = 'active' THEN 'active' WHEN schedule_status = 'paused' THEN 'paused' ELSE 'pending' END
FROM public.competitor_pipeline_settings 
WHERE fastcron_job_id IS NOT NULL;

SELECT pg_notify('pgrst','reload schema');
