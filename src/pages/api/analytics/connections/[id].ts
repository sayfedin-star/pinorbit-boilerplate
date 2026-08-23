export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { analyticsDb } from '../../../../server/db/analytics';
import { fastcronService } from '../../../../server/services/fastcron-service';

function sanitizeConnection(conn: any) {
  if (!conn || typeof conn !== 'object') return conn;
  const copy = { ...conn };
  delete copy.fastcron_token;
  delete copy.analytics_fastcron_token;
  delete copy.top_pins_fastcron_token;
  return copy;
}

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const connectionId = params.id;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: authentication required.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ success: false, error: 'Active workspace not found in session.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!connectionId) {
    return new Response(
      JSON.stringify({ success: false, error: 'connection ID parameter is required.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid JSON body.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const access = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    if (!access.isAdmin && !access.isOwner) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Forbidden: Admin or Owner role required to modify connections.',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Verify connection exists and belongs to this workspace
    const existing = await analyticsDb.getWorkspaceConnection(workspaceId, connectionId);
    if (!existing) {
      return new Response(
        JSON.stringify({ success: false, error: 'Connection not found in this workspace.' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const updates: any = {};
    const displayName = body.display_name !== undefined ? body.display_name : body.account_name;
    if (displayName !== undefined) {
      updates.display_name = displayName;
    }
    if (body.analytics_enabled !== undefined) {
      const nextEnabled = Boolean(body.analytics_enabled);
      updates.analytics_enabled = nextEnabled;

      // Safe lifecycle: Enable / Disable FastCron jobs accordingly
      if (nextEnabled !== existing.analytics_enabled) {
        if (nextEnabled) {
          if (existing.analytics_fastcron_job_id) {
            await fastcronService.enableFastCronJob(
              workspaceId,
              existing.analytics_fastcron_job_id,
              runtimeEnv
            );
          }
          if (existing.top_pins_fastcron_job_id) {
            await fastcronService.enableFastCronJob(
              workspaceId,
              existing.top_pins_fastcron_job_id,
              runtimeEnv
            );
          }
        } else {
          if (existing.analytics_fastcron_job_id) {
            await fastcronService.disableFastCronJob(
              workspaceId,
              existing.analytics_fastcron_job_id,
              runtimeEnv
            );
          }
          if (existing.top_pins_fastcron_job_id) {
            await fastcronService.disableFastCronJob(
              workspaceId,
              existing.top_pins_fastcron_job_id,
              runtimeEnv
            );
          }
        }
      }
    }

    const updated = await analyticsDb.updateWorkspaceConnection(
      workspaceId,
      connectionId,
      updates
    );

    const sanitized = sanitizeConnection(updated);
    return new Response(
      JSON.stringify({
        success: true,
        account: sanitized, // backward compatibility
        connection: sanitized,
        message: 'Pinterest connection updated successfully.',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to update connection.' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const connectionId = params.id;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: authentication required.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ success: false, error: 'Active workspace not found in session.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!connectionId) {
    return new Response(
      JSON.stringify({ success: false, error: 'connection ID parameter is required.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const access = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    if (!access.isAdmin && !access.isOwner) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Forbidden: Admin or Owner role required to delete connections.',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Verify connection exists and belongs to this workspace
    const existing = await analyticsDb.getWorkspaceConnection(workspaceId, connectionId);
    if (!existing) {
      return new Response(
        JSON.stringify({ success: false, error: 'Connection not found in this workspace.' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Safe lifecycle 3a: soft-delete disables both FastCron jobs (cron_disable)
    if (existing.analytics_fastcron_job_id) {
      await fastcronService.disableFastCronJob(
        workspaceId,
        existing.analytics_fastcron_job_id,
        runtimeEnv
      );
    }
    if (existing.top_pins_fastcron_job_id) {
      await fastcronService.disableFastCronJob(
        workspaceId,
        existing.top_pins_fastcron_job_id,
        runtimeEnv
      );
    }

    // Soft delete in Project 3: sets analytics_enabled = false, deleted_at = now()
    await analyticsDb.softDeleteWorkspaceConnection(workspaceId, connectionId);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Connection successfully soft-deleted. Historical analytics are preserved.',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to delete connection.' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
