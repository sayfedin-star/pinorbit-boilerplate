export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { analyticsDb } from '../../../../server/db/analytics';

function sanitizeConnection(conn: any) {
  if (!conn || typeof conn !== 'object') return conn;
  const copy = { ...conn };
  delete copy.fastcron_token;
  delete copy.analytics_fastcron_token;
  delete copy.top_pins_fastcron_token;
  return copy;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: authentication required.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: 'Active workspace not found in session.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    const url = new URL(request.url);
    const windowDays = parseInt(url.searchParams.get('window_days') || '30', 10);

    const connections = await analyticsDb.getWorkspaceConnectionsWithStats(
      workspaceId,
      windowDays
    );

    return new Response(JSON.stringify({ success: true, data: connections.map(sanitizeConnection) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    const isAuth = err.message?.includes('Forbidden') || err.message?.includes('Unauthorized');
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to list connections.' }),
      {
        status: isAuth ? 403 : 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: authentication required.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ success: false, error: 'Active workspace not found in session.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid JSON body.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Unified field: display_name (with fallback for compatibility)
  const displayName = body.display_name || body.account_name;
  const analyticsEnabled =
    body.analytics_enabled !== undefined ? Boolean(body.analytics_enabled) : true;

  if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
    return new Response(
      JSON.stringify({ success: false, error: 'display_name is required.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const access = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    if (!access.isAdmin && !access.isOwner) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Forbidden: Admin or Owner role required to add connections.',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const connection = await analyticsDb.createWorkspaceConnection(
      workspaceId,
      displayName,
      analyticsEnabled
    );

    const sanitized = sanitizeConnection(connection);
    return new Response(
      JSON.stringify({
        success: true,
        connection_id: connection.id,
        account: sanitized, // for backward compatibility
        connection: sanitized,
        message: 'Pinterest connection created successfully.',
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    const isAuth =
      err.message?.includes('Forbidden') ||
      err.message?.includes('Unauthorized') ||
      err.message?.includes('not a member');
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to create connection.' }),
      {
        status: isAuth ? 403 : 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
