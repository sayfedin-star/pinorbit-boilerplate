export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import {
  pausePublishingSchedule,
  resumePublishingSchedule,
  clonePublishingSchedule,
  deletePublishingSchedule,
  resolveScheduleToken,
  fastcronService,
} from '../../../server/services/fastcron-service';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ error: 'Unauthorized or missing workspace' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { ids, action } = body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return new Response(JSON.stringify({ error: 'ids array is required' }), { status: 400 });
  }
  if (!action || !['run', 'pause', 'resume', 'delete', 'clone'].includes(action)) {
    return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);
    const results: { id: string; success: boolean; error?: string; remote_deleted?: boolean; remote_error?: string }[] = [];

    for (const id of ids) {
      try {
        const { data: schedule } = await adminClient.from('posting_schedules').select('*').eq('id', id).eq('workspace_id', workspaceId).single();
        if (!schedule) {
          results.push({ id, success: false, error: 'Not found' });
          continue;
        }

        if (action === 'run') {
          if (schedule.fastcron_job_id) {
            const token = await resolveScheduleToken(schedule, runtimeEnv);
            if (token) {
              const res = await fastcronService.fastcronCall('cron_run', { id: schedule.fastcron_job_id }, token);
              if (!res.success) throw new Error(res.error);
            }
          }
          results.push({ id, success: true });
        } else if (action === 'pause') {
          if (!schedule.fastcron_job_id) throw new Error('Job not configured');
          const result = await pausePublishingSchedule(id, schedule.fastcron_job_id, runtimeEnv, workspaceId);
          if (!result.success) throw new Error(result.error);
          results.push({ id, success: true });
        } else if (action === 'resume') {
          if (!schedule.fastcron_job_id) throw new Error('Job not configured');
          const result = await resumePublishingSchedule(id, schedule.fastcron_job_id, runtimeEnv, workspaceId);
          if (!result.success) throw new Error(result.error);
          results.push({ id, success: true });
        } else if (action === 'delete') {
          const result = await deletePublishingSchedule(id, schedule.fastcron_job_id, runtimeEnv, workspaceId);
          if (!result.success) throw new Error(result.error);
          results.push({
            id,
            success: true,
            remote_deleted: result.remote_deleted,
            remote_error: result.remote_error,
          });
        } else if (action === 'clone') {
          const result = await clonePublishingSchedule(id, runtimeEnv, workspaceId);
          if (!result.success) throw new Error(result.error);
          results.push({ id, success: true });
        }
      } catch (e: any) {
        results.push({ id, success: false, error: e.message });
      }
    }

    const remoteOrphans = results.filter(r => r.success && r.remote_error).length;
    const summary = {
      total: ids.length,
      success: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      remote_orphans: remoteOrphans,
      results,
    };
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Bulk action failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
