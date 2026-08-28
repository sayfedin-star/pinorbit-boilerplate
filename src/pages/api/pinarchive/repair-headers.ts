// TODO(remove-after-verification): Temporary repair endpoint for legacy FastCron job headers
export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { getEffectiveSecret } from '../../../server/services/webhook-secrets';
import { fastcronCall } from '../../../server/lib/fastcron-client';
import { listWorkspaceTokens } from '../../../server/lib/token-resolver';
import { isMatchingPinArchiveJob, getDispatchEndpointUrl } from './cron';

export const POST: APIRoute = async ({ locals, request }) => {
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

    const effSecret = await getEffectiveSecret(workspaceId, runtimeEnv);
    if (!effSecret || !effSecret.value || effSecret.value.trim() === '') {
      return new Response(
        JSON.stringify({ success: false, error: 'Ingest secret not configured for workspace.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const tokens = await listWorkspaceTokens(workspaceId, 'pinarchive', runtimeEnv, true);
    if (!tokens || tokens.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'FastCron API token not configured on server or in workspace registry.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const dispatchUrl = getDispatchEndpointUrl(runtimeEnv, workspaceId);
    let totalMatched = 0;
    let repairedCount = 0;
    const repairedJobs: any[] = [];
    const processedJobIds = new Set<number>();

    for (const tokenItem of tokens) {
      if (!tokenItem.token) continue;
      const listRes = await fastcronCall('cron_list', { keyword: 'PinOrbit' }, tokenItem.token);
      const existingList: any[] = Array.isArray(listRes.data)
        ? listRes.data
        : Array.isArray(listRes.data?.data)
          ? listRes.data.data
          : Array.isArray(listRes.data?.jobs)
            ? listRes.data.jobs
            : [];

      const matchedJobs = existingList.filter((j) => isMatchingPinArchiveJob(j, workspaceId, dispatchUrl));
      for (const job of matchedJobs) {
        const jobId = Number(job.id);
        if (!jobId || processedJobIds.has(jobId)) continue;
        processedJobIds.add(jobId);
        totalMatched++;

        const jobLabel =
          job.name?.replace(/^PinOrbit\s*pinarchive\s*—\s*/i, '').replace(/\s*—\s*[a-f0-9-]+$/i, '') || 'Default Daily';
        const repairPostData = JSON.stringify({
          workspace_id: workspaceId,
          pipeline: 'pinarchive',
          label: jobLabel,
        });

        const repairParams = {
          id: jobId,
          name: `PinOrbit pinarchive — ${jobLabel} — ${workspaceId.slice(0, 8)}`,
          url: dispatchUrl,
          expression: job.expression || job.cron_expression || '0 3 * * *',
          timezone: job.timezone || 'UTC',
          httpMethod: 'POST',
          http_method: 'POST',
          httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
          http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
          postData: repairPostData,
          post_data: repairPostData,
          status: (job.status === 'disabled' || job.paused) ? 'disabled' : 'enabled',
        };

        const editRes = await fastcronCall('cron_edit', repairParams, tokenItem.token);
        if (editRes.success) {
          repairedCount++;
          repairedJobs.push({ id: jobId, name: repairParams.name, status: 'repaired' });
        } else {
          repairedJobs.push({ id: jobId, name: repairParams.name, status: 'failed', error: editRes.error });
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Repaired ${repairedCount} out of ${totalMatched} matched FastCron job(s).`,
        count: totalMatched,
        repaired_count: repairedCount,
        jobs: repairedJobs,
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
