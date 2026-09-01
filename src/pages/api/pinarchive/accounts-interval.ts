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

    // 1. Fetch matching accounts to dynamically recalculate next_run_at
    let selectQuery = db
      .from('pa_accounts')
      .select('id, username, last_run_at, created_at')
      .eq('workspace_id', wsCtx.workspaceId);

    if (accountIds.length > 0) {
      selectQuery = selectQuery.in('id', accountIds);
    } else if (accountId && UUID_REGEX.test(accountId)) {
      selectQuery = selectQuery.eq('id', accountId);
    } else if (username) {
      selectQuery = selectQuery.ilike('username', username);
    }

    const { data: accountsToUpdate, error: selectErr } = await selectQuery;
    if (selectErr) {
      return json({ success: false, error: selectErr.message }, 500);
    }

    if (!accountsToUpdate || accountsToUpdate.length === 0) {
      return json({ success: false, error: 'No matching creator accounts found.' }, 404);
    }

    const updatedNextDates: Record<string, string> = {};

    for (const acc of accountsToUpdate) {
      const baseMs = acc.last_run_at ? new Date(acc.last_run_at).getTime() : (acc.created_at ? new Date(acc.created_at).getTime() : Date.now());
      const nextRunIso = new Date(baseMs + intervalDays * 86400000).toISOString();
      updatedNextDates[acc.id] = nextRunIso;

      await db
        .from('pa_accounts')
        .update({
          interval_days: intervalDays,
          next_run_at: nextRunIso,
        })
        .eq('id', acc.id)
        .eq('workspace_id', wsCtx.workspaceId);
    }

    return json({
      success: true,
      count: accountsToUpdate.length,
      interval_days: intervalDays,
      next_run_dates: updatedNextDates,
    });
  } catch (err: any) {
    return json({ success: false, error: err.message || 'Internal Server Error' }, 500);
  }
}

export const PATCH: APIRoute = async ({ request, locals }) => handleIntervalUpdate(request, locals);
export const POST: APIRoute = async ({ request, locals }) => handleIntervalUpdate(request, locals);
