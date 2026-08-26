export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { getServerEnv } from '../../../server/db/clients';
import { getEffectiveSecret } from '../../../server/services/webhook-secrets';

const FASTCRON_BASE = 'https://www.fastcron.com/api/v1';

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
 * Resolves active FastCron API token (W3 isolation).
 */
export function resolveFastCronToken(runtimeEnv?: Record<string, any>): string | null {
  const env = getServerEnv(runtimeEnv);
  const tok =
    env.FASTCRON_API_TOKEN ||
    (runtimeEnv?.FASTCRON_API_TOKEN as string) ||
    (typeof process !== 'undefined' ? process.env.FASTCRON_API_TOKEN : '');

  if (tok && typeof tok === 'string' && tok.trim().length >= 16) {
    return tok.trim();
  }
  return null;
}

/**
 * Low-level FastCron API dispatch with fallback and timeout.
 */
export async function fastcronCall(
  action: string,
  params: Record<string, any>,
  token: string
): Promise<{ success: boolean; data?: any; error?: string }> {
  const url = `${FASTCRON_BASE}/${action}`;
  const payload = { token, ...params };

  try {
    let res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 404 || res.status === 405) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null) {
          searchParams.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      }
      res = await fetch(`${url}?${searchParams.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
      });
    }

    const data = await res.json().catch(() => ({}));

    if (
      data.status === 'OK' ||
      data.status === 'success' ||
      data.id ||
      data?.data?.id ||
      Array.isArray(data) ||
      Array.isArray(data?.data)
    ) {
      return { success: true, data };
    }

    const errorMsg =
      data.message ||
      data.error ||
      data.err_message ||
      (typeof data === 'string' && data.length > 0 ? data : `FastCron returned HTTP ${res.status}`);

    return { success: false, data, error: errorMsg };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'FastCron network request failed',
    };
  }
}

/**
 * Stateless Discovery: Searches FastCron jobs and matches postData.pipeline === 'pinarchive' && postData.workspace_id === ws
 */
export async function discoverPinArchiveJob(token: string, workspaceId: string): Promise<any | null> {
  const res = await fastcronCall('cron_list', { keyword: 'PinOrbit pinarchive' }, token);
  let matched = res.success ? matchJob(res.data, workspaceId) : null;
  if (matched) return matched;

  // Fallback to full list if keyword filter was too strict
  const fullRes = await fastcronCall('cron_list', {}, token);
  if (fullRes.success) {
    matched = matchJob(fullRes.data, workspaceId);
  }
  return matched;
}

function matchJob(data: any, workspaceId: string): any | null {
  const jobs: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.jobs)
        ? data.jobs
        : [];

  for (const j of jobs) {
    let postData: any = null;
    try {
      postData = typeof j.post_data === 'string' ? JSON.parse(j.post_data) : (j.post_data || (typeof j.postdata === 'string' ? JSON.parse(j.postdata) : j.postdata));
    } catch {
      postData = null;
    }

    if (postData && postData.pipeline === 'pinarchive' && postData.workspace_id === workspaceId) {
      return j;
    }

    if (j.name && j.name.includes('PinOrbit pinarchive') && j.name.includes(workspaceId.slice(0, 8))) {
      return j;
    }
  }
  return null;
}

/**
 * GET: Retrieves discovered FastCron job + next runs + last 10 logs.
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

    const token = resolveFastCronToken(runtimeEnv);
    if (!token) {
      return new Response(
        JSON.stringify({ success: false, error: 'FastCron API token not configured on server', configured: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const job = await discoverPinArchiveJob(token, workspaceId);
    if (!job) {
      return new Response(
        JSON.stringify({ success: true, job: null, configured: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch cron_next and cron_logs (last 10) in parallel
    const [nextRes, logsRes] = await Promise.all([
      fastcronCall('cron_next', { id: job.id }, token),
      fastcronCall('cron_logs', { id: job.id }, token),
    ]);

    const nextRuns = Array.isArray(nextRes.data)
      ? nextRes.data
      : Array.isArray(nextRes.data?.data)
        ? nextRes.data.data
        : Array.isArray(nextRes.data?.next)
          ? nextRes.data.next
          : [];

    const rawLogs = Array.isArray(logsRes.data)
      ? logsRes.data
      : Array.isArray(logsRes.data?.data)
        ? logsRes.data.data
        : Array.isArray(logsRes.data?.logs)
          ? logsRes.data.logs
          : [];

    return new Response(
      JSON.stringify({
        success: true,
        configured: true,
        job: {
          ...job,
          cron_next: nextRuns,
          cron_logs: rawLogs.slice(0, 10),
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Failed to retrieve FastCron job' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST: Handles job creation/update ({sync_time, timezone, enabled}) and run_now ({action:'run_now'}).
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

    // Branch A: Server-side run_now trigger
    if (body?.action === 'run_now') {
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

      const dispatchUrl = `https://api.github.com/repos/${githubRepo}/actions/workflows/pinarchive-refresh.yml/dispatches`;

      const ghRes = await fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dispatchToken.trim()}`,
          'Accept': 'application/vnd.github.v3+json',
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
          JSON.stringify({ success: true, message: 'Workflow run dispatched with force' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: `GitHub dispatch failed with HTTP ${ghRes.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Branch B: FastCron Job Add/Edit
    const token = resolveFastCronToken(runtimeEnv);
    if (!token) {
      return new Response(
        JSON.stringify({ success: false, error: 'FastCron API token not configured on server.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const parsedCron = parseTimeToCron(body.sync_time);
    if (!parsedCron.valid || !parsedCron.cron) {
      return new Response(
        JSON.stringify({ success: false, error: parsedCron.error || 'Invalid sync_time format' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const effSecret = await getEffectiveSecret(workspaceId, runtimeEnv);
    if (!effSecret || !effSecret.value || effSecret.value.trim() === '') {
      return new Response(
        JSON.stringify({ success: false, error: 'Ingest secret not configured' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const dispatchUrl =
      (runtimeEnv.PINARCHIVE_DISPATCH_URL as string) ||
      (typeof process !== 'undefined' ? process.env.PINARCHIVE_DISPATCH_URL : '') ||
      'https://pinorbit-v2.o-i.workers.dev/api/internal/pinarchive/dispatch';

    const timezone =
      body.timezone && typeof body.timezone === 'string' && body.timezone.trim().length > 0
        ? body.timezone.trim()
        : 'UTC';

    const isEnabled = body.enabled !== false;

    const jobParams = {
      name: `PinOrbit pinarchive — ${workspaceId.slice(0, 8)}`,
      url: dispatchUrl,
      expression: parsedCron.cron,
      timezone,
      http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
      post_data: JSON.stringify({ workspace_id: workspaceId, pipeline: 'pinarchive' }),
      status: isEnabled ? 'enabled' : 'disabled',
    };

    const discovered = await discoverPinArchiveJob(token, workspaceId);
    let jobResult: any;

    if (discovered && discovered.id) {
      jobResult = await fastcronCall('cron_edit', { id: discovered.id, ...jobParams }, token);
      if (!jobResult.success) {
        return new Response(
          JSON.stringify({ success: false, error: jobResult.error || 'Failed to update FastCron job.' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (!isEnabled) {
        await fastcronCall('cron_disable', { id: discovered.id }, token);
      } else {
        await fastcronCall('cron_enable', { id: discovered.id }, token);
      }
    } else {
      jobResult = await fastcronCall('cron_add', jobParams, token);
      if (!jobResult.success) {
        return new Response(
          JSON.stringify({ success: false, error: jobResult.error || 'Failed to create FastCron job.' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const newId = jobResult.data?.id || jobResult.data?.data?.id;
      if (newId && !isEnabled) {
        await fastcronCall('cron_disable', { id: newId }, token);
      }
    }

    return new Response(
      JSON.stringify({ success: true, job: jobResult.data }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Failed to process request.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE: Removes discovered FastCron job.
 */
export const DELETE: APIRoute = async ({ locals }) => {
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

    const token = resolveFastCronToken(runtimeEnv);
    if (!token) {
      return new Response(
        JSON.stringify({ success: false, error: 'FastCron API token not configured on server.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const discovered = await discoverPinArchiveJob(token, workspaceId);
    if (!discovered || !discovered.id) {
      return new Response(
        JSON.stringify({ success: true, message: 'No FastCron job found to delete.' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const delRes = await fastcronCall('cron_delete', { id: discovered.id }, token);
    if (!delRes.success) {
      return new Response(
        JSON.stringify({ success: false, error: delRes.error || 'Failed to delete FastCron job.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: 'FastCron job deleted successfully.' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Failed to delete FastCron job.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
