export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';

/**
 * Server-Only Internal PinArchive Ingest Endpoint.
 *
 * Accepts batches of Pinterest account and pin data pushed from the GAS Web App.
 *
 * Route-header contract:
 * 409 ingest_disabled is TERMINAL — callers must NOT retry.
 *
 * Security & RLS:
 * - Scoped strictly to workspace_id.
 * - Authenticates via x-ingest-secret using the getEffectiveSecret cascade and timingSafeEqual.
 * - Project 1 validates workspace existence.
 * - Project 4 stores accounts, pins, pin metric snapshots, and run telemetry.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
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
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: 'Malformed JSON payload.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2. Validate workspace_id
  if (!payload || !payload.workspace_id || typeof payload.workspace_id !== 'string') {
    return new Response(
      JSON.stringify({ success: false, error: 'Validation Error: workspace_id is required in payload.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const workspaceId = payload.workspace_id.trim();

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
    (typeof payload.ingest_secret === 'string' ? payload.ingest_secret : null);

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

  // 5. Ingest into Project 4 (PinArchive)
  try {
    const pinArchive = dbClients.getPinArchive(runtimeEnv);

    // Gating 1: Load pa_workspace_settings (defaults when absent)
    const { data: wsSettings } = await pinArchive
      .from('pa_workspace_settings')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    const ingestEnabled = wsSettings?.ingest_enabled ?? true;
    const pausedAccountPolicy = wsSettings?.paused_account_policy ?? 'reject';
    const defaultIntervalDays = wsSettings?.default_interval_days ?? 3;
    const maxBatchPins = wsSettings?.max_batch_pins ?? 500;

    // Gating 2: Workspace disabled -> 409
    if (!ingestEnabled) {
      return new Response(
        JSON.stringify({ success: false, error: 'ingest_disabled', skipped: true }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const account_meta = payload.account_meta || {};
    const username = String(payload.username || account_meta.username || '').trim() || 'default';
    const fetchedAt = payload.fetched_at || new Date().toISOString();
    const rawPins: any[] = Array.isArray(payload.pins) ? payload.pins : [];

    // Gating 3: Fetch current pa_accounts row before upsert
    const { data: existingAccount } = await pinArchive
      .from('pa_accounts')
      .select('id, status, ingest_enabled, interval_days')
      .eq('workspace_id', workspaceId)
      .eq('username', username)
      .maybeSingle();

    // Account ingest_enabled = false -> write NOTHING
    if (existingAccount && existingAccount.ingest_enabled === false) {
      return new Response(
        JSON.stringify({ success: true, skipped: 'account_ingest_disabled' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Account status = 'paused' and policy = 'reject' -> write NOTHING
    if (existingAccount && existingAccount.status === 'paused' && pausedAccountPolicy === 'reject') {
      return new Response(
        JSON.stringify({ success: true, skipped: 'account_paused' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Gating 4: max_batch_pins truncation
    let pins = rawPins;
    let truncatedCount: number | undefined;
    if (rawPins.length > maxBatchPins) {
      truncatedCount = rawPins.length;
      pins = rawPins.slice(0, maxBatchPins);
    }

    const promotedCount = pins.filter((p: any) => Boolean(p.promoted)).length;

    // A) Upsert pa_accounts
    const accountData: Record<string, any> = {
      workspace_id: workspaceId,
      username,
      last_run_at: fetchedAt,
      last_result: account_meta.last_result || 'success',
    };
    if (typeof account_meta.pins_count === 'number' && Number.isFinite(account_meta.pins_count)) {
      accountData.pins_count = Math.max(0, Math.round(account_meta.pins_count));
    }
    if (typeof account_meta.promoted_count === 'number' && Number.isFinite(account_meta.promoted_count)) {
      accountData.promoted_count = Math.max(0, Math.round(account_meta.promoted_count));
    }
    if (typeof payload.follower_count === 'number') accountData.follower_count = payload.follower_count;
    if (typeof account_meta.follower_count === 'number') accountData.follower_count = account_meta.follower_count;
    if (account_meta.sheet_id) accountData.sheet_id = account_meta.sheet_id;

    if (typeof account_meta.interval_days === 'number') {
      accountData.interval_days = account_meta.interval_days;
    } else if (!existingAccount) {
      // Apply workspace default_interval_days on new accounts
      accountData.interval_days = defaultIntervalDays;
    }

    if (account_meta.status) accountData.status = account_meta.status;
    if (account_meta.backfill_status) accountData.backfill_status = account_meta.backfill_status;
    if (account_meta.backfill_cursor !== undefined) accountData.backfill_cursor = account_meta.backfill_cursor;
    if (account_meta.next_run_at) accountData.next_run_at = account_meta.next_run_at;

    const { data: accountRow, error: accErr } = await pinArchive
      .from('pa_accounts')
      .upsert(accountData, { onConflict: 'workspace_id,username' })
      .select('id, workspace_id, username')
      .single();

    if (accErr || !accountRow) {
      return new Response(
        JSON.stringify({ success: false, error: `Account upsert failed: ${accErr?.message || 'Unknown error'}` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const accountId = accountRow.id;
    const pinIds = pins.map((p: any) => String(p.pin_id || p.id || '')).filter(Boolean);

    let pinsAddedCount = 0;
    let pinsUpdatedCount = 0;

    if (pins.length > 0) {
      // Fetch existing pin metric state for comparison
      const { data: existingPins } = await pinArchive
        .from('pa_pins')
        .select('id, pin_id, saves, repins, comments, share_count, archived_at')
        .eq('workspace_id', workspaceId)
        .in('pin_id', pinIds);

      const existingMap = new Map<string, { id: string; saves: number; repins: number; comments: number; share_count: number; archived_at: string | null }>();
      if (Array.isArray(existingPins)) {
        for (const ep of existingPins) {
          existingMap.set(ep.pin_id, {
            id: ep.id,
            saves: Number(ep.saves || 0),
            repins: Number(ep.repins || 0),
            comments: Number(ep.comments || 0),
            share_count: Number(ep.share_count || 0),
            archived_at: ep.archived_at || null,
          });
        }
      }

      // B) Upsert pa_pins
      const pinsToUpsert = pins.map((p: any) => {
        const pinId = String(p.pin_id || p.id);
        const existing = existingMap.get(pinId) || null;
        const isNew = !existing;

        if (existing) {
          pinsUpdatedCount++;
        } else {
          pinsAddedCount++;
        }

        return {
          workspace_id: workspaceId,
          account_id: accountId,
          pin_id: pinId,
          node_id: p.node_id || null,
          title: p.title || null,
          description: p.description || null,
          link: p.link || null,
          utm_link: p.utm_link || null,
          domain: p.domain || null,
          board_id: p.board_id || null,
          board_name: p.board_name || null,
          created_at_pinterest: p.created_at_pinterest || p.created_at || null,
          image_url: p.image_url || null,
          image_signature: p.image_signature || null,
          dominant_color: p.dominant_color || null,
          is_video: Boolean(p.is_video),
          is_product: Boolean(p.is_product),
          price: p.price !== undefined ? p.price : null,
          currency: p.currency || null,
          site_name: p.site_name || null,
          saves: Number(p.saves || 0),
          repins: Number(p.repins || 0),
          comments: Number(p.comments || 0),
          reactions: typeof p.reactions === 'object' && p.reactions !== null ? p.reactions : {},
          velocity: Number(p.velocity || 0),
          promoted: Boolean(p.promoted),
          last_updated_at: fetchedAt,

          // Enrichment (all nullable)
          archived_at: p.archived_at || existing?.archived_at || (isNew ? fetchedAt : null),
          annotations: Array.isArray(p.annotations) ? p.annotations : [],
          seo_category: p.seo_category || null,
          canonical_pin_id: p.canonical_pin_id || null,
          seo_alt_text: p.seo_alt_text || null,
          share_count: Number(p.share_count || 0),
          board_pin_count: typeof p.board_pin_count === 'number' ? p.board_pin_count : null,
          board_last_modified_at: p.board_last_modified_at || null,
        };
      });

      const { data: upsertedPins, error: pinErr } = await pinArchive
        .from('pa_pins')
        .upsert(pinsToUpsert, { onConflict: 'workspace_id,pin_id' })
        .select('id, pin_id, saves, repins, comments, share_count, reactions');

      if (pinErr) {
        return new Response(
          JSON.stringify({ success: false, error: `Pins upsert failed: ${pinErr.message}` }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // C) Insert pa_pin_metrics snapshot ONLY when saves, repins, or share_count differ from stored row
      const metricsToInsert: Array<{
        workspace_id: string;
        pin_ref: string;
        recorded_at: string;
        saves: number;
        repins: number;
        comments: number;
        shares: number;
        reactions_total: number;
      }> = [];

      if (Array.isArray(upsertedPins)) {
        for (const up of upsertedPins) {
          const existing = existingMap.get(up.pin_id);
          const curSaves = Number(up.saves || 0);
          const curRepins = Number(up.repins || 0);
          const curShares = Number(up.share_count || 0);

          if (!existing || existing.saves !== curSaves || existing.repins !== curRepins || existing.share_count !== curShares) {
            metricsToInsert.push({
              workspace_id: workspaceId,
              pin_ref: up.id,
              recorded_at: fetchedAt,
              saves: curSaves,
              repins: curRepins,
              comments: Number(up.comments || 0),
              shares: curShares,
              reactions_total: Number((up.reactions as any)?.total || 0),
            });
          }
        }
      }

      if (metricsToInsert.length > 0) {
        await pinArchive
          .from('pa_pin_metrics')
          .upsert(metricsToInsert, { onConflict: 'pin_ref,recorded_at', ignoreDuplicates: true });
      }
    }

    // D) Insert pa_runs row
    const triggerVal = (
      ['cron', 'manual', 'backfill', 'refresh'].includes(payload.trigger)
        ? payload.trigger
        : 'cron'
    ) as 'cron' | 'manual' | 'backfill' | 'refresh';
    const runRow = {
      workspace_id: workspaceId,
      account_id: accountId,
      trigger: triggerVal,
      started_at: fetchedAt,
      finished_at: new Date().toISOString(),
      pages_fetched: typeof payload.pages_fetched === 'number' ? payload.pages_fetched : 1,
      pins_added: pinsAddedCount,
      pins_updated: pinsUpdatedCount,
      pins_promoted: promotedCount,
      status: 'completed',
      message: payload.run_id ? String(payload.run_id) : null,
    };

    await pinArchive.from('pa_runs').insert(runRow);

    const responseData: Record<string, any> = {
      success: true,
      accepted: pins.length,
      archived_pin_ids: pinIds,
    };
    if (truncatedCount !== undefined) {
      responseData.truncated = truncatedCount;
    }

    return new Response(
      JSON.stringify(responseData),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: `Internal processing error: ${err.message || 'Unknown'}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
