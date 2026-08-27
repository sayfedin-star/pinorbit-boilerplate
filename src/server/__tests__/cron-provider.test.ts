import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getCronProvider, CronJobOrgProvider, FastCronProvider } from '../services/cron-provider';
import { cronExpressionToCronJobOrgSchedule } from '../services/cron-provider/cronjoborg';
import { resolveToken, listWorkspaceTokens, saveWorkspaceToken, deleteWorkspaceToken } from '../lib/token-resolver';
import { dbClients } from '../db/clients';

describe('Cron Provider Abstraction Suite', () => {
  it('Factory returns FastCronProvider or CronJobOrgProvider based on string', () => {
    const fastcron = getCronProvider('fastcron', 'test_key');
    expect(fastcron.providerName).toBe('fastcron');
    expect(fastcron instanceof FastCronProvider).toBe(true);

    const cronjob = getCronProvider('cronjoborg', 'test_key');
    expect(cronjob.providerName).toBe('cronjoborg');
    expect(cronjob instanceof CronJobOrgProvider).toBe(true);

    const cronjobAlias = getCronProvider('cron-job.org', 'test_key');
    expect(cronjobAlias.providerName).toBe('cronjoborg');
  });

  it('cronExpressionToCronJobOrgSchedule correctly parses standard expressions', () => {
    // 1) 0 4 * * * -> 04:00 daily
    const sched1 = cronExpressionToCronJobOrgSchedule('0 4 * * *', 'UTC');
    expect(sched1.minutes).toEqual([0]);
    expect(sched1.hours).toEqual([4]);
    expect(sched1.mdays).toEqual([-1]);
    expect(sched1.months).toEqual([-1]);
    expect(sched1.wdays).toEqual([-1]);
    expect(sched1.timezone).toBe('UTC');

    // 2) */15 9-17 * * 1-5 -> Every 15 mins between 9-17 Mon-Fri
    const sched2 = cronExpressionToCronJobOrgSchedule('*/15 9-17 * * 1-5', 'America/New_York');
    expect(sched2.minutes).toEqual([0, 15, 30, 45]);
    expect(sched2.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(sched2.wdays).toEqual([1, 2, 3, 4, 5]);
    expect(sched2.timezone).toBe('America/New_York');
  });

  it('FastCronProvider delegates to fastcronCall with correct payload mapping', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ status: 'OK', id: 4455 }),
    } as any);

    const provider = new FastCronProvider('dummy_token_12345');
    const result = await provider.create({
      name: 'Test Job',
      expression: '0 2 * * *',
      url: 'https://example.com/dispatch',
      payload: { foo: 'bar' },
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe('4455');
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('CronJobOrgProvider sends PUT request to cron-job.org with Bearer auth', async () => {
    let capturedUrl = '';
    let capturedHeaders: any = {};
    let capturedBody: any = {};

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: any) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(init?.body || '{}');
      return {
        status: 200,
        ok: true,
        json: async () => ({ jobId: 'cjo_9988' }),
      } as any;
    }) as any);

    const provider = new CronJobOrgProvider('cjo_api_key_secret');
    const result = await provider.create({
      name: 'PinOrbit Daily Scrape',
      expression: '30 4 * * 1,3,5',
      timezone: 'UTC',
      url: 'https://pinorbit.app/api/internal/competitors/dispatch',
      httpMethod: 'POST',
      headers: { 'x-ingest-secret': 'sec_123' },
      payload: { workspace_id: 'ws_1' },
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe('cjo_9988');
    expect(capturedUrl).toBe('https://api.cron-job.org/jobs');
    expect(capturedHeaders['Authorization']).toBe('Bearer cjo_api_key_secret');
    expect(capturedBody.job.title).toBe('PinOrbit Daily Scrape');
    expect(capturedBody.job.requestMethod).toBe(1);
    expect(capturedBody.job.schedule.minutes).toEqual([30]);
    expect(capturedBody.job.schedule.hours).toEqual([4]);
    expect(capturedBody.job.schedule.wdays).toEqual([1, 3, 5]);
    expect(capturedBody.job.extendedData.headers['x-ingest-secret']).toBe('sec_123');

    fetchSpy.mockRestore();
  });
});
