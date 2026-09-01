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
  max_batch_pins: 500,
  pin_filter_min_saves: 0,
  pin_filter_min_repins: 0,
  pin_filter_rising_age_days: 14,
  pin_filter_rising_saves: 34,
  refresh_max_pins: 0,
  discovery_stop_pages: 3,
  discovery_max_pages: 50,
  audit_sweep_enabled: true,
  daily_sheet_sync_enabled: false,
  github_schedule_enabled: true,
};

const ALLOWED_PATCH_KEYS = new Set([
  'workspace_id',
  'ingest_enabled',
  'paused_account_policy',
  'max_batch_pins',
  'pin_filter_min_saves',
  'pin_filter_min_repins',
  'pin_filter_rising_age_days',
  'pin_filter_rising_saves',
  'refresh_max_pins',
  'discovery_stop_pages',
  'discovery_max_pages',
  'audit_sweep_enabled',
  'daily_sheet_sync_enabled',
  'github_schedule_enabled',
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
      max_batch_pins: settings.max_batch_pins ?? DEFAULT_SETTINGS.max_batch_pins,
      pin_filter_min_saves: settings.pin_filter_min_saves ?? DEFAULT_SETTINGS.pin_filter_min_saves,
      pin_filter_min_repins: settings.pin_filter_min_repins ?? DEFAULT_SETTINGS.pin_filter_min_repins,
      pin_filter_rising_age_days: settings.pin_filter_rising_age_days ?? DEFAULT_SETTINGS.pin_filter_rising_age_days,
      pin_filter_rising_saves: settings.pin_filter_rising_saves ?? DEFAULT_SETTINGS.pin_filter_rising_saves,
      refresh_max_pins: settings.refresh_max_pins ?? DEFAULT_SETTINGS.refresh_max_pins,
      discovery_stop_pages: Number(settings.discovery_stop_pages ?? DEFAULT_SETTINGS.discovery_stop_pages),
      discovery_max_pages: Number(settings.discovery_max_pages ?? DEFAULT_SETTINGS.discovery_max_pages),
      audit_sweep_enabled: settings.audit_sweep_enabled ?? DEFAULT_SETTINGS.audit_sweep_enabled,
      daily_sheet_sync_enabled: settings.daily_sheet_sync_enabled ?? DEFAULT_SETTINGS.daily_sheet_sync_enabled,
      github_schedule_enabled: settings.github_schedule_enabled ?? DEFAULT_SETTINGS.github_schedule_enabled,
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

  // Ignore deprecated default_interval_days if sent by older clients
  if ('default_interval_days' in body) {
    delete body.default_interval_days;
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

  // Validate max_batch_pins
  if (body.max_batch_pins !== undefined) {
    const m = Number(body.max_batch_pins);
    if (!Number.isInteger(m) || m < 1 || m > 5000) {
      return json({ success: false, error: 'max_batch_pins must be an integer between 1 and 5000.' }, 422);
    }
  }

  // Validate pin_filter_min_saves
  if (body.pin_filter_min_saves !== undefined) {
    const s = Number(body.pin_filter_min_saves);
    if (!Number.isInteger(s) || s < 0 || s > 1000000) {
      return json({ success: false, error: 'pin_filter_min_saves must be an integer between 0 and 1000000.' }, 422);
    }
  }

  // Validate pin_filter_min_repins
  if (body.pin_filter_min_repins !== undefined) {
    const r = Number(body.pin_filter_min_repins);
    if (!Number.isInteger(r) || r < 0 || r > 1000000) {
      return json({ success: false, error: 'pin_filter_min_repins must be an integer between 0 and 1000000.' }, 422);
    }
  }

  // Validate pin_filter_rising_age_days
  if (body.pin_filter_rising_age_days !== undefined) {
    const a = Number(body.pin_filter_rising_age_days);
    if (!Number.isInteger(a) || a < 0 || a > 365) {
      return json({ success: false, error: 'pin_filter_rising_age_days must be an integer between 0 and 365.' }, 422);
    }
  }

  // Validate pin_filter_rising_saves
  if (body.pin_filter_rising_saves !== undefined) {
    const rs = Number(body.pin_filter_rising_saves);
    if (!Number.isInteger(rs) || rs < 0 || rs > 1000000) {
      return json({ success: false, error: 'pin_filter_rising_saves must be an integer between 0 and 1000000.' }, 422);
    }
  }

  // Validate refresh_max_pins
  if (body.refresh_max_pins !== undefined) {
    const rmp = Number(body.refresh_max_pins);
    if (!Number.isInteger(rmp) || rmp < 0 || rmp > 10000) {
      return json({ success: false, error: 'refresh_max_pins must be an integer between 0 and 10000.' }, 422);
    }
  }

  // Validate discovery_stop_pages
  if (body.discovery_stop_pages !== undefined) {
    const dsp = Number(body.discovery_stop_pages);
    if (!Number.isInteger(dsp) || dsp < 1 || dsp > 10) {
      return json({ success: false, error: 'discovery_stop_pages must be an integer between 1 and 10.' }, 422);
    }
  }

  // Validate discovery_max_pages
  if (body.discovery_max_pages !== undefined) {
    const dmp = Number(body.discovery_max_pages);
    if (!Number.isInteger(dmp) || dmp < 1 || dmp > 500) {
      return json({ success: false, error: 'discovery_max_pages must be an integer between 1 and 500.' }, 422);
    }
  }

  // Validate audit_sweep_enabled
  if (body.audit_sweep_enabled !== undefined && typeof body.audit_sweep_enabled !== 'boolean') {
    return json({ success: false, error: 'audit_sweep_enabled must be a boolean.' }, 422);
  }

  // Validate daily_sheet_sync_enabled
  if (body.daily_sheet_sync_enabled !== undefined && typeof body.daily_sheet_sync_enabled !== 'boolean') {
    return json({ success: false, error: 'daily_sheet_sync_enabled must be a boolean.' }, 422);
  }

  // Validate github_schedule_enabled
  if (body.github_schedule_enabled !== undefined && typeof body.github_schedule_enabled !== 'boolean') {
    return json({ success: false, error: 'github_schedule_enabled must be a boolean.' }, 422);
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
      max_batch_pins:
        body.max_batch_pins !== undefined
          ? Number(body.max_batch_pins)
          : (existing?.max_batch_pins ?? DEFAULT_SETTINGS.max_batch_pins),
      pin_filter_min_saves:
        body.pin_filter_min_saves !== undefined
          ? Number(body.pin_filter_min_saves)
          : (existing?.pin_filter_min_saves ?? DEFAULT_SETTINGS.pin_filter_min_saves),
      pin_filter_min_repins:
        body.pin_filter_min_repins !== undefined
          ? Number(body.pin_filter_min_repins)
          : (existing?.pin_filter_min_repins ?? DEFAULT_SETTINGS.pin_filter_min_repins),
      pin_filter_rising_age_days:
        body.pin_filter_rising_age_days !== undefined
          ? Number(body.pin_filter_rising_age_days)
          : (existing?.pin_filter_rising_age_days ?? DEFAULT_SETTINGS.pin_filter_rising_age_days),
      pin_filter_rising_saves:
        body.pin_filter_rising_saves !== undefined
          ? Number(body.pin_filter_rising_saves)
          : (existing?.pin_filter_rising_saves ?? DEFAULT_SETTINGS.pin_filter_rising_saves),
      refresh_max_pins:
        body.refresh_max_pins !== undefined
          ? Number(body.refresh_max_pins)
          : (existing?.refresh_max_pins ?? DEFAULT_SETTINGS.refresh_max_pins),
      discovery_stop_pages:
        body.discovery_stop_pages !== undefined
          ? Number(body.discovery_stop_pages)
          : (existing?.discovery_stop_pages ?? DEFAULT_SETTINGS.discovery_stop_pages),
      discovery_max_pages:
        body.discovery_max_pages !== undefined
          ? Number(body.discovery_max_pages)
          : (existing?.discovery_max_pages ?? DEFAULT_SETTINGS.discovery_max_pages),
      audit_sweep_enabled:
        body.audit_sweep_enabled !== undefined
          ? body.audit_sweep_enabled
          : (existing?.audit_sweep_enabled ?? DEFAULT_SETTINGS.audit_sweep_enabled),
      daily_sheet_sync_enabled:
        body.daily_sheet_sync_enabled !== undefined
          ? body.daily_sheet_sync_enabled
          : (existing?.daily_sheet_sync_enabled ?? DEFAULT_SETTINGS.daily_sheet_sync_enabled),
      github_schedule_enabled:
        body.github_schedule_enabled !== undefined
          ? body.github_schedule_enabled
          : (existing?.github_schedule_enabled ?? DEFAULT_SETTINGS.github_schedule_enabled),
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
      max_batch_pins: saved.max_batch_pins,
      pin_filter_min_saves: saved.pin_filter_min_saves,
      pin_filter_min_repins: saved.pin_filter_min_repins,
      pin_filter_rising_age_days: saved.pin_filter_rising_age_days,
      pin_filter_rising_saves: saved.pin_filter_rising_saves,
      refresh_max_pins: saved.refresh_max_pins ?? DEFAULT_SETTINGS.refresh_max_pins,
      discovery_stop_pages: Number(saved.discovery_stop_pages ?? DEFAULT_SETTINGS.discovery_stop_pages),
      discovery_max_pages: Number(saved.discovery_max_pages ?? DEFAULT_SETTINGS.discovery_max_pages),
      audit_sweep_enabled: saved.audit_sweep_enabled ?? DEFAULT_SETTINGS.audit_sweep_enabled,
      daily_sheet_sync_enabled: saved.daily_sheet_sync_enabled ?? DEFAULT_SETTINGS.daily_sheet_sync_enabled,
      github_schedule_enabled: saved.github_schedule_enabled ?? DEFAULT_SETTINGS.github_schedule_enabled,
      is_default: false,
      updated_at: saved.updated_at,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
