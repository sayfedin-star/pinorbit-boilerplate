export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { dbClients } from '../../../../server/db/clients';
import { errorStatus } from '../../../../server/lib/http-error';
import { parsePinterestPayload } from '../../../../lib/competitors';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  let body: any = {}; try { body = JSON.parse(await request.text() || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const user = locals.user, schedulingClient = locals.supabase, ws = locals.activeWorkspaceId;
  if (!user || !schedulingClient || !ws) return json({ error: 'Unauthorized' }, 401);
  try { await assertWorkspaceAccess(schedulingClient, ws, user.id, 'admin'); }
  catch (e: any) { return json({ error: e.message || 'Forbidden' }, errorStatus(e)); }

  if (!body.competitor_id || !UUID_REGEX.test(body.competitor_id)) {
    return json({ success: false, error: 'Invalid competitor ID format.' }, 400);
  }

  const db = dbClients.getCompetitors(locals.runtime?.env);
  const parsed = parsePinterestPayload(body.payload || '');
  if (parsed.type === 'unknown') return json({ success: false, message: 'Unknown payload format' }, 400);

  const comp = await db.from('competitors').select('*').eq('id', body.competitor_id).eq('workspace_id', ws).maybeSingle();
  if (!comp.data) return json({ error: 'Competitor not found in workspace' }, 404);
  const now = new Date().toISOString();

  if (parsed.type === 'user_profile' && parsed.profileData) {
    const p = parsed.profileData;
    const reach = Number(p.profile_reach ?? comp.data.profile_reach ?? 0);
    const views = Number(p.profile_views ?? comp.data.profile_views ?? 0);
    const fol = Number(p.follower_count ?? comp.data.follower_count ?? 0);
    const pins = Number(p.pin_count ?? comp.data.pin_count ?? 0);
    await db.from('competitors').update({
      profile_reach: reach, profile_views: views, follower_count: fol, pin_count: pins,
      full_name: p.full_name || comp.data.full_name, avatar_url: p.avatar_url || comp.data.avatar_url,
      website_url: p.website_url ?? comp.data.website_url, domain_verified: p.domain_verified ?? comp.data.domain_verified,
      last_pin_at: p.last_pin_at ?? comp.data.last_pin_at, last_checked_at: now,
    }).eq('id', comp.data.id).eq('workspace_id', ws);
    await db.from('competitor_snapshots').insert({ competitor_id: comp.data.id, profile_reach: reach, profile_views: views, follower_count: fol, pin_count: pins, recorded_at: now });
    await db.from('competitor_daily_snapshots').upsert({ competitor_id: comp.data.id, snapshot_date: now.slice(0, 10), profile_reach: reach, profile_views: views, follower_count: fol, pin_count: pins }, { onConflict: 'competitor_id,snapshot_date' });

    // Prune raw snapshots older than 30 days for this competitor
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    await db.from('competitor_snapshots')
      .delete()
      .eq('competitor_id', comp.data.id)
      .lt('recorded_at', thirtyDaysAgo);

    return json({ success: true, type: parsed.type, message: 'Profile payload ingested.' });
  }

  if (parsed.type === 'user_boards' && parsed.boardsData) {
    const rows = parsed.boardsData.map((bd: any) => ({
      competitor_id: comp.data.id, board_id: bd.board_id, name: bd.name,
      description: bd.description || '', url: bd.url || '', pin_count: Number(bd.pin_count || 0),
      follower_count: Number(bd.follower_count || 0),
      board_created_at: bd.board_created_at ? new Date(bd.board_created_at).toISOString() : null,
      last_pinned_at: bd.last_pinned_at ? new Date(bd.last_pinned_at).toISOString() : null,
    }));
    if (rows.length) await db.from('competitor_boards').upsert(rows, { onConflict: 'competitor_id,board_id' });
    return json({ success: true, type: parsed.type, message: `${rows.length} boards ingested.` });
  }
  return json({ success: false, message: 'No actionable data in payload' }, 400);
};
