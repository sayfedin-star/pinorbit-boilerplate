import type { CronProvider } from './provider';
import { FastCronProvider } from './fastcron';
import { CronJobOrgProvider } from './cronjoborg';
import { dbClients } from '../../db/clients';

export * from './provider';
export * from './fastcron';
export * from './cronjoborg';

export function getCronProvider(
  providerType: 'fastcron' | 'cronjoborg' | string = 'fastcron',
  apiKey: string
): CronProvider {
  const norm = String(providerType || 'fastcron').toLowerCase().trim();
  if (norm === 'cronjoborg' || norm === 'cron-job.org' || norm === 'cronjob') {
    return new CronJobOrgProvider(apiKey);
  }
  return new FastCronProvider(apiKey);
}

/**
 * Reads the single source of truth Cron Engine Provider for a workspace.
 * Queries Project 1 (Scheduling / Master DB authority) workspaces.cron_provider.
 * Returns 'fastcron' or 'cronjoborg'.
 */
export async function getGlobalCronProvider(
  workspaceId?: string | null,
  runtimeEnv?: Record<string, any>
): Promise<'fastcron' | 'cronjoborg'> {
  if (!workspaceId) return 'fastcron';
  try {
    const client = dbClients.getSchedulingAdmin(runtimeEnv);
    const { data, error } = await client
      .from('workspaces')
      .select('cron_provider')
      .eq('id', workspaceId)
      .maybeSingle();

    if (!error && data?.cron_provider) {
      const p = String(data.cron_provider).toLowerCase().trim();
      if (p === 'cronjoborg' || p === 'cron-job.org') {
        return 'cronjoborg';
      }
    }
  } catch (err) {
    console.warn('[getCronProvider] Error fetching global cron provider:', err);
  }
  return 'fastcron';
}
