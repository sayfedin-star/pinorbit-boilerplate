export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { listWorkspaceTokens, saveWorkspaceToken } from '../../../../server/lib/token-resolver';

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  const client = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

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
    await assertWorkspaceAccess(client, workspaceId, user.id, 'member');
    const tokens = await listWorkspaceTokens(workspaceId, 'competitors', runtimeEnv, false);
    return new Response(JSON.stringify(tokens || []), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to fetch tokens' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const client = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

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

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const rawToken = typeof body.token === 'string' ? body.token.trim() : '';
  const isDefault = Boolean(body.is_default);

  if (!name) {
    return new Response(JSON.stringify({ error: 'Token name is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!rawToken || rawToken.length < 8) {
    return new Response(JSON.stringify({ error: 'Token must be at least 8 characters' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(client, workspaceId, user.id, 'admin');
    const result = await saveWorkspaceToken(
      workspaceId,
      'competitors',
      { name, token: rawToken, is_default: isDefault },
      runtimeEnv
    );

    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error || 'Failed to save token' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, id: result.id }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to create token' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
