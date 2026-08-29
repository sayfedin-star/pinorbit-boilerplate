export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { triggerBoardAction } from '../../../server/services/fastcron-service';

export const POST: APIRoute = async ({ request, locals }) => {
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

  const { account_id, action, board_name, board_id, webhook_id } = body;

  // Validate required fields
  if (!account_id) {
    return new Response(JSON.stringify({ error: 'account_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (!action || !['create', 'list', 'delete', 'delete_local'].includes(action)) {
    return new Response(JSON.stringify({ error: 'Invalid action (must be create|list|delete|delete_local)' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // Validate action-specific fields
  if (action === 'create' && (!board_name || typeof board_name !== 'string')) {
    return new Response(JSON.stringify({ error: 'board_name is required for create action' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (['delete', 'delete_local'].includes(action) && (!board_id || typeof board_id !== 'string')) {
    return new Response(JSON.stringify({ error: 'board_id is required for delete action' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');

    // Verify account belongs to workspace
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);
    const { data: account } = await adminClient.from('accounts').select('id, workspace_id').eq('id', account_id).maybeSingle();
    if (!account || account.workspace_id !== workspaceId) {
      return new Response(JSON.stringify({ error: 'Forbidden: account does not belong to the active workspace.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Handle delete_local: DB row deletion ONLY, no Pinterest/Make webhook dispatch
    if (action === 'delete_local') {
      const sanitizedId = String(board_id).trim();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sanitizedId)) {
        return new Response(JSON.stringify({ error: 'Invalid board_id format.' }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sanitizedId);
      let query = adminClient
        .from('boards')
        .delete()
        .eq('account_id', account_id)
        .eq('workspace_id', workspaceId);

      if (isUuid) {
        query = query.or(`id.eq.${sanitizedId},board_id.eq.${sanitizedId},pinterest_board_id.eq.${sanitizedId}`);
      } else {
        query = query.or(`board_id.eq.${sanitizedId},pinterest_board_id.eq.${sanitizedId}`);
      }

      const { error: delErr } = await query;

      if (delErr) {
        return new Response(JSON.stringify({ error: delErr.message || 'Failed to delete local board' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: true, deleted_local: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Build extra payload
    const extra: Record<string, any> = { workspace_id: workspaceId };
    if (board_name) extra.board_name = board_name;
    if (board_id) extra.board_id = board_id;
    if (webhook_id) {
      const { data: wh } = await adminClient
        .from('account_webhooks')
        .select('id')
        .eq('id', webhook_id)
        .eq('account_id', account_id)
        .maybeSingle();

      if (!wh) {
        return new Response(JSON.stringify({ error: 'Forbidden: webhook does not belong to this account.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      extra.webhook_id = webhook_id;
    }

    // Call the existing trigger function
    const result = await triggerBoardAction(account_id, action as 'create' | 'list' | 'delete', extra, runtimeEnv);

    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error || 'Board action failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ success: true, status: result.status }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Board action failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
