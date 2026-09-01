export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
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

  if (typeof body.ingest_enabled !== 'boolean') {
    return json({ success: false, error: 'ingest_enabled must be a boolean.' }, 400);
  }

  const accountIds = body.account_ids;
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    return json({ success: false, error: 'account_ids must be a non-empty array of UUIDs.' }, 400);
  }

  for (const id of accountIds) {
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
      return json({ success: false, error: `Invalid account identifier format: ${id}` }, 400);
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

    const newStatus = body.ingest_enabled ? 'active' : 'paused';
    const { data, error, count } = await db
      .from('pa_accounts')
      .update({
        ingest_enabled: body.ingest_enabled,
        status: newStatus,
      })
      .eq('workspace_id', wsCtx.workspaceId)
      .in('id', accountIds)
      .select('id', { count: 'exact' });

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    const updatedCount = count !== null && count !== undefined ? count : (data?.length || 0);

    return json({
      success: true,
      updated: updatedCount,
      ingest_enabled: body.ingest_enabled,
      status: newStatus,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
