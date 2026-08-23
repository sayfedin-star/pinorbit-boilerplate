export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { HttpError } from '../../../server/lib/http-error';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/pinarchive/archived-usernames
 *
 * Fast read-only lookup endpoint returning a list of all Pinterest usernames
 * already archived in the active workspace. Used to badge and identify
 * competitors that are already tracked in PinArchive.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  const supabase = (locals as any).supabase;

  if (!user || !supabase) {
    return json({ success: false, error: 'Unauthorized: missing user session' }, 401);
  }

  const url = new URL(request.url);
  const rawWs = url.searchParams.get('workspace_id') || (locals as any).activeWorkspaceId;

  if (!rawWs || typeof rawWs !== 'string' || !UUID_REGEX.test(rawWs.trim())) {
    return json({ success: false, error: 'Invalid or missing workspace identifier format' }, 400);
  }

  const workspaceId = rawWs.trim();
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv;

  try {
    // Requires viewer or higher workspace access
    await assertWorkspaceAccess(locals, workspaceId, 'viewer');

    const pinArchive = dbClients.getPinArchive(runtimeEnv);
    const { data: rows, error: dbErr } = await pinArchive
      .from('pa_accounts')
      .select('username')
      .eq('workspace_id', workspaceId)
      .limit(1000);

    if (dbErr) {
      return json({ success: false, error: `Failed to fetch archived usernames: ${dbErr.message}` }, 500);
    }

    const usernames = Array.from(
      new Set(
        (rows || [])
          .map((r: any) => String(r.username || '').trim().toLowerCase().replace(/^@/, ''))
          .filter(Boolean)
      )
    );

    return json({
      success: true,
      workspace_id: workspaceId,
      usernames,
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Internal server error' }, 500);
  }
};
