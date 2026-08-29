export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { validateUserSession } from '../../../../server/auth/session';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';
import { promoteCandidates } from '../../../../server/services/promotion-service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Server-Only Candidate Pin Re-evaluation & Promotion Endpoint (Dual Auth).
 *
 * POST /api/internal/pinarchive/reevaluate
 *
 * Dual Auth:
 *  1. x-ingest-secret header validated against workspace secret (for GitHub Actions pipeline / FastCron)
 *  2. Session user with admin/owner role on workspace (for UI dashboard "Re-evaluate Now" button)
 *
 * Body: { workspace_id: "uuid" } or Query Param ?workspace_id=...
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    (typeof process !== 'undefined' ? process.env : {}) ||
    {};

  // 1. Parse payload / URL search params
  let body: any = {};
  try {
    const text = await request.text();
    if (text && text.trim().length > 0) {
      body = JSON.parse(text);
    }
  } catch {
    return json({ success: false, error: 'Malformed JSON payload.' }, 400);
  }

  const url = new URL(request.url);
  const rawWorkspaceId = body?.workspace_id || url.searchParams.get('workspace_id');

  if (!rawWorkspaceId || typeof rawWorkspaceId !== 'string' || !UUID_REGEX.test(rawWorkspaceId.trim())) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }
  const workspaceId = rawWorkspaceId.trim();

  // 2. DUAL AUTH
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
    return json({ success: false, error: 'Unauthorized: missing or invalid authentication credentials.' }, 401);
  }

  // 3. Execute Candidate Promotion
  try {
    const result = await promoteCandidates(workspaceId, runtimeEnv);

    if (result.error) {
      return json(
        {
          success: false,
          error: result.error,
          promoted: 0,
          checked: 0,
          workspace_id: workspaceId,
        },
        500
      );
    }

    return json({
      success: true,
      promoted: result.promoted,
      checked: result.checked,
      workspace_id: workspaceId,
    });
  } catch (err: any) {
    return json(
      {
        success: false,
        error: err?.message || 'Internal promotion failure',
        promoted: 0,
        checked: 0,
        workspace_id: workspaceId,
      },
      500
    );
  }
};
