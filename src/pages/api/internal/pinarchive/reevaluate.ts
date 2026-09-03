export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { validateUserSession } from '../../../../server/auth/session';
import { getEffectiveSecret, verifyIngestSecret } from '../../../../server/services/webhook-secrets';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';
import { promoteCandidates } from '../../../../server/services/promotion-service';
import { USERNAME_REGEX } from '../../../../lib/validation/pinterest';
import { dbClients } from '../../../../server/db/clients';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Server-Only Pin Re-evaluation & Promotion Endpoint (Dual Auth).
 *
 * POST /api/internal/pinarchive/reevaluate
 *
 * Dual Auth:
 *  1. x-ingest-secret header validated against workspace secret (for GitHub Actions pipeline / FastCron)
 *  2. Session user with admin/owner role on workspace (for UI dashboard "Re-evaluate Now" button)
 *
 * Actions:
 *  1. Reads active accounts for workspace
 *  2. Calls GAS PINARCHIVE_GAS_URL with { action: 'sheet_sync' } to re-evaluate Sheet rows against current filters
 *  3. Runs pa_promote_candidates DB RPC (promoteCandidates)
 *  4. Returns { success: true, sheet_synced, promoted, checked, workspace_id }
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
  let effectiveSecretValue = '';

  // Auth Method A: x-ingest-secret header
  const secretHeader = request.headers.get('x-ingest-secret');
  if (secretHeader) {
    try {
      const verification = await verifyIngestSecret(secretHeader, workspaceId, runtimeEnv);
      if (verification.valid) {
        authPassed = true;
        const eff = await getEffectiveSecret(workspaceId, runtimeEnv);
        if (eff?.value) effectiveSecretValue = eff.value;
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
        const eff = await getEffectiveSecret(workspaceId, runtimeEnv);
        if (eff?.value) effectiveSecretValue = eff.value;
      } catch {
        // Access denied or insufficient role
      }
    }
  }

  if (!authPassed) {
    return json({ success: false, error: 'Unauthorized: missing or invalid authentication credentials.' }, 401);
  }

  // 3. On-demand Sheet -> DB Sync (sheet_sync via GAS Writer)
  let sheetSynced = 0;
  let gasResult: any = null;

  try {
    const pinArchive = dbClients.getPinArchive(runtimeEnv);
    const { data: accounts } = await pinArchive
      .from('pa_accounts')
      .select('username')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active');

    let usernames: string[] = [];
    if (body?.usernames && Array.isArray(body.usernames)) {
      const parsed: string[] = [];
      for (const u of body.usernames) {
        if (typeof u === 'string') {
          const trimmed = u.trim().toLowerCase();
          if (USERNAME_REGEX.test(trimmed)) {
            parsed.push(trimmed);
          }
        }
      }
      usernames = Array.from(new Set<string>(parsed)).slice(0, 50);
    } else {
      usernames = (accounts || [])
        .map((a: any) => a.username)
        .filter((u: any) => typeof u === 'string' && USERNAME_REGEX.test(u))
        .slice(0, 50);
    }

    const gasUrl = (
      runtimeEnv.PINARCHIVE_GAS_URL ||
      runtimeEnv.PINARCHIVE_GAS_APP_URL ||
      process.env.PINARCHIVE_GAS_URL ||
      process.env.PINARCHIVE_GAS_APP_URL ||
      ''
    ).trim();

    const secretForGas = effectiveSecretValue || (runtimeEnv.PINARCHIVE_INGEST_SECRET || process.env.PINARCHIVE_INGEST_SECRET || '').trim();

    if (gasUrl && usernames.length > 0) {
      try {
        const gasRes = await fetch(gasUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-ingest-secret': secretForGas,
          },
          // Architectural Asymmetry Defense:
          // Inbound (GAS -> server) uses the x-ingest-secret header, but outbound (server -> GAS)
          // requires `secret` inside the JSON body because Google Apps Script Web Apps (doPost(e))
          // cannot access arbitrary incoming HTTP request headers and authenticates strictly via b.secret || b.payload.secret.
          body: JSON.stringify({
            action: 'sheet_sync',
            workspace_id: workspaceId,
            usernames: usernames,
            secret: secretForGas,
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (gasRes.ok) {
          gasResult = await gasRes.json().catch(() => ({}));
          if (gasResult?.ok && typeof gasResult.synced === 'number') {
            sheetSynced = gasResult.synced;
          }
        } else {
          const errText = await gasRes.text().catch(() => '');
          console.warn(`[Reevaluate] GAS sheet_sync HTTP ${gasRes.status}:`, errText);
        }
      } catch (gasErr: any) {
        console.warn('[Reevaluate] GAS sheet_sync call failed (non-blocking):', gasErr?.message);
      }
    }
  } catch (e: any) {
    console.warn('[Reevaluate] Accounts lookup failed (non-blocking):', e?.message);
  }

  // 4. Execute Candidate Promotion (DB-direct)
  try {
    const result = await promoteCandidates(workspaceId, runtimeEnv);

    if (result.error) {
      return json(
        {
          success: false,
          error: result.error,
          sheet_synced: sheetSynced,
          promoted: 0,
          checked: 0,
          workspace_id: workspaceId,
        },
        500
      );
    }

    return json({
      success: true,
      sheet_synced: sheetSynced,
      promoted: result.promoted,
      checked: result.checked,
      workspace_id: workspaceId,
    });
  } catch (err: any) {
    return json(
      {
        success: false,
        error: err?.message || 'Internal promotion failure',
        sheet_synced: sheetSynced,
        promoted: 0,
        checked: 0,
        workspace_id: workspaceId,
      },
      500
    );
  }
};
