export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { listWorkspaceTokens, saveWorkspaceToken } from '../../../../server/lib/token-resolver';
import { dbClients } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { fastcronCall } from '../../../../server/lib/fastcron-client';
import { getDispatchEndpointUrl } from '../schedules/index';

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  const client = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !client) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'Active workspace not found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(client, workspaceId, user.id, 'member');
    const tokens = await listWorkspaceTokens(workspaceId, 'competitors', runtimeEnv, false);
    return new Response(JSON.stringify(tokens || []), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to fetch tokens' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const client = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !client) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'Active workspace not found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const rawToken = typeof body.token === 'string' ? body.token.trim() : '';
  const isDefault = Boolean(body.is_default);

  if (!name) {
    return new Response(JSON.stringify({ error: 'Token name is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!rawToken || rawToken.length < 8) {
    return new Response(JSON.stringify({ error: 'Token must be at least 8 characters' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(client, workspaceId, user.id, 'admin');
    const result = await saveWorkspaceToken(
      workspaceId,
      'competitors',
      { name, token: rawToken, is_default: isDefault },
      runtimeEnv
    );

    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error || 'Failed to save token' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Best-effort auto-create default schedule (0 2 * * *) on first token if no job exists yet
    try {
      const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);
      const { data: existingSchedules } = await compAdmin
        .from('competitor_schedules')
        .select('id, fastcron_job_id')
        .eq('workspace_id', workspaceId);

      if (!existingSchedules || existingSchedules.length === 0) {
        const effSecret = await getEffectiveSecret(workspaceId, runtimeEnv);
        if (effSecret?.value) {
          const { data: ws } = await client
            .from('workspaces')
            .select('name')
            .eq('id', workspaceId)
            .maybeSingle();
          const wsName = (ws?.name || 'workspace').replace(/[—\r\n\t]+/g, ' ').trim().slice(0, 40) || 'workspace';

          const dispatchUrl = getDispatchEndpointUrl(runtimeEnv, workspaceId, effSecret.value.trim());
          const postDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'competitors', label: 'Default Daily', trigger: 'cron' });

          const defaultParams = {
            name: `PinOrbit competitors — ${wsName} — Default Daily — ${workspaceId.slice(0, 8)}`,
            url: dispatchUrl,
            expression: '0 2 * * *',
            timezone: 'UTC',
            httpMethod: 'POST',
            http_method: 'POST',
            httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
            http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
            postData: postDataStr,
            post_data: postDataStr,
            status: 'enabled',
          };
          const addRes = await fastcronCall('cron_add', defaultParams, rawToken);
          const newJobId = String(addRes.data?.id || addRes.data?.data?.id || '');
          if (newJobId) {
            await compAdmin.from('competitor_schedules').insert({
              workspace_id: workspaceId,
              label: 'Default Daily',
              cron_expression: '0 2 * * *',
              timezone: 'UTC',
              fastcron_token_id: result.id || null,
              fastcron_job_id: newJobId,
              status: 'active',
            });
          }
        }
      }
    } catch (autoErr) {
      console.warn('[Competitors Token] Auto schedule creation skipped/failed:', autoErr);
    }

    return new Response(JSON.stringify({ success: true, id: result.id }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to create token' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
