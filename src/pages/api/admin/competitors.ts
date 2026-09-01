export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

async function guard(locals: any, explicitWs?: string, role: 'member' | 'admin' = 'admin') {
  const user = locals.user, schedulingClient = locals.supabase;
  if (!user || !schedulingClient) return { err: json({ error: 'Unauthorized: missing session' }, 401) };
  const workspaceId = explicitWs || locals.activeWorkspaceId;
  if (!workspaceId) return { err: json({ error: 'Unauthorized: missing workspace identifier' }, 401) };
  try {
    const wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, role);
    return { ok: { ws: wsCtx.workspaceId, db: dbClients.getCompetitors(locals.runtime?.env) } };
  } catch (e: any) { return { err: json({ error: e.message || 'Forbidden' }, errorStatus(e)) }; }
}

// GET: list all (no id) OR detail with snapshots/boards (with id)
export const GET: APIRoute = async ({ request, locals }) => {
  const g = await guard(locals, undefined, 'member'); if (g.err) return g.err;
  const searchParams = new URL(request.url).searchParams;
  const id = searchParams.get('id');
  const rawLite = searchParams.get('lite');
  const rawBoardsOnly = searchParams.get('boards_only');

  // Flags must be exactly "1" if present
  if (rawLite !== null && rawLite !== '1') {
    return json({ success: false, error: 'Invalid lite flag value.' }, 400);
  }
  if (rawBoardsOnly !== null && rawBoardsOnly !== '1') {
    return json({ success: false, error: 'Invalid boards_only flag value.' }, 400);
  }

  const lite = rawLite === '1';
  const boardsOnly = rawBoardsOnly === '1';

  if (!id) {
    const { data, error } = await g.ok!.db.from('competitors').select('*')
      .eq('workspace_id', g.ok!.ws).order('created_at', { ascending: false });
    if (error) return json({ error: error.message }, 500);
    const comps = data || [];
    const ids = comps.map((c: any) => c.id);
    const countMap: Record<string, number> = {};
    const deltasMap: Record<string, any> = {};

    if (ids.length) {
      let snapsList: any[] = [];
      try {
        const snapsQuery = g.ok!.db.from('competitor_snapshots').select('competitor_id, profile_reach, profile_views, follower_count, pin_count, recorded_at');
        if (snapsQuery && typeof snapsQuery.in === 'function') {
          const { data } = await snapsQuery.in('competitor_id', ids).order('recorded_at', { ascending: false });
          snapsList = data || [];
        } else {
          const perComp = await Promise.all(ids.map(async (compId: string) => {
            const { data } = await g.ok!.db.from('competitor_snapshots')
              .select('competitor_id, profile_reach, profile_views, follower_count, pin_count, recorded_at')
              .eq('competitor_id', compId)
              .order('recorded_at', { ascending: false })
              .limit(2);
            return data || [];
          }));
          snapsList = perComp.flat();
        }
      } catch {
        snapsList = [];
      }

      const snapsByComp = new Map<string, any[]>();
      for (const s of snapsList) {
        if (!s.competitor_id) continue;
        let list = snapsByComp.get(s.competitor_id);
        if (!list) {
          list = [];
          snapsByComp.set(s.competitor_id, list);
        }
        if (list.length < 2) {
          list.push(s);
        }
      }

      const calc = (c: number, p: number) => ({
        change: c - p,
        percent: p > 0 ? Number((((c - p) / p) * 100).toFixed(1)) : 0,
      });

      for (const compId of ids) {
        const sList = snapsByComp.get(compId) || [];
        if (sList.length < 2) {
          deltasMap[compId] = null;
        } else {
          const curr = sList[0];
          const prev = sList[1];
          deltasMap[compId] = {
            reachChange: calc(curr.profile_reach || 0, prev.profile_reach || 0).change,
            reachPercent: calc(curr.profile_reach || 0, prev.profile_reach || 0).percent,
            viewsChange: calc(curr.profile_views || 0, prev.profile_views || 0).change,
            viewsPercent: calc(curr.profile_views || 0, prev.profile_views || 0).percent,
            followersChange: calc(curr.follower_count || 0, prev.follower_count || 0).change,
            followersPercent: calc(curr.follower_count || 0, prev.follower_count || 0).percent,
            pinsChange: calc(curr.pin_count || 0, prev.pin_count || 0).change,
            pinsPercent: calc(curr.pin_count || 0, prev.pin_count || 0).percent,
            reach: calc(curr.profile_reach || 0, prev.profile_reach || 0),
            views: calc(curr.profile_views || 0, prev.profile_views || 0),
            followers: calc(curr.follower_count || 0, prev.follower_count || 0),
            pins: calc(curr.pin_count || 0, prev.pin_count || 0),
          };
        }
      }

      try {
        const bRes = await g.ok!.db.from('competitor_boards').select('competitor_id').in('competitor_id', ids);
        for (const b of (bRes?.data || []) as any[]) countMap[b.competitor_id] = (countMap[b.competitor_id] || 0) + 1;
      } catch {
        // Non-blocking fallback
      }
    }

    return json({
      success: true,
      competitors: comps.map((c: any) => ({
        ...c,
        boards_count: countMap[c.id] || 0,
        deltas: deltasMap[c.id] || null,
      }))
    });
  }

  // Validate ID format before querying
  if (id && !UUID_REGEX.test(id)) {
    return json({ success: false, error: 'Invalid competitor ID format.' }, 400);
  }

  const db = g.ok!.db;
  if (boardsOnly) {
    const comp = await db.from('competitors').select('id').eq('id', id).eq('workspace_id', g.ok!.ws).maybeSingle();
    if (!comp.data) return json({ error: 'Not found in workspace' }, 404);
    const { data: boards, error: bErr } = await db.from('competitor_boards').select('*').eq('competitor_id', id).order('pin_count', { ascending: false });
    if (bErr) return json({ error: bErr.message }, 500);
    return json({ success: true, boards: boards || [] });
  }

  const comp = await db.from('competitors').select('*').eq('id', id).eq('workspace_id', g.ok!.ws).maybeSingle();
  if (!comp.data) return json({ error: 'Not found in workspace' }, 404);

  let snapsList: any[] = [];
  let boardsList: any[] = [];
  let topPinsList: any[] = [];
  let strategy_age_days: number | null = null;
  let oldest_board_date: string | null = null;

  if (lite) {
    const [snaps, oldestBoard] = await Promise.all([
      db.from('competitor_snapshots').select('*').eq('competitor_id', id).order('recorded_at', { ascending: false }).limit(100),
      db.from('competitor_boards')
        .select('board_created_at')
        .eq('competitor_id', id)
        .not('board_created_at', 'is', null)
        .order('board_created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
    ]);
    snapsList = (snaps.data || []).slice().reverse();
    boardsList = [];
    topPinsList = [];

    if (oldestBoard?.data?.board_created_at) {
      oldest_board_date = oldestBoard.data.board_created_at;
      const diffMs = Date.now() - new Date(oldestBoard.data.board_created_at).getTime();
      strategy_age_days = Math.max(0, Math.floor(diffMs / 86400000));
    }
  } else {
    const [snaps, boards, topPins] = await Promise.all([
      db.from('competitor_snapshots').select('*').eq('competitor_id', id).order('recorded_at', { ascending: false }).limit(100),
      db.from('competitor_boards').select('*').eq('competitor_id', id).order('pin_count', { ascending: false }),
      db.from('competitor_top_pins').select('*').eq('competitor_id', id).order('save_count', { ascending: false }).limit(10),
    ]);
    snapsList = (snaps.data || []).slice().reverse();
    boardsList = boards.data || [];
    topPinsList = topPins.data || [];
  }

  let deltas: any = null;
  if (snapsList.length >= 2) {
    const curr = snapsList[snapsList.length - 1];
    const prev = snapsList[snapsList.length - 2];
    const calc = (c: number, p: number) => ({
      change: c - p,
      percent: p > 0 ? Number((((c - p) / p) * 100).toFixed(1)) : 0,
    });
    deltas = {
      reachChange: calc(curr.profile_reach || 0, prev.profile_reach || 0).change,
      reachPercent: calc(curr.profile_reach || 0, prev.profile_reach || 0).percent,
      viewsChange: calc(curr.profile_views || 0, prev.profile_views || 0).change,
      viewsPercent: calc(curr.profile_views || 0, prev.profile_views || 0).percent,
      followersChange: calc(curr.follower_count || 0, prev.follower_count || 0).change,
      followersPercent: calc(curr.follower_count || 0, prev.follower_count || 0).percent,
      pinsChange: calc(curr.pin_count || 0, prev.pin_count || 0).change,
      pinsPercent: calc(curr.pin_count || 0, prev.pin_count || 0).percent,
    };
  }
  const competitor = lite
    ? { ...comp.data, strategy_age_days, oldest_board_date }
    : comp.data;

  return json({ success: true, competitor, snapshots: snapsList, boards: boardsList, topPins: topPinsList, deltas });
};

// POST: add new competitor(s) to Competitors DB (single or bulk)
export const POST: APIRoute = async ({ request, locals }) => {
  let body: any = {}; try { body = JSON.parse(await request.text() || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const g = await guard(locals, body.workspace_id); if (g.err) return g.err;

  // Bulk creation support
  if (Array.isArray(body.competitors) && body.competitors.length > 0) {
    const rawTags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);
    const rows = body.competitors.map((item: any) => {
      const u = typeof item === 'string' ? item : item.username;
      const username = String(u || '').trim().replace(/^@/, '');
      if (!username) return null;
      return {
        workspace_id: g.ok!.ws,
        username,
        full_name: (typeof item === 'object' && item.full_name) ? item.full_name : username,
        niche: (typeof item === 'object' && item.niche) ? item.niche : (body.niche || null),
        notes: (typeof item === 'object' && item.notes) ? item.notes : (body.notes || null),
        tags: (typeof item === 'object' && Array.isArray(item.tags)) ? item.tags : rawTags,
        account_type: (typeof item === 'object' && item.account_type) ? item.account_type : (body.account_type || 'competitor'),
        is_active: true,
      };
    }).filter(Boolean);

    if (rows.length === 0) return json({ error: 'No valid usernames provided' }, 400);

    const { data, error } = await g.ok!.db.from('competitors').insert(rows).select();
    if (error) return json({ error: error.message }, 500);
    return json({ success: true, count: data?.length || 0, competitors: data }, 201);
  }

  // Single creation
  const username = String(body.username || '').trim().replace(/^@/, '');
  if (!username) return json({ error: 'username required' }, 400);
  const { data, error } = await g.ok!.db.from('competitors').insert({
    workspace_id: g.ok!.ws, username,
    full_name: body.full_name || username,
    niche: body.niche || null, notes: body.notes || null,
    tags: Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean),
    account_type: body.account_type || 'competitor', is_active: true,
  }).select().single();
  return error ? json({ error: error.message }, 500) : json({ success: true, competitor: data }, 201);
};

// PATCH: update one competitor
export const PATCH: APIRoute = async ({ request, locals }) => {
  let body: any = {}; try { body = JSON.parse(await request.text() || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const g = await guard(locals, body.workspace_id); if (g.err) return g.err;
  if (!body.id) return json({ error: 'id required' }, 400);
  if (!UUID_REGEX.test(body.id)) {
    return json({ success: false, error: 'Invalid competitor ID format.' }, 400);
  }
  const patch: any = {};
  if (body.full_name !== undefined) patch.full_name = body.full_name;
  if (body.username !== undefined) patch.username = String(body.username).replace(/^@/, '');
  if (body.niche !== undefined) patch.niche = body.niche;
  if (body.account_type !== undefined) patch.account_type = body.account_type;
  if (body.tags !== undefined) patch.tags = body.tags;
  if (body.notes !== undefined) patch.notes = body.notes;
  const { data, error } = await g.ok!.db.from('competitors').update(patch).eq('id', body.id).eq('workspace_id', g.ok!.ws).select().single();
  return error ? json({ error: error.message }, 500) : json({ success: true, competitor: data });
};

// DELETE
export const DELETE: APIRoute = async ({ request, locals }) => {
  let body: any = {}; try { body = JSON.parse(await request.text() || '{}'); } catch { /* ok */ }
  const g = await guard(locals, body.workspace_id); if (g.err) return g.err;
  if (!body.id) return json({ error: 'id required' }, 400);
  if (!UUID_REGEX.test(body.id)) {
    return json({ success: false, error: 'Invalid competitor ID format.' }, 400);
  }
  const { error } = await g.ok!.db.from('competitors').delete().eq('id', body.id).eq('workspace_id', g.ok!.ws);
  return error ? json({ error: error.message }, 500) : json({ success: true });
};

