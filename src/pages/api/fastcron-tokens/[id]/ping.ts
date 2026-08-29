export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { dbClients, isKnownDefaultKek, isProductionEnv } from '../../../../server/db/clients';
import { decryptToken, resolveTokenKek } from '../../../../server/lib/token-crypto';
import { fastcronService } from '../../../../server/services/fastcron-service';

export const POST: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const { id } = params;

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ healthy: false, error: 'Unauthorized or missing workspace' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!id) {
    return new Response(JSON.stringify({ healthy: false, error: 'Token ID is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);

    const { data: tokenRow, error: dbErr } = await adminClient
      .from('fastcron_tokens')
      .select('id, workspace_id, token_encrypted')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (dbErr || !tokenRow) {
      return new Response(JSON.stringify({ healthy: false, error: 'Token not found in active workspace' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const kek = await resolveTokenKek(runtimeEnv);
    if (!kek || (isProductionEnv(runtimeEnv) && isKnownDefaultKek(kek))) {
      return new Response(JSON.stringify({ healthy: false, error: 'Token encryption key (KEK) unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const rawToken = await decryptToken(tokenRow.token_encrypted, kek);
    if (!rawToken || rawToken.trim().length < 16) {
      return new Response(JSON.stringify({ healthy: false, error: 'Failed to decrypt FastCron token' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Ping FastCron API with cron_account action (lightweight validation without altering or creating jobs)
    const pingResult = await fastcronService.fastcronCall('cron_account', {}, rawToken.trim());
    if (!pingResult.success) {
      // Fallback attempt with cron_list
      const listResult = await fastcronService.fastcronCall('cron_list', {}, rawToken.trim());
      if (!listResult.success) {
        return new Response(
          JSON.stringify({ healthy: false, error: pingResult.error || listResult.error || 'FastCron token validation failed' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(JSON.stringify({ healthy: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ healthy: false, error: err.message || 'Token ping failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
