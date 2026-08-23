export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

const DEFAULT_SETTINGS = {
  ingest_enabled: true,
  paused_account_policy: 'reject' as const,
  default_interval_days: 3,
  max_batch_pins: 500,
};

const ALLOWED_PATCH_KEYS = new Set([
  'workspace_id',
  'ingest_enabled',
  'paused_account_policy',
  'default_interval_days',
  'max_batch_pins',
]);

export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  if (!user || !schedulingClient) {
    return json({ success: false, error: 'Unauthorized: missing session' }, 401);
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id') || locals.activeWorkspaceId;
  if (!workspaceId) {
    return json({ success: false, error: 'Unauthorized: missing workspace identifier' }, 401);
  }
  if (!UUID_REGEX.test(workspaceId)) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }

  let wsCtx;
  try {
    wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'member');
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Forbidden' }, errorStatus(e));
  }

  try {
    const db = dbClients.getPinArchive(locals.runtime?.env);
    const { data: settings, error } = await db
      .from('pa_workspace_settings')
      .select('*')
      .eq('workspace_id', wsCtx.workspaceId)
      .maybeSingle();

    if (error) {
      return json({ success: false, error: error.message }, 500);
    }

    if (!settings) {
      return json({
        success: true,
        workspace_id: wsCtx.workspaceId,
        ...DEFAULT_SETTINGS,
        is_default: true,
        updated_at: null,
      });
    }

    return json({
      success: true,
      workspace_id: settings.workspace_id,
      ingest_enabled: settings.ingest_enabled ?? DEFAULT_SETTINGS.ingest_enabled,
      paused_account_policy: settings.paused_account_policy ?? DEFAULT_SETTINGS.paused_account_policy,
      default_interval_days: settings.default_interval_days ?? DEFAULT_SETTINGS.default_interval_days,
      max_batch_pins: settings.max_batch_pins ?? DEFAULT_SETTINGS.max_batch_pins,
      is_default: false,
      updated_at: settings.updated_at,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  if (!user || !schedulingClient) {
    return json({ success: false, error: 'Unauthorized: missing session' }, 401);
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text && text.trim().length > 0) {
      body = JSON.parse(text);
    }
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const workspaceId = body.workspace_id || locals.activeWorkspaceId;
  if (!workspaceId) {
    return json({ success: false, error: 'Unauthorized: missing workspace identifier' }, 401);
  }
  if (!UUID_REGEX.test(workspaceId)) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }

  // Reject unknown keys
  for (const key of Object.keys(body)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      return json({ success: false, error: `Unknown setting key: ${key}` }, 422);
    }
  }

  // Validate ingest_enabled
  if (body.ingest_enabled !== undefined && typeof body.ingest_enabled !== 'boolean') {
    return json({ success: false, error: 'ingest_enabled must be a boolean.' }, 422);
  }

  // Validate paused_account_policy
  if (
    body.paused_account_policy !== undefined &&
    body.paused_account_policy !== 'reject' &&
    body.paused_account_policy !== 'accept'
  ) {
    return json({ success: false, error: "paused_account_policy must be 'reject' or 'accept'." }, 422);
  }

  // Validate default_interval_days
  if (body.default_interval_days !== undefined) {
    const d = Number(body.default_interval_days);
    if (!Number.isInteger(d) || d < 1 || d > 30) {
      return json({ success: false, error: 'default_interval_days must be an integer between 1 and 30.' }, 422);
    }
  }

  // Validate max_batch_pins
  if (body.max_batch_pins !== undefined) {
    const m = Number(body.max_batch_pins);
    if (!Number.isInteger(m) || m < 1 || m > 5000) {
      return json({ success: false, error: 'max_batch_pins must be an integer between 1 and 5000.' }, 422);
    }
  }

  let wsCtx;
  try {
    wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Forbidden: Admin access required' }, errorStatus(e));
  }

  try {
    const db = dbClients.getPinArchive(locals.runtime?.env);

    // Fetch existing row if present
    const { data: existing } = await db
      .from('pa_workspace_settings')
      .select('*')
      .eq('workspace_id', wsCtx.workspaceId)
      .maybeSingle();

    const payload = {
      workspace_id: wsCtx.workspaceId,
      ingest_enabled:
        body.ingest_enabled !== undefined
          ? body.ingest_enabled
          : (existing?.ingest_enabled ?? DEFAULT_SETTINGS.ingest_enabled),
      paused_account_policy:
        body.paused_account_policy !== undefined
          ? body.paused_account_policy
          : (existing?.paused_account_policy ?? DEFAULT_SETTINGS.paused_account_policy),
      default_interval_days:
        body.default_interval_days !== undefined
          ? Number(body.default_interval_days)
          : (existing?.default_interval_days ?? DEFAULT_SETTINGS.default_interval_days),
      max_batch_pins:
        body.max_batch_pins !== undefined
          ? Number(body.max_batch_pins)
          : (existing?.max_batch_pins ?? DEFAULT_SETTINGS.max_batch_pins),
      updated_at: new Date().toISOString(),
    };

    const { data: saved, error: upsertErr } = await db
      .from('pa_workspace_settings')
      .upsert(payload, { onConflict: 'workspace_id' })
      .select('*')
      .single();

    if (upsertErr || !saved) {
      return json({ success: false, error: upsertErr?.message || 'Failed to save settings' }, 500);
    }

    return json({
      success: true,
      workspace_id: saved.workspace_id,
      ingest_enabled: saved.ingest_enabled,
      paused_account_policy: saved.paused_account_policy,
      default_interval_days: saved.default_interval_days,
      max_batch_pins: saved.max_batch_pins,
      is_default: false,
      updated_at: saved.updated_at,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
