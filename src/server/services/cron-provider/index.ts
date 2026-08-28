import type { CronProvider } from './provider';
import { FastCronProvider } from './fastcron';
import { CronJobOrgProvider } from './cronjoborg';
import { dbClients } from '../../db/clients';

export * from './provider';
export * from './fastcron';
export * from './cronjoborg';
export * from '../../../lib/cron-helper';

interface CachedProvider {
  provider: 'fastcron' | 'cronjoborg';
  expiry: number;
}

const globalCronProviderCache = new Map<string, CachedProvider>();

/**
 * Clears the in-memory cache for a specific workspace or all workspaces.
 */
export function clearCronProviderCache(workspaceId?: string): void {
  if (workspaceId) {
    globalCronProviderCache.delete(workspaceId);
  } else {
    globalCronProviderCache.clear();
  }
}

/**
 * Explicitly populates the in-memory cache for a workspace with a 60s TTL.
 */
export function setCronProviderCache(
  workspaceId: string,
  provider: 'fastcron' | 'cronjoborg',
  ttlMs: number = 60_000
): void {
  if (!workspaceId) return;
  globalCronProviderCache.set(workspaceId, {
    provider,
    expiry: Date.now() + ttlMs,
  });
}

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
 * Caches results in-memory for 60 seconds per workspace.
 * Returns 'fastcron' or 'cronjoborg'.
 */
export async function getGlobalCronProvider(
  workspaceId?: string | null,
  runtimeEnv?: Record<string, any>
): Promise<'fastcron' | 'cronjoborg'> {
  if (!workspaceId) return 'fastcron';

  const now = Date.now();
  const cached = globalCronProviderCache.get(workspaceId);
  if (cached && cached.expiry > now) {
    return cached.provider;
  }

  let resolvedProvider: 'fastcron' | 'cronjoborg' = 'fastcron';
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
        resolvedProvider = 'cronjoborg';
      }
    }
  } catch (err) {
    console.warn('[getCronProvider] Error fetching global cron provider:', err);
  }

  globalCronProviderCache.set(workspaceId, {
    provider: resolvedProvider,
    expiry: now + 60_000, // 60-second TTL
  });

  return resolvedProvider;
}

