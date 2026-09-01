export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';
import { computePinStage, computePinAnomaly } from '../../../server/lib/pin-stages';

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

    // Fetch creator account username if available
    if (pin.account_id) {
      const { data: acc } = await db
        .from('pa_accounts')
        .select('id, username')
        .eq('id', pin.account_id)
        .maybeSingle();
      if (acc && acc.username) {
        pin.account_username = acc.username;
      }
    }

    // b) Fetch historical snapshots (newest 500 snapshots ordered chronologically)
    const { data: metrics, error: metErr } = await db
      .from('pa_pin_metrics')
      .select('id, recorded_at, saves, repins, comments, shares, reactions_total')
      .eq('pin_ref', id)
      .order('recorded_at', { ascending: false })
      .limit(500);

    if (metErr) {
      return json({ success: false, error: metErr.message }, 500);
    }

    const snapsDesc = Array.isArray(metrics) ? metrics : [];
    const metricsList = [...snapsDesc].reverse(); // chronological

    const now = Date.now();
    const ONE_DAY_MS = 24 * 3600 * 1000;
    const THREE_DAYS_MS = 3 * ONE_DAY_MS;
    const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

    const currentSaves = Number(pin.saves || 0);
    const currentRepins = Number(pin.repins || 0);

    let deltaSaves24h = 0;
    let deltaSaves3d = 0;
    let deltaSaves7d = 0;
    let deltaRepins24h = 0;
    let deltaRepins7d = 0;
    let daysBetween = 1;

    if (snapsDesc.length >= 2) {
      const latestSnap = snapsDesc[0];
      const t0 = new Date(latestSnap.recorded_at).getTime();
      const latestS = Number(latestSnap.saves || currentSaves);
      const latestR = Number(latestSnap.repins || currentRepins);

      const findBaselineSnap = (targetMs: number) => {
        const prior = snapsDesc.find((s) => (t0 - new Date(s.recorded_at).getTime()) >= targetMs * 0.75);
        return prior || snapsDesc[snapsDesc.length - 1];
      };

      const snap24h = findBaselineSnap(ONE_DAY_MS);
      const snap3d = findBaselineSnap(THREE_DAYS_MS);
      const snap7d = findBaselineSnap(SEVEN_DAYS_MS);

      deltaSaves24h = Math.max(0, latestS - Number(snap24h.saves || 0));
      deltaSaves3d = Math.max(deltaSaves24h, latestS - Number(snap3d.saves || 0));
      deltaSaves7d = Math.max(deltaSaves3d, latestS - Number(snap7d.saves || 0));

      deltaRepins24h = Math.max(0, latestR - Number(snap24h.repins || 0));
      deltaRepins7d = Math.max(deltaRepins24h, latestR - Number(snap7d.repins || 0));

      const t1 = new Date(snap24h.recorded_at).getTime();
      daysBetween = Math.max(0.01, (t0 - t1) / 86400000);
    }

    // Strict Guarantee: Delta cannot exceed total current saves
    deltaSaves24h = Math.min(deltaSaves24h, currentSaves);
    deltaSaves3d = Math.min(deltaSaves3d, currentSaves);
    deltaSaves7d = Math.min(deltaSaves7d, currentSaves);

    const ageDays = Math.max(0, (now - new Date(pin.created_at_pinterest || pin.archived_at || now).getTime()) / ONE_DAY_MS);
    const velocity = Number(pin.velocity || 0);

    const stage = computePinStage(velocity, deltaSaves24h, ageDays);
    const anomaly = computePinAnomaly(deltaSaves24h, velocity, daysBetween);

    pin.age_days = Math.round(ageDays * 10) / 10;
    pin.stage = stage;
    pin.anomaly = anomaly;
    pin.delta_saves_24h = deltaSaves24h;
    pin.delta_saves_3d = deltaSaves3d;
    pin.delta_saves_7d = deltaSaves7d;
    pin.delta_repins_24h = deltaRepins24h;
    pin.delta_repins_7d = deltaRepins7d;
    pin.deltas = {
      saves: deltaSaves24h,
      repins: deltaRepins24h,
      comments: 0,
      shares: 0,
      reactions: 0,
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
