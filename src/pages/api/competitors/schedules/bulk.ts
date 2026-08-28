export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { dbClients } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { fastcronCall } from '../../../../server/lib/fastcron-client';
import { resolveToken } from '../../../../server/lib/token-resolver';
import { getDispatchEndpointUrl } from './index';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized or missing workspace' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Invalid JSON payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
  const action: string = body?.action || '';

  if (ids.length === 0) {
    return new Response(JSON.stringify({ success: false, error: 'No schedule IDs provided for batch action.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!['run', 'pause', 'resume', 'delete', 'clone'].includes(action)) {
    return new Response(JSON.stringify({ success: false, error: `Invalid batch action: ${action}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);

    const { data: schedules, error: fetchErr } = await compAdmin
      .from('competitor_schedules')
      .select('*')
      .eq('workspace_id', workspaceId)
      .in('id', ids);

    if (fetchErr || !schedules || schedules.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'No matching schedules found.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let successCount = 0;
    let failedCount = 0;
    const results: any[] = [];

    for (const sched of schedules) {
      try {
        const targetTokenObj = await resolveToken(
          { workspaceId, tokenId: sched.fastcron_token_id },
          'competitors',
          runtimeEnv
        );

        if (action === 'pause' || action === 'resume') {
          if (sched.fastcron_job_id && targetTokenObj?.token) {
            const apiAction = action === 'pause' ? 'cron_disable' : 'cron_enable';
            await fastcronCall(apiAction, { id: Number(sched.fastcron_job_id) }, targetTokenObj.token);
          }
          await compAdmin
            .from('competitor_schedules')
            .update({ status: action === 'pause' ? 'paused' : 'active', updated_at: new Date().toISOString() })
            .eq('id', sched.id);

          successCount++;
          results.push({ id: sched.id, action, success: true });
        } else if (action === 'delete') {
          if (sched.fastcron_job_id && targetTokenObj?.token) {
            await fastcronCall('cron_delete', { id: Number(sched.fastcron_job_id) }, targetTokenObj.token).catch(() => {});
          }
          await compAdmin.from('competitor_schedules').delete().eq('id', sched.id);
          successCount++;
          results.push({ id: sched.id, action, success: true });
        } else if (action === 'clone') {
          const newLabel = `${sched.label || 'Schedule'} (copy)`;
          const effSecret = await getEffectiveSecret(workspaceId, runtimeEnv);
          if (!effSecret || !effSecret.value || effSecret.value.trim() === '') {
            failedCount++;
            results.push({ id: sched.id, action, success: false, error: 'Ingest secret not configured for workspace.' });
            continue;
          }
          const dispatchUrl = getDispatchEndpointUrl(runtimeEnv, workspaceId, effSecret.value.trim());

          let newJobId: string | null = null;
          if (targetTokenObj?.token) {
            const postDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'competitors', label: newLabel });
            const cloneParams = {
              name: `PinOrbit competitors — ${newLabel} — ${workspaceId.slice(0, 8)}`,
              url: dispatchUrl,
              expression: sched.cron_expression,
              timezone: sched.timezone || 'UTC',
              httpMethod: 'POST',
              http_method: 'POST',
              httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
              http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
              postData: postDataStr,
              post_data: postDataStr,
              status: sched.status === 'active' ? 'enabled' : 'disabled',
            };
            const addRes = await fastcronCall('cron_add', cloneParams, targetTokenObj.token);
            newJobId = String(addRes.data?.id || addRes.data?.data?.id || '');
          }

          const { data: cloned } = await compAdmin
            .from('competitor_schedules')
            .insert({
              workspace_id: workspaceId,
              label: newLabel,
              cron_expression: sched.cron_expression,
              timezone: sched.timezone || 'UTC',
              fastcron_token_id: sched.fastcron_token_id,
              fastcron_job_id: newJobId,
              status: sched.status,
            })
            .select('*')
            .single();

          successCount++;
          results.push({ id: sched.id, cloned_id: cloned?.id, action, success: true });
        } else if (action === 'run') {
          if (sched.fastcron_job_id && targetTokenObj?.token) {
            await fastcronCall('cron_run', { id: Number(sched.fastcron_job_id) }, targetTokenObj.token);
            successCount++;
            results.push({ id: sched.id, action, success: true });
          } else {
            failedCount++;
            results.push({ id: sched.id, action, success: false, error: 'No fastcron_job_id or token' });
          }
        }
      } catch (itemErr: any) {
        failedCount++;
        results.push({ id: sched.id, action, success: false, error: itemErr.message });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        action,
        total: ids.length,
        succeeded: successCount,
        failed: failedCount,
        results,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Bulk action failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
