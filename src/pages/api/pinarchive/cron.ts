export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients, getServerEnv } from '../../../server/db/clients';
import { getEffectiveSecret, maskSecret } from '../../../server/services/webhook-secrets';
import { resolveScheduleToken } from '../../../server/services/fastcron-service';
import { resolveTokenKek, decryptToken } from '../../../server/lib/token-crypto';

export const FASTCRON_BASE = 'https://www.fastcron.com/api/v1';

export const getDispatchEndpointUrl = (runtimeEnv?: Record<string, any>, workspaceId?: string): string => {
  const base =
    (runtimeEnv?.PINARCHIVE_DISPATCH_URL as string) ||
    (typeof process !== 'undefined' ? process.env.PINARCHIVE_DISPATCH_URL : '') ||
    'https://pinorbit-v2.o-i.workers.dev/api/internal/pinarchive/dispatch';

  if (workspaceId) {
    const url = new URL(base);
    url.searchParams.set('workspace_id', workspaceId);
    return url.toString();
  }
  return base;
};

/**
 * Epoch normalization helper (v6-T2).
 * Normalizes seconds-based timestamps (< 1e12) to millisecond epoch numbers.
 */
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

/**
 * Converts HH:MM (24-hour) format to standard cron expression: M H * * *
 */
export function parseTimeToCron(timeStr?: string | null): { valid: boolean; cron?: string; error?: string } {
  if (!timeStr || !/^\d{1,2}:\d{2}$/.test(timeStr.trim())) {
    return { valid: false, error: 'Time must be in HH:MM (24-hour) format (e.g. 04:00).' };
  }

  const [hStr, mStr] = timeStr.trim().split(':');
  const hour = parseInt(hStr, 10);
  const minute = parseInt(mStr, 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { valid: false, error: 'Hour must be between 0-23 and minute between 0-59.' };
  }

  return {
    valid: true,
    cron: `${minute} ${hour} * * *`,
  };
}

/**
 * Validates standard 5-part cron expression (min hour dom mon dow).
 */
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

import { fastcronCall as sharedFastcronCall } from '../../../server/lib/fastcron-client';
import { listWorkspaceTokens, resolveToken } from '../../../server/lib/token-resolver';

/**
 * Low-level FastCron API dispatch with fallback and timeout.
 */
export async function fastcronCall(
  action: string,
  params: Record<string, any>,
  token: string
): Promise<{ success: boolean; data?: any; error?: string }> {
  return sharedFastcronCall(action, params, token);
}

export interface ResolvedFastCronToken {
  id: string | null;
  name: string;
  masked_token: string;
  is_default: boolean;
  source: 'workspace_registry' | 'env';
  token: string;
}

/**
 * Resolves all available FastCron tokens for a workspace from PinArchive-P4 isolated table.
 */
