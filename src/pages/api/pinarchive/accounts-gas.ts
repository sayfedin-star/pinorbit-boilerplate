export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { promoteCandidates } from '../../../server/services/promotion-service';
import { errorStatus } from '../../../server/lib/http-error';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,30}$/;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

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
    const runtimeEnv =
      (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
      (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
      (typeof process !== 'undefined' ? process.env : {}) ||
      {};
    const db = dbClients.getPinArchive(runtimeEnv);

    // Status action: workspace-level status request (DB-direct)
    if (action === 'status') {
      const { data: accounts, error: accErr } = await db
        .from('pa_accounts')
        .select('id, username, status, follower_count, pins_count, last_run_at, next_run_at, interval_days, backfill_status, backfill_cursor, last_result, ingest_enabled')
        .eq('workspace_id', wsCtx.workspaceId)
        .order('username', { ascending: true });

      const { data: settings } = await db
        .from('pa_workspace_settings')
        .select('*')
        .eq('workspace_id', wsCtx.workspaceId)
        .maybeSingle();

      return json({
        success: true,
        ok: !accErr,
        accounts: accounts || [],
        settings: settings || null,
        error: accErr?.message,
      });
    }

    // Account-specific actions
    const rawUsernames: any[] = Array.isArray(body.usernames) ? body.usernames : [body.username].filter(Boolean);
    const usernames = rawUsernames
      .map((u) => String(u).trim().toLowerCase())
      .filter((u) => USERNAME_REGEX.test(u))
      .slice(0, 50);

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

    if (action === 'run_now') {
      const githubRepo =
        (runtimeEnv.GITHUB_REPO as string) ||
        (typeof process !== 'undefined' ? process.env.GITHUB_REPO : '') ||
        'sayfedin-star/PinOrbit-v2';

      const dispatchToken =
        (runtimeEnv.GITHUB_DISPATCH_TOKEN as string) ||
        (runtimeEnv.GH_REFRESH_TOKEN as string) ||
        (typeof process !== 'undefined' ? process.env.GITHUB_DISPATCH_TOKEN || process.env.GH_REFRESH_TOKEN : '') ||
        '';

      if (!dispatchToken || !dispatchToken.trim()) {
        return json({ success: false, error: 'GitHub dispatch token not configured on server.' }, 503);
      }

      let maxPagesInput = body.max_pages ? String(body.max_pages) : '';
      if (!maxPagesInput) {
        const { data: wsSetting } = await db
          .from('pa_workspace_settings')
          .select('discovery_max_pages')
          .eq('workspace_id', wsCtx.workspaceId)
          .maybeSingle();
        if (wsSetting?.discovery_max_pages) {
          maxPagesInput = String(wsSetting.discovery_max_pages);
        }
      }

      const dispatchUrl = `https://api.github.com/repos/${githubRepo}/actions/workflows/pinarchive-pipeline.yml/dispatches`;
      const ghRes = await fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${dispatchToken.trim()}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'PinOrbit-v2',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            workspace_id: wsCtx.workspaceId,
            usernames: usernames.join(','),
            mode: 'all',
            force: 'true',
            max_pages: maxPagesInput,
          },
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (ghRes.status === 204 || (ghRes.status >= 200 && ghRes.status < 300)) {
        for (const u of usernames) {
          results.push({ username: u, ok: true, summary: { queued: true } });
        }
      } else {
        const ghErrText = await ghRes.text().catch(() => '');
        for (const u of usernames) {
          results.push({ username: u, ok: false, error: `GitHub dispatch failed (HTTP ${ghRes.status}): ${ghErrText}` });
        }
      }
    } else if (action === 'sync_now') {
      const promRes = await promoteCandidates(wsCtx.workspaceId, runtimeEnv);
      for (const u of usernames) {
        results.push({
          username: u,
          ok: !promRes.error,
          error: promRes.error,
          summary: { promoted: promRes.promoted, checked: promRes.checked },
        });
      }
    } else if (action === 'pause') {
      await db
        .from('pa_accounts')
        .update({ status: 'paused' })
        .eq('workspace_id', wsCtx.workspaceId)
        .in('username', usernames);

      for (const u of usernames) {
        results.push({ username: u, ok: true });
      }
    } else if (action === 'resume') {
      await db
        .from('pa_accounts')
        .update({ status: 'active' })
        .eq('workspace_id', wsCtx.workspaceId)
        .in('username', usernames);

      for (const u of usernames) {
        results.push({ username: u, ok: true });
      }
    } else if (action === 'set_interval') {
      await db
        .from('pa_accounts')
        .update({ interval_days: days })
        .eq('workspace_id', wsCtx.workspaceId)
        .in('username', usernames);

      for (const u of usernames) {
        results.push({ username: u, ok: true });
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
