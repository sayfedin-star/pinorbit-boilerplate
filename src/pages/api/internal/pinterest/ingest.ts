export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../../server/db/clients';
import { getEffectiveSecret } from '../../../../server/services/webhook-secrets';
import { pinnerETL } from '../../../../server/services/pinner-etl';
import { timingSafeEqual } from '../../../../server/lib/timing-safe';

export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env || (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv || {};

  // 1. Parse JSON body
  let payload: any;
  try {
    const text = await request.text();
    if (!text || text.trim().length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'Empty request payload.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    payload = JSON.parse(text);
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: 'Malformed JSON payload.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // 2. Engine events branch (pin.posted / pin.failed / board.created / boards.list / board.deleted) BEFORE connection_id requirement
  const engineEvents = ['pin.posted', 'pin.failed', 'board.created', 'boards.list', 'board.deleted'];
  if (payload && engineEvents.includes(payload.event)) {
    const ev = payload.event as string;
    const admin = dbClients.getSchedulingAdmin(runtimeEnv);

    // Resolve workspace_id from payload or from account_id lookup
    let wsId = payload.workspace_id;
    if (!wsId && payload.account_id) {
      const { data: acc } = await admin.from('accounts').select('workspace_id').eq('id', payload.account_id).maybeSingle();
      if (acc?.workspace_id) wsId = acc.workspace_id;
    }

    if (!wsId) {
      return new Response(JSON.stringify({ success: false, error: 'workspace_id or valid account_id required for engine events.' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    }

    const eff = await getEffectiveSecret(wsId, runtimeEnv);
    if (isProductionEnv(runtimeEnv) && eff.source === 'env' && isKnownDefaultIngestSecret(eff.value)) {
      return new Response(JSON.stringify({ success: false, error: 'Service unavailable: ingest secret not configured on server.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    const prov = request.headers.get('x-ingest-secret') || (typeof payload.ingest_secret === 'string' ? payload.ingest_secret : null);
    if (!prov || !eff.value || !(await timingSafeEqual(prov, eff.value))) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid x-ingest-secret header.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // A) pin.posted / pin.failed
    if (ev === 'pin.posted' || ev === 'pin.failed') {
      const internalId = payload.pin_id;
      if (!internalId) return new Response(JSON.stringify({ success: false, error: 'pin_id required.' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
      const { data: pin } = await admin.from('pins').select('*').eq('id', internalId).eq('workspace_id', wsId).maybeSingle();
      if (!pin) return new Response(JSON.stringify({ success: false, error: 'Pin not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      if (ev === 'pin.failed' || payload.success === false) {
        const rc = (pin.retry_count ?? 0) + 1;
        const exhausted = rc >= (pin.max_retries ?? 2);
        await admin.from('pins').update({
          status: exhausted ? 'failed' : 'pending',
          processing_started_at: null,
          retry_count: rc,
          failure_type: 'permanent',
          last_failure_reason: payload.error || 'Make reported failure',
          last_attempt_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', internalId).eq('workspace_id', wsId);
        await admin.from('pin_delivery_logs').insert({ pin_id: internalId, attempt_no: pin.attempts, event_type: 'dispatch_failed', error_message: payload.error || null, metadata: { source: 'make_callback' } }).then(() => {});
        return new Response(JSON.stringify({ success: true, handled: 'pin_failed', exhausted }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const postedAt = payload.created_at
        ? (() => {
            try {
              const d = new Date(payload.created_at);
              return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
            } catch { return new Date().toISOString(); }
          })()
        : new Date().toISOString();

      const updateFields: any = {
        status: 'posted',
        posted_at: postedAt,
        pinterest_pin_id: payload.id || pin.pinterest_pin_id || null,
        pinterest_pin_created_at: payload.created_at || null,
        processing_started_at: null,
        last_error_message: null,
        updated_at: new Date().toISOString(),
      };

      if (typeof payload.image_url === 'string' && payload.image_url.trim().length > 0 && !payload.image_url.includes('{{')) {
        updateFields.image_url = payload.image_url.trim();
      }

      await admin.from('pins').update(updateFields).eq('id', internalId).eq('workspace_id', wsId);
      await admin.from('pin_delivery_logs').insert({ pin_id: internalId, attempt_no: pin.attempts, event_type: 'dispatch_success', provider: 'pinterest', metadata: { pinterest_pin_id: payload.id || pin.pinterest_pin_id, board_id: payload.board_id, source: 'make_callback' } }).then(() => {});
      return new Response(JSON.stringify({ success: true, handled: 'pin_posted' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Helper coercers for enriched board fields
    const parseCoerceInt = (val: any): number | null => {
      if (val === undefined || val === null || val === '') return null;
      const n = parseInt(String(val), 10);
      return Number.isNaN(n) ? 0 : n;
    };

    const parseCoerceDate = (val: any): string | null => {
      if (!val || typeof val !== 'string') return null;
      try {
        const d = new Date(val);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      } catch {
        return null;
      }
    };

    // B) board.created
    if (ev === 'board.created') {
      const accId = payload.account_id;
      const bId = String(payload.board_id || payload.id || '');
      const bName = String(payload.board_name || payload.name || '');
      if (!accId || !bId || !bName) {
        return new Response(JSON.stringify({ success: false, error: 'account_id, board_id, board_name required.' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
      }
      const { data: acc } = await admin.from('accounts').select('workspace_id').eq('id', accId).maybeSingle();
      if (!acc) return new Response(JSON.stringify({ success: false, error: 'Account not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      if (acc.workspace_id !== wsId) {
        return new Response(JSON.stringify({ success: false, error: 'Account does not belong to workspace.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      const pinCount = parseCoerceInt(payload.pin_count);
      const followerCount = parseCoerceInt(payload.follower_count);
      const boardCreatedAt = parseCoerceDate(payload.board_created_at || payload.created_at);
      const boardPinsModifiedAt = parseCoerceDate(payload.board_pins_modified_at || payload.pins_modified_at);
      const nowIso = new Date().toISOString();

      const { data: upsertedBoard, error: insErr } = await admin.from('boards').upsert({
        account_id: accId,
        workspace_id: acc.workspace_id,
        board_name: bName,
        board_id: bId,
        pinterest_board_id: bId,
        created_via: 'webhook_auto_create',
        pin_count: pinCount,
        follower_count: followerCount,
        board_created_at: boardCreatedAt,
        board_pins_modified_at: boardPinsModifiedAt,
        last_synced_at: nowIso,
      }, { onConflict: 'account_id, board_id' }).select('id, board_id, board_name, pin_count, follower_count, last_synced_at').single();

      await admin.from('board_provisioning_requests').update({
        status: insErr ? 'failed' : 'completed',
        error_message: insErr?.message || null,
        completed_at: new Date().toISOString(),
      }).eq('idempotency_key', `create:${accId}:${String(bName).toLowerCase()}`).then(() => {});

      return new Response(JSON.stringify({
        success: !insErr,
        handled: 'board.created',
        board: upsertedBoard || { board_id: bId, board_name: bName },
        error: insErr?.message || null,
      }), { status: insErr ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
    }

    // C) boards.list
    if (ev === 'boards.list') {
      const accId = payload.account_id;
      // Support both array payload.boards and per-bundle individual board payload
      const rawBoards = Array.isArray(payload.boards)
        ? payload.boards
        : (payload.board_id || payload.id || payload.board_name || payload.name)
        ? [payload]
        : [];

      if (!accId) {
        return new Response(JSON.stringify({ success: false, error: 'account_id required.' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
      }
      const { data: acc } = await admin.from('accounts').select('workspace_id').eq('id', accId).maybeSingle();
      if (!acc) return new Response(JSON.stringify({ success: false, error: 'Account not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      if (acc.workspace_id !== wsId) {
        return new Response(JSON.stringify({ success: false, error: 'Account does not belong to workspace.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      const nowIso = new Date().toISOString();
      const boardsToUpsert = rawBoards
        .map((b: any) => {
          const bId = String(b.id || b.board_id || '');
          const bName = String(b.name || b.board_name || '');
          if (!bId) return null;

          return {
            account_id: accId,
            workspace_id: acc.workspace_id,
            board_id: bId,
            pinterest_board_id: bId,
            board_name: bName || 'Untitled Board',
            created_via: 'webhook_sync',
            pin_count: parseCoerceInt(b.pin_count),
            follower_count: parseCoerceInt(b.follower_count),
            board_created_at: parseCoerceDate(b.board_created_at || b.created_at),
            board_pins_modified_at: parseCoerceDate(b.board_pins_modified_at || b.pins_modified_at),
            last_synced_at: nowIso,
          };
        })
        .filter(Boolean);

      let syncedCount = 0;
      const errors: string[] = [];

      if (boardsToUpsert.length > 0) {
        const { error: upErr } = await admin.from('boards').upsert(
          boardsToUpsert,
          { onConflict: 'account_id,board_id' }
        );
        if (upErr) {
          errors.push(`Batch upsert: ${upErr.message}`);
          console.warn('[IngestAPI] Batch board upsert error:', upErr.message);
        } else {
          syncedCount = boardsToUpsert.length;
        }
      }

      return new Response(JSON.stringify({
        success: errors.length === 0 || syncedCount > 0,
        handled: 'boards.list',
        synced: syncedCount,
        total: rawBoards.length,
        errors: errors.length > 0 ? errors : undefined,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // D) board.deleted
    if (ev === 'board.deleted') {
      const accId = payload.account_id;
      const bId = String(payload.board_id || payload.id || '');
      if (!accId || !bId) {
        return new Response(JSON.stringify({ success: false, error: 'account_id and board_id required.' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
      }
      const { data: acc } = await admin.from('accounts').select('workspace_id').eq('id', accId).maybeSingle();
      if (!acc) return new Response(JSON.stringify({ success: false, error: 'Account not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      if (acc.workspace_id !== wsId) {
        return new Response(JSON.stringify({ success: false, error: 'Account does not belong to workspace.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bId);
      const sanitizedId = String(bId).trim();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sanitizedId)) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid board identifier format.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      let query = admin
        .from('boards')
        .delete()
        .eq('account_id', accId)
        .eq('workspace_id', wsId);

      if (isUuid) {
        query = query.or(`id.eq.${sanitizedId},board_id.eq.${sanitizedId},pinterest_board_id.eq.${sanitizedId}`);
      } else {
        query = query.or(`board_id.eq.${sanitizedId},pinterest_board_id.eq.${sanitizedId}`);
      }

      const { error: delErr } = await query;

      if (delErr) {
        return new Response(JSON.stringify({ success: false, error: delErr.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        success: true,
        handled: 'board.deleted',
        board_id: bId,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // 3. Require connection_id
  if (!payload || !payload.connection_id) {
    return new Response(JSON.stringify({ success: false, error: 'Validation Error: connection_id is required in payload.' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
  }

  // 4. Authenticate BEFORE connection lookup (generic errors only)
  const preEff = await getEffectiveSecret(payload.workspace_id || '', runtimeEnv);
  if (isProductionEnv(runtimeEnv) && preEff.source === 'env' && isKnownDefaultIngestSecret(preEff.value)) {
    return new Response(JSON.stringify({ success: false, error: 'Service unavailable: ingest secret not configured on server.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  const providedSecret = request.headers.get('x-ingest-secret');
  if (!providedSecret || !preEff.value || !(await timingSafeEqual(providedSecret, preEff.value))) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid x-ingest-secret header.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // 5. Load connection (authenticated) — generic errors, no enumeration
  let connection: any = null;
  try {
    const analyticsClient = dbClients.getAnalytics(runtimeEnv);
    const { data, error } = await analyticsClient
      .from('analytics_connections')
      .select('id, workspace_id, display_name, analytics_enabled, deleted_at')
      .eq('id', payload.connection_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error || !data) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid connection or unauthorized.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    connection = data;
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: 'Internal server error.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // 6. Tenant boundary check & server-side injection
  if (payload.workspace_id && payload.workspace_id !== connection.workspace_id) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Forbidden: workspace_id in payload does not match connection workspace.'
    }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  const targetSecret = await getEffectiveSecret(connection.workspace_id, runtimeEnv);
  if (!targetSecret?.value || !providedSecret || !(await timingSafeEqual(providedSecret, targetSecret.value))) {
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized: invalid secret for connection workspace.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  payload.workspace_id = connection.workspace_id;

  // 7. DEFAULT-LOCKED
  if (connection.analytics_enabled === false) {
    return new Response(JSON.stringify({ success: false, error: 'connection_disabled' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  // 8. Rate limit headers
  const rawHeaders: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    if (key.startsWith('x-ratelimit') || key.startsWith('x-pinterest')) rawHeaders[key] = value;
  }
  if (!payload.raw_headers || Object.keys(payload.raw_headers).length === 0) payload.raw_headers = rawHeaders;

  // 9. Execute ETL
  try {
    const kvNamespace = runtimeEnv?.ANALYTICS_KV;
    const result = await pinnerETL.processIngestionPayload(payload, kvNamespace, runtimeEnv);
    const isNotFound = result.error?.includes('not registered');
    const isValidation = result.error?.includes('Validation Error');
    const statusCode = result.success ? 200 : isNotFound ? 404 : isValidation ? 422 : 502;
    return new Response(JSON.stringify(result), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('[IngestAPI] Fatal ETL processing error in Project 3:', err);
    return new Response(JSON.stringify({ success: false, error: 'Internal server error.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
