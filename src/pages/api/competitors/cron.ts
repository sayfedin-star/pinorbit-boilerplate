export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { getEffectiveSecret } from '../../../server/services/webhook-secrets';
import { fastcronCall } from '../../../server/lib/fastcron-client';
import { listWorkspaceTokens, resolveToken } from '../../../server/lib/token-resolver';

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

export function extractPostData(job: any): any | null {
  const raw = job.post_data || job.postdata;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function isMatchingCompetitorJob(job: any, workspaceId: string, dispatchEndpointUrl: string): boolean {
  const postData = extractPostData(job);
  const urlMatches = typeof job.url === 'string' && (
    job.url === dispatchEndpointUrl ||
    job.url.includes('/api/internal/competitors/dispatch') ||
    job.url.includes('/competitors/dispatch')
  );

  if (postData && postData.pipeline === 'competitors' && (!postData.workspace_id || postData.workspace_id === workspaceId)) {
    return true;
  }

  if (urlMatches && (
    !job.name ||
    job.name.toLowerCase().includes('competitor') ||
    job.name.toLowerCase().includes('pinorbit competitors') ||
    (workspaceId && job.name.includes(workspaceId.slice(0, 8)))
  )) {
    return true;
  }

  return false;
}

export interface ResolvedFastCronToken {
  id: string | null;
  name: string;
  masked_token: string;
  is_default: boolean;
  source: 'workspace_registry' | 'env';
  token: string;
}

export async function getWorkspaceFastCronTokens(
  workspaceId: string,
  runtimeEnv: Record<string, any>
): Promise<ResolvedFastCronToken[]> {
  const summaries = await listWorkspaceTokens(workspaceId, 'competitors', runtimeEnv, true);
  return summaries
    .filter((s): s is typeof s & { token: string } => Boolean(s.token))
    .map((s) => ({
      id: s.id,
      name: s.name,
      masked_token: s.masked_token,
      is_default: s.is_default,
      source: s.source,
      token: s.token,
    }));
}

export async function resolveTargetToken(
  tokenId: string | null | undefined,
  workspaceId: string,
  runtimeEnv: Record<string, any>
): Promise<ResolvedFastCronToken | null> {
  try {
    const res = await resolveToken(
      { workspaceId, tokenId: tokenId || undefined },
      'competitors',
      runtimeEnv
    );
    return {
      id: res.tokenId || null,
      name: res.name || 'Workspace Token',
      masked_token: res.maskedToken || ('••••' + res.token.slice(-4)),
      is_default: true,
      source: res.source === 'env' ? 'env' : 'workspace_registry',
      token: res.token,
    };
  } catch {
    return null;
  }
}

// ── GET Handler: Lists Competitors FastCron Jobs & Tokens ─────────────────────
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
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);

    const dispatchUrl = getDispatchEndpointUrl(runtimeEnv);
    const tokens = await getWorkspaceFastCronTokens(workspaceId, runtimeEnv);

    if (tokens.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          tokens: [],
          jobs: [],
          job: null,
          configured: false,
          token_source: null,
          token_name: null,
          masked_token: null,
          error: 'FastCron API token not configured on server or in workspace registry.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const liveJobsMap = new Map<number, { job: any; tokenInfo: ResolvedFastCronToken }>();

    for (const tokenItem of tokens) {
      try {
        const res = await fastcronCall('cron_list', { keyword: 'PinOrbit' }, tokenItem.token);
        const list: any[] = Array.isArray(res.data)
          ? res.data
          : Array.isArray(res.data?.data)
            ? res.data.data
            : Array.isArray(res.data?.jobs)
              ? res.data.jobs
              : [];

        for (const j of list) {
          if (isMatchingCompetitorJob(j, workspaceId, dispatchUrl)) {
            const jId = Number(j.id);
            if (!isNaN(jId) && jId > 0 && !liveJobsMap.has(jId)) {
              liveJobsMap.set(jId, { job: j, tokenInfo: tokenItem });
            }
          }
        }
      } catch (listErr) {
        console.warn(`[Competitors FastCron] List failed for token ${tokenItem.masked_token}:`, listErr);
      }
    }

    const jobEntries = Array.from(liveJobsMap.values());
    const enrichedJobs = await Promise.all(
      jobEntries.map(async ({ job, tokenInfo: itemTokenInfo }) => {
        let cronNext: any[] = [];
        let cronLogs: any[] = [];

        try {
          const [nextRes, logsRes] = await Promise.all([
            fastcronCall('cron_next', { id: job.id }, itemTokenInfo.token),
            fastcronCall('cron_logs', { id: job.id }, itemTokenInfo.token),
          ]);

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
        } catch {}

        const postData = extractPostData(job) || {};
        const isPaused =
          job.status === 'disabled' ||
          job.status === 'paused' ||
          job.paused === true ||
          job.paused === 1 ||
          job.paused === '1';

        return {
          id: Number(job.id),
          name: job.name,
          label: postData.label || job.name,
          expression: job.expression || job.cron_expression || '0 2 * * *',
          timezone: job.timezone || 'UTC',
          url: job.url,
          paused: isPaused,
          status: isPaused ? 'paused' : 'active',
          next_run: toMs(cronNext[0] || job.next_run),
          last_run: toMs(cronLogs[0]?.date || job.last_run),
          last_status: cronLogs[0]?.status || job.last_status || null,
          last_http_code: cronLogs[0]?.http_status_code || null,
          token_id: itemTokenInfo.id,
          token_name: itemTokenInfo.name,
          masked_token: itemTokenInfo.masked_token,
          token_source: itemTokenInfo.source,
          cron_logs: cronLogs.slice(0, 10),
          cron_next: cronNext.slice(0, 5),
        };
      })
    );

    const primaryJob = enrichedJobs[0] || null;
    const defaultToken = tokens.find((t) => t.is_default) || tokens[0] || null;

    return new Response(
      JSON.stringify({
        success: true,
        configured: Boolean(primaryJob),
        token_source: defaultToken?.source || null,
        token_name: defaultToken?.name || null,
        masked_token: defaultToken?.masked_token || null,
        job: primaryJob,
        jobs: enrichedJobs,
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
      JSON.stringify({ success: false, error: err.message || 'Internal Server Error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// ── POST Handler: Create, Edit, Pause, Resume, Sync Missing, Run Now ─────────
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

  const action = body?.action || 'create';

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');

    const dispatchUrl = getDispatchEndpointUrl(runtimeEnv);
    const effSecret = await getEffectiveSecret(workspaceId, runtimeEnv);
    if (!effSecret || !effSecret.value || effSecret.value.trim() === '') {
      return new Response(
        JSON.stringify({ success: false, error: 'Ingest secret not configured for workspace.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const targetTokenObj = await resolveTargetToken(body?.token_id, workspaceId, runtimeEnv);
    if (!targetTokenObj || !targetTokenObj.token) {
      return new Response(
        JSON.stringify({ success: false, error: 'FastCron API token not configured on server or in workspace registry.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const token = targetTokenObj.token;
    const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);

    // ── Branch: sync_missing (Creates default 0 2 * * * job if 0 jobs found) ──
    if (action === 'sync_missing') {
      const listRes = await fastcronCall('cron_list', { keyword: 'PinOrbit' }, token);
      const existingList: any[] = Array.isArray(listRes.data)
        ? listRes.data
        : Array.isArray(listRes.data?.data)
          ? listRes.data.data
          : Array.isArray(listRes.data?.jobs)
            ? listRes.data.jobs
            : [];

      const matchedJobs = existingList.filter((j) => isMatchingCompetitorJob(j, workspaceId, dispatchUrl));
      if (matchedJobs.length > 0) {
        let repairedCount = 0;
        for (const job of matchedJobs) {
          const jobId = Number(job.id);
          if (jobId) {
            const jobLabel =
              job.name?.replace(/^PinOrbit\s*competitors\s*—\s*/i, '').replace(/\s*—\s*[a-f0-9-]+$/i, '') || 'Default Daily';
            const repairPostData = JSON.stringify({
              workspace_id: workspaceId,
              pipeline: 'competitors',
              label: jobLabel,
            });
            const repairParams = {
              id: jobId,
              name: `PinOrbit competitors — ${jobLabel} — ${workspaceId.slice(0, 8)}`,
              url: getDispatchEndpointUrl(runtimeEnv, workspaceId),
              expression: job.expression || job.cron_expression || '0 2 * * *',
              timezone: job.timezone || 'UTC',
              httpMethod: 'POST',
              http_method: 'POST',
              httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
              http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
              postData: repairPostData,
              post_data: repairPostData,
              status: (job.status === 'disabled' || job.paused) ? 'disabled' : 'enabled',
            };
            const editRes = await fastcronCall('cron_edit', repairParams, token);
            if (editRes.success) repairedCount++;
          }
        }

        const firstJob = matchedJobs[0];
        await compAdmin
          .from('competitor_pipeline_settings')
          .upsert({
            workspace_id: workspaceId,
            fastcron_job_id: String(firstJob.id),
            cron_expression: firstJob.expression || '0 2 * * *',
            cron_provider: 'fastcron',
            schedule_status: firstJob.status === 'disabled' || firstJob.paused ? 'paused' : 'active',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'workspace_id' });

        return new Response(
          JSON.stringify({
            success: true,
            message: `Verified and repaired ${repairedCount} existing FastCron job(s) for this workspace.`,
            count: matchedJobs.length,
            repaired: repairedCount,
            job: firstJob,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const defaultPostDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'competitors', label: 'Default Daily' });
      const defaultParams = {
        name: `PinOrbit competitors — Default Daily — ${workspaceId.slice(0, 8)}`,
        url: getDispatchEndpointUrl(runtimeEnv, workspaceId),
        expression: '0 2 * * *',
        timezone: 'UTC',
        httpMethod: 'POST',
        http_method: 'POST',
        httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
        http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
        postData: defaultPostDataStr,
        post_data: defaultPostDataStr,
        status: 'enabled',
      };

      const addRes = await fastcronCall('cron_add', defaultParams, token);
      if (!addRes.success) {
        return new Response(
          JSON.stringify({ success: false, error: addRes.error || 'Failed to create default competitor FastCron job.' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const createdJobId = String(addRes.data?.id || addRes.data?.data?.id || '');
      if (createdJobId) {
        await compAdmin
          .from('competitor_pipeline_settings')
          .upsert({
            workspace_id: workspaceId,
            fastcron_job_id: createdJobId,
            cron_expression: '0 2 * * *',
            cron_provider: 'fastcron',
            schedule_status: 'active',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'workspace_id' });
      }

      return new Response(
        JSON.stringify({ success: true, message: 'Default daily FastCron job created (02:00 UTC).', job: addRes.data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Branch: pause / resume ──────────────────────────────────────────────
    if (action === 'pause' || action === 'resume') {
      const jobId = Number(body?.job_id);
      if (!jobId || isNaN(jobId)) {
        return new Response(
          JSON.stringify({ success: false, error: 'job_id is required for pause/resume.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const toggleAction = action === 'pause' ? 'cron_disable' : 'cron_enable';
      const toggleRes = await fastcronCall(toggleAction, { id: jobId }, token);

      if (!toggleRes.success) {
        return new Response(
          JSON.stringify({ success: false, error: toggleRes.error || `Failed to ${action} job.` }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      await compAdmin
        .from('competitor_pipeline_settings')
        .update({
          schedule_status: action === 'pause' ? 'paused' : 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', workspaceId);

      return new Response(
        JSON.stringify({ success: true, message: `FastCron job #${jobId} ${action === 'pause' ? 'paused' : 'resumed'}.` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Branch: create / edit ───────────────────────────────────────────────
    const label = body?.label?.trim() || 'Competitor Refresh';
    const rawCron = body?.cron_expression || '0 2 * * *';
    const cronValidation = validateCronExpression(rawCron);
    if (!cronValidation.valid) {
      return new Response(
        JSON.stringify({ success: false, error: cronValidation.error }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const cronExpression = cronValidation.cron!;
    const timezone = body?.timezone || 'UTC';
    const enabled = body?.enabled !== false;
    const postDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'competitors', label });

    const fastcronParams = {
      name: `PinOrbit competitors — ${label} — ${workspaceId.slice(0, 8)}`,
      url: getDispatchEndpointUrl(runtimeEnv, workspaceId),
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

    const isEdit = action === 'edit' || Boolean(body?.job_id);
    let apiRes: any;

    if (isEdit) {
      const jobId = Number(body.job_id);
      apiRes = await fastcronCall('cron_edit', { id: jobId, ...fastcronParams }, token);
    } else {
      apiRes = await fastcronCall('cron_add', fastcronParams, token);
    }

    if (!apiRes.success) {
      return new Response(
        JSON.stringify({ success: false, error: apiRes.error || `Failed to ${isEdit ? 'edit' : 'create'} FastCron job.` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const savedJobId = String(body.job_id || apiRes.data?.id || apiRes.data?.data?.id || '');
    await compAdmin
      .from('competitor_pipeline_settings')
      .upsert({
        workspace_id: workspaceId,
        fastcron_job_id: savedJobId || null,
        cron_expression: cronExpression,
        timezone,
        cron_provider: 'fastcron',
        schedule_status: enabled ? 'active' : 'paused',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id' });

    return new Response(
      JSON.stringify({
        success: true,
        message: `FastCron job ${isEdit ? 'updated' : 'created'} successfully.`,
        job: apiRes.data,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Internal Server Error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// ── DELETE Handler: Delete Job from FastCron ─────────────────────────────────
export const DELETE: APIRoute = async ({ request, locals }) => {
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

  let jobId: number | null = null;
  let tokenId: string | null = null;

  const url = new URL(request.url);
  if (url.searchParams.get('job_id')) jobId = Number(url.searchParams.get('job_id'));

  if (!jobId) {
    try {
      const body = await request.json();
      if (body?.job_id) jobId = Number(body.job_id);
      if (body?.id) jobId = Number(body.id);
      if (body?.token_id) tokenId = body.token_id;
    } catch {}
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');

    const targetTokenObj = await resolveTargetToken(tokenId, workspaceId, runtimeEnv);
    if (!targetTokenObj || !targetTokenObj.token) {
      return new Response(
        JSON.stringify({ success: false, error: 'FastCron API token not configured on server.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (jobId) {
      const delRes = await fastcronCall('cron_delete', { id: jobId }, targetTokenObj.token);
      if (!delRes.success) {
        return new Response(
          JSON.stringify({ success: false, error: delRes.error || 'Failed to delete FastCron job.' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);
    await compAdmin
      .from('competitor_pipeline_settings')
      .update({
        fastcron_job_id: null,
        schedule_status: 'pending',
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_id', workspaceId);

    return new Response(
      JSON.stringify({ success: true, message: 'FastCron job deleted.' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Internal Server Error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
