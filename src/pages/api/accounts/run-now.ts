export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { timingSafeEqual } from '../../../server/lib/timing-safe';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized or missing workspace' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Malformed JSON payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const accountId = body.account_id;
  const force = body.force === true || body.force === 'true';

  if (!accountId) {
    return new Response(JSON.stringify({ success: false, error: 'account_id is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const admin = dbClients.getSchedulingAdmin(runtimeEnv);

    // Find active schedule for this account
    let query = admin
      .from('posting_schedules')
      .select('*')
      .eq('account_id', accountId)
      .eq('workspace_id', workspaceId);

    if (!force) {
      query = query.eq('status', 'active');
    }

    const { data: schedules } = await query.order('created_at', { ascending: true }).limit(1);

    if (!schedules || schedules.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'No posting schedule configured for this account. Create a schedule first.',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const schedule = schedules[0];
    const base = (typeof process !== 'undefined' && process.env.DISPATCH_BASE_URL)
      ? process.env.DISPATCH_BASE_URL.replace(/\/$/, '')
      : 'https://pinorbit-v2.o-i.workers.dev';

    const dispatchUrl = `${base}/api/internal/pinterest/dispatch-due-pin`;

    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        schedule_id: schedule.id,
        dispatch_token: schedule.dispatch_token,
        force,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const resJson = await res.json().catch(() => ({}));
    return new Response(
      JSON.stringify({
        success: res.ok && resJson.success !== false,
        dispatched: Boolean(resJson.dispatched),
        force,
        schedule_id: schedule.id,
        detail: resJson,
      }),
      { status: res.ok ? 200 : res.status || 500, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to dispatch run' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
