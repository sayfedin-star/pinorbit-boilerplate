export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';

// Route: /api/pinarchive/notes (POST) - Update manual notes on an archived pin
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTES_LENGTH = 2000;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  if (!user || !schedulingClient) {
    return json({ success: false, error: 'Unauthorized: missing session' }, 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON payload' }, 400);
  }

  const workspaceId = body.workspace_id || locals.activeWorkspaceId;
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

  const pinId = body.pin_id;
  if (!pinId || !UUID_REGEX.test(pinId)) {
    return json({ success: false, error: 'Invalid pin identifier format.' }, 400);
  }

  if (typeof body.notes !== 'string') {
    return json({ success: false, error: 'Notes content must be a string.' }, 400);
  }

  const notes = body.notes.trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    return json({ success: false, error: `Notes cannot exceed ${MAX_NOTES_LENGTH} characters.` }, 400);
  }

  try {
    const db = dbClients.getPinArchive(locals.runtime?.env);
    const now = new Date().toISOString();

    const { data, error } = await db
      .from('pa_pins')
      .update({
        notes: notes.length > 0 ? notes : null,
        notes_updated_at: now,
      })
      .eq('id', pinId)
      .eq('workspace_id', wsCtx.workspaceId)
      .select('id, notes, notes_updated_at')
      .maybeSingle();

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }
    if (!data) {
      return json({ success: false, error: 'Pin not found.' }, 404);
    }

    return json({
      success: true,
      pin_id: data.id,
      notes: data.notes,
      notes_updated_at: data.notes_updated_at,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
