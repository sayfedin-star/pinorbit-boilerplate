export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients, isKnownDefaultKek, isProductionEnv } from '../../../server/db/clients';
import { encryptToken, resolveTokenKek } from '../../../server/lib/token-crypto';
import { maskSecret } from '../../../server/services/webhook-secrets';

export const PATCH: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const { id } = params;

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ error: 'Unauthorized or missing workspace' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);

    const { data: existing } = await adminClient
      .from('fastcron_tokens')
      .select('*')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!existing) {
      return new Response(JSON.stringify({ error: 'Token not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const updateFields: Record<string, any> = { updated_at: new Date().toISOString() };

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return new Response(JSON.stringify({ error: 'Name cannot be empty' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      updateFields.name = name;
    }

    if (body.is_default !== undefined) {
      const isDefault = Boolean(body.is_default);
      if (isDefault) {
        await adminClient.from('fastcron_tokens').update({ is_default: false }).eq('workspace_id', workspaceId);
      }
      updateFields.is_default = isDefault;
    }

    if (body.token !== undefined && typeof body.token === 'string' && body.token.trim().length > 0) {
      const rawToken = body.token.trim();
      if (rawToken.length < 16) {
        return new Response(JSON.stringify({ error: 'Token must be at least 16 characters' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const kek = await resolveTokenKek(runtimeEnv);
      if (!kek || (isProductionEnv(runtimeEnv) && isKnownDefaultKek(kek))) {
        return new Response(JSON.stringify({ error: 'TOKEN_KEK unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      updateFields.token_encrypted = await encryptToken(rawToken, kek);
      updateFields.token_masked = maskSecret(rawToken);
    }

    const { data: updated, error: updateErr } = await adminClient
      .from('fastcron_tokens')
      .update(updateFields)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .select('id, workspace_id, name, token_masked, is_default, created_at, updated_at')
      .single();

    if (updateErr || !updated) throw updateErr || new Error('Update failed');
    return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to update token' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const { id } = params;

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ error: 'Unauthorized or missing workspace' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);

    const { data: existing } = await adminClient
      .from('fastcron_tokens')
      .select('*')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!existing) {
      return new Response(JSON.stringify({ error: 'Token not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const { error: delErr } = await adminClient
      .from('fastcron_tokens')
      .delete()
      .eq('id', id)
      .eq('workspace_id', workspaceId);
    if (delErr) throw delErr;

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to delete token' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
