export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { validateUserSession } from '../../../../server/auth/session';
import * as webhookSecrets from '../../../../server/services/webhook-secrets';
import { isProductionEnv, isKnownDefaultIngestSecret } from '../../../../server/db/clients';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';
import { USERNAME_REGEX } from '../../../../lib/validation/pinterest';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Worker Refresh Relay Endpoint (Dual Auth)
 *
 * Dispatches GitHub Actions workflow for PinArchive refresh.
 * Dual Auth:
 *  1. x-ingest-secret header validated against workspace secret (for FastCron)
 *  2. Session user with admin role on workspace (for UI dashboard buttons)
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    {};

  // 1. Parse JSON body
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON request body.' }, 400);
  }

  // 2. Validate workspace_id
  const workspaceId = body?.workspace_id;
  if (!workspaceId || typeof workspaceId !== 'string' || !UUID_REGEX.test(workspaceId)) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }

  // Validate optional usernames / username
  let validatedUsernames: string[] = [];
  if (body?.usernames !== undefined && body?.usernames !== null) {
    const rawList = Array.isArray(body.usernames)
      ? body.usernames
      : typeof body.usernames === 'string'
        ? body.usernames.split(',')
        : [];

    const parsed: string[] = [];
    for (const u of rawList) {
      if (typeof u !== 'string') {
        return json({ success: false, error: 'usernames elements must be strings.' }, 400);
      }
      const trimmed = u.trim().toLowerCase();
      if (!USERNAME_REGEX.test(trimmed)) {
        return json({ success: false, error: `Invalid username format: ${u}` }, 400);
      }
      parsed.push(trimmed);
    }
    validatedUsernames = Array.from(new Set<string>(parsed)).slice(0, 50);
  }

  let username: string | undefined;
  if (body?.username !== undefined && body?.username !== null) {
    if (typeof body.username !== 'string') {
      return json({ success: false, error: 'username must be a string.' }, 400);
    }
    const trimmed = String(body.username).trim().toLowerCase();
    if (!USERNAME_REGEX.test(trimmed)) {
      return json({ success: false, error: 'Invalid username format.' }, 400);
    }
    username = trimmed;
  }

  // 3. DUAL AUTH
  let authPassed = false;

  // Auth Method A: x-ingest-secret header
  const secretHeader = request.headers.get('x-ingest-secret') || request.headers.get('x-dispatch-secret');
  if (secretHeader) {
    try {
      const eff = webhookSecrets.getEffectiveSecret ? await webhookSecrets.getEffectiveSecret(workspaceId, runtimeEnv) : null;
      if (isProductionEnv(runtimeEnv) && eff?.source === 'env' && isKnownDefaultIngestSecret(eff.value)) {
        return json({ success: false, error: 'Service unavailable: ingest secret not configured on server.' }, 503);
      }
      try {
        if ('verifyIngestSecret' in webhookSecrets && typeof (webhookSecrets as any).verifyIngestSecret === 'function') {
          const verification = await (webhookSecrets as any).verifyIngestSecret(secretHeader, workspaceId, runtimeEnv);
          if (verification?.valid) {
            authPassed = true;
          }
        }
      } catch (err: any) {
        console.warn('[PinArchiveRefresh] verifyIngestSecret error:', err?.message || err);
      }
      if (!authPassed && eff?.value) {
        if (await timingSafeEqual(secretHeader, eff.value)) {
          authPassed = true;
        }
      }
    } catch (err: any) {
      console.warn('[PinArchiveRefresh] Secret evaluation error:', err?.message || err);
    }
  }

  // Auth Method B: Session admin
  if (!authPassed) {
    let user = (locals as any)?.user;
    const schedulingClient = (locals as any)?.supabase;

    if (!user && schedulingClient) {
      const sessionState = await validateUserSession(schedulingClient);
      user = sessionState.user;
    }

    if (user && schedulingClient) {
      try {
        await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
        authPassed = true;
      } catch (err: any) {
        console.warn('[PinArchiveRefresh] Session admin check failed:', err?.message || err);
      }
    }
  }

  if (!authPassed) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  // 4. GitHub Relay
  const tok =
    runtimeEnv.GH_REFRESH_TOKEN ||
    runtimeEnv.GITHUB_DISPATCH_TOKEN ||
    (typeof process !== 'undefined' ? process.env.GH_REFRESH_TOKEN || process.env.GITHUB_DISPATCH_TOKEN : '');
  if (!tok || !String(tok).trim()) {
    return json({ success: false, error: 'refresh_not_configured' }, 503);
  }

  const githubRepo =
    (runtimeEnv.GITHUB_REPO as string) ||
    (typeof process !== 'undefined' ? process.env.GITHUB_REPO : '') ||
    'sayfedin-star/pinorbit-v2';

  const dispatchUrl = `https://api.github.com/repos/${githubRepo}/actions/workflows/pinarchive-pipeline.yml/dispatches`;
  const dispatchPayload = {
    ref: 'main',
    inputs: {
      workspace_id: workspaceId,
      usernames: validatedUsernames.length > 0 ? validatedUsernames.join(',') : (username || ''),
      mode: 'all',
    },
  };

  try {
    const ghRes = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${String(tok).trim()}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'pinorbit-worker',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dispatchPayload),
      signal: AbortSignal.timeout(10000),
    });

    if (ghRes.status === 204 || (ghRes.status >= 200 && ghRes.status < 300)) {
      const responseBody: Record<string, any> = {
        success: true,
        queued: true,
        queued_runs: 1,
        workspace_id: workspaceId,
      };
      if (validatedUsernames.length > 0) {
        responseBody.usernames = validatedUsernames;
        responseBody.accounts = validatedUsernames.length;
      } else if (username) {
        responseBody.username = username;
        responseBody.accounts = 1;
      }
      return json(responseBody, 202);
    }

    if (ghRes.status === 401 || ghRes.status === 403) {
      console.error(`[PinArchive Refresh Relay] GitHub authorization failure: HTTP ${ghRes.status}`);
      return json({ success: false, error: 'refresh_token_invalid' }, 503);
    }

    console.error(`[PinArchive Refresh Relay] GitHub dispatch returned HTTP ${ghRes.status}`);
    return json({ success: false, error: 'github_dispatch_failed' }, 502);
  } catch (err: any) {
    console.error('[PinArchive Refresh Relay] GitHub dispatch network error or timeout:', err?.message || 'Unknown network error');
    return json({ success: false, error: 'github_dispatch_failed' }, 502);
  }
};
