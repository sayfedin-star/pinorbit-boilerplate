export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';
import { isCompetitorKekActive } from '../../../server/lib/competitor-kek';
import { resolveToken } from '../../../server/lib/token-resolver';
import { getEffectiveSecret } from '../../../server/services/webhook-secrets';
import { fastcronCall } from '../../../server/lib/fastcron-client';

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
  const url = new URL(request.url);
  const jobId = url.searchParams.get('job_id');

  try {
    // 1. If job_id is requested, return single job status for real-time polling
    if (jobId) {
      const { data: job, error: jobErr } = await competitorsClient
        .from('competitor_ingestion_jobs')
        .select('id, workspace_id, competitor_id, status, trigger, items_processed, error_message, started_at, completed_at, created_at')
        .eq('id', jobId)
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (jobErr || !job) {
        return jsonResponse({ success: false, error: 'Job not found' }, 404);
      }

      return jsonResponse({ success: true, job }, 200);
    }

    // 2. Full Ops State: Pipeline Settings, Competitors, and Recent Jobs
    const { data: pipelineSettings } = await competitorsClient
      .from('competitor_pipeline_settings')
      .select('workspace_id, is_enabled, dry_run, max_retries, updated_at, cron_expression, fastcron_job_id, cron_provider, schedule_status, timezone')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    const fallbackSettings = {
      workspace_id: workspaceId,
      is_enabled: true,
      dry_run: false,
      max_retries: 3,
      updated_at: null,
      cron_provider: 'fastcron',
      schedule_status: 'pending',
    };

    const { data: competitors, error: compErr } = await competitorsClient
      .from('competitors')
      .select('id, username, full_name, avatar_url, is_active, last_checked_at, profile_reach, profile_views, follower_count, pin_count, competitor_settings(is_active, update_frequency_hours, last_manual_update)')
      .eq('workspace_id', workspaceId)
      .order('username', { ascending: true });

    if (compErr) throw compErr;

    const { data: jobs, error: jobsErr } = await competitorsClient
      .from('competitor_ingestion_jobs')
      .select('id, workspace_id, competitor_id, status, trigger, items_processed, error_message, started_at, completed_at, created_at')
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

  const { workspaceId, competitorsClient, runtimeEnv } = auth.ok!;

  const isEnabled = body.is_enabled !== undefined ? Boolean(body.is_enabled) : true;
  const dryRun = body.dry_run !== undefined ? Boolean(body.dry_run) : false;
  const maxRetries = Number.isInteger(body.max_retries) ? Math.max(1, Math.min(10, body.max_retries)) : 3;

  try {
    const updatePayload: Record<string, any> = {
      workspace_id: workspaceId,
      is_enabled: isEnabled,
      dry_run: dryRun,
      max_retries: maxRetries,
      updated_at: new Date().toISOString(),
    };

    if (body.cron_provider !== undefined) updatePayload.cron_provider = body.cron_provider;
    if (body.cron_expression !== undefined) updatePayload.cron_expression = body.cron_expression;
    if (body.timezone !== undefined) updatePayload.timezone = body.timezone;
    if (body.schedule_status !== undefined) updatePayload.schedule_status = body.schedule_status;
    if (body.fastcron_job_id !== undefined) updatePayload.fastcron_job_id = body.fastcron_job_id;

    // Sync FastCron job if cron_expression is set
    if (body.cron_expression && body.cron_provider !== 'github_actions') {
      try {
        const targetToken = await resolveToken({ workspaceId }, 'competitors', runtimeEnv);
        if (targetToken?.token) {
          const effSecret = await getEffectiveSecret(workspaceId, runtimeEnv);
          if (effSecret?.value) {
            const { data: ws } = await locals.supabase
              .from('workspaces')
              .select('name')
              .eq('id', workspaceId)
              .maybeSingle();
            const wsName = (ws?.name || 'workspace').replace(/[—\r\n\t]+/g, ' ').trim().slice(0, 40) || 'workspace';

            const dispatchUrl = (runtimeEnv?.COMPETITORS_DISPATCH_URL as string) || 'https://pinorbit-v2.o-i.workers.dev/api/internal/competitors/dispatch';
            const fastcronParams = {
              name: `PinOrbit competitors — ${wsName} — Schedule — ${workspaceId.slice(0, 8)}`,
              url: dispatchUrl,
              expression: body.cron_expression,
              timezone: body.timezone || updatePayload.timezone || 'UTC',
              http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
              post_data: JSON.stringify({ workspace_id: workspaceId, pipeline: 'competitors', label: 'Schedule' }),
              status: isEnabled ? 'enabled' : 'disabled',
            };

            const { data: existingSettings } = await competitorsClient
              .from('competitor_pipeline_settings')
              .select('fastcron_job_id')
              .eq('workspace_id', workspaceId)
              .maybeSingle();

            const existingJobId = updatePayload.fastcron_job_id || existingSettings?.fastcron_job_id;
            if (existingJobId) {
              await fastcronCall('cron_edit', { id: Number(existingJobId), ...fastcronParams }, targetToken.token);
            } else {
              const addRes = await fastcronCall('cron_add', fastcronParams, targetToken.token);
              const newId = String(addRes.data?.id || addRes.data?.data?.id || '');
              if (newId) {
                updatePayload.fastcron_job_id = newId;
                updatePayload.schedule_status = 'active';
              }
            }
          }
        }
      } catch (cronErr) {
        console.warn('[Competitor Ops PUT] FastCron sync error:', cronErr);
      }
    }

    const { data, error } = await competitorsClient
      .from('competitor_pipeline_settings')
      .upsert(updatePayload, { onConflict: 'workspace_id' })
      .select('*')
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
    const { data: comp, error: compErr } = await competitorsClient
      .from('competitors')
      .select('id')
      .eq('id', competitor_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (compErr || !comp) {
      return jsonResponse({ success: false, error: 'Competitor not found in active workspace' }, 404);
    }

    if (is_active !== undefined) {
      await competitorsClient
        .from('competitors')
        .update({ is_active: Boolean(is_active) })
        .eq('id', competitor_id)
        .eq('workspace_id', workspaceId);
    }

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
    // Empty body defaults to full workspace update
  }

  const auth = await authenticateAdmin(request, locals, body.workspace_id);
  if (auth.error) return auth.error;

  const { workspaceId, competitorsClient, runtimeEnv } = auth.ok!;

  // 1. Resolve Target Scope & Competitor IDs
  const scope = body.scope || (body.competitor_id || (Array.isArray(body.ids) && body.ids.length > 0) ? 'selected' : 'all');
  let selectedIds: string[] = [];

  if (Array.isArray(body.ids) && body.ids.length > 0) {
    selectedIds = body.ids.filter((id: string) => UUID_REGEX.test(id));
  } else if (body.competitor_id && UUID_REGEX.test(body.competitor_id)) {
    selectedIds = [body.competitor_id];
  } else if (Array.isArray(body.competitor_ids) && body.competitor_ids.length > 0) {
    selectedIds = body.competitor_ids.filter((id: string) => UUID_REGEX.test(id));
  }

  const targetScope = scope === 'selected' && selectedIds.length > 0 ? 'Selected' : 'All Active';
  const forceRun = Boolean(body.force === true || body.force === 'true');
  const dryRun = Boolean(body.dry_run === true || body.dry_run === 'true');
  const targetUsername = typeof body.username === 'string' ? body.username.trim() : (typeof body.target_username === 'string' ? body.target_username.trim() : '');

  try {
    // 2. Insert Ingestion Job record with 'running' status (not queued) and trigger origin
    const trigger = (selectedIds.length === 1 || body.competitor_id) ? 'run_now' : 'full';
    const { data: job, error: jobErr } = await competitorsClient
      .from('competitor_ingestion_jobs')
      .insert({
        workspace_id: workspaceId,
        competitor_id: selectedIds.length === 1 ? selectedIds[0] : (body.competitor_id || null),
        status: 'running',
        trigger,
        items_processed: 0,
        started_at: new Date().toISOString(),
      })
      .select('id, workspace_id, competitor_id, status, trigger, created_at')
      .single();

    if (jobErr || !job) throw jobErr || new Error('Failed to create ingestion job record');

    // 3. Dispatch to GitHub Actions workflow directly
    const githubRepo =
      (runtimeEnv.GITHUB_REPO as string) ||
      (typeof process !== 'undefined' ? process.env.GITHUB_REPO : '') ||
      'sayfedin-star/PinOrbit-v2';

    const dispatchToken =
      (runtimeEnv.GITHUB_DISPATCH_TOKEN as string) ||
      (runtimeEnv.GH_REFRESH_TOKEN as string) ||
      (typeof process !== 'undefined' ? process.env.GITHUB_DISPATCH_TOKEN || process.env.GH_REFRESH_TOKEN : '') ||
      '';

    if (!dispatchToken || !dispatchToken.trim()) {
      // If dispatch token is missing, fail job in DB and return error
      await competitorsClient
        .from('competitor_ingestion_jobs')
        .update({ status: 'failed', error_message: 'GitHub dispatch token not configured on server', completed_at: new Date().toISOString() })
        .eq('id', job.id);

      return jsonResponse({ success: false, error: 'GitHub dispatch token not configured on server' }, 503);
    }

    const dispatchEndpoint = `https://api.github.com/repos/${githubRepo}/actions/workflows/update-competitors.yml/dispatches`;

    const ghRes = await fetch(dispatchEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${dispatchToken.trim()}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'PinOrbit-v2',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          workspace_id: workspaceId,
          target_scope: targetScope,
          competitor_ids: selectedIds.join(','),
          target_username: targetUsername,
          dry_run: dryRun ? 'true' : '',
          force_run: forceRun ? 'true' : '',
        },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (ghRes.status === 204 || (ghRes.status >= 200 && ghRes.status < 300)) {
      return jsonResponse(
        {
          success: true,
          dispatched: true,
          job_id: job.id,
          scope,
          target_scope: targetScope,
          count: selectedIds.length > 0 ? selectedIds.length : 'all',
          force: forceRun,
        },
        202
      );
    }

    // GitHub upstream returned error
    await competitorsClient
      .from('competitor_ingestion_jobs')
      .update({
        status: 'failed',
        error_message: `GitHub dispatch upstream returned HTTP ${ghRes.status}`,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    return jsonResponse(
      { success: false, error: `GitHub dispatch upstream returned HTTP ${ghRes.status}` },
      502
    );
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message || 'Failed to dispatch competitor update' }, 500);
  }
};
