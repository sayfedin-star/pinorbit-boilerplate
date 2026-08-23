export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients, isKnownDefaultKek, isProductionEnv } from '../../../server/db/clients';
import { encryptToken, decryptToken, resolveTokenKek } from '../../../server/lib/token-crypto';
import { maskSecret } from '../../../server/services/webhook-secrets';
import { syncPublishingSchedule } from '../../../server/services/fastcron-service';

export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'Active workspace not found' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    const isAdmin = wsCtx.isAdmin;
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);
    let query = adminClient.from('posting_schedules').select('*, accounts(account_name), account_webhooks(label), fastcron_tokens(id, name, is_default, token_masked)').eq('workspace_id', workspaceId);
    
    // Accept optional ?account_id= and verify it belongs to workspace
    const account_id = url.searchParams.get('account_id');
    if (account_id) {
      const { data: account } = await adminClient.from('accounts').select('id, workspace_id').eq('id', account_id).maybeSingle();
      if (!account || account.workspace_id !== workspaceId) {
        return new Response(JSON.stringify({ error: 'Forbidden: account does not belong to the active workspace.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      query = query.eq('account_id', account_id);
    }
    
    let { data, error } = await query.order('created_at', { ascending: false });
    if (error) {
      // Fallback query without joins in case foreign key relationships are unlinked
      let basicQuery = adminClient.from('posting_schedules').select('*').eq('workspace_id', workspaceId);
      if (account_id) basicQuery = basicQuery.eq('account_id', account_id);
      const { data: basicData, error: basicError } = await basicQuery.order('created_at', { ascending: false });
      if (basicError) throw basicError;
      data = basicData;
    }

    // Fetch account_webhooks map for robust label resolution (scoped to workspace accounts)
    const { data: wsAccounts } = await adminClient.from('accounts').select('id').eq('workspace_id', workspaceId);
    const wsAccountIds = (wsAccounts || []).map((a: any) => a.id);
    const { data: webhooksData } = wsAccountIds.length > 0
      ? await adminClient.from('account_webhooks').select('id, label').in('account_id', wsAccountIds)
      : { data: [] };
    const webhookMap = new Map<string, string>();
    (webhooksData || []).forEach((w: any) => {
      if (w.id && w.label) webhookMap.set(w.id, w.label);
    });

    const kek = await resolveTokenKek(runtimeEnv);
    const sanitizedSchedules = await Promise.all((data || []).map(async (schedule: any) => {
      const result: any = { ...schedule };
      delete result.fastcron_token_encrypted;  // NEVER send ciphertext to client
      
      result.webhook_label = schedule.webhook_id
        ? (webhookMap.get(schedule.webhook_id) || schedule.account_webhooks?.label || 'Channel')
        : 'Auto';
      if (schedule.fastcron_tokens) {
        result.token_name = schedule.fastcron_tokens.name;
        result.fastcron_token_masked = schedule.fastcron_tokens.token_masked;
        result.has_fastcron_token = true;
      } else if (schedule.fastcron_token_encrypted && kek) {
        try {
          const decrypted = await decryptToken(schedule.fastcron_token_encrypted, kek);
          if (decrypted) {
            result.has_fastcron_token = true;
            result.fastcron_token_masked = maskSecret(decrypted);  // Returns '••••XXXX'
          } else {
            result.has_fastcron_token = false;
          }
        } catch {
          result.has_fastcron_token = false;
        }
      } else {
        result.has_fastcron_token = false;
      }

      result.is_admin = isAdmin;
      if (!isAdmin && result.dispatch_token) {
        result.dispatch_token = maskSecret(result.dispatch_token);
      }

      return result;
    }));

    return new Response(JSON.stringify(sanitizedSchedules), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to fetch schedules' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'Active workspace not found' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  if (!body.account_id) {
    return new Response(JSON.stringify({ error: 'account_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // SECURITY: Verify account belongs to workspace
  const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);
  const { data: account } = await adminClient.from('accounts').select('id, workspace_id').eq('id', body.account_id).maybeSingle();
  if (!account || account.workspace_id !== workspaceId) {
    return new Response(JSON.stringify({ error: 'Forbidden: account does not belong to the active workspace.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');

    let fastcron_token_id = body.fastcron_token_id || null;
    let fastcron_token_encrypted: string | null = null;
    if (body.fastcron_token && typeof body.fastcron_token === 'string' && body.fastcron_token.trim().length > 0) {
      const kek = await resolveTokenKek(runtimeEnv);
      if (!kek || (isProductionEnv(runtimeEnv) && isKnownDefaultKek(kek))) {
        return new Response(JSON.stringify({ error: 'TOKEN_KEK unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      try {
        fastcron_token_encrypted = await encryptToken(body.fastcron_token.trim(), kek);
        fastcron_token_id = null;
      } catch (e: any) {
        return new Response(JSON.stringify({ error: 'Failed to encrypt token: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    const dispatch_token = crypto.randomUUID();
    const newRow = {
      workspace_id: workspaceId,
      account_id: body.account_id,
      label: body.label || '',
      webhook_id: body.webhook_id || null,
      timezone: body.timezone || 'UTC',
      window_start: body.window_start || '09:00',
      window_end: body.window_end || '21:00',
      interval_minutes: body.interval_minutes ?? 36,
      random_delay_minutes: body.random_delay_minutes ?? 0,
      active_days: body.active_days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      started_at: body.started_at || null,
      batch: body.batch ?? 1,
      status: 'not_synced',
      dispatch_token,
      cron_expression: body.cron_expression || null,
      fastcron_job_id: null,
      fastcron_token_id: fastcron_token_id,
      fastcron_token_encrypted: fastcron_token_encrypted,
    };
    const { data: inserted, error: insertErr } = await adminClient.from('posting_schedules').insert(newRow).select().single();
    if (insertErr || !inserted) throw insertErr || new Error('Insert failed');
    const syncResult = await syncPublishingSchedule(inserted, runtimeEnv);
    if (!syncResult.success) {
      await adminClient.from('posting_schedules').update({ status: 'error' }).eq('id', inserted.id);
    } else {
      await adminClient.from('posting_schedules').update({ status: 'active', fastcron_job_id: syncResult.job_id }).eq('id', inserted.id);
    }
    const responseSchedule = { ...inserted };
    delete responseSchedule.fastcron_token_encrypted;
    delete responseSchedule.dispatch_token;
    return new Response(JSON.stringify({ ...responseSchedule, job_id: syncResult.job_id }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to create schedule' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
