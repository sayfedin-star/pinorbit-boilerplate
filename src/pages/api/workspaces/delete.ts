export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { cleanupWorkspaceAnalytics } from '../../../server/services/workspace-cleanup';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try {
    body = JSON.parse((await request.text()) || '{}');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const workspaceId = body.workspace_id;
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'workspace_id required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Must be workspace owner to delete
    const access = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'owner');
    if (!access.isOwner) {
      return new Response(JSON.stringify({ error: 'Only workspace owners can delete workspaces' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check P1 tables
    const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
    const [accRes, boardRes, pinRes] = await Promise.all([
      p1Admin.from('accounts').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
      p1Admin.from('boards').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
      p1Admin.from('pins').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    ]);

    // Check P2 tables
    const p2Admin = dbClients.getCompetitorsAdmin(runtimeEnv);
    const [compRes, compBoardRes] = await Promise.all([
      p2Admin.from('competitors').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
      p2Admin.from('competitor_boards').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    ]);

    // Check P3 tables
    const p3Admin = dbClients.getAnalyticsAdmin(runtimeEnv);
    const connRes = await p3Admin
      .from('analytics_connections')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId);

    // Check P4 tables (PinArchive)
    let paAccCount = 0;
    let paPinCount = 0;
    let paRunCount = 0;
    try {
      const p4Admin = dbClients.getPinArchive(runtimeEnv);
      if (p4Admin && typeof p4Admin.from === 'function') {
        const [paAccRes, paPinRes, paRunRes] = await Promise.all([
          p4Admin.from('pa_accounts').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
          p4Admin.from('pa_pins').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
          p4Admin.from('pa_runs').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
        ]);
        paAccCount = paAccRes?.count || 0;
        paPinCount = paPinRes?.count || 0;
        paRunCount = paRunRes?.count || 0;
      }
    } catch {}

    const total = (accRes.count || 0) + (boardRes.count || 0) + (pinRes.count || 0) +
                  (compRes.count || 0) + (compBoardRes.count || 0) + (connRes.count || 0) +
                  paAccCount + paPinCount + paRunCount;

    if (total > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: `Workspace is not empty (${total} records across P1/P2/P3/P4). Delete all data first.`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Clean up cross-project settings, FastCron jobs, and KV secret overrides before deleting workspace
    try {
      const p4Admin = dbClients.getPinArchive(runtimeEnv);
      await Promise.allSettled([
        p4Admin?.from?.('pa_workspace_settings')?.delete?.()?.eq?.('workspace_id', workspaceId),
        p4Admin?.from?.('pa_runs')?.delete?.()?.eq?.('workspace_id', workspaceId),
        p3Admin?.from?.('workspace_analytics_settings')?.delete?.()?.eq?.('workspace_id', workspaceId),
        p1Admin?.from?.('workspace_retention_settings')?.delete?.()?.eq?.('workspace_id', workspaceId),
        cleanupWorkspaceAnalytics(workspaceId, runtimeEnv),
      ]);
    } catch {}

    // Delete workspace
    const { error } = await schedulingClient.from('workspaces').delete().eq('id', workspaceId);
    if (error) throw error;

    return new Response(JSON.stringify({ success: true, deleted: workspaceId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    const isAuth = err.message?.includes('Forbidden') || err.message?.includes('Unauthorized');
    return new Response(JSON.stringify({ error: err.message || 'Failed to delete workspace' }), {
      status: isAuth ? (err.status || 403) : (err.status || 500),
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
