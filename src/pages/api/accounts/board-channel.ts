export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';

export const PATCH: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

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

  const { account_id, webhook_id } = body;

  if (!account_id) {
    return new Response(JSON.stringify({ error: 'account_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');

    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);

    // Verify account belongs to active workspace
    const { data: account } = await adminClient
      .from('accounts')
      .select('id, workspace_id')
      .eq('id', account_id)
      .maybeSingle();

    if (!account || account.workspace_id !== workspaceId) {
      return new Response(JSON.stringify({ error: 'Forbidden: account does not belong to the active workspace.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // If webhook_id is provided, verify webhook belongs to the same account
    const targetWhId = webhook_id && typeof webhook_id === 'string' && webhook_id.trim().length > 0
      ? webhook_id.trim()
      : null;

    if (targetWhId) {
      const { data: wh } = await adminClient
        .from('account_webhooks')
        .select('id, account_id')
        .eq('id', targetWhId)
        .maybeSingle();

      if (!wh || wh.account_id !== account_id) {
        return new Response(JSON.stringify({ error: 'Selected webhook does not belong to this account.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Update board_webhook_id on account
    const { error: updateErr } = await adminClient
      .from('accounts')
      .update({
        board_webhook_id: targetWhId,
        board_creation_webhook_id: targetWhId, // Keep synced for backward compatibility
      })
      .eq('id', account_id)
      .eq('workspace_id', workspaceId);

    if (updateErr) {
      return new Response(JSON.stringify({ error: updateErr.message || 'Failed to update board channel.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: true,
      account_id,
      board_webhook_id: targetWhId,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Server error updating board channel.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
