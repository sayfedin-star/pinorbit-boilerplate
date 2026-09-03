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

export async function handleDispatch(body: any, locals: any) {
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

  // Debounce rapid sequential FastCron retries within 15 seconds of a successful dispatch
  if (!force && schedule.last_dispatched_at) {
    const msSinceLast = Date.now() - new Date(schedule.last_dispatched_at).getTime();
    if (msSinceLast < 15000) {
      return json({ success: true, dispatched: 0, skipped: 0, reason: 'recently_dispatched' });
    }
  }

  // Timezone-aware window and active days enforcement (skipped when explicit cron_expression is configured or force=true)
  if (!force) {
    const windowCheck = checkScheduleWindow(schedule);
    if (!windowCheck.allowed) {
      return json({ success: true, dispatched: false, reason: windowCheck.reason });
    }
  }

  // 1b) Concurrency Lease Guard: Acquire atomic lock on posting_schedules to block concurrent FastCron calls with the same token
  let leaseAcquired = false;
  let dispatched = 0;
  let skipped = 0;
  if (!force) {
    const { data: leaseOk, error: leaseErr } = await admin.rpc('acquire_schedule_dispatch_lease', {
      p_schedule_id: scheduleId,
      p_lease_seconds: 45,
      p_workspace_id: schedule.workspace_id,
    });

    if (leaseErr) {
      // Fallback check-and-set if RPC error
      const { data: updatedSchedule } = await admin
        .from('posting_schedules')
        .update({ locked_until: new Date(Date.now() + 45000).toISOString(), updated_at: new Date().toISOString() })
        .eq('id', scheduleId)
        .eq('workspace_id', schedule.workspace_id)
        .or(`locked_until.is.null,locked_until.lte.${new Date().toISOString()}`)
        .select('id')
        .maybeSingle();

      if (!updatedSchedule) {
        return json({ success: true, dispatched: false, reason: 'already_processing' });
      }
      leaseAcquired = true;
    } else if (!leaseOk) {
      return json({ success: true, dispatched: false, reason: 'already_processing' });
    } else {
      leaseAcquired = true;
    }
  }

  const accountId = schedule.account_id;
  const workspaceId = schedule.workspace_id;

  try {
    // 2) Stale lock recovery & orphan sweep - strictly scoped per-schedule (not workspace-wide)
    const { data: wsSettings } = await admin
      .from('workspace_retention_settings')
      .select('processing_timeout_minutes')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    const processingTimeoutMinutes = clampProcessingTimeoutMinutes(wsSettings?.processing_timeout_minutes);
    const staleCut = new Date(Date.now() - processingTimeoutMinutes * 60000).toISOString();

    // 2a) Stale recovery: reset timed-out processing pins with remaining retries back to pending
    try {
      await admin
        .from('pins')
        .update({
          status: 'pending',
          processing_started_at: null,
          claimed_at: null,
          claimed_by_schedule_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', workspaceId)
        .eq('account_id', accountId)
        .eq('status', 'processing')
        .or(`claimed_at.lt.${staleCut},and(claimed_at.is.null,processing_started_at.lt.${staleCut})`)
        .lt('attempts', 2);
    } catch (sweepErr) {
      console.warn('[Dispatch] Stale pin recovery warning:', sweepErr);
    }

    // 2b) Terminal transition: mark timed-out processing pins that exhausted retries (attempts >= 2) as failed
    try {
      await admin
        .from('pins')
        .update({
          status: 'failed',
          error_message: 'Processing timed out after maximum retry attempts.',
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', workspaceId)
        .eq('account_id', accountId)
        .eq('status', 'processing')
        .or(`claimed_at.lt.${staleCut},and(claimed_at.is.null,processing_started_at.lt.${staleCut})`)
        .gte('attempts', 2);
    } catch (termErr) {
      console.warn('[Dispatch] Terminal pin transition warning:', termErr);
    }

    // 3) Account + daily cap
    const { data: account } = await admin.from('accounts').select('*').eq('id', accountId).maybeSingle();
    if (!force && (!account || account.is_active === false)) return json({ success: true, dispatched: false, reason: 'account_inactive' });
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const { count: postedToday } = await admin.from('pins').select('*', { count: 'exact', head: true })
      .eq('account_id', accountId).eq('status', 'posted').gte('posted_at', todayStart.toISOString());
    if (!force && (postedToday ?? 0) >= (account?.max_pins_per_day ?? 20)) return json({ success: true, dispatched: false, reason: 'cap_reached' });

    // 4) Atomic claim: claimed_at and claimed_by_schedule_id are set atomically inside the RPC
    const { data: claimed, error: rpcErr } = await admin.rpc('claim_due_pins_simple', {
      p_account_id: accountId,
      p_limit: Math.min(schedule.batch ?? 1, 50),
      p_schedule_id: scheduleId,
    });
    if (rpcErr) return json({ success: false, error: 'claim RPC failed: ' + rpcErr.message }, 500);
    if (!claimed || claimed.length === 0) return json({ success: true, dispatched: false, reason: 'no_due_pins' });

    // 5) Webhook channel (schedule's channel first, then any with capacity)
    const { data: hooks } = await admin.from('account_webhooks').select('*').eq('account_id', accountId).eq('is_active', true).order('priority', { ascending: true });
    const hook = (hooks || []).find((h: any) => h.id === schedule.webhook_id && (h.remaining_capacity ?? 0) > 0)
      || (hooks || []).find((h: any) => (h.remaining_capacity ?? 0) > 0);
    if (!hook?.webhook_url) {
      for (const c of claimed) {
        await admin.from('pins').update({
          status: 'pending',
          processing_started_at: null,
          claimed_at: null,
          claimed_by_schedule_id: null,
          updated_at: new Date().toISOString(),
        }).eq('id', c.id).eq('workspace_id', workspaceId).eq('account_id', accountId);
      }
      return json({ success: true, dispatched: false, reason: 'no_webhook_capacity' });
    }

    // 6) Board resolution + push tickets to Make
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
        await admin.from('pins').update({
          status: 'failed',
          last_failure_reason: 'Missing image_url',
          processing_started_at: null,
          claimed_at: null,
          claimed_by_schedule_id: null,
          updated_at: new Date().toISOString(),
        }).eq('id', c.id).eq('workspace_id', workspaceId).eq('account_id', accountId);
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
          const { data: existingProv } = await admin
            .from('board_provisioning_requests')
            .select('id, status')
            .eq('idempotency_key', idem)
            .maybeSingle();

          if (!existingProv || existingProv.status !== 'provisioning') {
            const { error: provErr } = await admin.from('board_provisioning_requests').upsert({
              workspace_id: workspaceId,
              account_id: accountId,
              board_name: pin.board_name,
              idempotency_key: idem,
              status: 'provisioning',
              webhook_id: hook.id,
            }, { onConflict: 'idempotency_key' });
            if (provErr) {
              console.warn('[Dispatch] Board provisioning request error:', provErr.message);
            }
            await triggerBoardAction(accountId, 'create', {
              board_name: pin.board_name,
              workspace_id: workspaceId,
              webhook_id: hook.id,
              idempotency_key: idem,
            }, runtimeEnv).catch((err) => console.warn('[Dispatch] triggerBoardAction error:', err?.message || err));
          }
        }
        // Revert attempt increment and backoff to avoid spinning or inflating attempts
        await admin.from('pins').update({
          status: 'pending',
          processing_started_at: null,
          claimed_at: null,
          claimed_by_schedule_id: null,
          attempts: Math.max(0, (pin.attempts || 1) - 1),
          next_retry_at: new Date(Date.now() + 120000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', c.id).eq('workspace_id', workspaceId);
        skipped++; continue;
      }

      // Pre-fetch Idempotency Guard: Verify pin is still in processing and claimed by this schedule
      const { data: verifiedPin } = await admin
        .from('pins')
        .select('id, status, attempts')
        .eq('id', pin.id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'processing')
        .eq('claimed_by_schedule_id', scheduleId)
        .maybeSingle();

      if (!verifiedPin) {
        // Pin transitioned concurrently or was swept; skip fetch to prevent duplicate dispatch
        skipped++;
        continue;
      }

      const idempotencyKey = buildPinPostIdempotencyKey(pin.id, verifiedPin.attempts);

      const pushRes = await fetch(hook.webhook_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'pin.post',
          idempotency_key: idempotencyKey,
          pin_id: pin.id, workspace_id: workspaceId, account_id: accountId,
          title: pin.title, description: pin.description, image_url: pin.image_url, link: pin.link,
          board_name: pin.board_name, board_id: boardId,
        }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);

      if (pushRes && pushRes.ok) {
        successfulExecutions++;
        dispatched++;
      } else {
        // Push failed or timed out: back off and reset pin to pending so it is not abandoned in processing
        await admin.from('pins').update({
          status: 'pending',
          processing_started_at: null,
          claimed_at: null,
          claimed_by_schedule_id: null,
          next_retry_at: new Date(Date.now() + 60000).toISOString(),
          last_failure_reason: pushRes ? `Webhook responded HTTP ${pushRes.status}` : 'Webhook push timed out or connection failed',
          updated_at: new Date().toISOString(),
        }).eq('id', pin.id).eq('workspace_id', workspaceId);
        skipped++;
      }
    }

    // Update webhook counter atomically via increment_webhook_execution RPC
    if (successfulExecutions > 0) {
      const { error: incErr } = await admin.rpc('increment_webhook_execution', {
        p_webhook_id: hook.id,
        p_count: successfulExecutions,
        p_workspace_id: workspaceId,
      });
      if (incErr) {
        console.warn('[Dispatch] increment_webhook_execution RPC failed, falling back:', incErr.message);
        hook.executions_used = (hook.executions_used ?? 0) + successfulExecutions;
        hook.monthly_usage = (hook.monthly_usage ?? 0) + successfulExecutions;
        try {
          await admin.from('account_webhooks').update({
            executions_used: hook.executions_used,
            monthly_usage: hook.monthly_usage,
            last_used_at: new Date().toISOString(),
          }).eq('id', hook.id).eq('account_id', accountId);
        } catch (err: any) {
          console.warn('[Dispatch] fallback hook counter error:', err?.message || err);
        }
      }
    }

    if (dispatched > 0) {
      // Keep locked_until for 20s as a debounce buffer to prevent concurrent/retry duplicate dispatch
      try {
        await admin.from('posting_schedules').update({
          last_dispatched_at: new Date().toISOString(),
          locked_until: new Date(Date.now() + 20000).toISOString(),
        }).eq('id', scheduleId).eq('workspace_id', workspaceId);
      } catch (err: any) {
        console.warn('[Dispatch] debounce lock error:', err?.message || err);
      }
    }

    return json({ success: true, dispatched, skipped });
  } finally {
    // Only release the lease immediately if nothing was dispatched (error or no due pins).
    // If a pin was dispatched, the 20s debounce locked_until buffer protects against overlapping retries.
    if (leaseAcquired && dispatched === 0) {
      try {
        await admin.rpc('release_schedule_dispatch_lease', {
          p_schedule_id: scheduleId,
          p_workspace_id: workspaceId,
        });
      } catch (relErr: any) {
        console.warn('[Dispatch] release lease failed:', relErr?.message || relErr);
      }
    }
  }
}

export const GET: APIRoute = async () =>
  new Response(JSON.stringify({ success: false, error: 'Method Not Allowed. Use POST with JSON payload.' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  let body: any = {};
  try {
    body = JSON.parse((await request.text()) || '{}');
  } catch {
    return json({ success: false, error: 'Malformed JSON payload.' }, 400);
  }

  return handleDispatch(body, locals);
};
