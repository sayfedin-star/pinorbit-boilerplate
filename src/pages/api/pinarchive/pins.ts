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

  try {
    const { data, error } = await db
      .from('pa_pins')
      .select('pin_id, title, image_url, link, saves, repins, comments, share_count, velocity, annotations, seo_category, canonical_pin_id, archived_at, board_name, board_id, dominant_color, node_id, is_video')
      .eq('workspace_id', ws)
      .not('archived_at', 'is', null)
      .order(sortCol, { ascending: false })
      .limit(limit);

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    return json({
      success: true,
      pins: data || [],
      count: (data || []).length,
      sort: sortCol,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
