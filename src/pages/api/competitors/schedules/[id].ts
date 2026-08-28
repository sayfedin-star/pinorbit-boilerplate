export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { dbClients } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { fastcronCall } from '../../../../server/lib/fastcron-client';
import { resolveToken } from '../../../../server/lib/token-resolver';
import { validateCronExpression, getDispatchEndpointUrl } from './index';

// ── PATCH: Update Schedule ────────────────────────────────────────────────────
export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const id = params.id;

  if (!user || !schedulingClient || !workspaceId || !id) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized or missing ID' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Invalid JSON payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);

    // 1. Fetch current schedule (support UUID or numeric fastcron_job_id)
    let query = compAdmin.from('competitor_schedules').select('*').eq('workspace_id', workspaceId);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      query = query.eq('id', id);
    } else {
      query = query.eq('fastcron_job_id', id);
    }
    const { data: schedule, error: fetchErr } = await query.maybeSingle();

    if (fetchErr || !schedule) {
      return new Response(JSON.stringify({ success: false, error: 'Schedule not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const updatePayload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (body.label !== undefined) updatePayload.label = String(body.label).trim();
    if (body.timezone !== undefined) updatePayload.timezone = String(body.timezone).trim();
    if (body.fastcron_token_id !== undefined) updatePayload.fastcron_token_id = body.fastcron_token_id || null;
    if (body.token_id !== undefined) updatePayload.fastcron_token_id = body.token_id || null;

    if (body.cron_expression !== undefined) {
      const v = validateCronExpression(body.cron_expression);
      if (!v.valid) {
        return new Response(JSON.stringify({ success: false, error: v.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      updatePayload.cron_expression = v.cron;
    }

    if (body.status !== undefined) {
      if (['active', 'paused', 'pending', 'error'].includes(body.status)) {
        updatePayload.status = body.status;
      }
    } else if (body.enabled !== undefined) {
      updatePayload.status = body.enabled ? 'active' : 'paused';
    }

    // 2. Sync FastCron API
    if (schedule.fastcron_job_id) {
      const targetTokenObj = await resolveToken(
        { workspaceId, tokenId: updatePayload.fastcron_token_id || schedule.fastcron_token_id },
        'competitors',
        runtimeEnv
      );

      if (targetTokenObj?.token) {
        const effSecret = await getEffectiveSecret(workspaceId, runtimeEnv);
        if (!effSecret || !effSecret.value || effSecret.value.trim() === '') {
          return new Response(
            JSON.stringify({ success: false, error: 'Ingest secret not configured for workspace.' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const dispatchUrl = getDispatchEndpointUrl(runtimeEnv, workspaceId, effSecret.value.trim());
        const isEnabled = updatePayload.status ? updatePayload.status === 'active' : schedule.status === 'active';
        const postDataStr = JSON.stringify({
          workspace_id: workspaceId,
          pipeline: 'competitors',
          label: updatePayload.label || schedule.label || 'Schedule',
        });

        const fastcronParams: Record<string, any> = {
          id: Number(schedule.fastcron_job_id),
          name: `PinOrbit competitors — ${updatePayload.label || schedule.label || 'Schedule'} — ${workspaceId.slice(0, 8)}`,
          url: dispatchUrl,
          expression: updatePayload.cron_expression || schedule.cron_expression,
          timezone: updatePayload.timezone || schedule.timezone || 'UTC',
          httpMethod: 'POST',
          http_method: 'POST',
          httpHeaders: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
          http_headers: `Content-Type: application/json\r\nx-ingest-secret: ${effSecret.value.trim()}`,
          postData: postDataStr,
          post_data: postDataStr,
          status: isEnabled ? 'enabled' : 'disabled',
        };

        const editRes = await fastcronCall('cron_edit', fastcronParams, targetTokenObj.token);
        if (!editRes.success) {
          return new Response(
            JSON.stringify({ success: false, error: editRes.error || 'Failed to update schedule in FastCron.' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    // 3. Update DB row
    const { data: updated, error: updateErr } = await compAdmin
      .from('competitor_schedules')
      .update(updatePayload)
      .eq('id', id)
      .select('*')
      .single();

    if (updateErr) throw updateErr;

    return new Response(
      JSON.stringify({ success: true, schedule: updated, message: 'Schedule updated successfully.' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to update schedule' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// ── DELETE: Delete Schedule ───────────────────────────────────────────────────
export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const id = params.id;

  if (!user || !schedulingClient || !workspaceId || !id) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized or missing ID' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const compAdmin = dbClients.getCompetitorsAdmin(runtimeEnv);

    // 1. Find schedule (support UUID or numeric fastcron_job_id)
    let query = compAdmin.from('competitor_schedules').select('*').eq('workspace_id', workspaceId);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      query = query.eq('id', id);
    } else {
      query = query.eq('fastcron_job_id', id);
    }
    const { data: schedule } = await query.maybeSingle();

    const targetJobId = schedule?.fastcron_job_id || (!isNaN(Number(id)) ? id : null);

    // 2. Best-effort FastCron delete
    if (targetJobId) {
      try {
        const targetTokenObj = await resolveToken(
          { workspaceId, tokenId: schedule?.fastcron_token_id },
          'competitors',
          runtimeEnv
        );
        if (targetTokenObj?.token) {
          await fastcronCall('cron_delete', { id: Number(targetJobId) }, targetTokenObj.token);
        }
      } catch (delErr) {
        console.warn(`[Competitors Schedule DELETE] Remote FastCron delete warning:`, delErr);
      }
    }

    // 3. Delete from DB if row exists
    if (schedule?.id) {
      await compAdmin
        .from('competitor_schedules')
        .delete()
        .eq('id', schedule.id)
        .eq('workspace_id', workspaceId);
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Schedule deleted successfully.' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to delete schedule' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
