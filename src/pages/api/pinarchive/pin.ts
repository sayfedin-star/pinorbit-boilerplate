export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';

// Route: /api/pinarchive/pin (GET) - Single Pin Deep-Dive Details & Historical Metrics
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
  if (!workspaceId) {
    return json({ success: false, error: 'Unauthorized: missing workspace identifier' }, 401);
  }
  if (!UUID_REGEX.test(workspaceId)) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }

  let wsCtx;
  try {
    wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'member');
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Forbidden' }, errorStatus(e));
  }

  const id = searchParams.get('id');
  if (!id || !UUID_REGEX.test(id)) {
    return json({ success: false, error: 'Invalid pin identifier format.' }, 400);
  }

  try {
    const db = dbClients.getPinArchive(locals.runtime?.env);

    // a) Fetch primary pin record
    const { data: pin, error: pinErr } = await db
      .from('pa_pins')
      .select('*')
      .eq('id', id)
      .eq('workspace_id', wsCtx.workspaceId)
      .maybeSingle();

    if (pinErr) {
      return json({ success: false, error: pinErr.message }, 500);
    }
    if (!pin) {
      return json({ success: false, error: 'Pin not found.' }, 404);
    }

    // b) Fetch historical snapshots
    const { data: metrics, error: metErr } = await db
      .from('pa_pin_metrics')
      .select('recorded_at, saves, repins, comments, shares, reactions_total')
      .eq('pin_ref', id)
      .order('recorded_at', { ascending: true })
      .limit(500);

    if (metErr) {
      return json({ success: false, error: metErr.message }, 500);
    }

    const metricsList = metrics || [];
    let deltaSaves = 0;
    let deltaRepins = 0;
    let deltaComments = 0;
    let deltaShares = 0;
    let deltaReactions = 0;
    let daysBetween = 1;

    if (metricsList.length >= 2) {
      const latest = metricsList[metricsList.length - 1];
      const prior = metricsList[metricsList.length - 2];
      deltaSaves = Number(latest.saves || 0) - Number(prior.saves || 0);
      deltaRepins = Number(latest.repins || 0) - Number(prior.repins || 0);
      deltaComments = Number(latest.comments || 0) - Number(prior.comments || 0);
      deltaShares = Number(latest.shares || 0) - Number(prior.shares || 0);
      deltaReactions = Number(latest.reactions_total || 0) - Number(prior.reactions_total || 0);

      const t0 = new Date(latest.recorded_at).getTime();
      const t1 = new Date(prior.recorded_at).getTime();
      daysBetween = Math.max(0.01, (t0 - t1) / 86400000);
    }

    const ageDays = Math.max(0, (Date.now() - new Date(pin.created_at_pinterest || pin.archived_at || Date.now()).getTime()) / 86400000);
    const velocity = Number(pin.velocity || 0);

    // Stage computation
    let stage: 'NEW' | 'GROWING' | 'MATURE' | 'COOLING' | 'DORMANT' = 'DORMANT';
    if (velocity < 0.5) {
      stage = 'DORMANT';
    } else if (velocity < 2 && deltaSaves < 0) {
      stage = 'COOLING';
    } else if (ageDays <= 14) {
      stage = 'NEW';
    } else if (velocity >= 10) {
      stage = 'GROWING';
    } else if (velocity >= 2 && ageDays > 14) {
      stage = 'MATURE';
    } else {
      stage = velocity >= 2 ? 'MATURE' : 'DORMANT';
    }

    // Anomaly detection
    let anomaly: 'SPIKE' | 'COOLING' | null = null;
    if (metricsList.length >= 2) {
      if (deltaSaves >= Math.max(20, 3 * velocity * daysBetween)) {
        anomaly = 'SPIKE';
      } else if (deltaSaves <= -Math.max(10, 0.5 * velocity * daysBetween)) {
        anomaly = 'COOLING';
      }
    }

    pin.age_days = Math.round(ageDays * 10) / 10;
    pin.stage = stage;
    pin.anomaly = anomaly;
    pin.deltas = {
      saves: deltaSaves,
      repins: deltaRepins,
      comments: deltaComments,
      shares: deltaShares,
      reactions: deltaReactions,
    };

    // c) Fetch canonical siblings and cluster consolidation if canonical_pin_id is present
    let canonical_siblings: any[] = [];
    let cluster_stats = {
      total_saves: Number(pin.saves || 0),
      variations_count: 1,
      rank: 1,
      share_pct: 100,
    };

    if (pin.canonical_pin_id) {
      const { data: clusterRows, error: sibErr } = await db
        .from('pa_pins')
        .select('id, pin_id, title, saves, archived_at, image_url')
        .eq('canonical_pin_id', pin.canonical_pin_id)
        .eq('workspace_id', wsCtx.workspaceId)
        .order('saves', { ascending: false })
        .limit(50);

      if (!sibErr && Array.isArray(clusterRows)) {
        canonical_siblings = clusterRows.filter((s: any) => s.id !== id);
        const totalClusterSaves = clusterRows.reduce((acc, r) => acc + Number(r.saves || 0), 0);
        const pinRank = clusterRows.findIndex((r) => r.id === id) + 1;
        cluster_stats = {
          total_saves: totalClusterSaves,
          variations_count: clusterRows.length,
          rank: pinRank > 0 ? pinRank : 1,
          share_pct: totalClusterSaves > 0 ? Math.round((Number(pin.saves || 0) / totalClusterSaves) * 100) : 100,
        };
      }
    }

    return json({
      success: true,
      pin,
      metrics: metricsList,
      canonical_siblings,
      cluster_stats,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
