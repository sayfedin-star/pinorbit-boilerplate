export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret, verifyIngestSecret } from '../../../../server/services/webhook-secrets';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-Only Internal PinArchive Config Endpoint for GAS Collector.
 *
 * GET /api/internal/pinarchive/config?workspace_id=...
 *
 * Header: x-ingest-secret: <PINARCHIVE_SECRET>
 *
 * Contract Split (P2-06 & Forensic Audit Follow-Up):
 * - Database Query Errors / Unhandled Exceptions: Returns HTTP 503 so external GAS collectors
 *   can detect temporary infrastructure failure and retry rather than executing with false zeroes.
 * - Absent Settings Row: Returns HTTP 200 with default fallback settings {0,0,14,34,0,3,true,false,true}
 *   when the settings row is legitimately unconfigured in the database.
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

  // 1. Auth First (Candidate-set verification)
  const eff = await getEffectiveSecret(workspaceId, runtimeEnv);
  if (isProductionEnv(runtimeEnv) && eff.source === 'env' && isKnownDefaultIngestSecret(eff.value)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Service unavailable: ingest secret not configured on server.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const providedSecret = request.headers.get('x-ingest-secret');
  const verification = await verifyIngestSecret(providedSecret, workspaceId, runtimeEnv);
  if (!verification.valid) {
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
      .select('pin_filter_min_saves, pin_filter_min_repins, pin_filter_rising_age_days, pin_filter_rising_saves, refresh_max_pins, discovery_stop_pages, audit_sweep_enabled, daily_sheet_sync_enabled, github_schedule_enabled')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (error) {
      console.warn('[PinArchive Config] Database error reading settings:', error.message);
      return new Response(
        JSON.stringify({
          success: false,
          error: `Database error reading settings: ${error.message}`,
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!settings) {
      return new Response(
        JSON.stringify({
          success: true,
          pin_filter_min_saves: 0,
          pin_filter_min_repins: 0,
          pin_filter_rising_age_days: 14,
          pin_filter_rising_saves: 34,
          refresh_max_pins: 0,
          discovery_stop_pages: 3,
          audit_sweep_enabled: true,
          daily_sheet_sync_enabled: false,
          github_schedule_enabled: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        pin_filter_min_saves: Number(settings.pin_filter_min_saves || 0),
        pin_filter_min_repins: Number(settings.pin_filter_min_repins || 0),
        pin_filter_rising_age_days: Number(settings.pin_filter_rising_age_days ?? 14),
        pin_filter_rising_saves: Number(settings.pin_filter_rising_saves ?? 34),
        refresh_max_pins: Number(settings.refresh_max_pins || 0),
        discovery_stop_pages: Number(settings.discovery_stop_pages ?? 3),
        audit_sweep_enabled: settings.audit_sweep_enabled ?? true,
        daily_sheet_sync_enabled: settings.daily_sheet_sync_enabled ?? false,
        github_schedule_enabled: settings.github_schedule_enabled ?? true,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.warn('[PinArchiveConfig] Exception in config endpoint, returning 503:', err?.message || err);
    return new Response(
      JSON.stringify({
        success: false,
        error: `Database service unavailable: ${err?.message || 'Unknown error'}`,
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
