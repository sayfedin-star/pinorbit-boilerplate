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

export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  if (!user || !schedulingClient) {
    return json({ success: false, error: 'Unauthorized: missing session' }, 401);
  }

  const searchParams = new URL(request.url).searchParams;
  const workspaceId = searchParams.get('workspace_id') || locals.activeWorkspaceId;
  const accountId = searchParams.get('account_id')?.trim();

  if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }

  if (!accountId || !UUID_REGEX.test(accountId)) {
    return json({ success: false, error: 'Invalid account identifier format.' }, 422);
  }

  try {
    const wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'member');
    const db = dbClients.getPinArchive(locals.runtime?.env);

    const { data, error } = await db.rpc('pa_account_boards', {
      p_workspace_id: wsCtx.workspaceId,
      p_account_id: accountId,
    });

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    const rows = Array.isArray(data) ? data : [];
    const boards = rows.map((r: any) => ({
      board_name: r.board_name,
      pins: Number(r.pins || 0),
    }));

    return json({
      success: true,
      boards,
      count: boards.length,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, errorStatus(e));
  }
};
