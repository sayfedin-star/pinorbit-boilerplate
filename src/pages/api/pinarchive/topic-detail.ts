export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';
import { computePinStage } from '../../../server/lib/pin-stages';

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

  const name = (searchParams.get('name') || '').trim();
  if (!name || name.length > 120) {
    return json({ success: false, error: 'Validation Error: name (1-120 chars) is required.' }, 400);
  }

  try {
    const { data: memberPins, error } = await db
      .from('pa_pins')
      .select('id, pin_id, title, image_url, link, saves, repins, comments, share_count, velocity, annotations, seo_category, canonical_pin_id, archived_at, board_name, board_id, account_id, is_video, created_at_pinterest, notes')
      .eq('workspace_id', ws)
      .contains('annotations', [{ name }])
      .order('saves', { ascending: false })
      .limit(500);

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    const rawPins = memberPins || [];
    const pinsCount = rawPins.length;
    let total_saves = 0;
    let total_repins = 0;
    let total_shares = 0;
    let total_velocity = 0;
    const savesList: number[] = [];

    const stage_distribution: Record<string, number> = {
      NEW: 0,
      GROWING: 0,
      MATURE: 0,
      COOLING: 0,
      DORMANT: 0,
    };

    const boardMap = new Map<string, { name: string; pins: number; sum_saves: number }>();
    const cooccurringMap = new Map<string, Set<string>>();

    for (const p of rawPins) {
      const s = Number(p.saves || 0);
      const r = Number(p.repins || 0);
      const sh = Number(p.share_count || 0);
      const v = Number(p.velocity || 0);

      total_saves += s;
      total_repins += r;
      total_shares += sh;
      total_velocity += v;
      savesList.push(s);

      // Stage distribution
      const pinDate = p.created_at_pinterest || p.archived_at;
      const ageDays = Math.max(0, (Date.now() - new Date(pinDate || Date.now()).getTime()) / 86400000);
      const stage = computePinStage(v, 0, ageDays);
      if (stage in stage_distribution) {
        stage_distribution[stage]++;
      }

      // Boards breakdown
      const bName = (p.board_name || 'General Board').trim();
      let boardEntry = boardMap.get(bName);
      if (!boardEntry) {
        boardEntry = { name: bName, pins: 0, sum_saves: 0 };
        boardMap.set(bName, boardEntry);
      }
      boardEntry.pins += 1;
      boardEntry.sum_saves += s;

      // Co-occurring keywords
      const pinId = String(p.pin_id || p.id);
      const annotations = Array.isArray(p.annotations) ? p.annotations : [];
      for (const ann of annotations) {
        const annName = typeof ann === 'string' ? ann.trim() : (ann?.name ? String(ann.name).trim() : '');
        if (!annName || annName === name) continue;
        let set = cooccurringMap.get(annName);
        if (!set) {
          set = new Set<string>();
          cooccurringMap.set(annName, set);
        }
        set.add(pinId);
      }
    }

    // Median saves
    savesList.sort((a, b) => a - b);
    let median_saves = 0;
    if (savesList.length > 0) {
      const mid = Math.floor(savesList.length / 2);
      if (savesList.length % 2 === 1) {
        median_saves = savesList[mid];
      } else {
        median_saves = Math.round((savesList[mid - 1] + savesList[mid]) / 2);
      }
    }

    const kpis = {
      pins: pinsCount,
      total_saves,
      avg_saves: pinsCount > 0 ? Math.round(total_saves / pinsCount) : 0,
      median_saves,
      total_repins,
      total_shares,
      avg_velocity: pinsCount > 0 ? Math.round((total_velocity / pinsCount) * 10) / 10 : 0,
    };

    const boards = Array.from(boardMap.values()).sort((a, b) => b.sum_saves - a.sum_saves);

    // Accounts breakdown
    const { data: accountsData, error: accErr } = await db
      .from('pa_accounts')
      .select('id, username')
      .eq('workspace_id', ws)
      .limit(1000);

    if (accErr) {
      return json({ success: false, error: accErr.message }, 500);
    }

    const usernameMap = new Map<string, string>();
    for (const a of accountsData || []) {
      if (a.id) usernameMap.set(a.id, a.username || 'unknown');
    }

    const accountTallyMap = new Map<string, { username: string; pins: number; sum_saves: number }>();
    for (const p of rawPins) {
      const accId = p.account_id || '';
      const username = (accId && usernameMap.get(accId)) || 'unknown';
      let entry = accountTallyMap.get(username);
      if (!entry) {
        entry = { username, pins: 0, sum_saves: 0 };
        accountTallyMap.set(username, entry);
      }
      entry.pins += 1;
      entry.sum_saves += Number(p.saves || 0);
    }
    const accounts = Array.from(accountTallyMap.values()).sort((a, b) => b.sum_saves - a.sum_saves);

    // Top 15 co-occurring keywords
    const cooccurring = Array.from(cooccurringMap.entries())
      .map(([annName, set]) => ({ name: annName, pins: set.size }))
      .sort((a, b) => b.pins - a.pins)
      .slice(0, 15);

    // Top 12 pins
    const top_pins = rawPins.slice(0, 12).map((p: any) => {
      const v = Number(p.velocity || 0);
      const pinDate = p.created_at_pinterest || p.archived_at;
      const ageDays = Math.max(0, (Date.now() - new Date(pinDate || Date.now()).getTime()) / 86400000);
      return {
        id: p.id,
        pin_id: p.pin_id,
        title: p.title,
        image_url: p.image_url,
        link: p.link,
        saves: p.saves,
        repins: p.repins,
        share_count: p.share_count,
        velocity: p.velocity,
        stage: computePinStage(v, 0, ageDays),
        anomaly: null,
        board_name: p.board_name,
        seo_category: p.seo_category,
        annotations: p.annotations,
        created_at_pinterest: p.created_at_pinterest,
        archived_at: p.archived_at,
      };
    });

    return json({
      success: true,
      topic: name,
      kpis,
      stage_distribution,
      boards,
      accounts,
      cooccurring,
      top_pins,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
