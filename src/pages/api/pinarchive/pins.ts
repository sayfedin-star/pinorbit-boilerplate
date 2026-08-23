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

  const rawSort = searchParams.get('sort') || 'saves';
  const sortCol = rawSort === 'velocity' ? 'velocity' : 'saves';

  const rawLimit = parseInt(searchParams.get('limit') || '50', 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 500);

  const q = searchParams.get('q')?.trim();
  const board = searchParams.get('board')?.trim();
  const rawMinSaves = parseInt(searchParams.get('min_saves') || '', 10);
  const minSaves = !isNaN(rawMinSaves) && rawMinSaves > 0 ? rawMinSaves : undefined;
  const inCluster = searchParams.get('in_cluster') === '1' || searchParams.get('in_cluster') === 'true';

  try {
    let query = db
      .from('pa_pins')
      .select('id, pin_id, title, image_url, link, saves, repins, comments, share_count, velocity, annotations, seo_category, canonical_pin_id, archived_at, board_name, board_id, dominant_color, node_id, is_video, created_at_pinterest, notes, notes_updated_at')
      .eq('workspace_id', ws)
      .not('archived_at', 'is', null);

    if (q) {
      const escaped = q.replace(/[%_\\]/g, '\\$&');
      query = query.ilike('title', `%${escaped}%`);
    }

    if (board) {
      query = query.eq('board_name', board);
    }

    if (minSaves !== undefined) {
      query = query.gte('saves', minSaves);
    }

    if (inCluster) {
      query = query.not('canonical_pin_id', 'is', null);
    }

    const { data, error } = await query.order(sortCol, { ascending: false }).limit(limit);

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    const pins = data || [];

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
        if (snaps.length >= 2) {
          if (deltaSaves >= Math.max(20, 3 * velocity * daysBetween)) {
            anomaly = 'SPIKE';
          } else if (deltaSaves <= -Math.max(10, 0.5 * velocity * daysBetween)) {
            anomaly = 'COOLING';
          }
        }

        p.age_days = Math.round(ageDays * 10) / 10;
        p.stage = stage;
        p.anomaly = anomaly;
        p.delta_saves = deltaSaves;
      }
    }

    return json({
      success: true,
      pins,
      count: pins.length,
      sort: sortCol,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
