export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { deleteWorkspaceToken } from '../../../../server/lib/token-resolver';
import { dbClients } from '../../../../server/db/clients';

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const client = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const { id } = params;

  if (!id) {
    return new Response(JSON.stringify({ error: 'Token ID is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!user || !client) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'Active workspace not found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(client, workspaceId, user.id, 'admin');
    const envWithClient = { ...runtimeEnv, supabaseClient: client };
    const result = await deleteWorkspaceToken(workspaceId, id, 'competitors', envWithClient);
    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error || 'Failed to delete token' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to delete token' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const PATCH: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  const client = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const { id } = params;

  if (!id) {
    return new Response(JSON.stringify({ error: 'Token ID is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!user || !client) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'Active workspace not found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(client, workspaceId, user.id, 'admin');
    const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);

    if (body.is_default === true) {
      await compAdmin
        .from('competitor_fastcron_tokens')
        .update({ is_default: false })
        .eq('workspace_id', workspaceId);

      const { error } = await compAdmin
        .from('competitor_fastcron_tokens')
        .update({ is_default: true })
        .eq('id', id)
        .eq('workspace_id', workspaceId);

      if (error) throw error;
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to update token' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
