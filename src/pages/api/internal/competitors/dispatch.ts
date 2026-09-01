export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret, verifyIngestSecret } from '../../../../server/services/webhook-secrets';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-Only Internal Competitors Dispatch Endpoint.
 *
 * Triggered by FastCron / cron-job.org (or platform ops) via GET or POST to dispatch
 * GitHub Actions update-competitors workflow.
 *
 * Security & RLS:
 * - Public self-auth via x-ingest-secret (workspace -> global -> env cascade) or ?secret= param.
 * - Strictly scoped to workspace_id (full UUID or 8-char prefix resolved via DB).
 * - Verifies workspace existence in Project 1.
 * - Returns JSON 202 on success, or 400, 401, 403, 422, 502, 503.
 */
async function handleCompetitorsDispatch(
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

  if (!UUID_REGEX.test(workspaceId)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Validation Error: valid workspace_id UUID is required.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
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

  // 3. Verify workspace existence in Project 1
  let isMasterScope = false;
  try {
    const admin = dbClients.getSchedulingAdmin(runtimeEnv);
    const { data: ws, error: wsErr } = await admin
      .from('workspaces')
      .select('id, is_master')
      .eq('id', workspaceId)
      .maybeSingle();

    if (wsErr || !ws) {
      return new Response(
        JSON.stringify({ success: false, error: 'Workspace not found or unauthorized.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Master Scope is strictly restricted to DB-verified master workspaces
    const isMaster = Boolean(ws.is_master);
    isMasterScope = isMaster && payload.scope !== 'current' && url.searchParams.get('scope') !== 'current';
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

  const dispatchUrl = `https://api.github.com/repos/${githubRepo}/actions/workflows/update-competitors.yml/dispatches`;

  const forceValue =
    payload.force === 'true' || payload.force === true || url.searchParams.get('force') === 'true'
      ? 'true'
      : '';
  const dryRunValue =
    payload.dry_run === 'true' || payload.dry_run === true || url.searchParams.get('dry_run') === 'true'
      ? 'true'
      : '';
  const targetScope =
    payload.target_scope ||
    url.searchParams.get('target_scope') ||
    (payload.competitor_ids || url.searchParams.get('competitor_ids') ? 'Selected' : 'All Active');

  const rawCompIds = payload.competitor_ids || url.searchParams.get('competitor_ids');
  const competitorIds = Array.isArray(rawCompIds)
    ? rawCompIds.join(',')
    : (typeof rawCompIds === 'string' ? rawCompIds : '');
  const targetUsername =
    typeof payload.target_username === 'string'
      ? payload.target_username
      : url.searchParams.get('target_username') || '';

  const validTriggers = ['cron', 'manual', 'run_now', 'full'];
  const rawTrigger = typeof payload.trigger === 'string' ? payload.trigger.trim().toLowerCase() : (url.searchParams.get('trigger')?.trim().toLowerCase() || 'cron');
  const resolvedTrigger = validTriggers.includes(rawTrigger) ? rawTrigger : 'cron';

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
          workspace_id: isMasterScope ? '' : workspaceId,
          target_scope: targetScope,
          competitor_ids: competitorIds,
          target_username: targetUsername,
          dry_run: dryRunValue,
          force_run: forceValue,
          trigger: resolvedTrigger,
          run_trigger: resolvedTrigger,
        },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (ghRes.status === 204 || (ghRes.status >= 200 && ghRes.status < 300)) {
      return new Response(
        JSON.stringify({
          success: true,
          dispatched: true,
          workspace_id: isMasterScope ? 'all' : workspaceId,
          is_master_scope: isMasterScope,
          target_scope: targetScope,
          competitor_ids: competitorIds || undefined,
          trigger: resolvedTrigger,
          force: forceValue === 'true',
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (ghRes.status === 401 || ghRes.status === 403) {
      console.error(`[Competitors Dispatch] GitHub authorization failure: HTTP ${ghRes.status}`);
      return new Response(
        JSON.stringify({ success: false, error: 'GitHub dispatch authorization failed.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: `GitHub dispatch upstream returned HTTP ${ghRes.status}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[Competitors Dispatch] Network error or timeout contacting GitHub Actions API:', err?.message);
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Failed to communicate with GitHub Actions API.' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── GET & POST Handlers ───────────────────────────────────────────────────────
export const GET: APIRoute = async ({ request, locals }) => {
  return handleCompetitorsDispatch(request, {}, locals);
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

  return handleCompetitorsDispatch(request, payload, locals);
};
