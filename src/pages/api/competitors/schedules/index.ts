export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { dbClients } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { fastcronCall } from '../../../../server/lib/fastcron-client';
import { listWorkspaceTokens, resolveToken } from '../../../../server/lib/token-resolver';
import { isMatchingCompetitorJob } from '../cron';

export const getDispatchEndpointUrl = (runtimeEnv?: Record<string, any>, workspaceId?: string): string => {
  const base =
    (runtimeEnv?.COMPETITORS_DISPATCH_URL as string) ||
    (typeof process !== 'undefined' ? process.env.COMPETITORS_DISPATCH_URL : '') ||
    'https://pinorbit-v2.o-i.workers.dev/api/internal/competitors/dispatch';

  if (workspaceId) {
    const url = new URL(base);
    url.searchParams.set('workspace_id', workspaceId);
    return url.toString();
  }
  return base;
};

export const toMs = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    const num = Number(v);
    if (!isNaN(num) && num > 0) {
      return num < 1e12 ? num * 1000 : num;
    }
    const d = new Date(v).getTime();
    return isNaN(d) ? null : d;
  }
  return null;
};

export function validateCronExpression(expr?: string | null): { valid: boolean; cron?: string; error?: string } {
  if (!expr || typeof expr !== 'string' || expr.trim().length === 0) {
    return { valid: false, error: 'Cron expression cannot be empty.' };
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) {
    return { valid: false, error: 'Standard cron expression must contain at least 5 fields (min hour dom mon dow).' };
  }
  return { valid: true, cron: parts.slice(0, 5).join(' ') };
}

