export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { dbClients } from '../../../../server/db/clients';
import { fastcronService, resolveScheduleToken } from '../../../../server/services/fastcron-service';

export const GET: APIRoute = async ({ url, params, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const { id } = params;
  const view = url.searchParams.get('view') || 'logs';

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ error: 'Unauthorized or missing workspace' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);
    const { data: schedule } = await adminClient
      .from('posting_schedules')
      .select('*')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!schedule) {
      return new Response(JSON.stringify({ error: 'Schedule not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (!schedule.fastcron_job_id) {
      return new Response(JSON.stringify({ error: 'Job not configured' }), { status: 400 });
    }

    let token: string | undefined;
    try {
      token = await resolveScheduleToken(schedule, runtimeEnv);
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message || 'FastCron API token not configured' }), { status: 400 });
    }
    if (!token) return new Response(JSON.stringify({ error: 'FastCron API token not configured' }), { status: 400 });

    let action = 'cron_logs';
    if (view === 'failures') action = 'cron_failures';
    else if (view === 'next') action = 'cron_next';

    const res = await fastcronService.fastcronCall(action, { id: schedule.fastcron_job_id }, token);
    if (!res.success) return new Response(JSON.stringify({ error: res.error }), { status: 500 });
    const data = res.data?.logs || res.data?.data?.logs || res.data?.data || (Array.isArray(res.data) ? res.data : []);
    return new Response(JSON.stringify(Array.isArray(data) ? data : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to fetch FastCron data' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
