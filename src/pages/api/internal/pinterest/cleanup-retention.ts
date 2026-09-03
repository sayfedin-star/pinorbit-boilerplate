export const prerender = false;

import type { APIRoute } from 'astro';
import { isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import * as webhookSecrets from '../../../../server/services/webhook-secrets';
import { runRetentionCleanup } from '../../../../server/services/retention-cleanup';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';

export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env || (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv || {};

  // 1. Extract and validate workspace_id from header or JSON body
  let workspaceId = request.headers.get('x-workspace-id')?.trim();

  const text = await request.text();
  if (text && text.trim().length > 0) {
    let body: Record<string, any>;
    try {
      body = JSON.parse(text);
    } catch (err: any) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Malformed JSON payload: ' + err.message,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (body && typeof body.workspace_id === 'string' && body.workspace_id.trim().length > 0) {
      workspaceId = body.workspace_id.trim();
    }
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'workspace_id is required in JSON body or x-workspace-id header.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 2. Authenticate
  const secret = request.headers.get('x-ingest-secret') || request.headers.get('x-dispatch-secret');
  const expected = webhookSecrets.getEffectiveSecret ? await webhookSecrets.getEffectiveSecret(workspaceId, runtimeEnv) : null;

  if (isProductionEnv(runtimeEnv) && expected?.source === 'env' && isKnownDefaultIngestSecret(expected.value)) {
    return new Response(JSON.stringify({ success: false, error: 'Service unavailable: ingest secret not configured on server.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  let authValid = false;
  try {
    if ('verifyIngestSecret' in webhookSecrets && typeof (webhookSecrets as any).verifyIngestSecret === 'function') {
      const verification = await (webhookSecrets as any).verifyIngestSecret(secret, workspaceId, runtimeEnv);
      authValid = Boolean(verification?.valid);
    }
  } catch (err: any) {
    console.warn('[CleanupRetention] verifyIngestSecret error:', err?.message || err);
  }
  if (!authValid && secret && expected?.value) {
    authValid = await timingSafeEqual(secret, expected.value);
  }

  if (!authValid) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized: invalid or missing x-ingest-secret.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 3. Dynamic Retention Cleanup & Orphan Sweep
  try {
    const payload = await runRetentionCleanup(workspaceId, runtimeEnv, { trigger: 'api' });
    return new Response(
      JSON.stringify(payload),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message || 'Retention cleanup failed.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
