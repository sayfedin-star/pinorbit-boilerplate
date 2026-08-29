export const prerender = false;
import type { APIRoute } from 'astro';
import { dbClients, hasSchedulingSecretKey } from '../../../../server/db/clients';
import { triggerBoardAction } from '../../../../server/services/fastcron-service';
import {
  checkScheduleWindow,
  clampProcessingTimeoutMinutes,
  buildPinPostIdempotencyKey,
  buildBoardCreateIdempotencyKey,
} from '../../../../server/services/scheduling-logic';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';

const json = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

async function handleDispatch(body: any, locals: any) {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  const scheduleId = typeof body.schedule_id === 'string' ? body.schedule_id : '';
  const token = typeof body.dispatch_token === 'string' ? body.dispatch_token : '';
  if (!scheduleId || !token) return json({ success: false, error: 'schedule_id and dispatch_token are required.' }, 400);
  if (!hasSchedulingSecretKey(runtimeEnv)) return json({ success: false, error: 'SCHEDULING_SUPABASE_SECRET_KEY not configured; dispatch disabled.' }, 503);

  const admin = dbClients.getSchedulingAdmin(runtimeEnv);

  const force = body?.force === true || body?.force === 'true';

  // 1) Load schedule + authenticate via per-schedule dispatch token
  const { data: schedule } = await admin.from('posting_schedules').select('*').eq('id', scheduleId).maybeSingle();
  if (!schedule || !schedule.dispatch_token || !(await timingSafeEqual(schedule.dispatch_token, token))) return json({ success: false, error: 'Unauthorized: invalid schedule or dispatch token.' }, 401);
  if (!force && schedule.status !== 'active') return json({ success: true, dispatched: false, reason: 'paused' });
  if (!force && schedule.started_at && new Date(schedule.started_at).getTime() > Date.now()) return json({ success: true, dispatched: false, reason: 'not_started' });

  // Timezone-aware window and active days enforcement (skipped when explicit cron_expression is configured or force=true)
  if (!force) {
    const windowCheck = checkScheduleWindow(schedule);
    if (!windowCheck.allowed) {
      return json({ success: true, dispatched: false, reason: windowCheck.reason });
    }
  }

  const accountId = schedule.account_id;
  const workspaceId = schedule.workspace_id;

  // 2) Stale lock recovery & orphan sweep (per-workspace processing_timeout_minutes)
  const { data: wsSettings } = await admin
    .from('workspace_retention_settings')
    .select('processing_timeout_minutes')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const processingTimeoutMinutes = clampProcessingTimeoutMinutes(wsSettings?.processing_timeout_minutes);
  const staleCut = new Date(Date.now() - processingTimeoutMinutes * 60000).toISOString();
  await admin.from('pins').update({ status: 'pending', processing_started_at: null, claimed_at: null, updated_at: new Date().toISOString() })
    .eq('status', 'processing').eq('workspace_id', workspaceId).lt('claimed_at', staleCut).lt('attempts', 2).then(() => {});

  // 3) Account + daily cap
  const { data: account } = await admin.from('accounts').select('*').eq('id', accountId).maybeSingle();
  if (!force && (!account || account.is_active === false)) return json({ success: true, dispatched: false, reason: 'account_inactive' });
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const { count: postedToday } = await admin.from('pins').select('*', { count: 'exact', head: true })
    .eq('account_id', accountId).eq('status', 'posted').gte('posted_at', todayStart.toISOString());
  if (!force && (postedToday ?? 0) >= (account?.max_pins_per_day ?? 20)) return json({ success: true, dispatched: false, reason: 'cap_reached' });

  // 4) Atomic claim
  const { data: claimed, error: rpcErr } = await admin.rpc('claim_due_pins_simple', { p_account_id: accountId, p_limit: schedule.batch ?? 1 });
  if (rpcErr) return json({ success: false, error: 'claim RPC failed: ' + rpcErr.message }, 500);
  if (!claimed || claimed.length === 0) return json({ success: true, dispatched: false, reason: 'no_due_pins' });

  // Ensure claimed_at is set for claimed pins
  const claimedIds = claimed.map((c: any) => c.id);
  await admin.from('pins').update({ claimed_at: new Date().toISOString() }).in('id', claimedIds).then(() => {});

  // 5) Webhook channel (schedule's channel first, then any with capacity)
  const { data: hooks } = await admin.from('account_webhooks').select('*').eq('account_id', accountId).eq('is_active', true).order('priority', { ascending: true });
  const hook = (hooks || []).find((h: any) => h.id === schedule.webhook_id && (h.remaining_capacity ?? 0) > 0)
    || (hooks || []).find((h: any) => (h.remaining_capacity ?? 0) > 0);
  if (!hook?.webhook_url) {
    for (const c of claimed) await admin.from('pins').update({ status: 'pending', processing_started_at: null, claimed_at: null, updated_at: new Date().toISOString() }).eq('id', c.id);
    return json({ success: true, dispatched: false, reason: 'no_webhook_capacity' });
  }

  // 6) Board resolution + push tickets to Make
  let dispatched = 0; let skipped = 0;

  const pinIds = claimed.map((c: any) => c.id);
  const { data: pinsList } = await admin
    .from('pins')
    .select('*')
    .in('id', pinIds);

  const rawBoardNames = (pinsList || []).map((p: any) => p.board_name).filter(Boolean);
  const boardNames = [...new Set(rawBoardNames.map((n: string) => String(n).trim()))];

  let boardsList: any[] = [];
  if (boardNames.length > 0) {
    const { data: bList } = await admin
      .from('boards')
      .select('board_name, pinterest_board_id')
      .eq('account_id', accountId)
      .in('board_name', boardNames)
      .not('pinterest_board_id', 'is', null);
    boardsList = bList || [];
  }

  const pinMap = new Map((pinsList || []).map((p: any) => [p.id, p]));
  const boardMap = new Map(boardsList.map((b: any) => [String(b.board_name).toLowerCase(), b.pinterest_board_id]));

  let successfulExecutions = 0;

  for (const c of claimed) {
    const pin = pinMap.get(c.id);
    if (!pin) { skipped++; continue; }
    if (!pin.image_url) {
      await admin.from('pins').update({ status: 'failed', last_failure_reason: 'Missing image_url', processing_started_at: null, updated_at: new Date().toISOString() }).eq('id', c.id);
      skipped++; continue;
    }
    let boardId = pin.board_name ? (boardMap.get(String(pin.board_name).toLowerCase()) || null) : null;
    if (!boardId && pin.board_name) {
      // Escape ILIKE wildcards and query with limit(1) to prevent PGRST116
      const escapedBoardName = String(pin.board_name || '').replace(/[%_\\]/g, '\\$&');
      const { data: fallbackBoard } = await admin
        .from('boards')
        .select('pinterest_board_id')
        .eq('account_id', accountId)
        .ilike('board_name', escapedBoardName)
        .not('pinterest_board_id', 'is', null)
        .limit(1)
        .maybeSingle();
      boardId = fallbackBoard?.pinterest_board_id || null;
    }
    if (!boardId) {
      if (account.auto_create_missing_boards && pin.board_name) {
        const idem = buildBoardCreateIdempotencyKey(accountId, pin.board_name);
        await admin.from('board_provisioning_requests').upsert({ workspace_id: workspaceId, account_id: accountId, board_name: pin.board_name, idempotency_key: idem, status: 'provisioning', webhook_id: hook.id }, { onConflict: 'idempotency_key' }).then(() => {});
        await triggerBoardAction(accountId, 'create', { board_name: pin.board_name, workspace_id: workspaceId, webhook_id: hook.id, idempotency_key: idem }, runtimeEnv).catch(() => {});
      }
      await admin.from('pins').update({ status: 'pending', processing_started_at: null, updated_at: new Date().toISOString() }).eq('id', c.id);
      skipped++; continue;
    }
    const pushRes = await fetch(hook.webhook_url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'pin.post',
        idempotency_key: buildPinPostIdempotencyKey(pin.id, pin.attempts),
        pin_id: pin.id, workspace_id: workspaceId, account_id: accountId,
        title: pin.title, description: pin.description, image_url: pin.image_url, link: pin.link,
        board_name: pin.board_name, board_id: boardId,
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);

    if (pushRes && pushRes.ok) {
      successfulExecutions++;
    }
    dispatched++;
  }

  // Update webhook counter once after loop
  if (successfulExecutions > 0) {
    hook.executions_used = (hook.executions_used ?? 0) + successfulExecutions;
    await admin.from('account_webhooks').update({
      executions_used: hook.executions_used,
      last_used_at: new Date().toISOString(),
    }).eq('id', hook.id).then(() => {});
  }

  if (dispatched > 0) {
    await admin.from('posting_schedules').update({ last_dispatched_at: new Date().toISOString() }).eq('id', scheduleId).eq('workspace_id', workspaceId).then(() => {});
  }

  return json({ success: true, dispatched, skipped });
}

export const GET: APIRoute = async ({ url, locals }) =>
  handleDispatch({ schedule_id: url.searchParams.get('schedule_id') || '', dispatch_token: url.searchParams.get('dispatch_token') || '' }, locals);

export const POST: APIRoute = async ({ request, locals }) => {
  let body: any = {};
  try {
    body = JSON.parse((await request.text()) || '{}');
  } catch {
    return json({ success: false, error: 'Malformed JSON payload.' }, 400);
  }

  // Fall back to URL search params if body is empty
  if (!body.schedule_id || !body.dispatch_token) {
    const url = new URL(request.url);
    body.schedule_id = body.schedule_id || url.searchParams.get('schedule_id');
    body.dispatch_token = body.dispatch_token || url.searchParams.get('dispatch_token');
  }

  return handleDispatch(body, locals);
};
