export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { dbClients } from '../../../../server/db/clients';
import { errorStatus } from '../../../../server/lib/http-error';

const json = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

export const DELETE: APIRoute = async ({ request, locals }) => {
  let body: any = {}; try { body = JSON.parse(await request.text() || '{}'); } catch { /* ok */ }
  const user = locals.user, schedulingClient = locals.supabase, ws = locals.activeWorkspaceId;
  if (!user || !schedulingClient || !ws) return json({ error: 'Unauthorized' }, 401);
  try { await assertWorkspaceAccess(schedulingClient, ws, user.id, 'admin'); }
  catch (e: any) { return json({ error: e.message || 'Forbidden' }, errorStatus(e)); }
  if (!body.snapshot_id) return json({ error: 'snapshot_id required' }, 400);

  const db = dbClients.getCompetitors(locals.runtime?.env);
  const snap = await db.from('competitor_snapshots').select('id, competitor_id').eq('id', body.snapshot_id).maybeSingle();
  if (!snap.data) return json({ error: 'Snapshot not found' }, 404);
  const comp = await db.from('competitors').select('id').eq('id', snap.data.competitor_id).eq('workspace_id', ws).maybeSingle();
  if (!comp.data) return json({ error: 'Snapshot not found' }, 404);

  const { error } = await db
    .from('competitor_snapshots')
    .delete()
    .eq('id', body.snapshot_id)
    .eq('competitor_id', comp.data.id);
  return error ? json({ error: error.message }, 500) : json({ success: true });
};
