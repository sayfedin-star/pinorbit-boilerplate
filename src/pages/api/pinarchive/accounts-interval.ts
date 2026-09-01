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

async function handleIntervalUpdate(request: Request, locals: any): Promise<Response> {
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

  const intervalDays = Number(body.interval_days ?? body.days);
  if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 90) {
    return json({ success: false, error: 'interval_days must be an integer between 1 and 90.' }, 400);
  }

  const username = body.username ? String(body.username).trim() : '';
  const accountId = body.account_id ? String(body.account_id).trim() : '';
  const accountIds = Array.isArray(body.account_ids)
    ? body.account_ids.map((id: any) => String(id).trim()).filter((id: string) => UUID_REGEX.test(id))
    : [];

  if (!username && !accountId && accountIds.length === 0) {
    return json({ success: false, error: 'Either username, account_id, or account_ids array is required.' }, 400);
  }

  let wsCtx;
  try {
    wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Forbidden: Admin access required' }, errorStatus(e));
  }

  try {
    const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv;
    const db = dbClients.getPinArchive(runtimeEnv);

    let query = db
      .from('pa_accounts')
      .update({
        interval_days: intervalDays,
      })
      .eq('workspace_id', wsCtx.workspaceId);

    if (accountIds.length > 0) {
      query = query.in('id', accountIds);
    } else if (accountId && UUID_REGEX.test(accountId)) {
      query = query.eq('id', accountId);
    } else if (username) {
      query = query.ilike('username', username);
    }

    const { error } = await query;
    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    return json({
      success: true,
      count: accountIds.length > 0 ? accountIds.length : 1,
      interval_days: intervalDays,
    });
  } catch (err: any) {
    return json({ success: false, error: err.message || 'Internal Server Error' }, 500);
  }
}

export const PATCH: APIRoute = async ({ request, locals }) => handleIntervalUpdate(request, locals);
export const POST: APIRoute = async ({ request, locals }) => handleIntervalUpdate(request, locals);
