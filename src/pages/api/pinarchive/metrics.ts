export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';

// Route: /api/pinarchive/metrics (DELETE) - Delete pin metric snapshots (admin only)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 100;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

export const DELETE: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  if (!user || !schedulingClient) {
    return json({ success: false, error: 'Unauthorized: missing session' }, 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON payload' }, 400);
  }

  const workspaceId = body.workspace_id || locals.activeWorkspaceId;
  if (!workspaceId) {
    return json({ success: false, error: 'Unauthorized: missing workspace identifier' }, 401);
  }
  if (!UUID_REGEX.test(workspaceId)) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }

  const metricIds = body.metric_ids;
  if (!Array.isArray(metricIds) || metricIds.length === 0) {
    return json({ success: false, error: 'metric_ids must be a non-empty array of UUIDs.' }, 400);
  }
  if (metricIds.length > MAX_BATCH) {
    return json({ success: false, error: `metric_ids batch limit exceeded: max ${MAX_BATCH}.` }, 422);
  }
  for (const id of metricIds) {
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
      return json({ success: false, error: `Invalid metric identifier format: ${id}` }, 400);
    }
  }

  let wsCtx;
  try {
    wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Forbidden: Admin access required' }, errorStatus(e));
  }

  try {
    const db = dbClients.getPinArchive(locals.runtime?.env);
    const deleteQuery: any = db
      .from('pa_pin_metrics')
      .delete()
      .eq('workspace_id', wsCtx.workspaceId)
      .in('id', metricIds);
    const { data, error, count } = await deleteQuery.select('id', { count: 'exact' });

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    const deletedCount = count !== null && count !== undefined ? count : (data?.length || 0);
    return json({ success: true, deleted: deletedCount });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
