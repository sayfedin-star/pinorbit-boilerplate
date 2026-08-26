export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';
import { computePinStage, computePinAnomaly } from '../../../server/lib/pin-stages';

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

  const rawSort = searchParams.get('sort') || 'saves';
  const sortCol = rawSort === 'velocity' ? 'velocity' : 'saves';

  const rawLimit = parseInt(searchParams.get('limit') || '50', 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 500);

  const q = searchParams.get('q')?.trim();
  const board = searchParams.get('board')?.trim();
  const inCluster = searchParams.get('in_cluster') === '1' || searchParams.get('in_cluster') === 'true';
  const accountId = searchParams.get('account_id')?.trim();
  const stageParam = (searchParams.get('stage') || '').trim().toUpperCase();
  const STAGE_VALUES = ['NEW', 'GROWING', 'MATURE', 'COOLING', 'DORMANT'];
  const stageFilter = STAGE_VALUES.includes(stageParam) ? stageParam : null;

  if (accountId && !UUID_REGEX.test(accountId)) {
    return json({ success: false, error: 'Invalid account_id format.' }, 422);
  }

  // New Server-Paginated RPC Mode for Account Pins Page
  if (searchParams.get('mode') === 'page') {
    if (!accountId) {
      return json({ success: false, error: 'account_id is required for mode=page.' }, 422);
    }

    const sort = searchParams.get('sort')?.trim() || 'saves';
    const asc = searchParams.get('asc') === '1' || searchParams.get('asc') === 'true' || searchParams.get('order') === 'asc';
    const pageSizeRaw = parseInt(searchParams.get('page_size') || searchParams.get('limit') || '50', 10);
    const pageSize = Math.min(Math.max(isNaN(pageSizeRaw) ? 50 : pageSizeRaw, 1), 100);
    const page = Math.max(parseInt(searchParams.get('page') || '1', 10) || 1, 1);
    const offset = (page - 1) * pageSize;

    try {
      const { data, error } = await db.rpc('pa_account_pins_page', {
        p_workspace_id: ws,
        p_account_id: accountId,
        p_q: q || null,
        p_board: board || null,
        p_stage: stageFilter || null,
        p_sort: sort,
        p_asc: asc,
        p_limit: pageSize,
        p_offset: offset,
      });

      if (error) {
        return json({ success: false, error: error.message }, 500);
      }

      const rows = Array.isArray(data) ? data : [];
      const total = rows.length > 0 ? Number(rows[0].total_count || 0) : 0;

      const pins = rows.map((p: any) => {
        const deltaSaves = Number(p.delta_saves || 0);
        const velocity = Number(p.velocity || 0);
        const ageDays = Math.max(0, (Date.now() - new Date(p.created_at_pinterest || p.archived_at || Date.now()).getTime()) / 86400000);
        const stage = computePinStage(velocity, deltaSaves, ageDays);
        const anomaly = computePinAnomaly(deltaSaves, velocity, 1);

        return {
          id: p.id,
          pin_id: p.pin_id,
          title: p.title,
          image_url: p.image_url,
          link: p.link,
          saves: Number(p.saves || 0),
          repins: Number(p.repins || 0),
          comments: Number(p.comments || 0),
          share_count: Number(p.share_count || 0),
          reactions: p.reactions || {},
          velocity,
          annotations: p.annotations || [],
          board_name: p.board_name,
          seo_category: p.seo_category,
          created_at_pinterest: p.created_at_pinterest,
          archived_at: p.archived_at,
          first_seen_at: p.first_seen_at,
          delta_saves: deltaSaves,
          delta_repins: Number(p.delta_repins || 0),
          delta_shares: Number(p.delta_shares || 0),
          delta_reactions: Number(p.delta_reactions || 0),
          last_snapshot_at: p.last_snapshot_at,
          age_days: Math.round(ageDays * 10) / 10,
          stage,
          anomaly,
        };
      });

      return json({
        success: true,
        pins,
        count: pins.length,
        total,
        page,
        page_size: pageSize,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      });
    } catch (e: any) {
      return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
    }
  }

  try {
    // 1. Load pa_workspace_settings for persisted filters
    const { data: wsSettings } = await db
      .from('pa_workspace_settings')
      .select('pin_filter_min_saves, pin_filter_min_repins, pin_filter_rising_age_days, pin_filter_rising_saves')
      .eq('workspace_id', ws)
      .maybeSingle();

    const minSaves = Number(wsSettings?.pin_filter_min_saves || 0);
    const minRepins = Number(wsSettings?.pin_filter_min_repins || 0);
    const risA = Number(wsSettings?.pin_filter_rising_age_days ?? 14);
    const risS = Number(wsSettings?.pin_filter_rising_saves ?? 34);

    let query = db
      .from('pa_pins')
      .select('id, pin_id, title, image_url, link, saves, repins, comments, share_count, velocity, annotations, seo_category, canonical_pin_id, archived_at, board_name, board_id, dominant_color, node_id, is_video, created_at_pinterest, notes, notes_updated_at')
      .eq('workspace_id', ws);

    if (accountId) {
      query = query.eq('account_id', accountId);
    }

    const orParts: string[] = [];
    if (minSaves > 0) orParts.push(`saves.gte.${minSaves}`);
    if (minRepins > 0) orParts.push(`repins.gte.${minRepins}`);
    if (risA > 0 && risS > 0) {
      const cutoff = new Date(Date.now() - risA * 86400000).toISOString();
      orParts.push(`and(created_at_pinterest.gte."${cutoff}",saves.gte.${risS})`);
    }
    if (orParts.length) query = query.or(orParts.join(','));

    if (q) {
      const escaped = q.replace(/[%_\\]/g, '\\$&');
      query = query.ilike('title', `%${escaped}%`);
    }

    if (board) {
      query = query.eq('board_name', board);
    }

    if (inCluster) {
      query = query.not('canonical_pin_id', 'is', null);
    }

    const { data, error } = await query.order(sortCol, { ascending: false }).limit(limit);

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    const pins: any[] = data || [];

    if (pins.length > 0) {
      const pinIds = pins.map((p: any) => p.id).filter(Boolean);
      const { data: metricsData } = await db
        .from('pa_pin_metrics')
        .select('pin_ref, recorded_at, saves, repins, comments, shares, reactions_total')
        .in('pin_ref', pinIds)
        .order('recorded_at', { ascending: false });

      const metricsMap = new Map<string, any[]>();
      if (Array.isArray(metricsData)) {
        for (const m of metricsData) {
          const list = metricsMap.get(m.pin_ref) || [];
          if (list.length < 2) list.push(m);
          metricsMap.set(m.pin_ref, list);
        }
      }

      for (const p of pins) {
        const snaps = metricsMap.get(p.id) || [];
        let deltaSaves = 0;
        let daysBetween = 1;
        if (snaps.length >= 2) {
          deltaSaves = Number(snaps[0].saves || 0) - Number(snaps[1].saves || 0);
          const t0 = new Date(snaps[0].recorded_at).getTime();
          const t1 = new Date(snaps[1].recorded_at).getTime();
          daysBetween = Math.max(0.01, (t0 - t1) / 86400000);
        }

        const ageDays = Math.max(0, (Date.now() - new Date(p.created_at_pinterest || p.archived_at || Date.now()).getTime()) / 86400000);
        const velocity = Number(p.velocity || 0);

        const stage = computePinStage(velocity, deltaSaves, ageDays);
        const anomaly = computePinAnomaly(deltaSaves, velocity, daysBetween);

        p.age_days = Math.round(ageDays * 10) / 10;
        p.stage = stage;
        p.anomaly = anomaly;
        p.delta_saves = deltaSaves;
      }
    }

    const filteredPins = stageFilter ? pins.filter((p: any) => p.stage === stageFilter) : pins;

    return json({
      success: true,
      pins: filteredPins,
      count: filteredPins.length,
      sort: sortCol,
      filters: { minSaves, minRepins, risingAgeDays: risA, risingSaves: risS },
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
