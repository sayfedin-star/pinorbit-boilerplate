export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { encryptToken, resolveTokenKek } from '../../../server/lib/token-crypto';

export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id') || locals.activeWorkspaceId;

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ error: 'Unauthorized or missing workspace ID' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);

    const { data: workspace, error } = await adminClient
      .from('workspaces')
      .select('id, cron_provider, cron_provider_api_key_encrypted')
      .eq('id', workspaceId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const provider = workspace?.cron_provider || 'fastcron';
    const hasCustomKey = Boolean(workspace?.cron_provider_api_key_encrypted);

    return new Response(
      JSON.stringify({
        success: true,
        workspace_id: workspaceId,
        provider,
        has_custom_key: hasCustomKey,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to load workspace cron provider' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
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

  const workspaceId = body.workspace_id || locals.activeWorkspaceId;
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'workspace_id is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawProvider = String(body.provider || 'fastcron').toLowerCase().trim();
  const provider = rawProvider === 'cronjoborg' || rawProvider === 'cron-job.org' ? 'cronjoborg' : 'fastcron';
  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : undefined;

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);

    const updatePayload: Record<string, any> = {
      cron_provider: provider,
      updated_at: new Date().toISOString(),
    };

    if (apiKey && apiKey.length >= 8) {
      const kek = await resolveTokenKek(runtimeEnv);
      if (!kek) {
        return new Response(JSON.stringify({ error: 'Encryption KEK is not configured on server' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      updatePayload.cron_provider_api_key_encrypted = await encryptToken(apiKey, kek);
    }

    const { data: updated, error: updateErr } = await adminClient
      .from('workspaces')
      .update(updatePayload)
      .eq('id', workspaceId)
      .select('id, cron_provider, cron_provider_api_key_encrypted')
      .single();

    if (updateErr) throw updateErr;

    // Optional sync to downstream project pipeline settings for backward compatibility
    try {
      const compClient = dbClients.getCompetitorsAdmin(runtimeEnv);
      await compClient
        .from('competitor_pipeline_settings')
        .update({ cron_provider: provider, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId);
    } catch {}

    try {
      const analyticsClient = dbClients.getAnalyticsAdmin(runtimeEnv);
      await analyticsClient
        .from('workspace_analytics_settings')
        .update({ cron_provider: provider, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId);
    } catch {}

    try {
      const paClient = dbClients.getPinArchive(runtimeEnv);
      await paClient
        .from('pa_workspace_settings')
        .update({ cron_provider: provider, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId);
    } catch {}

    return new Response(
      JSON.stringify({
        success: true,
        workspace_id: updated.id,
        provider: updated.cron_provider,
        has_custom_key: Boolean(updated.cron_provider_api_key_encrypted),
        message: `Workspace cron provider set to ${provider === 'cronjoborg' ? 'cron-job.org' : 'FastCron'}`,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to update workspace cron provider' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const PUT: APIRoute = POST;
export const PATCH: APIRoute = POST;