export async function getWorkspaceFastCronTokens(
  workspaceId: string,
  runtimeEnv: Record<string, any>
): Promise<ResolvedFastCronToken[]> {
  const summaries = await listWorkspaceTokens(workspaceId, 'pinarchive', runtimeEnv, true);
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

/**
 * Resolves a specific token by token_id or returns the default workspace / env token.
 */
export async function resolveTargetToken(
  tokenId: string | null | undefined,
  workspaceId: string,
  runtimeEnv: Record<string, any>
): Promise<ResolvedFastCronToken | null> {
  try {
    const res = await resolveToken(
      { workspaceId, tokenId: tokenId || undefined },
      'pinarchive',
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

/**
 * Token info helper for backwards compatibility.
 */
export async function getPinArchiveTokenInfo(
  workspaceId: string,
  runtimeEnv: Record<string, any>
): Promise<{
  token: string | null;
  token_source: 'workspace_registry' | 'env' | null;
  token_name: string | null;
  masked_token: string | null;
}> {
  try {
    const res = await resolveToken({ workspaceId }, 'pinarchive', runtimeEnv);
    return {
      token: res.token,
      token_source: res.source === 'env' ? 'env' : 'workspace_registry',
      token_name: res.name || 'Workspace Default',
      masked_token: res.maskedToken || ('••••' + res.token.slice(-4)),
    };
  } catch {
    return {
      token: null,
      token_source: null,
      token_name: null,
      masked_token: null,
    };
  }
}

/**
 * Parses post_data from a FastCron job object.
 */
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

/**
 * Verifies that a FastCron job belongs to PinArchive in this workspace.
 */
export function isMatchingPinArchiveJob(job: any, workspaceId: string, dispatchEndpointUrl: string): boolean {
  const postData = extractPostData(job);
  const urlMatches = typeof job.url === 'string' && (
    job.url === dispatchEndpointUrl ||
    job.url.includes('/api/internal/pinarchive/dispatch') ||
    job.url.includes('/pinarchive/dispatch')
  );

  if (postData && postData.pipeline === 'pinarchive' && (!postData.workspace_id || postData.workspace_id === workspaceId)) {
    return true;
  }

  if (urlMatches && (
    !job.name ||
    job.name.toLowerCase().includes('pinarchive') ||
    job.name.toLowerCase().includes('pinorbit') ||
    (workspaceId && job.name.includes(workspaceId.slice(0, 8)))
  )) {
    return true;
  }

  return false;
}

/**
 * Stateless Discovery: Searches FastCron jobs and matches postData.pipeline === 'pinarchive' && postData.workspace_id === ws
 */
export async function discoverPinArchiveJob(
  token: string,
  workspaceId: string,
  dispatchEndpointUrl?: string
): Promise<any | null> {
  const url = dispatchEndpointUrl || 'https://pinorbit-v2.o-i.workers.dev/api/internal/pinarchive/dispatch';
  const res = await fastcronCall('cron_list', { keyword: 'PinOrbit' }, token);
  const list: any[] = Array.isArray(res.data)
    ? res.data
    : Array.isArray(res.data?.data)
      ? res.data.data
      : Array.isArray(res.data?.jobs)
        ? res.data.jobs
        : [];

  for (const j of list) {
    if (isMatchingPinArchiveJob(j, workspaceId, url)) return j;
  }

  // Fallback to full list if keyword filter was too strict
  const fullRes = await fastcronCall('cron_list', {}, token);
  const fullList: any[] = Array.isArray(fullRes.data)
    ? fullRes.data
    : Array.isArray(fullRes.data?.data)
      ? fullRes.data.data
      : Array.isArray(fullRes.data?.jobs)
        ? fullRes.data.jobs
        : [];

  for (const j of fullList) {
    if (isMatchingPinArchiveJob(j, workspaceId, url)) return j;
  }

  return null;
}

/**
 * Orphan cleanup (4-condition gate):
 * Deletes FastCron jobs on the token where:
 * 1. url === DISPATCH_ENDPOINT_URL
 * 2. postData.pipeline === 'pinarchive'
 * 3. postData.workspace_id === ws
 * 4. id NOT IN currently-known job ids
 */
export async function cleanupOrphanJobs(
  token: string,
  workspaceId: string,
  dispatchEndpointUrl: string,
  knownJobIds: Set<number>
): Promise<number> {
  let cleanedCount = 0;
  try {
    const listRes = await fastcronCall('cron_list', { keyword: 'PinOrbit' }, token);
    const jobs: any[] = Array.isArray(listRes.data)
      ? listRes.data
      : Array.isArray(listRes.data?.data)
        ? listRes.data.data
        : Array.isArray(listRes.data?.jobs)
          ? listRes.data.jobs
          : [];

    for (const j of jobs) {
      const jId = Number(j.id);
      const postData = extractPostData(j);
      const isPinArchive = postData && postData.pipeline === 'pinarchive' && postData.workspace_id === workspaceId;
      const urlMatches = typeof j.url === 'string' && (j.url === dispatchEndpointUrl || j.url.includes('/api/internal/pinarchive/dispatch'));

      // 4-Condition Gate Check
      if (
        urlMatches &&
        isPinArchive &&
        postData.workspace_id === workspaceId &&
        !knownJobIds.has(jId)
      ) {
        console.log(`[PinArchive FastCron] Deleting orphan job #${jId} (${j.name})`);
        const del = await fastcronCall('cron_delete', { id: jId }, token);
        if (del.success) cleanedCount++;
      }
    }
  } catch (err) {
    console.warn('[PinArchive FastCron] Orphan cleanup error:', err);
  }
  return cleanedCount;
}

/**
 * GET: Retrieves multi-token FastCron jobs for PinArchive in the active workspace.
 */
export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    (typeof process !== 'undefined' ? process.env : {}) ||
    {};

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
    const tokenInfo = await getPinArchiveTokenInfo(workspaceId, runtimeEnv);

    if (!tokenInfo.token && tokens.length === 0) {
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

    // Fetch jobs across each distinct token
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
          if (isMatchingPinArchiveJob(j, workspaceId, dispatchUrl)) {
            const jId = Number(j.id);
            if (!isNaN(jId) && jId > 0 && !liveJobsMap.has(jId)) {
              liveJobsMap.set(jId, { job: j, tokenInfo: tokenItem });
            }
          }
        }
      } catch (listErr) {
        console.warn(`[PinArchive FastCron] List failed for token ${tokenItem.masked_token}:`, listErr);
      }
    }

    // Enrich each discovered job with cron_next and cron_logs (last 10) in parallel
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
        } catch {
          // fail-lazy on telemetry fetch
        }

        const postData = extractPostData(job) || {};
        const isPaused =
          job.status === 'disabled' ||
          job.status === 'paused' ||
          job.status === 0 ||
          job.status === '0' ||
          job.paused === true;

        const nextRunRaw = cronNext[0] || job.cron_next || job.next_run_at || job.nextRun;
        const lastLog = cronLogs[0] || null;
        const lastRunRaw = lastLog?.date || lastLog?.created_at || job.last_run_at || job.lastRun;

        let label = postData.label;
        if (!label && job.name && job.name.includes(' — ')) {
          const parts = job.name.split(' — ');
          if (parts.length >= 2) label = parts[1].trim();
        }
        if (!label) label = 'Daily Refresh';

        return {
          id: Number(job.id),
          name: job.name || `PinOrbit pinarchive — ${label}`,
          label,
          expression: job.expression || job.cron_expression || '0 3 * * *',
          timezone: job.timezone || 'UTC',
          paused: isPaused,
          status: isPaused ? 'disabled' : 'enabled',
          next_run: toMs(nextRunRaw),
          last_run: toMs(lastRunRaw),
          last_status: lastLog?.status || (lastLog?.http_status_code === 202 ? 'OK' : null),
          last_http_code: lastLog?.http_status_code || lastLog?.status_code || null,
          masked_token: itemTokenInfo.masked_token,
          token_name: itemTokenInfo.name,
          token_id: itemTokenInfo.id,
          token_source: itemTokenInfo.source,
          cron_next: cronNext,
          cron_logs: cronLogs.slice(0, 10),
          post_data: postData,
        };
      })
    );

    return new Response(
      JSON.stringify({
        success: true,
        configured: true,
        token_source: tokenInfo.token_source || 'workspace_registry',
        token_name: tokenInfo.token_name || 'Workspace Default',
        masked_token: tokenInfo.masked_token || 'fastcron...',
        tokens: tokens.map((t) => ({
          id: t.id,
          name: t.name,
          masked_token: t.masked_token,
          is_default: t.is_default,
          source: t.source,
        })),
        jobs: enrichedJobs,
        // Backward-compatibility single job alias for legacy cards
        job: enrichedJobs[0] || null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Failed to retrieve FastCron jobs.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST: Handles multi-job actions (create, edit, pause, resume, clone, run_now, sync_missing).
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    (typeof process !== 'undefined' ? process.env : {}) ||
    {};

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized or missing workspace' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Malformed JSON payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);

    const action = body?.action || 'create';
    const dispatchUrl = getDispatchEndpointUrl(runtimeEnv);

    // ── Branch: run_now (Server-side GitHub dispatch with force=true) ───────
    if (action === 'run_now') {
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
        return new Response(
          JSON.stringify({ success: false, error: 'GitHub dispatch token not configured on server.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const dispatchEndpoint = `https://api.github.com/repos/${githubRepo}/actions/workflows/pinarchive-refresh.yml/dispatches`;

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
            force: 'true',
          },
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (ghRes.status === 204 || (ghRes.status >= 200 && ghRes.status < 300)) {
        return new Response(
          JSON.stringify({ success: true, message: 'Workflow run dispatched immediately with force.' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: `GitHub dispatch failed with HTTP ${ghRes.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Resolve Target Token & Effective Ingest Secret ──────────────────────
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

    // ── Branch: sync_missing (Creates default job if 0 jobs found) ──────────
    if (action === 'sync_missing') {
      const listRes = await fastcronCall('cron_list', { keyword: 'PinOrbit' }, token);
      const existingList: any[] = Array.isArray(listRes.data)
        ? listRes.data
        : Array.isArray(listRes.data?.data)
          ? listRes.data.data
          : Array.isArray(listRes.data?.jobs)
            ? listRes.data.jobs
            : [];

      const matchedJobs = existingList.filter((j) => isMatchingPinArchiveJob(j, workspaceId, dispatchUrl));
      if (matchedJobs.length > 0) {
        return new Response(
          JSON.stringify({ success: true, message: 'FastCron jobs already present for this workspace.', count: matchedJobs.length }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const dispatchUrl = getDispatchEndpointUrl(runtimeEnv, workspaceId);
      const postDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'pinarchive', label: 'Default Daily' });
      const defaultParams = {
        name: `PinOrbit pinarchive — Default Daily — ${workspaceId.slice(0, 8)}`,
        url: dispatchUrl,
        expression: '0 3 * * *',
        timezone: 'UTC',
        httpMethod: 'POST',
        http_method: 'POST',
        httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
        http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
        postData: postDataStr,
        post_data: postDataStr,
        status: 'enabled',
      };

      const addRes = await fastcronCall('cron_add', defaultParams, token);
      if (!addRes.success) {
        return new Response(
          JSON.stringify({ success: false, error: addRes.error || 'Failed to create default sync FastCron job.' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, message: 'Default daily FastCron job created (03:00 UTC).', job: addRes.data }),
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

      // Marker verification before modification
      const getRes = await fastcronCall('cron_get', { id: jobId }, token);
      const existingJob = getRes.data?.data || getRes.data?.job || getRes.data;
      if (!existingJob || !isMatchingPinArchiveJob(existingJob, workspaceId, dispatchUrl)) {
        return new Response(
          JSON.stringify({ success: false, error: 'Job not found or unauthorized marker mismatch.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
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

      return new Response(
        JSON.stringify({ success: true, message: `FastCron job #${jobId} ${action === 'pause' ? 'paused' : 'resumed'}.` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Branch: clone ───────────────────────────────────────────────────────
    if (action === 'clone') {
      const jobId = Number(body?.job_id);
      if (!jobId || isNaN(jobId)) {
        return new Response(
          JSON.stringify({ success: false, error: 'job_id is required for clone.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const getRes = await fastcronCall('cron_get', { id: jobId }, token);
      const existingJob = getRes.data?.data || getRes.data?.job || getRes.data;
      if (!existingJob || !isMatchingPinArchiveJob(existingJob, workspaceId, dispatchUrl)) {
        return new Response(
          JSON.stringify({ success: false, error: 'Job not found or unauthorized marker mismatch.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const postData = extractPostData(existingJob) || {};
      const clonedLabel = `${postData.label || 'Schedule'} (copy)`;
      const postDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'pinarchive', label: clonedLabel });
      const cloneParams = {
        name: `PinOrbit pinarchive — ${clonedLabel} — ${workspaceId.slice(0, 8)}`,
        url: getDispatchEndpointUrl(runtimeEnv, workspaceId),
        expression: existingJob.expression || '0 3 * * *',
        timezone: existingJob.timezone || 'UTC',
        httpMethod: 'POST',
        http_method: 'POST',
        httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
        http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
        postData: postDataStr,
        post_data: postDataStr,
        status: 'enabled',
      };

      const cloneRes = await fastcronCall('cron_add', cloneParams, token);
      if (!cloneRes.success) {
        return new Response(
          JSON.stringify({ success: false, error: cloneRes.error || 'Failed to clone FastCron job.' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, message: `FastCron job cloned as "${clonedLabel}".`, job: cloneRes.data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Branch: edit ────────────────────────────────────────────────────────
    if (action === 'edit' || (body?.job_id && action !== 'create')) {
      const jobId = Number(body.job_id);
      if (!jobId || isNaN(jobId)) {
        return new Response(
          JSON.stringify({ success: false, error: 'job_id is required for edit.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Marker verification before edit
      const getRes = await fastcronCall('cron_get', { id: jobId }, token);
      const existingJob = getRes.data?.data || getRes.data?.job || getRes.data;
      if (!existingJob || !isMatchingPinArchiveJob(existingJob, workspaceId, dispatchUrl)) {
        return new Response(
          JSON.stringify({ success: false, error: 'Job not found or unauthorized marker mismatch.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }

      let cronExpression: string;
      if (body.cron_expression) {
        const validCron = validateCronExpression(body.cron_expression);
        if (!validCron.valid || !validCron.cron) {
          return new Response(
            JSON.stringify({ success: false, error: validCron.error || 'Invalid cron expression.' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        cronExpression = validCron.cron;
      } else {
        const parsedCron = parseTimeToCron(body.sync_time);
        if (!parsedCron.valid || !parsedCron.cron) {
          return new Response(
            JSON.stringify({ success: false, error: parsedCron.error || 'Invalid sync_time format.' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        cronExpression = parsedCron.cron;
      }

      const label = body.label && typeof body.label === 'string' && body.label.trim().length > 0 ? body.label.trim() : 'Schedule';
      const timezone = body.timezone && typeof body.timezone === 'string' && body.timezone.trim().length > 0 ? body.timezone.trim() : 'UTC';
      const isEnabled = body.enabled !== false;
      const editPostDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'pinarchive', label });

      const editParams = {
        id: jobId,
        name: `PinOrbit pinarchive — ${label} — ${workspaceId.slice(0, 8)}`,
        url: getDispatchEndpointUrl(runtimeEnv, workspaceId),
        expression: cronExpression,
        timezone,
        httpMethod: 'POST',
        http_method: 'POST',
        httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
        http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
        postData: editPostDataStr,
        post_data: editPostDataStr,
        status: isEnabled ? 'enabled' : 'disabled',
      };

      const editRes = await fastcronCall('cron_edit', editParams, token);
      if (!editRes.success) {
        return new Response(
          JSON.stringify({ success: false, error: editRes.error || 'Failed to edit FastCron job.' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (!isEnabled) {
        await fastcronCall('cron_disable', { id: jobId }, token);
      } else {
        await fastcronCall('cron_enable', { id: jobId }, token);
      }

      // 4-Condition Orphan Cleanup
      await cleanupOrphanJobs(token, workspaceId, dispatchUrl, new Set([jobId]));

      return new Response(
        JSON.stringify({ success: true, message: 'FastCron job updated successfully.', job: editRes.data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Branch: create ──────────────────────────────────────────────────────
    let cronExpression: string;
    if (body.cron_expression) {
      const validCron = validateCronExpression(body.cron_expression);
      if (!validCron.valid || !validCron.cron) {
        return new Response(
          JSON.stringify({ success: false, error: validCron.error || 'Invalid cron expression.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      cronExpression = validCron.cron;
    } else {
      const parsedCron = parseTimeToCron(body.sync_time);
      if (!parsedCron.valid || !parsedCron.cron) {
        return new Response(
          JSON.stringify({ success: false, error: parsedCron.error || 'Invalid sync_time format.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      cronExpression = parsedCron.cron;
    }

    const label = body.label && typeof body.label === 'string' && body.label.trim().length > 0 ? body.label.trim() : 'Daily Refresh';
    const timezone = body.timezone && typeof body.timezone === 'string' && body.timezone.trim().length > 0 ? body.timezone.trim() : 'UTC';
    const isEnabled = body.enabled !== false;
    const createPostDataStr = JSON.stringify({ workspace_id: workspaceId, pipeline: 'pinarchive', label });

    const addParams = {
      name: `PinOrbit pinarchive — ${label} — ${workspaceId.slice(0, 8)}`,
      url: getDispatchEndpointUrl(runtimeEnv, workspaceId),
      expression: cronExpression,
      timezone,
      httpMethod: 'POST',
      http_method: 'POST',
      httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
      http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
      postData: createPostDataStr,
      post_data: createPostDataStr,
      status: isEnabled ? 'enabled' : 'disabled',
    };

    const addRes = await fastcronCall('cron_add', addParams, token);
    if (!addRes.success) {
      return new Response(
        JSON.stringify({ success: false, error: addRes.error || 'Failed to create FastCron job.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const newJobId = Number(addRes.data?.id || addRes.data?.data?.id);
    if (newJobId && !isEnabled) {
      await fastcronCall('cron_disable', { id: newJobId }, token);
    }

    // 4-Condition Orphan Cleanup after create
    if (newJobId) {
      await cleanupOrphanJobs(token, workspaceId, dispatchUrl, new Set([newJobId]));
    }

    return new Response(
      JSON.stringify({ success: true, message: 'FastCron job created successfully.', job: addRes.data }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Failed to process FastCron request.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE: Removes a discovered FastCron job after verifying marker and workspace_id in postData.
 */
export const DELETE: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    (typeof process !== 'undefined' ? process.env : {}) ||
    {};

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized or missing workspace' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let jobId: number | null = null;
  let tokenId: string | null = null;

  try {
    const urlObj = new URL(request.url);
    const qId = urlObj.searchParams.get('job_id') || urlObj.searchParams.get('id');
    tokenId = urlObj.searchParams.get('token_id');
    if (qId) jobId = Number(qId);
  } catch {}

  if (!jobId) {
    try {
      const body = await request.json();
      if (body?.job_id) jobId = Number(body.job_id);
      if (body?.id) jobId = Number(body.id);
      if (body?.token_id) tokenId = body.token_id;
    } catch {}
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);

    const targetTokenObj = await resolveTargetToken(tokenId, workspaceId, runtimeEnv);
    if (!targetTokenObj || !targetTokenObj.token) {
      return new Response(
        JSON.stringify({ success: false, error: 'FastCron API token not configured on server.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const token = targetTokenObj.token;
    const dispatchUrl = getDispatchEndpointUrl(runtimeEnv);

    // If specific job_id provided, verify marker before delete
    if (jobId && !isNaN(jobId)) {
      const getRes = await fastcronCall('cron_get', { id: jobId }, token);
      const existingJob = getRes.data?.data || getRes.data?.job || getRes.data;

      // Marker and Workspace ID verification before cron_delete
      if (!existingJob || !isMatchingPinArchiveJob(existingJob, workspaceId, dispatchUrl)) {
        return new Response(
          JSON.stringify({ success: false, error: 'Unauthorized marker check: Job does not belong to this workspace pipeline.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const delRes = await fastcronCall('cron_delete', { id: jobId }, token);
      if (!delRes.success) {
        return new Response(
          JSON.stringify({ success: false, error: delRes.error || 'Failed to delete FastCron job.' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      console.log(`[PinArchive FastCron] Deleted FastCron job #${jobId} for workspace ${workspaceId}`);
      return new Response(
        JSON.stringify({ success: true, message: `FastCron job #${jobId} deleted successfully.` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // If no specific job_id, delete all discovered jobs for this workspace
    const listRes = await fastcronCall('cron_list', { keyword: 'PinOrbit' }, token);
    const jobs: any[] = Array.isArray(listRes.data)
      ? listRes.data
      : Array.isArray(listRes.data?.data)
        ? listRes.data.data
        : Array.isArray(listRes.data?.jobs)
          ? listRes.data.jobs
          : [];

    let deletedCount = 0;
    for (const j of jobs) {
      if (isMatchingPinArchiveJob(j, workspaceId, dispatchUrl)) {
        const delRes = await fastcronCall('cron_delete', { id: j.id }, token);
        if (delRes.success) deletedCount++;
      }
    }

    return new Response(
      JSON.stringify({ success: true, message: `Deleted ${deletedCount} FastCron job(s) for workspace.` }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Failed to delete FastCron job.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
