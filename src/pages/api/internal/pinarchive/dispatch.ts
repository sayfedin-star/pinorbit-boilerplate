export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';
import { gasCall } from '../../../../server/lib/gas-bridge';

/**
 * Server-Only Internal PinArchive Dispatch Endpoint (FastCron Target).
 *
 * Triggers GAS scraping/sync execution for active accounts in the specified workspace.
 *
 * Architecture Law:
 * - PinOrbit never reads or writes Google Sheets directly.
 * - This endpoint invokes the GAS Web App bridge via `gasCall`.
 *
 * Security:
 * - Scoped strictly to workspace_id.
 * - Authenticates via x-ingest-secret using the getEffectiveSecret cascade and timingSafeEqual.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    {};

  // 1. Parse optional JSON body
  let body: Record<string, any> = {};
  try {
    const text = await request.text();
    if (text && text.trim().length > 0) {
      body = JSON.parse(text);
    }
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: 'Malformed JSON payload.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2. Validate workspace_id (from body or query param)
  const url = new URL(request.url);
  const rawWsId = body.workspace_id || url.searchParams.get('workspace_id');
  if (!rawWsId || typeof rawWsId !== 'string' || rawWsId.trim().length === 0) {
    return new Response(
      JSON.stringify({ success: false, error: 'Validation Error: workspace_id is required.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const workspaceId = rawWsId.trim();

  // 3. Authenticate via getEffectiveSecret + timingSafeEqual FIRST
  const eff = await getEffectiveSecret(workspaceId, runtimeEnv);
  if (isProductionEnv(runtimeEnv) && eff.source === 'env' && isKnownDefaultIngestSecret(eff.value)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Service unavailable: ingest secret not configured on server.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const providedSecret =
    request.headers.get('x-ingest-secret') ||
    (typeof body.ingest_secret === 'string' ? body.ingest_secret : null);

  if (!providedSecret || !eff.value || !(await timingSafeEqual(providedSecret, eff.value))) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid x-ingest-secret header.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 4. Verify workspace existence in Project 1 (Scheduling / Auth Authority)
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
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: 'Workspace verification failed.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 5. Query active accounts in Project 4 (PinArchive)
  try {
    const pinArchive = dbClients.getPinArchive(runtimeEnv);
    const targetUsername =
      (typeof body.username === 'string' && body.username.trim().length > 0 ? body.username.trim() : null) ||
      url.searchParams.get('username') ||
      null;

    let usernamesToDispatch: string[] = [];

    if (targetUsername) {
      usernamesToDispatch = [targetUsername];
    } else {
      const { data: accounts, error: accErr } = await pinArchive
        .from('pa_accounts')
        .select('username, status')
        .eq('workspace_id', workspaceId)
        .eq('status', 'active');

      if (accErr) {
        return new Response(
          JSON.stringify({ success: false, error: `Failed to query accounts: ${accErr.message}` }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      usernamesToDispatch = (accounts || []).map((a: any) => a.username).filter(Boolean);
    }

    // 6. Dispatch to GAS bridge for each account
    const dispatched: Array<{ username: string; ok: boolean; error?: string }> = [];
    const CHUNK_SIZE = 5;

    for (let i = 0; i < usernamesToDispatch.length; i += CHUNK_SIZE) {
      const chunk = usernamesToDispatch.slice(i, i + CHUNK_SIZE);
      const chunkResults = await Promise.all(
        chunk.map(async (username) => {
          const callRes = await gasCall(runtimeEnv, workspaceId, 'run', { username });
          return { username, ok: Boolean(callRes.ok), error: callRes.error || undefined };
        })
      );
      dispatched.push(...chunkResults);
    }

    return new Response(
      JSON.stringify({
        success: true,
        dispatched,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: `Dispatch failed: ${err.message || 'Unknown'}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
