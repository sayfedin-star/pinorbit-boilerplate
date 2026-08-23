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

    // c) Fetch canonical siblings if canonical_pin_id is present
    let canonical_siblings: any[] = [];
    if (pin.canonical_pin_id) {
      const { data: siblings, error: sibErr } = await db
        .from('pa_pins')
        .select('id, pin_id, title, saves, archived_at, image_url')
        .eq('canonical_pin_id', pin.canonical_pin_id)
        .eq('workspace_id', wsCtx.workspaceId)
        .limit(10);

      if (!sibErr && Array.isArray(siblings)) {
        canonical_siblings = siblings.filter((s: any) => s.id !== id);
      }
    }

    return json({
      success: true,
      pin,
      metrics: metrics || [],
      canonical_siblings,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
