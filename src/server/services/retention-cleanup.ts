import { dbClients } from '../db/clients';
import { clampRetentionPostedDays, clampProcessingTimeoutMinutes } from './scheduling-logic';

export interface CleanupOverrides {
  p1?: boolean;
  p2?: boolean;
  p3?: boolean;
}

interface BatchedDeleteOptions {
  column: string;
  value: string;
  dateColumn: string;
  cutoff: string;
  extraFilter?: { column: string; value: string };
  batchSize?: number;
}

export async function batchedDelete(
  client: any,
  table: string,
  options: BatchedDeleteOptions
): Promise<number> {
  let totalDeleted = 0;
  const batchSize = options.batchSize || 500;
  const MAX_BATCH_ITERATIONS = 50;
  let iterations = 0;

  while (iterations++ < MAX_BATCH_ITERATIONS) {
    let query = client
      .from(table)
      .select('id')
      .eq(options.column, options.value)
      .lt(options.dateColumn, options.cutoff);

    if (options.extraFilter) {
      query = query.eq(options.extraFilter.column, options.extraFilter.value);
    }

    const { data: rows, error: selectErr } = await query.limit(batchSize);
    if (selectErr) throw selectErr;
    if (!rows || rows.length === 0) break;

    const ids = rows.map((r: any) => r.id);
    const { count, error: deleteErr } = await client
      .from(table)
      .delete({ count: 'exact' })
      .in('id', ids);

    if (deleteErr) throw deleteErr;

    const batchDeleted = count ?? ids.length;
    totalDeleted += batchDeleted;

    if (batchDeleted < batchSize) break;

    // Small delay to reduce DB load
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return totalDeleted;
}

export async function runRetentionCleanup(
  workspaceId: string,
  runtimeEnv: Record<string, any>,
  opts?: { overrides?: CleanupOverrides; trigger?: 'api' | 'manual' }
): Promise<Record<string, any>> {
  const schedulingAdmin = dbClients.getSchedulingAdmin(runtimeEnv);

  // Read workspace retention settings (with fallbacks)
  const { data: wsSettings } = await schedulingAdmin
    .from('workspace_retention_settings')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const retentionPostedDays = clampRetentionPostedDays(wsSettings?.retention_posted_days);
  const processingTimeoutMinutes = clampProcessingTimeoutMinutes(wsSettings?.processing_timeout_minutes);
  const postedCutoff = new Date(Date.now() - retentionPostedDays * 86400000).toISOString();

  const warnings: string[] = [];

  // Effective gates based on explicit overrides or DB toggles (default false in schema)
  const effectiveP1 = opts?.overrides?.p1 ?? Boolean(wsSettings?.auto_prune_enabled ?? false);
  const effectiveP2 = opts?.overrides?.p2 ?? Boolean(wsSettings?.p2_prune_enabled ?? false);
  const effectiveP3 = opts?.overrides?.p3 ?? Boolean(wsSettings?.p3_prune_enabled ?? false);

  // 1. Unconditional Orphan Pin Sweep (outside gates)
  const sweepCutoff = new Date(Date.now() - processingTimeoutMinutes * 60000).toISOString();
  let sweptPinsCount = 0;
  try {
    const { count, error: sweepErr } = await schedulingAdmin
      .from('pins')
      .update({
        status: 'pending',
        processing_started_at: null,
        claimed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_id', workspaceId)
      .eq('status', 'processing')
      .lt('claimed_at', sweepCutoff)
      .lt('attempts', 2);

    if (sweepErr) throw sweepErr;
    sweptPinsCount = count ?? 0;
  } catch (err: any) {
    warnings.push(`Sweep failed: ${err.message}`);
  }

  // 2. Gate P1 (Posted pins, terminal pins, delivery logs, import sessions)
  let deletedPinsCount = 0;
  let deletedTerminalPinsCount = 0;
  let deletedDeliveryLogs = 0;
  let deletedImportSessions = 0;

  if (effectiveP1) {
    try {
      // 1. Purge posted pins older than workspace retention days using batchedDelete
      deletedPinsCount = await batchedDelete(schedulingAdmin, 'pins', {
        column: 'workspace_id',
        value: workspaceId,
        dateColumn: 'posted_at',
        cutoff: postedCutoff,
        extraFilter: { column: 'status', value: 'posted' },
      });

      // 2. Terminal pins: failed & cancelled using batchedDelete
      const terminalDays = typeof wsSettings?.retention_terminal_days === 'number' ? wsSettings.retention_terminal_days : 90;
      const terminalCutoff = new Date(Date.now() - terminalDays * 86400000).toISOString();
      const delFailed = await batchedDelete(schedulingAdmin, 'pins', {
        column: 'workspace_id',
        value: workspaceId,
        dateColumn: 'updated_at',
        cutoff: terminalCutoff,
        extraFilter: { column: 'status', value: 'failed' },
      });
      const delCancelled = await batchedDelete(schedulingAdmin, 'pins', {
        column: 'workspace_id',
        value: workspaceId,
        dateColumn: 'updated_at',
        cutoff: terminalCutoff,
        extraFilter: { column: 'status', value: 'cancelled' },
      });
      deletedTerminalPinsCount = delFailed + delCancelled;

      // 3. Pin delivery logs RPC
      const logsDays = typeof wsSettings?.retention_logs_days === 'number' ? wsSettings.retention_logs_days : 14;
      const { data: logsData, error: logsErr } = await schedulingAdmin.rpc('purge_old_pin_delivery_logs', {
        p_keep_success_days: logsDays,
        p_keep_failure_days: Math.max(logsDays, 30),
        p_workspace_id: workspaceId,
      });
      if (logsErr) throw logsErr;
      deletedDeliveryLogs = typeof logsData === 'number' ? logsData : 0;

      // 4. Import sessions using batchedDelete
      const importDays = typeof wsSettings?.import_sessions_days === 'number' ? wsSettings.import_sessions_days : 30;
      const sessionsCutoff = new Date(Date.now() - importDays * 86400000).toISOString();
      deletedImportSessions = await batchedDelete(schedulingAdmin, 'import_sessions', {
        column: 'workspace_id',
        value: workspaceId,
        dateColumn: 'created_at',
        cutoff: sessionsCutoff,
      });
    } catch (p1Err: any) {
      console.error('[Retention] P1 prune failed:', p1Err);
      warnings.push(`P1 prune failed: ${p1Err.message || String(p1Err)}`);
    }
  }

  // 3. Gate P2 (Competitor snapshots and ingestion jobs)
  let p2Result: any = null;
  if (effectiveP2) {
    try {
      const competitorsClient = dbClients.getCompetitors(runtimeEnv);
      const compSnapshotsDays = typeof wsSettings?.competitor_snapshots_days === 'number' ? wsSettings.competitor_snapshots_days : 90;
      const compJobsDays = typeof wsSettings?.competitor_jobs_days === 'number' ? wsSettings.competitor_jobs_days : 30;
      const { data: p2Data, error: p2Err } = await competitorsClient.rpc('purge_competitor_retention', {
        p_keep_snapshot_days: compSnapshotsDays,
        p_keep_job_days: compJobsDays,
        p_workspace_id: workspaceId,
      });
      if (p2Err) throw p2Err;
      p2Result = p2Data;
    } catch (p2Err: any) {
      console.error('[Retention] P2 prune failed:', p2Err);
      warnings.push(`P2 prune failed: ${p2Err.message || String(p2Err)}`);
    }
  }

  // 4. Gate P3 (Analytics snapshots and ingestion runs)
  let deletedSnapshotsCount = 0;
  let deletedIngestionRuns = 0;
  if (effectiveP3) {
    try {
      const analyticsClient = dbClients.getAnalytics(runtimeEnv);
      const ingestionRunsDays = typeof wsSettings?.ingestion_runs_days === 'number' ? wsSettings.ingestion_runs_days : 30;
      const { data: runsData, error: runsErr } = await analyticsClient.rpc('purge_old_analytics_ingestion_runs', {
        p_keep_days: ingestionRunsDays,
        p_workspace_id: workspaceId,
      });
      if (runsErr) throw runsErr;
      deletedIngestionRuns = runsData?.deleted_runs ?? (typeof runsData === 'number' ? runsData : 0);

      const topPinsRawDays = typeof wsSettings?.top_pins_raw_days === 'number' ? wsSettings.top_pins_raw_days : 180;
      const snapshotCutoff = new Date(Date.now() - topPinsRawDays * 86400000).toISOString().split('T')[0];

      const rollupCutoff = new Date(Date.now() - topPinsRawDays * 86400000);
      const { data: oldSnapshots } = await analyticsClient
        .from('top_pins_snapshots')
        .select('*')
        .eq('workspace_id', workspaceId)
        .lt('window_end', rollupCutoff.toISOString())
        .limit(10000);

      if (oldSnapshots && oldSnapshots.length > 0) {
        const monthlyRollups = new Map<string, any>();
        for (const snap of oldSnapshots) {
          if (!snap.window_end) continue;
          const monthKey = `${snap.workspace_id}_${snap.connection_id}_${snap.sort_by}_${snap.window_end.slice(0, 7)}`;
          const existing = monthlyRollups.get(monthKey) || { pins: [] };
          existing.pins.push(snap);
          monthlyRollups.set(monthKey, existing);
        }
        console.warn(`[Cleanup] ${oldSnapshots.length} snapshots >${topPinsRawDays}d - would create ${monthlyRollups.size} monthly rollups`);
      }

      deletedSnapshotsCount = await batchedDelete(analyticsClient, 'top_pins_snapshots', {
        column: 'workspace_id',
        value: workspaceId,
        dateColumn: 'window_end',
        cutoff: snapshotCutoff,
      });

      if (wsSettings?.top_pins_downsample_enabled) {
        console.warn('[Retention] Top pins downsampling requested for workspace:', workspaceId);
      }
    } catch (p3Err: any) {
      console.error('[Retention] P3 prune failed:', p3Err);
      warnings.push(`P3 prune failed: ${p3Err.message || String(p3Err)}`);
    }
  }

  // Construct consolidated payload
  const payload: Record<string, any> = {
    success: true,
    workspace_id: workspaceId,
    auto_prune_enabled: Boolean(wsSettings?.auto_prune_enabled ?? false),
    p2_prune_enabled: Boolean(wsSettings?.p2_prune_enabled ?? false),
    p3_prune_enabled: Boolean(wsSettings?.p3_prune_enabled ?? false),
    retention_posted_days: retentionPostedDays,
    processing_timeout_minutes: processingTimeoutMinutes,
    deleted_pins_count: deletedPinsCount,
    deleted_terminal_pins_count: deletedTerminalPinsCount,
    deleted_delivery_logs: deletedDeliveryLogs,
    deleted_import_sessions: deletedImportSessions,
    swept_pins_count: sweptPinsCount,
    p2: p2Result,
    deleted_ingestion_runs: deletedIngestionRuns,
    deleted_snapshots_count: deletedSnapshotsCount,
    posted_cutoff: postedCutoff,
    warnings,
  };

  // Fail-lazy telemetry upsert with complete schema defaults
  try {
    const telemetryPayload = {
      ...(wsSettings ?? {}),
      workspace_id: workspaceId,
      auto_prune_enabled: wsSettings?.auto_prune_enabled ?? false,
      retention_posted_days: retentionPostedDays,
      retention_terminal_days: wsSettings?.retention_terminal_days ?? 90,
      retention_logs_days: wsSettings?.retention_logs_days ?? 14,
      import_sessions_days: wsSettings?.import_sessions_days ?? 30,
      processing_timeout_minutes: processingTimeoutMinutes,
      p2_prune_enabled: wsSettings?.p2_prune_enabled ?? false,
      competitor_snapshots_days: wsSettings?.competitor_snapshots_days ?? 90,
      competitor_jobs_days: wsSettings?.competitor_jobs_days ?? 30,
      p3_prune_enabled: wsSettings?.p3_prune_enabled ?? false,
      ingestion_runs_days: wsSettings?.ingestion_runs_days ?? 30,
      top_pins_raw_days: wsSettings?.top_pins_raw_days ?? 180,
      top_pins_downsample_enabled: wsSettings?.top_pins_downsample_enabled ?? false,
      analytics_daily_keep_days: wsSettings?.analytics_daily_keep_days ?? null,
      last_cleanup_at: new Date().toISOString(),
      last_cleanup_result: {
        at: new Date().toISOString(),
        trigger: opts?.trigger ?? 'api',
        swept_pins: payload.swept_pins_count,
        warnings: payload.warnings,
        sections: {
          p1: {
            pins: payload.deleted_pins_count,
            terminal: payload.deleted_terminal_pins_count,
            logs: payload.deleted_delivery_logs,
            sessions: payload.deleted_import_sessions,
          },
          p2: payload.p2 ?? null,
          p3: {
            runs: payload.deleted_ingestion_runs,
            snapshots: payload.deleted_snapshots_count,
          },
        },
      },
      updated_at: new Date().toISOString(),
    };

    await schedulingAdmin
      .from('workspace_retention_settings')
      .upsert(telemetryPayload, { onConflict: 'workspace_id' });
  } catch (e) {
    console.warn('[Retention] telemetry write failed:', e);
  }

  return payload;
}
