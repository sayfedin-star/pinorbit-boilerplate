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
    const accRes = await db
      .from('pa_accounts')
      .select('id, username, status, pins_count, follower_count, last_run_at, sheet_id, interval_days, next_run_at')
      .eq('workspace_id', ws)
      .limit(100);

    if (accRes.error) {
      return json({ success: false, error: accRes.error.message }, 500);
    }

    const accounts = accRes.data || [];

    // 1. Get exact total pins count once via lightweight HEAD request
    const { count: totalPinsCount, error: countErr } = await db
      .from('pa_pins')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', ws);

    if (countErr) {
      return json({ success: false, error: countErr.message }, 500);
    }

    const totalPins = totalPinsCount ?? 0;

    // 2. Paginate over rows without count calculation
    const PAGE = 1000, MAX_PAGES = 20;
    let offset = 0, archived = 0, sumSaves = 0, sumShares = 0;
    while (offset < PAGE * MAX_PAGES) {
      const { data, error } = await db
        .from('pa_pins')
        .select('saves, share_count, archived_at')
        .eq('workspace_id', ws)
        .order('pin_id', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) return json({ success: false, error: error.message }, 500);
      for (const p of data || []) {
        if (p.archived_at !== null) archived++;
        sumSaves += Number(p.saves || 0);
        sumShares += Number(p.share_count || 0);
      }
      if (!data || data.length < PAGE) break;
      offset += PAGE;
    }

    return json({
      success: true,
      accounts,
      totals: {
        accounts: accounts.length,
        archived_pins: archived,
        sum_saves: sumSaves,
        sum_shares: sumShares,
        total_pins: totalPins,
      },
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
