export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { validateUserSession } from '../../../../server/auth/session';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,30}$/;

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
    (typeof process !== 'undefined' ? process.env : {}) ||
    {};

  // 1. Parse JSON body
  let body: any;
  try {
    const text = await request.text();
    if (!text || text.trim().length === 0) {
      return json({ success: false, error: 'Empty request payload.' }, 400);
    }
    body = JSON.parse(text);
  } catch {
    return json({ success: false, error: 'Malformed JSON payload.' }, 400);
  }

  // 2. Validate workspace_id (required UUID)
  const rawWorkspaceId = body?.workspace_id;
  if (!rawWorkspaceId || typeof rawWorkspaceId !== 'string' || !UUID_REGEX.test(rawWorkspaceId.trim())) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }
  const workspaceId = rawWorkspaceId.trim();

  // Validate optional username
  let username: string | undefined;
  if (body?.username !== undefined && body?.username !== null && String(body.username).trim() !== '') {
    const trimmed = String(body.username).trim();
    if (!USERNAME_REGEX.test(trimmed)) {
      return json({ success: false, error: 'Invalid username format.' }, 400);
    }
    username = trimmed;
  }

  // 3. DUAL AUTH
  let authPassed = false;

  // Auth Method A: x-ingest-secret header
  const secretHeader = request.headers.get('x-ingest-secret');
  if (secretHeader) {
    try {
      const eff = await getEffectiveSecret(workspaceId, runtimeEnv);
      if (eff?.value && (await timingSafeEqual(secretHeader, eff.value))) {
        authPassed = true;
      }
    } catch {
      // Secret evaluation failed
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
      } catch {
        // Access denied or insufficient role
      }
    }
  }

  if (!authPassed) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  // 4. GitHub Relay
  const tok = runtimeEnv.GH_REFRESH_TOKEN || (typeof process !== 'undefined' ? process.env.GH_REFRESH_TOKEN : '');
  if (!tok || !String(tok).trim()) {
    return json({ success: false, error: 'refresh_not_configured' }, 503);
  }

  const dispatchUrl = 'https://api.github.com/repos/sayfedin-star/pinorbit-v2/actions/workflows/pinarchive-refresh.yml/dispatches';
  const dispatchPayload = {
    ref: 'main',
    inputs: {
      workspace_id: workspaceId,
      username: username || '',
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
        workspace_id: workspaceId,
      };
      if (username) {
        responseBody.username = username;
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
