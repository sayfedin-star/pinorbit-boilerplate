export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-Only Internal Competitors Dispatch Endpoint.
 *
 * Triggered by FastCron / cron-job.org (or platform ops) to dispatch
 * GitHub Actions update-competitors workflow.
 *
 * Security & RLS:
 * - Public self-auth via x-ingest-secret (workspace -> global -> env cascade).
 * - Strictly scoped to workspace_id.
 * - Verifies workspace existence in Project 1.
 * - Returns JSON 202 on success, or 400, 401, 403, 422, 502, 503.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    (typeof process !== 'undefined' ? process.env : {}) ||
    {};

  // 1. Parse JSON body
  let payload: any;
  try {
    const text = await request.text();
    if (!text || text.trim().length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Empty request payload.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    payload = JSON.parse(text);
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Malformed JSON payload.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2. Validate workspace_id
  if (!payload || !payload.workspace_id || typeof payload.workspace_id !== 'string' || payload.workspace_id.trim() === '') {
    return new Response(
      JSON.stringify({ success: false, error: 'Validation Error: workspace_id is required in payload.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const workspaceId = payload.workspace_id.trim();
  if (!UUID_REGEX.test(workspaceId)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Validation Error: valid workspace_id UUID is required.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 3. Authenticate via getEffectiveSecret + timingSafeEqual
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
      (typeof payload.ingest_secret === 'string' ? payload.ingest_secret : null);

    if (!providedSecret || !eff.value || !(await timingSafeEqual(providedSecret, eff.value))) {
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid x-ingest-secret header.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Authentication evaluation failed.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 4. Verify workspace existence in Project 1
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

  // 5. Forward to GitHub Actions workflow_dispatch
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

  const forceValue = payload.force === 'true' || payload.force === true ? 'true' : '';
  const dryRunValue = payload.dry_run === 'true' || payload.dry_run === true ? 'true' : '';
  const targetScope = payload.target_scope || (payload.competitor_ids ? 'Selected' : 'All Active');
  const competitorIds = Array.isArray(payload.competitor_ids)
    ? payload.competitor_ids.join(',')
    : (typeof payload.competitor_ids === 'string' ? payload.competitor_ids : '');
  const targetUsername = typeof payload.target_username === 'string' ? payload.target_username : '';

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
          target_scope: targetScope,
          competitor_ids: competitorIds,
          target_username: targetUsername,
          dry_run: dryRunValue,
          force_run: forceValue,
        },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (ghRes.status === 204 || (ghRes.status >= 200 && ghRes.status < 300)) {
      return new Response(
        JSON.stringify({
          success: true,
          dispatched: true,
          workspace_id: workspaceId,
          target_scope: targetScope,
          competitor_ids: competitorIds || undefined,
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
};
