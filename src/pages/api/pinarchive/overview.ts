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

async function guard(locals: any, explicitWs?: string) {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  if (!user || !schedulingClient) {
    return { err: json({ success: false, error: 'Unauthorized: missing session' }, 401) };
  }
  const workspaceId = explicitWs || locals.activeWorkspaceId;
  if (!workspaceId) {
    return { err: json({ success: false, error: 'Unauthorized: missing workspace identifier' }, 401) };
  }
  if (!UUID_REGEX.test(workspaceId)) {
    return { err: json({ success: false, error: 'Invalid workspace identifier format.' }, 400) };
  }
  try {
    const wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'member');
    return { ok: { ws: wsCtx.workspaceId, db: dbClients.getPinArchive(locals.runtime?.env) } };
  } catch (e: any) {
    return { err: json({ success: false, error: e.message || 'Forbidden' }, errorStatus(e)) };
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  const searchParams = new URL(request.url).searchParams;
  const explicitWs = searchParams.get('workspace_id') || undefined;
  const g = await guard(locals, explicitWs);
  if (g.err) return g.err;

  const db = g.ok!.db;
  const ws = g.ok!.ws;

  try {
    const [accRes, pinsRes] = await Promise.all([
      db
        .from('pa_accounts')
        .select('id, username, status, pins_count, follower_count, last_run_at, sheet_id, interval_days, next_run_at, ingest_enabled')
        .eq('workspace_id', ws)
        .limit(100),
      db
        .from('pa_pins')
        .select('saves, share_count, archived_at')
        .eq('workspace_id', ws)
        .limit(500),
    ]);

    if (accRes.error) {
      return json({ success: false, error: accRes.error.message }, 500);
    }
    if (pinsRes.error) {
      return json({ success: false, error: pinsRes.error.message }, 500);
    }

    const accounts = accRes.data || [];
    const pins = pinsRes.data || [];

    let archived_pins = 0;
    let sum_saves = 0;
    let sum_shares = 0;

    for (const p of pins) {
      if (p.archived_at !== null) {
        archived_pins++;
      }
      sum_saves += Number(p.saves || 0);
      sum_shares += Number(p.share_count || 0);
    }

    return json({
      success: true,
      accounts,
      totals: {
        accounts: accounts.length,
        archived_pins,
        sum_saves,
        sum_shares,
        total_pins: pins.length,
      },
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
