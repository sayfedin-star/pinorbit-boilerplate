export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { gasCall } from '../../../server/lib/gas-bridge';
import { errorStatus } from '../../../server/lib/http-error';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,30}$/;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  if (!user || !schedulingClient) {
    return json({ success: false, error: 'Unauthorized: missing session' }, 401);
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text && text.trim().length > 0) {
      body = JSON.parse(text);
    }
  } catch {
    return json({ success: false, error: 'Malformed JSON payload.' }, 400);
  }

  const workspaceId = body.workspace_id || locals.activeWorkspaceId;
  if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }

  const action = String(body.action || '').trim().toLowerCase();
  const ALLOWED_ACTIONS = ['run_now', 'sync_now', 'pause', 'resume', 'set_interval', 'status'];
  if (!ALLOWED_ACTIONS.includes(action)) {
    return json({ success: false, error: `Invalid action: must be one of ${ALLOWED_ACTIONS.join(', ')}` }, 422);
  }

  try {
    const wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'member');
    const db = dbClients.getPinArchive(locals.runtime?.env);

    // Status action: workspace-level status request
    if (action === 'status') {
      const gasRes = await gasCall(locals.runtime?.env, wsCtx.workspaceId, 'status', {});
      return json({
        success: true,
        ok: gasRes.ok,
        accounts: gasRes.accounts || [],
        error: gasRes.error,
      });
    }

    // Account-specific actions
    const rawUsernames: any[] = Array.isArray(body.usernames) ? body.usernames : [body.username].filter(Boolean);
    const usernames = rawUsernames
      .map((u) => String(u).trim().toLowerCase())
      .filter((u) => USERNAME_REGEX.test(u))
      .slice(0, 20);

    if (usernames.length === 0) {
      return json({ success: false, error: 'At least one valid username is required.' }, 422);
    }

    // Verify all requested usernames exist in this workspace's pa_accounts
    const { data: dbAccounts, error: accErr } = await db
      .from('pa_accounts')
      .select('id, username, status, interval_days')
      .eq('workspace_id', wsCtx.workspaceId)
      .in('username', usernames);

    if (accErr) {
      return json({ success: false, error: `Database error verifying accounts: ${accErr.message}` }, 500);
    }

    const verifiedUsernames = new Set((dbAccounts || []).map((a: any) => a.username.toLowerCase()));
    const unverified = usernames.filter((u) => !verifiedUsernames.has(u));
    if (unverified.length > 0) {
      return json({
        success: false,
        error: `Accounts not found in workspace: ${unverified.join(', ')}`,
      }, 404);
    }

    const results: Array<{ username: string; ok: boolean; error?: string; summary?: any }> = [];
    const days = Number(body.days) || 3;

    // Concurrency Policy:
    // run_now / sync_now -> SEQUENTIAL with 1500ms spacing (due to single GAS script lock)
    if (action === 'run_now' || action === 'sync_now') {
      for (let i = 0; i < usernames.length; i++) {
        const u = usernames[i];
        if (i > 0) await sleep(1500);

        if (action === 'run_now') {
          const res = await gasCall(locals.runtime?.env, wsCtx.workspaceId, 'run', { username: u, force: true });
          results.push({ username: u, ok: res.ok, error: res.error, summary: res.summary });
        } else if (action === 'sync_now') {
          const res = await gasCall(locals.runtime?.env, wsCtx.workspaceId, 'sync', { username: u });
          results.push({ username: u, ok: res.ok, error: res.error, summary: res.summary });
        }
      }
    } else {
      // Parallel execution for pause, resume, set_interval (chunks of 5)
      const CHUNK_SIZE = 5;
      for (let i = 0; i < usernames.length; i += CHUNK_SIZE) {
        const chunk = usernames.slice(i, i + CHUNK_SIZE);
        const chunkPromises = chunk.map(async (u) => {
          let gasAction = action;
          let gasPayload: Record<string, any> = { username: u };

          if (action === 'pause') {
            gasAction = 'pause';
          } else if (action === 'resume') {
            gasAction = 'resume';
          } else if (action === 'set_interval') {
            gasAction = 'set_interval';
            gasPayload.days = days;
          }

          const res = await gasCall(locals.runtime?.env, wsCtx.workspaceId, gasAction, gasPayload);

          // Update local DB status if successful
          if (res.ok) {
            if (action === 'pause') {
              await db.from('pa_accounts').update({ status: 'paused' }).eq('workspace_id', wsCtx.workspaceId).eq('username', u);
            } else if (action === 'resume') {
              await db.from('pa_accounts').update({ status: 'active' }).eq('workspace_id', wsCtx.workspaceId).eq('username', u);
            } else if (action === 'set_interval') {
              await db.from('pa_accounts').update({ interval_days: days }).eq('workspace_id', wsCtx.workspaceId).eq('username', u);
            }
          }

          return { username: u, ok: res.ok, error: res.error, summary: res.summary };
        });

        const chunkResults = await Promise.all(chunkPromises);
        results.push(...chunkResults);
      }
    }

    return json({
      success: true,
      action,
      results,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, errorStatus(e));
  }
};
