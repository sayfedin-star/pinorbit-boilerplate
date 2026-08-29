export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { syncPublishingSchedule } from '../../../server/services/fastcron-service';

export const POST: APIRoute = async ({ locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ error: 'Unauthorized or missing workspace' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);
    const { data: schedules, error: fetchErr } = await adminClient
      .from('posting_schedules')
      .select('*')
      .eq('workspace_id', workspaceId)
      .is('fastcron_job_id', null)
      .in('status', ['active', 'not_synced', 'error']);
    if (fetchErr) throw fetchErr;

    const results: { id: string; success: boolean; error?: string; job_id?: number | null }[] = [];
    for (const schedule of schedules || []) {
      try {
        const syncResult = await syncPublishingSchedule(schedule, runtimeEnv, workspaceId);
        results.push({ id: schedule.id, success: syncResult.success, error: syncResult.error, job_id: syncResult.job_id });
      } catch (e: any) {
        results.push({ id: schedule.id, success: false, error: e.message });
      }
    }

    const summary = { total: schedules?.length || 0, synced: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results };
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Sync missing failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
