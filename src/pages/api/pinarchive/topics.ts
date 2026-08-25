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

  const search = searchParams.get('q')?.trim() || searchParams.get('search')?.trim() || null;
  const minPins = Math.max(parseInt(searchParams.get('min_pins') || '1', 10) || 1, 1);
  const sort = searchParams.get('sort')?.trim() || 'sum_saves';

  const rawLimit = parseInt(searchParams.get('limit') || searchParams.get('page_size') || '50', 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 200);

  let offset = 0;
  if (searchParams.has('offset')) {
    const rawOffset = parseInt(searchParams.get('offset') || '0', 10);
    offset = Math.max(isNaN(rawOffset) ? 0 : rawOffset, 0);
  } else if (searchParams.has('page')) {
    const page = Math.max(parseInt(searchParams.get('page') || '1', 10) || 1, 1);
    offset = (page - 1) * limit;
  }

  try {
    const { data, error } = await db.rpc('pa_topic_clusters_page', {
      p_workspace_id: ws,
      p_search: search,
      p_min_pins: minPins,
      p_sort: sort,
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    const rows = Array.isArray(data) ? data : [];
    const total = rows.length > 0 ? Number(rows[0].total_count || 0) : 0;

    const topics = rows.map((r: any) => ({
      name: r.name,
      pins: Number(r.pins || 0),
      sum_saves: Number(r.sum_saves || 0),
      avg_saves: Number(r.avg_saves || 0),
    }));

    return json({
      success: true,
      topics,
      count: topics.length,
      total,
      limit,
      offset,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
