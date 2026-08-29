export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients, isKnownDefaultKek, isProductionEnv } from '../../../server/db/clients';
import { encryptToken, resolveTokenKek } from '../../../server/lib/token-crypto';
import { syncPublishingSchedule, deletePublishingSchedule } from '../../../server/services/fastcron-service';

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
    const { data: schedule } = await adminClient
      .from('posting_schedules')
      .select('*')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!schedule) {
      return new Response(JSON.stringify({ error: 'Schedule not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    const updateFields: Record<string, any> = {};
    const allowedFields = ['label', 'webhook_id', 'timezone', 'window_start', 'window_end', 'interval_minutes', 'random_delay_minutes', 'active_days', 'started_at', 'batch', 'status', 'fastcron_token_id', 'cron_expression'];
    for (const field of allowedFields) {
      if (body[field] !== undefined) updateFields[field] = body[field];
    }
    if (body.fastcron_token_id !== undefined && body.fastcron_token_id !== null) {
      updateFields.fastcron_token_encrypted = null;
    }
    if (body.fastcron_token !== undefined) {
      if (body.fastcron_token === null) {
        updateFields.fastcron_token_encrypted = null;  // Clear override
      } else if (typeof body.fastcron_token === 'string' && body.fastcron_token.trim().length > 0) {
        const kek = await resolveTokenKek(runtimeEnv);
        if (!kek || (isProductionEnv(runtimeEnv) && isKnownDefaultKek(kek))) {
          return new Response(JSON.stringify({ error: 'TOKEN_KEK unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
        try {
          updateFields.fastcron_token_encrypted = await encryptToken(body.fastcron_token.trim(), kek);
          updateFields.fastcron_token_id = null;
        } catch (e: any) {
          return new Response(JSON.stringify({ error: 'Failed to encrypt token: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
      }
      // If empty string, do nothing (keep existing value)
    }
    if (Object.keys(updateFields).length === 0) {
      return new Response(JSON.stringify({ error: 'No valid fields to update' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const { data: updated, error: updateErr } = await adminClient
      .from('posting_schedules')
      .update(updateFields)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .select()
      .single();
    if (updateErr || !updated) throw updateErr || new Error('Update failed');
    const syncResult = await syncPublishingSchedule(updated, runtimeEnv, workspaceId);
    const responseSchedule = { ...updated };
    delete responseSchedule.fastcron_token_encrypted;
    delete responseSchedule.dispatch_token;
    return new Response(JSON.stringify({ ...responseSchedule, job_id: syncResult.job_id }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to update schedule' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const { id } = params;

  if (!user || !schedulingClient || !workspaceId || !id) {
    return new Response(JSON.stringify({ error: 'Unauthorized or missing workspace/schedule ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);
    const { data: schedule } = await adminClient
      .from('posting_schedules')
      .select('*')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!schedule) {
      return new Response(JSON.stringify({ error: 'Schedule not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    const result = await deletePublishingSchedule(id, schedule?.fastcron_job_id, runtimeEnv, workspaceId);
    if (!result.success) throw new Error(result.error);
    return new Response(JSON.stringify({ success: true, remote_deleted: result.remote_deleted, remote_error: result.remote_error }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to delete schedule' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