// ── GET: List Competitor Multi-Schedules & Discover Remote FastCron Jobs ─────
export const GET: APIRoute = async ({ locals }) => {
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
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'member');
    const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);
    const dispatchUrl = getDispatchEndpointUrl(runtimeEnv);

    // 1. Fetch persistent schedules from P2
    let { data: dbSchedules, error: schedErr } = await compAdmin
      .from('competitor_schedules')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });

    if (schedErr) throw schedErr;
    dbSchedules = dbSchedules || [];

    // 2. Fetch available tokens
    const tokens = await listWorkspaceTokens(workspaceId, 'competitors', runtimeEnv, true);
    const tokenMap = new Map<string, typeof tokens[0]>();
    for (const t of tokens) {
      if (t.id) tokenMap.set(t.id, t);
    }
    const defaultToken = tokens.find((t) => t.is_default) || tokens[0] || null;

    // 3. FastCron Discovery: Discover any remote FastCron jobs for this workspace
    const knownJobIds = new Set<string>(dbSchedules.map((s: any) => String(s.fastcron_job_id || '')));
    const discoveredRemoteJobs: any[] = [];

    if (defaultToken?.token) {
      try {
        const listRes = await fastcronCall('cron_list', { keyword: 'PinOrbit' }, defaultToken.token);
        const rawJobs = Array.isArray(listRes.data)
          ? listRes.data
          : Array.isArray(listRes.data?.data)
            ? listRes.data.data
            : Array.isArray(listRes.data?.jobs)
              ? listRes.data.jobs
              : [];

        for (const rJob of rawJobs) {
          if (isMatchingCompetitorJob(rJob, workspaceId, dispatchUrl)) {
            const rJobIdStr = String(rJob.id);
            if (!knownJobIds.has(rJobIdStr)) {
              // Remote orphan/duplicate job discovered in FastCron! Auto-adopt into competitor_schedules
              try {
                const { data: adoptedRow } = await compAdmin
                  .from('competitor_schedules')
                  .insert({
                    workspace_id: workspaceId,
                    label: rJob.name?.replace(/^PinOrbit\s*competitors\s*—\s*/i, '').replace(/\s*—\s*[a-f0-9-]+$/i, '') || 'Default Daily',
                    cron_expression: rJob.expression || rJob.cron_expression || '0 2 * * *',
                    timezone: rJob.timezone || 'UTC',
                    fastcron_token_id: defaultToken.id || null,
                    fastcron_job_id: rJobIdStr,
                    status: (rJob.status === 'disabled' || rJob.paused) ? 'paused' : 'active',
                  })
                  .select('*')
                  .single();

                if (adoptedRow) {
                  dbSchedules.push(adoptedRow);
                  knownJobIds.add(rJobIdStr);
                }
              } catch (adoptErr) {
                console.warn('[Competitors Discovery] Failed to adopt FastCron job #' + rJobIdStr, adoptErr);
              }
            }
          }
        }
      } catch (discErr) {
        console.warn('[Competitors Discovery] Remote FastCron list failed:', discErr);
      }
    }

    // 4. Enrich each schedule with FastCron live telemetry if job_id exists
    const enrichedSchedules = await Promise.all(
      (dbSchedules || []).map(async (sched: any) => {
        let cronNext: any[] = [];
        let cronLogs: any[] = [];
        let liveJob: any = null;

        const assignedToken = sched.fastcron_token_id ? tokenMap.get(sched.fastcron_token_id) : defaultToken;
        const apiToken = assignedToken?.token || defaultToken?.token;

        if (sched.fastcron_job_id && apiToken) {
          try {
            const [getRes, nextRes, logsRes] = await Promise.all([
              fastcronCall('cron_get', { id: Number(sched.fastcron_job_id) }, apiToken),
              fastcronCall('cron_next', { id: Number(sched.fastcron_job_id) }, apiToken),
              fastcronCall('cron_logs', { id: Number(sched.fastcron_job_id) }, apiToken),
            ]);

            liveJob = getRes.data?.data || getRes.data?.job || getRes.data || null;

            cronNext = Array.isArray(nextRes.data)
              ? nextRes.data
              : Array.isArray(nextRes.data?.data)
                ? nextRes.data.data
                : Array.isArray(nextRes.data?.next)
                  ? nextRes.data.next
                  : [];

            cronLogs = Array.isArray(logsRes.data)
              ? logsRes.data
              : Array.isArray(logsRes.data?.data)
                ? logsRes.data.data
                : Array.isArray(logsRes.data?.logs)
                  ? logsRes.data.logs
                  : [];
          } catch (telemetryErr) {
            console.warn(`[Competitors Schedule Telemetry] Failed for job #${sched.fastcron_job_id}:`, telemetryErr);
          }
        }

        const isPaused =
          sched.status === 'paused' ||
          liveJob?.status === 'disabled' ||
          liveJob?.status === 'paused' ||
          liveJob?.paused === true ||
          liveJob?.paused === 1;

        return {
          id: sched.id,
          fastcron_job_id: sched.fastcron_job_id ? Number(sched.fastcron_job_id) : null,
          label: sched.label || 'Default Daily',
          expression: sched.cron_expression,
          timezone: sched.timezone || 'UTC',
          status: isPaused ? 'paused' : sched.status || 'active',
          paused: isPaused,
          dispatch_token: sched.dispatch_token,
          fastcron_token_id: sched.fastcron_token_id,
          token_name: assignedToken?.name || 'Workspace Default',
          masked_token: assignedToken?.masked_token || defaultToken?.masked_token || '••••••••',
          token_source: assignedToken?.source || defaultToken?.source || 'workspace_registry',
          next_run: toMs(cronNext[0] || liveJob?.next_run),
          last_run: toMs(cronLogs[0]?.date || liveJob?.last_run),
          last_status: cronLogs[0]?.status || liveJob?.last_status || null,
          last_http_code: cronLogs[0]?.http_status_code || null,
          cron_logs: cronLogs.slice(0, 10),
          cron_next: cronNext.slice(0, 5),
          created_at: sched.created_at,
          updated_at: sched.updated_at,
        };
      })
    );

    return new Response(
      JSON.stringify({
        success: true,
        schedules: enrichedSchedules,
        tokens: tokens.map((t) => ({
          id: t.id,
          name: t.name,
          masked_token: t.masked_token,
          is_default: t.is_default,
          source: t.source,
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to fetch competitor schedules' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// ── POST: Create New Competitor Multi-Schedule ────────────────────────────────
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
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

  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Competitor Ingestion';
  const rawCron = body.cron_expression || '0 2 * * *';
  const cronValidation = validateCronExpression(rawCron);
  if (!cronValidation.valid) {
    return new Response(
      JSON.stringify({ success: false, error: cronValidation.error }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const cronExpression = cronValidation.cron!;
  const timezone = body.timezone || 'UTC';
  const enabled = body.enabled !== false;
  const tokenId = body.token_id || body.fastcron_token_id || null;

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');

    const dispatchUrl = getDispatchEndpointUrl(runtimeEnv, workspaceId);
    const effSecret = await getEffectiveSecret(workspaceId, runtimeEnv);
    if (!effSecret || !effSecret.value || effSecret.value.trim() === '') {
      return new Response(
        JSON.stringify({ success: false, error: 'Ingest secret not configured for workspace.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const targetTokenObj = await resolveToken(
      { workspaceId, tokenId: tokenId || undefined },
      'competitors',
      runtimeEnv
    );
    if (!targetTokenObj || !targetTokenObj.token) {
      return new Response(
        JSON.stringify({ success: false, error: 'FastCron API token not configured on server or in workspace registry.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Call FastCron cron_add with explicit http_method / httpMethod: 'POST'
    const postDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'competitors', label });
    const fastcronParams = {
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
      status: enabled ? 'enabled' : 'disabled',
    };

    const addRes = await fastcronCall('cron_add', fastcronParams, targetTokenObj.token);
    if (!addRes.success) {
      return new Response(
        JSON.stringify({ success: false, error: addRes.error || 'Failed to create schedule in FastCron.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const createdJobId = String(addRes.data?.id || addRes.data?.data?.id || '');
    const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);

    const { data: newRow, error: insertErr } = await compAdmin
      .from('competitor_schedules')
      .insert({
        workspace_id: workspaceId,
        label,
        cron_expression: cronExpression,
        timezone,
        fastcron_token_id: targetTokenObj.tokenId || null,
        fastcron_job_id: createdJobId || null,
        status: enabled ? 'active' : 'paused',
      })
      .select('*')
      .single();

    if (insertErr) throw insertErr;

    return new Response(
      JSON.stringify({ success: true, schedule: newRow, message: 'Schedule created successfully.' }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to create competitor schedule' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
