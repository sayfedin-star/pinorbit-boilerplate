import { analyticsDb } from '../db/analytics';
import { removeWorkspaceOverride } from './webhook-secrets';
import { fastcronService } from './fastcron-service';

/**
 * Safety-Critical Workspace Analytics Cleanup Hook.
 * Directives:
 * 1. Delete ONLY ingest_secret:ws:{wsId} override.
 * 2. Disable (cron_disable) every active connection job (both channels), best-effort.
 * 3. NEVER read, write, or delete ingest_secret:global.
 * 4. runtimeEnv is a required parameter; zero process.env reads.
 */
export async function cleanupWorkspaceAnalytics(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<{ success: boolean; disabledJobsCount: number; complete: boolean; failedJobsCount: number }> {
  if (!wsId) {
    throw new Error('Workspace ID is required for cleanup.');
  }

  // 1. Remove ONLY the workspace override secret
  await removeWorkspaceOverride(wsId, runtimeEnv);

  let disabledJobsCount = 0;
  let failedJobsCount = 0;

  // 2. Disable FastCron jobs for all workspace connections (best effort)
  try {
    const connections = await analyticsDb.listWorkspaceConnections(wsId);
    for (const conn of connections) {
      if (conn.analytics_fastcron_job_id) {
        try {
          await fastcronService.disableFastCronJob(
            wsId,
            conn.analytics_fastcron_job_id,
            runtimeEnv
          );
          disabledJobsCount++;
        } catch (e) {
          failedJobsCount++;
          console.warn(
            `[WorkspaceCleanup] Failed to disable analytics cron job ${conn.analytics_fastcron_job_id}:`,
            e
          );
        }
      }

      if (conn.top_pins_fastcron_job_id) {
        try {
          await fastcronService.disableFastCronJob(
            wsId,
            conn.top_pins_fastcron_job_id,
            runtimeEnv
          );
          disabledJobsCount++;
        } catch (e) {
          failedJobsCount++;
          console.warn(
            `[WorkspaceCleanup] Failed to disable top_pins cron job ${conn.top_pins_fastcron_job_id}:`,
            e
          );
        }
      }
    }
  } catch (err) {
    failedJobsCount++;
    console.warn(`[WorkspaceCleanup] Error listing connections for workspace ${wsId}:`, err);
  }

  return {
    success: true,
    complete: failedJobsCount === 0,
    disabledJobsCount,
    failedJobsCount,
  };
}
