import type { CronProvider } from './provider';
import { FastCronProvider } from './fastcron';
import { CronJobOrgProvider } from './cronjoborg';

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
