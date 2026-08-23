export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { HttpError } from '../../../server/lib/http-error';
import { gasCall } from '../../../server/lib/gas-bridge';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMPORT_ACCOUNTS = 50;
const MAX_DISPATCH_ACCOUNTS = 5;

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/pinarchive/accounts-import
 *
 * Imports competitor Pinterest creators directly into PinArchive and triggers
 * the Google Apps Script (GAS) Control Sheet bridge.
 *
 * Hard Rules:
 * - Tenant isolated via assertWorkspaceAccess(supabase, workspaceId, user.id, 'admin').
 * - R1: Never overwrites existing account rows (status, interval_days, ingest_enabled).
 * - Caps: <= 50 accounts per batch.
 * - dispatch defers to FEATURE_DISPATCH_NOW; executes GAS 'run' per account.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  const supabase = (locals as any).supabase;

  if (!user || !supabase) {
    return json({ success: false, error: 'Unauthorized: missing user session' }, 401);
  }

  let body: any;
  try {
    const text = await request.text();
    if (!text || text.trim().length === 0) {
      return json({ success: false, error: 'Empty request body' }, 400);
    }
    body = JSON.parse(text);
  } catch (err) {
    return json({ success: false, error: 'Malformed JSON payload' }, 400);
  }

  const rawWs = body.workspace_id || (locals as any).activeWorkspaceId;
  if (!rawWs || typeof rawWs !== 'string' || !UUID_REGEX.test(rawWs.trim())) {
    return json({ success: false, error: 'Invalid workspace identifier format' }, 400);
  }

  const workspaceId = rawWs.trim();
  const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [];

  if (rawAccounts.length === 0) {
    return json({ success: false, error: 'accounts array is required and must not be empty' }, 422);
  }

  if (rawAccounts.length > MAX_IMPORT_ACCOUNTS) {
    return json({
      success: false,
      error: `accounts batch limit exceeded: max ${MAX_IMPORT_ACCOUNTS} accounts allowed per import`,
    }, 422);
  }

  const dispatchActive = Boolean(body.dispatch);
  if (dispatchActive && rawAccounts.length > MAX_DISPATCH_ACCOUNTS) {
    return json({
      success: false,
      error: `dispatch limit exceeded: max ${MAX_DISPATCH_ACCOUNTS} accounts allowed when dispatch is true`,
    }, 422);
  }

  const runtimeEnv =
    (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env ||
    (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv ||
    {};

  try {
    // Requires admin or owner role to import accounts
    await assertWorkspaceAccess(supabase, workspaceId, user.id, 'admin');

    const pinArchive = dbClients.getPinArchive(runtimeEnv);

    // 1. Fetch workspace settings for default interval
    const { data: wsSettings } = await pinArchive
      .from('pa_workspace_settings')
      .select('default_interval_days, ingest_enabled')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    const defaultInterval = wsSettings?.default_interval_days || 3;

    // 2. Query existing accounts to honor R1 (no overwrite)
    const normalizedAccounts = rawAccounts.map((a: any) => ({
      username: String(a.username || '').trim().replace(/^@/, '').toLowerCase(),
      interval_days: typeof a.interval_days === 'number' ? a.interval_days : undefined,
      user_id: a.user_id ? String(a.user_id).trim() : undefined,
    })).filter(a => Boolean(a.username));

    const usernames = normalizedAccounts.map(a => a.username);

    const { data: existingRows } = await pinArchive
      .from('pa_accounts')
      .select('id, username, status, ingest_enabled, interval_days')
      .eq('workspace_id', workspaceId)
      .in('username', usernames);

    const existingMap = new Map<string, any>(
      (existingRows || []).map((r: any) => [r.username.toLowerCase(), r])
    );

    // Check FEATURE_DISPATCH_NOW flag
    const flagVal = String(runtimeEnv.FEATURE_DISPATCH_NOW || '').trim().toLowerCase();
    const featureDispatchNowActive = flagVal === 'true' || flagVal === '1';

    const results: any[] = [];
    let importedCount = 0;
    let skippedCount = 0;

    for (const acc of normalizedAccounts) {
      const existing = existingMap.get(acc.username);

      if (existing) {
        // R1: Already exists in PinArchive -> Never overwrite existing status/interval/ingest_enabled
        skippedCount++;
        const itemResult: Record<string, any> = {
          id: existing.id,
          username: acc.username,
          status: 'already_archived',
          ingest_enabled: existing.ingest_enabled,
          interval_days: existing.interval_days,
        };

        if (dispatchActive) {
          if (featureDispatchNowActive) {
            const dispRes = await gasCall(runtimeEnv, workspaceId, 'run', {
              username: acc.username,
            });
            itemResult.dispatch_status = dispRes.ok ? 'dispatched' : 'dispatch_failed';
            if (dispRes.error) itemResult.dispatch_error = dispRes.error;
          } else {
            itemResult.dispatch_status = 'deferred_flag_off';
          }
        }

        results.push(itemResult);
        continue;
      }

      // New Account -> Insert row into Project 4 pa_accounts
      const intervalDays =
        typeof acc.interval_days === 'number' && acc.interval_days >= 1 && acc.interval_days <= 30
          ? acc.interval_days
          : defaultInterval;

      const { data: newRow, error: insErr } = await pinArchive
        .from('pa_accounts')
        .upsert(
          {
            workspace_id: workspaceId,
            username: acc.username,
            status: 'active',
            ingest_enabled: true,
            interval_days: intervalDays,
          },
          { onConflict: 'workspace_id,username', ignoreDuplicates: true }
        )
        .select('id, username')
        .single();

      if (insErr || !newRow) {
        results.push({
          username: acc.username,
          status: 'error',
          error: insErr?.message || 'Insert failed',
        });
        continue;
      }

      importedCount++;

      // Trigger GAS Control Sheet Bridge
      const gasAddRes = await gasCall(runtimeEnv, workspaceId, 'add_account', {
        username: acc.username,
        workspace_id: workspaceId,
        interval_days: intervalDays,
        user_id: acc.user_id || '',
      });

      const itemResult: Record<string, any> = {
        id: newRow.id,
        username: acc.username,
        status: 'imported',
        interval_days: intervalDays,
        gas_bridge: gasAddRes.ok ? 'synced' : 'failed',
      };

      if (!gasAddRes.ok && gasAddRes.error) {
        itemResult.gas_error = gasAddRes.error;
      }

      // Trigger real-time dispatch if requested and feature flag active
      if (dispatchActive) {
        if (featureDispatchNowActive) {
          const dispRes = await gasCall(runtimeEnv, workspaceId, 'run', {
            username: acc.username,
          });
          itemResult.dispatch_status = dispRes.ok ? 'dispatched' : 'dispatch_failed';
          if (dispRes.error) itemResult.dispatch_error = dispRes.error;
        } else {
          itemResult.dispatch_status = 'deferred_flag_off';
        }
      }

      results.push(itemResult);
    }

    return json({
      success: true,
      workspace_id: workspaceId,
      imported: importedCount,
      skipped: skippedCount,
      total: normalizedAccounts.length,
      results,
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Internal server error' }, 500);
  }
};
