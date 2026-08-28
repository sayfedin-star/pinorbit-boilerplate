export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret, verifyIngestSecret } from '../../../../server/services/webhook-secrets';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-Only Internal PinArchive Dispatch Endpoint.
 *
 * Triggered by FastCron via GET or POST to dispatch GitHub Actions pinarchive-refresh workflow.
 *
 * Security & RLS:
 * - Public self-auth via x-ingest-secret (workspace -> global -> env cascade) or ?secret= param.
 * - Strictly scoped to workspace_id (full UUID or 8-char prefix resolved via DB).
 * - Verifies workspace existence in Project 1.
 * - Never throws: always returns JSON 202, 400, 401, 403, 422, 502, 503.
 */
async function handlePinArchiveDispatch(
  request: Request,
  payload: Record<string, any>,
  locals: any
): Promise<Response> {
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    (typeof process !== 'undefined' ? process.env : {}) ||
    {};

  const url = new URL(request.url);

  // 1. Extract workspace_id (from payload or URL searchParams or name pattern)
  let rawWorkspaceId =
    payload.workspace_id ||
    url.searchParams.get('workspace_id') ||
    url.searchParams.get('ws') ||
    '';

  if (!rawWorkspaceId && typeof payload.name === 'string') {
    const match = payload.name.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?/i);
    if (match) rawWorkspaceId = match[0];
  }

  if (!rawWorkspaceId || typeof rawWorkspaceId !== 'string' || rawWorkspaceId.trim() === '') {
    return new Response(
      JSON.stringify({ success: false, error: 'Validation Error: workspace_id is required.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let workspaceId = rawWorkspaceId.trim();

  // If workspaceId is not a full UUID (e.g. 8-char prefix), resolve it from Project 1 DB
  if (!UUID_REGEX.test(workspaceId)) {
    try {
      const admin = dbClients.getSchedulingAdmin(runtimeEnv);
      const { data: wsMatch } = await admin
        .from('workspaces')
        .select('id')
        .ilike('id', `${workspaceId}%`)
        .limit(1)
        .maybeSingle();

      if (wsMatch?.id) {
        workspaceId = wsMatch.id;
      } else {
        return new Response(
          JSON.stringify({ success: false, error: 'Validation Error: valid workspace_id UUID is required.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'Validation Error: valid workspace_id UUID is required.' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // 2. Authenticate via verifyIngestSecret (candidate-set verification)
  try {
    const eff = await getEffectiveSecret(workspaceId, runtimeEnv);
    if (isProductionEnv(runtimeEnv) && eff.source === 'env' && isKnownDefaultIngestSecret(eff.value)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Service unavailable: ingest secret not configured on server.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const providedSecret =
      request.headers.get('x-ingest-secret') ||
      request.headers.get('x-dispatch-secret') ||
      (typeof payload.ingest_secret === 'string' ? payload.ingest_secret : null) ||
      (typeof payload.secret === 'string' ? payload.secret : null) ||
      url.searchParams.get('secret') ||
      url.searchParams.get('ingest_secret');

    // Candidate-set verification across all valid sources (workspace, workspace:prev, global, global:prev, env)
    const verification = await verifyIngestSecret(providedSecret, workspaceId, runtimeEnv);

    if (!verification.valid) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Unauthorized: missing or invalid x-ingest-secret header.',
          debug: {
            header_present: Boolean(providedSecret),
            secret_length: providedSecret?.length || 0,
          },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Authentication evaluation failed.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 3. Verify workspace existence in Project 1 (Scheduling / Auth Authority)
  try {
    const admin = dbClients.getSchedulingAdmin(runtimeEnv);
    const { data: ws, error: wsErr } = await admin
      .from('workspaces')
      .select('id')
      .eq('id', workspaceId)
      .maybeSingle();

    if (wsErr || !ws) {
      return new Response(
        JSON.stringify({ success: false, error: 'Workspace not found or unauthorized.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Workspace verification failed.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 4. Forward to GitHub Actions workflow_dispatch
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
    return new Response(
      JSON.stringify({ success: false, error: 'GitHub dispatch token not configured on server.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const dispatchUrl = `https://api.github.com/repos/${githubRepo}/actions/workflows/pinarchive-refresh.yml/dispatches`;
  const forceValue =
    payload.force === 'true' || payload.force === true || url.searchParams.get('force') === 'true'
      ? 'true'
      : '';

  try {
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
          workspace_id: workspaceId,
          force: forceValue,
        },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (ghRes.status === 204 || (ghRes.status >= 200 && ghRes.status < 300)) {
      try {
        const pinArchive = dbClients.getPinArchive(runtimeEnv);
        await pinArchive
          .from('pa_workspace_settings')
          .update({ updated_at: new Date().toISOString() })
          .eq('workspace_id', workspaceId);
      } catch (dbErr) {
        console.warn('[PinArchive Dispatch] Non-blocking DB touch failed:', dbErr);
      }

      return new Response(
        JSON.stringify({
          success: true,
          dispatched: true,
          workspace_id: workspaceId,
          force: forceValue === 'true',
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (ghRes.status === 401 || ghRes.status === 403) {
      console.error(`[PinArchive Dispatch] GitHub authorization failure: HTTP ${ghRes.status}`);
      return new Response(
        JSON.stringify({ success: false, error: 'GitHub dispatch authorization failed.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.error(`[PinArchive Dispatch] GitHub dispatch returned HTTP ${ghRes.status}`);
    return new Response(
      JSON.stringify({ success: false, error: `GitHub dispatch upstream returned HTTP ${ghRes.status}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[PinArchive Dispatch] Network error or timeout contacting GitHub Actions API:', err?.message);
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Failed to communicate with GitHub Actions API.' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── GET & POST Handlers ───────────────────────────────────────────────────────
export const GET: APIRoute = async ({ request, locals }) => {
  return handlePinArchiveDispatch(request, {}, locals);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const hasQueryParams = Boolean(url.searchParams.get('workspace_id') || url.searchParams.get('ws'));

  let text = '';
  try {
    text = await request.text();
  } catch {
    text = '';
  }

  if (!text || text.trim().length === 0) {
    if (!hasQueryParams) {
      return new Response(
        JSON.stringify({ success: false, error: 'Empty request payload.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  let payload: Record<string, any> = {};
  if (text && text.trim().length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!hasQueryParams) {
        return new Response(
          JSON.stringify({ success: false, error: 'Malformed JSON payload.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
  }

  return handlePinArchiveDispatch(request, payload, locals);
};
