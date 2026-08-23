export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';
import { isCompetitorKekActive } from '../../../server/lib/competitor-kek';

function getRuntimeEnv(locals: any): Record<string, any> {
  return locals?.runtime?.env || locals?.runtimeEnv || {};
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function authenticateAdmin(request: Request, locals: any, explicitWorkspaceId?: string) {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const runtimeEnv = getRuntimeEnv(locals);

  if (!user || !schedulingClient) {
    return { error: jsonResponse({ success: false, error: 'Unauthorized: missing session' }, 401) };
  }

  const url = new URL(request.url);
  const workspaceId = explicitWorkspaceId || url.searchParams.get('workspace_id') || locals.activeWorkspaceId;

  if (!workspaceId) {
    return { error: jsonResponse({ success: false, error: 'Unauthorized: missing workspace identifier' }, 401) };
  }

  try {
    const wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const competitorsClient = dbClients.getCompetitors(runtimeEnv);
    return { ok: { user, workspaceId: wsCtx.workspaceId, competitorsClient, runtimeEnv } };
  } catch (err: any) {
    const status = errorStatus(err);
    return { error: jsonResponse({ success: false, error: err.message || 'Forbidden: Access Denied' }, status) };
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  const auth = await authenticateAdmin(request, locals);
  if (auth.error) return auth.error;

  const { workspaceId, competitorsClient } = auth.ok!;

  try {
    // 1. Pipeline Settings
    const { data: pipelineSettings } = await competitorsClient
      .from('competitor_pipeline_settings')
      .select('workspace_id, is_enabled, dry_run, max_retries, updated_at')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    const fallbackSettings = {
      workspace_id: workspaceId,
      is_enabled: true,
      dry_run: false,
      max_retries: 3,
      updated_at: null,
    };

    // 2. Competitors with settings
    const { data: competitors, error: compErr } = await competitorsClient
      .from('competitors')
      .select('id, username, full_name, avatar_url, is_active, last_checked_at, profile_reach, profile_views, follower_count, pin_count, competitor_settings(is_active, update_frequency_hours, last_manual_update)')
      .eq('workspace_id', workspaceId)
      .order('username', { ascending: true });

    if (compErr) throw compErr;

    // 3. Recent 15 ingestion jobs
    const { data: jobs, error: jobsErr } = await competitorsClient
      .from('competitor_ingestion_jobs')
      .select('id, workspace_id, competitor_id, status, items_processed, error_message, started_at, completed_at, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(15);

    if (jobsErr) throw jobsErr;

    const kekActive = await isCompetitorKekActive(competitorsClient);

    return jsonResponse(
      {
        success: true,
        settings: pipelineSettings || fallbackSettings,
        kekActive,
        competitors: competitors || [],
        jobs: jobs || [],
      },
      200
    );
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message || 'Failed to load competitor ops state' }, 500);
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON payload' }, 400);
  }

  const auth = await authenticateAdmin(request, locals, body.workspace_id);
  if (auth.error) return auth.error;

  const { workspaceId, competitorsClient } = auth.ok!;

  const isEnabled = body.is_enabled !== undefined ? Boolean(body.is_enabled) : true;
  const dryRun = body.dry_run !== undefined ? Boolean(body.dry_run) : false;
  const maxRetries = Number.isInteger(body.max_retries) ? Math.max(1, Math.min(10, body.max_retries)) : 3;

  try {
    const { data, error } = await competitorsClient
      .from('competitor_pipeline_settings')
      .upsert(
        {
          workspace_id: workspaceId,
          is_enabled: isEnabled,
          dry_run: dryRun,
          max_retries: maxRetries,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id' }
      )
      .select('workspace_id, is_enabled, dry_run, max_retries, updated_at')
      .single();

    if (error) throw error;

    return jsonResponse({ success: true, settings: data }, 200);
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message || 'Failed to update pipeline settings' }, 500);
  }
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PATCH: APIRoute = async ({ request, locals }) => {
  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON payload' }, 400);
  }

  const auth = await authenticateAdmin(request, locals, body.workspace_id);
  if (auth.error) return auth.error;

  const { workspaceId, competitorsClient } = auth.ok!;
  const { competitor_id, is_active, update_frequency_hours } = body;

  if (!competitor_id || !UUID_REGEX.test(competitor_id)) {
    return jsonResponse({ success: false, error: 'Valid competitor_id (UUID) is required' }, 400);
  }

  try {
    // Verify competitor belongs to caller's workspace
    const { data: comp, error: compErr } = await competitorsClient
      .from('competitors')
      .select('id')
      .eq('id', competitor_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (compErr || !comp) {
      return jsonResponse({ success: false, error: 'Competitor not found in active workspace' }, 404);
    }

    // 1. If is_active is provided, update competitors table
    if (is_active !== undefined) {
      await competitorsClient
        .from('competitors')
        .update({ is_active: Boolean(is_active) })
        .eq('id', competitor_id)
        .eq('workspace_id', workspaceId);
    }

    // 2. Fetch existing settings or default
    const { data: existing } = await competitorsClient
      .from('competitor_settings')
      .select('id, competitor_id, is_active, update_frequency_hours')
      .eq('competitor_id', competitor_id)
      .maybeSingle();

    const newActive = is_active !== undefined ? Boolean(is_active) : existing?.is_active ?? true;
    const newFreq = update_frequency_hours !== undefined ? Number(update_frequency_hours) : existing?.update_frequency_hours ?? 24;

    const { data: updatedSetting, error: settingErr } = await competitorsClient
      .from('competitor_settings')
      .upsert(
        {
          competitor_id,
          is_active: newActive,
          update_frequency_hours: newFreq,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'competitor_id' }
      )
      .select('id, competitor_id, is_active, update_frequency_hours, last_manual_update, updated_at')
      .single();

    if (settingErr) throw settingErr;

    return jsonResponse(
      {
        success: true,
        competitor_id,
        setting: updatedSetting,
      },
      200
    );
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message || 'Failed to update competitor settings' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    // Empty body is valid for full update
  }

  const auth = await authenticateAdmin(request, locals, body.workspace_id);
  if (auth.error) return auth.error;

  const { workspaceId, competitorsClient, runtimeEnv } = auth.ok!;
  const competitorId = body.competitor_id || null;
  const username = body.username || null;

  try {
    if (competitorId) {
      if (!UUID_REGEX.test(competitorId)) {
        return jsonResponse({ success: false, error: 'Invalid competitor_id (UUID) format' }, 400);
      }
      const { data: comp, error: compErr } = await competitorsClient
        .from('competitors')
        .select('id')
        .eq('id', competitorId)
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (compErr || !comp) {
        return jsonResponse({ success: false, error: 'Competitor not found in active workspace' }, 404);
      }
    }

    // 1. Insert job with queued status
    const { data: job, error: jobErr } = await competitorsClient
      .from('competitor_ingestion_jobs')
      .insert({
        workspace_id: workspaceId,
        competitor_id: competitorId,
        status: 'queued',
        items_processed: 0,
      })
      .select('id, workspace_id, competitor_id, status, created_at')
      .single();

    if (jobErr) throw jobErr;

    // Queue-only: the 5-minute poller job in GitHub Actions adopts queued jobs.
    return jsonResponse(
      {
        success: true,
        job_id: job.id,
        queued: true,
        note: 'Poller will pick this up within 5 minutes.',
      },
      202
    );
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message || 'Failed to dispatch competitor update' }, 500);
  }
};
