export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';
import { getNextCronDate } from '../../../lib/cron-helper';
import { resolveToken } from '../../../server/lib/token-resolver';

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
      .select('id, username, status, pins_count, follower_count, last_run_at, sheet_id, next_run_at, ingest_enabled, interval_days, backfill_status, backfill_cursor, last_result')
      .eq('workspace_id', ws)
      .limit(100);

    if (accRes.error) {
      return json({ success: false, error: accRes.error.message }, 500);
    }

    let accounts = (accRes.data || []).map((a: any) => ({ ...a }));

    // Fetch live DB pin count per account (pins total + archived qualifying)
    const countMap = new Map<string, number>();
    const archivedMap = new Map<string, number>();
    try {
      if (typeof db.rpc === 'function') {
        const { data: countData, error: countRpcErr } = await db.rpc('pa_account_pin_counts', { p_workspace_id: ws });
        if (!countRpcErr && Array.isArray(countData)) {
          for (const row of countData) {
            if (row.account_id) {
              countMap.set(row.account_id, Number(row.pins || 0));
              archivedMap.set(row.account_id, Number(row.archived ?? row.pins ?? 0));
            }
          }
        }
      }
    } catch (err) {
      console.warn('Could not query pa_account_pin_counts:', err);
    }

    for (const a of accounts) {
      a.db_pins_count = countMap.has(a.id) ? countMap.get(a.id) : a.pins_count;
      a.archived_count = archivedMap.has(a.id) ? archivedMap.get(a.id) : (a.db_pins_count ?? a.pins_count ?? 0);
    }

    // Compute Recent Δ per account from its latest refresh run session (preserves delta without 5m global cutoff)
    let changedMap = new Map<string, number>();
    try {
      const runsTable = db.from('pa_runs');
      if (runsTable && typeof runsTable.select === 'function') {
        const { data: recentRuns } = await runsTable
          .select('account_id, pins_updated, started_at')
          .eq('workspace_id', ws)
          .eq('trigger', 'refresh')
          .order('started_at', { ascending: false })
          .limit(300);

        if (Array.isArray(recentRuns) && recentRuns.length > 0) {
          const accountLatestTime = new Map<string, number>();
          for (const r of recentRuns) {
            if (!r.account_id || !r.started_at) continue;
            const t = new Date(r.started_at).getTime();
            if (!accountLatestTime.has(r.account_id) || t > accountLatestTime.get(r.account_id)!) {
              accountLatestTime.set(r.account_id, t);
            }
          }

          for (const r of recentRuns) {
            if (!r.account_id || !r.started_at) continue;
            const latestT = accountLatestTime.get(r.account_id);
            if (!latestT) continue;
            const t = new Date(r.started_at).getTime();
            // Aggregate batches from the same run session (within 45 minutes of account's latest run)
            if (latestT - t <= 45 * 60 * 1000) {
              changedMap.set(r.account_id, (changedMap.get(r.account_id) || 0) + Number(r.pins_updated || 0));
            }
          }
        }
      }
    } catch (err) {
      console.warn('Could not query pa_runs refresh delta:', err);
    }

    // Derive active schedule next run from persisted workspace settings
    let activeNextRunIso: string | null = null;
    try {
      const settingsTable = db.from('pa_workspace_settings');
      if (settingsTable && typeof settingsTable.select === 'function') {
        const { data: wsSettings } = await settingsTable
          .select('cron_expression, schedule_status, fastcron_job_id')
          .eq('workspace_id', ws)
          .maybeSingle();

        const cronExpr = wsSettings?.cron_expression;
        const isPaused = wsSettings?.schedule_status === 'paused' || wsSettings?.schedule_status === 'disabled';
        const hasJob = Boolean(wsSettings?.fastcron_job_id);
        const jobTimezone = 'UTC';

        if (cronExpr && !isPaused && hasJob) {
          const nextDate = getNextCronDate(cronExpr, jobTimezone);
          if (nextDate) {
            activeNextRunIso = nextDate.toISOString();
          }
        }
      }
    } catch (err: any) {
      console.warn(`[PinArchive Overview] Could not derive schedule next run for workspace ${ws}:`, err?.message || err);
    }

    // Attach to each account:
    accounts = accounts.map((a: any) => ({
      ...a,
      next_run_at: activeNextRunIso || a.next_run_at || null,
      changed_last_refresh: changedMap.get(a.id) ?? 0,
      checked_last_refresh: Number(a.db_pins_count ?? 0), // total pins for account = checked
    }));

    // 1. Get exact total pins count once via lightweight HEAD request
    const { count: totalPinsCount, error: countErr } = await db
      .from('pa_pins')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', ws);

    if (countErr) {
      return json({ success: false, error: countErr.message }, 500);
    }

    const totalPins = totalPinsCount ?? 0;

    // 2. Sums via SQL RPC; fallback to paginated scan if RPC unavailable
    let sumSaves = 0, sumShares = 0;
    try {
      const rpcRes = await db.rpc('pa_workspace_sums', { p_workspace_id: ws });
      if (!rpcRes.error && Array.isArray(rpcRes.data) && rpcRes.data.length > 0) {
        sumSaves = Number(rpcRes.data[0].sum_saves || 0);
        sumShares = Number(rpcRes.data[0].sum_shares || 0);
      } else {
        const PAGE = 1000;
        let offset = 0;
        while (true) {
          const { data, error } = await db
            .from('pa_pins')
            .select('saves, share_count')
            .eq('workspace_id', ws)
            .order('pin_id', { ascending: true })
            .range(offset, offset + PAGE - 1);
          if (error) break;
          for (const p of data || []) {
            sumSaves += Number(p.saves || 0);
            sumShares += Number(p.share_count || 0);
          }
          if (!data || data.length < PAGE) break;
          offset += PAGE;
        }
      }
    } catch (sumErr) {
      console.warn('[PinArchive Overview] Sums query warning:', sumErr);
    }

    return json({
      success: true,
      accounts,
      totals: {
        accounts: accounts.length,
        archived_pins: totalPins,
        sum_saves: sumSaves,
        sum_shares: sumShares,
        total_pins: totalPins,
      },
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
