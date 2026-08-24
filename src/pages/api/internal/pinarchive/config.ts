export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-Only Internal PinArchive Config Endpoint for GAS Collector.
 *
 * GET /api/internal/pinarchive/config?workspace_id=...
 *
 * Header: x-ingest-secret: <PINARCHIVE_SECRET>
 *
 * Fail-Lazy: Returns 200 with fallback {0,0,0} on any DB error so GAS collector
 * always receives a valid payload and never crashes.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    {};

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id')?.trim();

  if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Validation Error: valid workspace_id is required.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 1. Auth First
  const eff = await getEffectiveSecret(workspaceId, runtimeEnv);
  if (isProductionEnv(runtimeEnv) && eff.source === 'env' && isKnownDefaultIngestSecret(eff.value)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Service unavailable: ingest secret not configured on server.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const providedSecret = request.headers.get('x-ingest-secret');
  if (!providedSecret || !eff.value || !(await timingSafeEqual(providedSecret, eff.value))) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid x-ingest-secret header.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2. Load settings (fail-lazy)
  try {
    const pinArchive = dbClients.getPinArchive(runtimeEnv);
    const { data: settings, error } = await pinArchive
      .from('pa_workspace_settings')
      .select('pin_filter_min_saves, pin_filter_min_repins, pin_filter_max_age_days')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (error || !settings) {
      return new Response(
        JSON.stringify({
          success: true,
          pin_filter_min_saves: 0,
          pin_filter_min_repins: 0,
          pin_filter_max_age_days: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        pin_filter_min_saves: Number(settings.pin_filter_min_saves || 0),
        pin_filter_min_repins: Number(settings.pin_filter_min_repins || 0),
        pin_filter_max_age_days: Number(settings.pin_filter_max_age_days || 0),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch {
    // Fail-lazy fallback
    return new Response(
      JSON.stringify({
        success: true,
        pin_filter_min_saves: 0,
        pin_filter_min_repins: 0,
        pin_filter_max_age_days: 0,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
