export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret, verifyIngestSecret } from '../../../../server/services/webhook-secrets';

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{1,60}$/;

  // 2. Validate workspace_id
  if (!payload || !payload.workspace_id || typeof payload.workspace_id !== 'string') {
    return new Response(
      JSON.stringify({ success: false, error: 'Validation Error: workspace_id is required in payload.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const workspaceId = payload.workspace_id.trim();
  if (!UUID_REGEX.test(workspaceId)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Validation Error: valid workspace_id UUID is required.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 3. Authenticate via verifyIngestSecret (candidate-set verification)
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

  const verification = await verifyIngestSecret(providedSecret, workspaceId, runtimeEnv);
  if (!verification.valid) {
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
    const maxBatchPins = wsSettings?.max_batch_pins ?? 500;

    // Gating 2: Workspace disabled -> 409
    if (!ingestEnabled) {
      return new Response(
        JSON.stringify({ success: false, error: 'ingest_disabled', skipped: true }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const account_meta = payload.account_meta || {};
    const rawUsername = String(payload.username || account_meta.username || '').trim().toLowerCase();
    if (!rawUsername || !USERNAME_REGEX.test(rawUsername) || rawUsername === 'default') {
      return new Response(
        JSON.stringify({ success: false, error: 'Validation Error: valid account username is required.' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const username = rawUsername;
    const fetchedAt = payload.fetched_at || new Date().toISOString();
    
    // Deduplicate incoming pins by pin_id (taking the last occurrence)
    const rawPinsList: any[] = Array.isArray(payload.pins) ? payload.pins : [];
    const dedupedMap = new Map<string, any>();
    for (const p of rawPinsList) {
      const pid = String(p.pin_id || p.id || '').trim();
      if (pid) {
        dedupedMap.set(pid, p);
      }
    }
    const rawPins = Array.from(dedupedMap.values());
    rawPins.sort((a: any, b: any) => {
      const ta = new Date(a.created_at_pinterest || a.created_at || 0).getTime();
      const tb = new Date(b.created_at_pinterest || b.created_at || 0).getTime();
      if (tb !== ta) return tb - ta;
      return Number(b.saves || 0) - Number(a.saves || 0);
    });

    // Gating 3: Fetch current pa_accounts row before upsert
    const { data: existingAccount } = await pinArchive
      .from('pa_accounts')
      .select('id, status, ingest_enabled')
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
    if (existingAccount && ['paused', 'cookie_expired', 'error'].includes(existingAccount.status) && pausedAccountPolicy === 'reject') {
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
    };
    if (typeof account_meta.last_result === 'string' && /^(pages=|discovery)/i.test(account_meta.last_result.trim())) {
      accountData.last_result = account_meta.last_result.trim();
    }
    if (payload.trigger === 'refresh') {
      accountData.last_run_at = fetchedAt;
    }
    if (typeof payload.follower_count === 'number' && Number.isFinite(payload.follower_count)) {
      accountData.follower_count = Math.max(0, Math.round(payload.follower_count));
    }
    if (payload.trigger !== 'refresh') {
      if (typeof account_meta.pins_count === 'number' && Number.isFinite(account_meta.pins_count)) {
        accountData.pins_count = Math.max(0, Math.round(account_meta.pins_count));
      }
      if (typeof account_meta.promoted_count === 'number' && Number.isFinite(account_meta.promoted_count)) {
        accountData.promoted_count = Math.max(0, Math.round(account_meta.promoted_count));
      }
    }
    if (account_meta.sheet_id) accountData.sheet_id = account_meta.sheet_id;

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

    // Phase C1: Atomic Ingest Write Mode (pa_ingest_pin_batch active)
    let rpcHandled = false;
    let pinsAddedCount = 0;
    let pinsUpdatedCount = 0;

    if (pins.length > 0 && typeof pinArchive.rpc === 'function') {
      try {
        const s = (v: any) => (v === '' || v == null ? undefined : v); // '' → omitted → NULL → R4 keeps target (mirrors legacy ||)
        const pinsPayload = pins.map((p: any) => {
          const row: Record<string, any> = {
            pin_id: String(p.pin_id || p.id),
            title: s(p.title),
            description: s(p.description),
            link: s(p.link),
            domain: s(p.domain),
            board_name: s(p.board_name),
            created_at_pinterest: p.created_at_pinterest ?? p.created_at ?? null,
            image_url: s(p.image_url),
            saves: Number(p.saves || 0),
            repins: Number(p.repins || 0),
            comments: Number(p.comments || 0),
            velocity: Number(p.velocity || 0),
          };
          if (p.is_video !== undefined) row.is_video = Boolean(p.is_video);
          if (p.is_product !== undefined) row.is_product = Boolean(p.is_product);
          if (p.promoted !== undefined) row.promoted = Boolean(p.promoted);
          if (p.price !== undefined) row.price = p.price;
          if (p.currency !== undefined) row.currency = p.currency;
          if (p.site_name !== undefined) row.site_name = p.site_name;
          if (p.node_id !== undefined) row.node_id = p.node_id;
          if (p.board_id !== undefined) row.board_id = p.board_id;
          if (p.utm_link !== undefined) row.utm_link = p.utm_link;
          if (p.share_count !== undefined) row.share_count = Number(p.share_count || 0);
          if (p.reactions !== undefined) row.reactions = p.reactions;
          if (p.annotations !== undefined) row.annotations = p.annotations;
          if (p.seo_category !== undefined) row.seo_category = p.seo_category;
          if (p.canonical_pin_id !== undefined) row.canonical_pin_id = p.canonical_pin_id;
          if (p.seo_alt_text !== undefined) row.seo_alt_text = p.seo_alt_text;
          if (p.board_pin_count !== undefined) row.board_pin_count = p.board_pin_count;
          if (p.board_last_modified_at !== undefined) row.board_last_modified_at = p.board_last_modified_at;
          if (p.image_signature !== undefined) row.image_signature = p.image_signature;
          if (p.dominant_color !== undefined) row.dominant_color = p.dominant_color;
          if (p.archived_at !== undefined) row.archived_at = p.archived_at;
          return row;
        });
        const rpcRes = await pinArchive.rpc('pa_ingest_pin_batch', {
          p_workspace_id: workspaceId,
          p_account_id: accountId,
          p_fetched_at: fetchedAt,
          p_pins: pinsPayload,
          p_dry_run: false,
        });
        if (rpcRes && !rpcRes.error && rpcRes.data && rpcRes.data.success !== false && typeof rpcRes.data.snapshots === 'number') {
          rpcHandled = true;
          pinsAddedCount = Number(rpcRes.data.added || 0);
          pinsUpdatedCount = Number(rpcRes.data.updated || 0);
        } else if (rpcRes?.error) {
          console.warn('[ingest-rpc] RPC error, falling back to legacy manual upsert:', rpcRes.error.message);
        }
      } catch (dryErr: any) {
        console.warn('[ingest-rpc] Exception invoking pa_ingest_pin_batch, falling back to legacy manual upsert:', dryErr?.message || dryErr);
      }
    }

    if (!rpcHandled && pins.length > 0) {
      // Fetch existing pin metric & enrichment state in chunks of 100 to avoid URI 414 errors
      const existingPins: any[] = [];
      const CHUNK_SIZE = 100;
      for (let i = 0; i < pinIds.length; i += CHUNK_SIZE) {
        const chunk = pinIds.slice(i, i + CHUNK_SIZE);
        const { data, error } = await pinArchive
          .from('pa_pins')
          .select('id, pin_id, saves, repins, comments, share_count, reactions, archived_at, annotations, board_pin_count, board_last_modified_at, seo_category, canonical_pin_id, utm_link, image_signature, dominant_color, seo_alt_text, title, description, link, domain, board_name, board_id, created_at_pinterest, image_url, node_id, is_video, is_product, promoted')
          .eq('workspace_id', workspaceId)
          .in('pin_id', chunk);

        if (error) {
          console.error('[ingest] Error querying existing pins chunk:', error);
          throw error;
        }
        if (Array.isArray(data)) {
          existingPins.push(...data);
        }
      }

      const existingMap = new Map<string, {
        id: string;
        saves: number;
        repins: number;
        comments: number;
        share_count: number;
        reactions: Record<string, any> | null;
        archived_at: string | null;
        annotations: any[] | null;
        board_pin_count: number | null;
        board_last_modified_at: string | null;
        seo_category: string | null;
        canonical_pin_id: string | null;
        utm_link: string | null;
        image_signature: string | null;
        dominant_color: string | null;
        seo_alt_text: string | null;
        title: string | null;
        description: string | null;
        link: string | null;
        domain: string | null;
        board_name: string | null;
        board_id: string | null;
        created_at_pinterest: string | null;
        image_url: string | null;
        node_id: string | null;
        is_video: boolean;
        is_product: boolean;
        promoted: boolean;
      }>();

      if (Array.isArray(existingPins)) {
        for (const ep of existingPins) {
          existingMap.set(ep.pin_id, {
            id: ep.id,
            saves: Number(ep.saves || 0),
            repins: Number(ep.repins || 0),
            comments: Number(ep.comments || 0),
            share_count: Number(ep.share_count || 0),
            reactions: typeof ep.reactions === 'object' && ep.reactions !== null ? ep.reactions : null,
            archived_at: ep.archived_at || null,
            annotations: Array.isArray(ep.annotations) ? ep.annotations : null,
            board_pin_count: typeof ep.board_pin_count === 'number' ? ep.board_pin_count : null,
            board_last_modified_at: ep.board_last_modified_at || null,
            seo_category: ep.seo_category || null,
            canonical_pin_id: ep.canonical_pin_id || null,
            utm_link: ep.utm_link || null,
            image_signature: ep.image_signature || null,
            dominant_color: ep.dominant_color || null,
            seo_alt_text: ep.seo_alt_text || null,
            title: ep.title || null,
            description: ep.description || null,
            link: ep.link || null,
            domain: ep.domain || null,
            board_name: ep.board_name || null,
            board_id: ep.board_id || null,
            created_at_pinterest: ep.created_at_pinterest || null,
            image_url: ep.image_url || null,
            node_id: ep.node_id || null,
            is_video: Boolean(ep.is_video),
            is_product: Boolean(ep.is_product),
            promoted: Boolean(ep.promoted),
          });
        }
      }

      // B) Upsert pa_pins (Enrichment-Preserving Two-Writer Merge)
      // Architecture Law: GAS owns Google Sheets; the GitHub refresh workflow owns DB enrichment
      // (works by pin_id against public pinterest.com/pin/<id>/ pages, no cookie). Independent pipelines.
      // Ingest merge must NEVER let a GAS write downgrade workflow enrichment (idea urls, board details, share counts).
      const pinsToUpsert = pins.map((p: any) => {
        const pinId = String(p.pin_id || p.id);
        const existing = existingMap.get(pinId) || null;
        const isNew = !existing;

        if (existing) {
          pinsUpdatedCount++;
        } else {
          pinsAddedCount++;
        }

        // 1. Annotation merge (by name — url/idea_id NEVER lost)
        const mergedByName = new Map<string, any>();
        for (const a of (existing?.annotations || [])) {
          if (a?.name) mergedByName.set(a.name, a);
        }
        for (const a of (p.annotations || [])) {
          if (a?.name) {
            const prev = mergedByName.get(a.name) || {};
            mergedByName.set(a.name, {
              name: a.name,
              idea_id: a.idea_id ?? prev.idea_id ?? null,
              url: a.url ?? prev.url ?? null,
            });
          }
        }

        return {
          workspace_id: workspaceId,
          account_id: accountId,
          pin_id: pinId,
          node_id: p.node_id ?? existing?.node_id ?? null,
          title: p.title || existing?.title || null,
          description: p.description || existing?.description || null,
          link: p.link || existing?.link || null,
          domain: p.domain || existing?.domain || null,
          board_id: p.board_id ?? existing?.board_id ?? null,
          board_name: p.board_name || existing?.board_name || null,
          created_at_pinterest: p.created_at_pinterest || p.created_at || existing?.created_at_pinterest || null,
          image_url: p.image_url || existing?.image_url || null,
          is_video: p.is_video !== undefined ? Boolean(p.is_video) : (existing?.is_video ?? false),
          is_product: p.is_product !== undefined ? Boolean(p.is_product) : (existing?.is_product ?? false),
          price: p.price !== undefined ? p.price : null,
          currency: p.currency || null,
          site_name: p.site_name || null,
          saves: Math.max(Number(p.saves || 0), existing?.saves || 0),
          repins: Math.max(Number(p.repins || 0), existing?.repins || 0),
          comments: Math.max(Number(p.comments || 0), existing?.comments || 0),
          reactions: p.reactions === undefined
            ? (existing?.reactions ?? {})
            : (typeof p.reactions === 'object' && p.reactions !== null ? p.reactions : (existing?.reactions ?? {})),
          velocity: Number(p.velocity || 0),
          promoted: p.promoted !== undefined ? Boolean(p.promoted) : (existing?.promoted ?? false),
          last_updated_at: fetchedAt,
          share_count: Math.max(
            p.share_count === undefined ? (existing?.share_count ?? 0) : Number(p.share_count || 0),
            existing?.share_count || 0
          ),

          // Preserved Enrichment & Direct Qualified Ingestion
          archived_at: existing?.archived_at || (p.archived_at !== undefined ? p.archived_at : fetchedAt),
          annotations: Array.from(mergedByName.values()),
          board_pin_count: p.board_pin_count ?? existing?.board_pin_count ?? null,
          board_last_modified_at: p.board_last_modified_at ?? existing?.board_last_modified_at ?? null,
          seo_category: p.seo_category ?? existing?.seo_category ?? null,
          canonical_pin_id: p.canonical_pin_id ?? existing?.canonical_pin_id ?? null,
          utm_link: p.utm_link ?? existing?.utm_link ?? null,
          image_signature: p.image_signature || existing?.image_signature || null,
          dominant_color: p.dominant_color || existing?.dominant_color || null,
          seo_alt_text: p.seo_alt_text ?? existing?.seo_alt_text ?? null,
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

      // C) Insert pa_pin_metrics snapshot ONLY on new pins or when metrics strictly advance
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

          if (!existing || curSaves > existing.saves || curRepins > existing.repins) {
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
