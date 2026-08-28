export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret, verifyIngestSecret } from '../../../../server/services/webhook-secrets';
import { SORT_MODES } from '../../../../server/services/fastcron-service';

/**
 * Server-Only Internal Daily Dispatch Endpoint (F1, X4, X5, X6).
 *
 * Invoked daily by FastCron jobs (or manual triggers) with x-ingest-secret (or x-dispatch-secret).
 * Computes concrete start_date/end_date server-side and forwards the complete
 * normalized payload directly to the configured Make.com channel webhook.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env || (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv || {};

  // 1. Parse JSON body
  let body: Record<string, any>;
  try {
    const text = await request.text();
    if (!text || text.trim().length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Empty request payload.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
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

  // 2. Validate body fields & Normalize channel to canonical (X5)
  if (!body || !body.connection_id) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Validation Error: connection_id is required in body.',
      }),
      {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!body.channel) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Validation Error: channel is required in body.',
      }),
      {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const rawChannel = String(body.channel).trim().toLowerCase();
  let canonicalChannel: 'account_analytics' | 'top_pins';
  if (rawChannel === 'account_analytics' || rawChannel === 'analytics') {
    canonicalChannel = 'account_analytics';
  } else if (rawChannel === 'top_pins') {
    canonicalChannel = 'top_pins';
  } else {
    return new Response(
      JSON.stringify({
        success: false,
        error: `Validation Error: Invalid channel "${body.channel}". Allowed: account_analytics, top_pins.`,
      }),
      {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 3. Authenticate pre-check against global/env secret before detailed queries
  const ingestSecret = request.headers.get('x-ingest-secret');
  const legacyDispatchSecret = request.headers.get('x-dispatch-secret');
  if (legacyDispatchSecret && !ingestSecret) {
    console.warn('[DailyDispatch] Deprecation warning: Header x-dispatch-secret is deprecated. Use x-ingest-secret instead.');
  }
  const providedSecret = ingestSecret || legacyDispatchSecret;

  if (!providedSecret) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Unauthorized: missing authentication header.',
      }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 4. Look up connection in Project 3 (deleted_at IS NULL)
  let connection: any = null;
  try {
    const analyticsClient = dbClients.getAnalytics(runtimeEnv);
    const { data, error } = await analyticsClient
      .from('analytics_connections')
      .select('*')
      .eq('id', body.connection_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (error || !data) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Connection "${body.connection_id}" not found or has been deleted.`,
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    connection = data;
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: `Database lookup error: ${err.message}`,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 5. Resolve expected secret via getEffectiveSecret for the connection's workspace
  const effectiveSecretResult = await getEffectiveSecret(
    connection.workspace_id,
    runtimeEnv
  );
  const expectedSecret = effectiveSecretResult?.value;

  if (isProductionEnv(runtimeEnv) && effectiveSecretResult?.source === 'env' && isKnownDefaultIngestSecret(expectedSecret)) {
    return new Response(JSON.stringify({ success: false, error: 'Service unavailable: ingest secret not configured on server.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  // 6. Timing-safe authentication across all candidates
  const verification = await verifyIngestSecret(providedSecret, connection.workspace_id, runtimeEnv);
  if (!verification.valid) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Unauthorized: invalid authentication header.',
      }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 7. Check if connection is disabled (bypassed if force=true)
  const force = body?.force === true || body?.force === 'true';
  if (!force && connection.analytics_enabled === false) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'connection_disabled',
      }),
      {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 8. Check webhook URL configured (X6)
  const isAnalytics = canonicalChannel === 'account_analytics';
  const targetWebhookUrl = isAnalytics
    ? connection.analytics_webhook_url
    : connection.top_pins_webhook_url;

  if (!targetWebhookUrl || typeof targetWebhookUrl !== 'string' || targetWebhookUrl.trim().length === 0) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'webhook_not_configured',
      }),
      {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // 8. Date Precedence & Server-Side Offset Computation (X4)
  let startDate: string;
  let endDate: string;

  const hasStartDate = body.start_date !== undefined && body.start_date !== null && String(body.start_date).trim() !== '';
  const hasEndDate = body.end_date !== undefined && body.end_date !== null && String(body.end_date).trim() !== '';

  if (hasStartDate || hasEndDate) {
    if (!hasStartDate || !hasEndDate) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Validation Error: Both start_date and end_date must be provided for manual override.',
        }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const sStr = String(body.start_date).trim();
    const eStr = String(body.end_date).trim();
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    if (!dateRegex.test(sStr) || !dateRegex.test(eStr) || isNaN(Date.parse(sStr)) || isNaN(Date.parse(eStr))) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Validation Error: start_date and end_date must follow YYYY-MM-DD format.',
        }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (sStr > eStr) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Validation Error: start_date must be before end_date (identical dates allowed for same-day pull).',
        }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    startDate = sStr;
    endDate = eStr;
  } else {
    // Offset-driven date resolution
    const startOffset = isAnalytics
      ? (connection.analytics_start_offset_days ?? 7)
      : (connection.top_pins_start_offset_days ?? 7);
    const endOffset = isAnalytics
      ? (connection.analytics_end_offset_days ?? 1)
      : (connection.top_pins_end_offset_days ?? 2);

    const now = new Date();
    const startObj = new Date(now.getTime() - startOffset * 24 * 60 * 60 * 1000);
    const endObj = new Date(now.getTime() - endOffset * 24 * 60 * 60 * 1000);
    startDate = startObj.toISOString().split('T')[0];
    endDate = endObj.toISOString().split('T')[0];
  }

  // 9. Build Forwarding Payload with Canonical Channel (X5)
  let forwardPayload: Record<string, any>;
  if (isAnalytics) {
    const startOffset = connection.analytics_start_offset_days ?? 7;
    const endOffset = connection.analytics_end_offset_days ?? 1;
    forwardPayload = {
      job_type: 'daily_sync',
      channel: 'account_analytics',
      connection_id: connection.id,
      start_date: startDate,
      end_date: endDate,
      analytics_start_offset_days: startOffset,
      analytics_end_offset_days: endOffset,
    };
  } else {
    const startOffset = connection.top_pins_start_offset_days ?? 7;
    const endOffset = connection.top_pins_end_offset_days ?? 2;
    const effectiveSortModes =
      connection.top_pins_sort_modes && connection.top_pins_sort_modes.length > 0
        ? connection.top_pins_sort_modes
        : SORT_MODES;
    const effectiveNumPins = connection.top_pins_num_of_pins || 50;

    forwardPayload = {
      job_type: 'daily_sync',
      channel: 'top_pins',
      connection_id: connection.id,
      start_date: startDate,
      end_date: endDate,
      top_pins_start_offset_days: startOffset,
      top_pins_end_offset_days: endOffset,
      num_of_pins: effectiveNumPins,
      sort_modes: effectiveSortModes,
    };
  }

  // 10. Forward to Target Channel Webhook with 8s Timeout
  try {
    const res = await fetch(targetWebhookUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forwardPayload),
      signal: AbortSignal.timeout(8000),
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Successfully dispatched ${canonicalChannel} payload to webhook.`,
        forwarded_payload: forwardPayload,
        webhook_status: res.status,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (fetchErr: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: `Webhook dispatch failed: ${fetchErr.message || 'Network error'}`,
        forwarded_payload: forwardPayload,
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
