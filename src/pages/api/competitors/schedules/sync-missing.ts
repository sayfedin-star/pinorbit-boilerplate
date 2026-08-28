export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { dbClients } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { fastcronCall } from '../../../../server/lib/fastcron-client';
import { resolveToken } from '../../../../server/lib/token-resolver';
import { getDispatchEndpointUrl } from './index';

export const POST: APIRoute = async ({ locals }) => {
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

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);

    // Check if any schedules already exist
    const { data: existing, error: fetchErr } = await compAdmin
      .from('competitor_schedules')
      .select('id, fastcron_job_id, cron_expression')
      .eq('workspace_id', workspaceId);

    if (fetchErr) throw fetchErr;

    if (existing && existing.length > 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Schedules already configured for this workspace.',
          count: existing.length,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const dispatchUrl = getDispatchEndpointUrl(runtimeEnv, workspaceId);
    const effSecret = await getEffectiveSecret(workspaceId, runtimeEnv);
    if (!effSecret || !effSecret.value || effSecret.value.trim() === '') {
      return new Response(
        JSON.stringify({ success: false, error: 'Ingest secret not configured for workspace.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const targetTokenObj = await resolveToken(
      { workspaceId },
      'competitors',
      runtimeEnv
    );
    if (!targetTokenObj || !targetTokenObj.token) {
      return new Response(
        JSON.stringify({ success: false, error: 'FastCron API token not configured on server or in workspace registry.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const label = 'Default Daily';
    const cronExpression = '0 2 * * *';
    const timezone = 'UTC';
    const postDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'competitors', label });

    const defaultParams = {
      name: `PinOrbit competitors — ${label} — ${workspaceId.slice(0, 8)}`,
      url: dispatchUrl,
      expression: cronExpression,
      timezone,
      httpMethod: 'POST',
      http_method: 'POST',
      httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
      http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
      postData: postDataStr,
      post_data: postDataStr,
      status: 'enabled',
    };

    const addRes = await fastcronCall('cron_add', defaultParams, targetTokenObj.token);
    if (!addRes.success) {
      return new Response(
        JSON.stringify({ success: false, error: addRes.error || 'Failed to create default FastCron job.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const createdJobId = String(addRes.data?.id || addRes.data?.data?.id || '');

    const { data: newRow, error: insertErr } = await compAdmin
      .from('competitor_schedules')
      .insert({
        workspace_id: workspaceId,
        label,
        cron_expression: cronExpression,
        timezone,
        fastcron_token_id: targetTokenObj.tokenId || null,
        fastcron_job_id: createdJobId || null,
        status: 'active',
      })
      .select('*')
      .single();

    if (insertErr) throw insertErr;

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Default daily schedule created (02:00 UTC).',
        schedule: newRow,
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to sync missing schedule' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
