import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCronProvider,
  CronJobOrgProvider,
  FastCronProvider,
  clearCronProviderCache,
  setCronProviderCache,
  getGlobalCronProvider,
  humanCron,
  humanCronTitle,
} from '../services/cron-provider';
import { cronExpressionToCronJobOrgSchedule } from '../services/cron-provider/cronjoborg';
import { resolveToken, listWorkspaceTokens, saveWorkspaceToken, deleteWorkspaceToken } from '../lib/token-resolver';
import { dbClients } from '../db/clients';

describe('Cron Provider Abstraction Suite', () => {
  beforeEach(() => {
    clearCronProviderCache();
    vi.restoreAllMocks();
  });

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

  it('getGlobalCronProvider resolves workspaces.cron_provider from Project 1 DB', async () => {
    // Mock DB client returning cronjoborg
    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { cron_provider: 'cronjoborg' },
              error: null,
            }),
          }),
        }),
      }),
    };

    const spy = vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    const provider = await getGlobalCronProvider('ws-test-123');
    expect(provider).toBe('cronjoborg');
    expect(mockAdmin.from).toHaveBeenCalledWith('workspaces');

    spy.mockRestore();
  });

  it('getGlobalCronProvider falls back to fastcron on error or missing workspace', async () => {
    const p1 = await getGlobalCronProvider(null);
    expect(p1).toBe('fastcron');

    const mockAdminErr = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: null,
              error: new Error('DB error'),
            }),
          }),
        }),
      }),
    };

    const spy = vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdminErr as any);
    const p2 = await getGlobalCronProvider('ws-missing');
    expect(p2).toBe('fastcron');
    spy.mockRestore();
  });

  it('getGlobalCronProvider caches provider for 60s — 10 consecutive calls execute exactly 1 DB query', async () => {
    const mockSelect = vi.fn().mockResolvedValue({
      data: { cron_provider: 'cronjoborg' },
      error: null,
    });

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: mockSelect,
          }),
        }),
      }),
    };

    const spy = vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    // Call 10 times consecutively
    for (let i = 0; i < 10; i++) {
      const res = await getGlobalCronProvider('ws-cached-10x');
      expect(res).toBe('cronjoborg');
    }

    // Exactly 1 DB query
    expect(mockAdmin.from).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it('resolveToken called 10 times executes exactly 1 DB query for workspace provider check', async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { cron_provider: 'fastcron' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }),
    };

    const spy = vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    for (let i = 0; i < 10; i++) {
      const res = await resolveToken(
        { workspaceId: 'ws-token-10x' },
        'scheduling',
        { FASTCRON_API_TOKEN: 'fastcron_test_token_12345' }
      );
      expect(res.token).toBe('fastcron_test_token_12345');
      expect(res.source).toBe('env');
    }

    // Workspaces table was queried exactly 1 time due to 60s cache
    const workspaceCalls = mockAdmin.from.mock.calls.filter((c: any) => c[0] === 'workspaces');
    expect(workspaceCalls.length).toBe(1);

    spy.mockRestore();
  });

  it('clearCronProviderCache and setCronProviderCache manage cache correctly', async () => {
    setCronProviderCache('ws-custom-set', 'cronjoborg');

    const mockAdmin = {
      from: vi.fn(),
    };
    const spy = vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    // Should return from cache without touching DB
    const res1 = await getGlobalCronProvider('ws-custom-set');
    expect(res1).toBe('cronjoborg');
    expect(mockAdmin.from).not.toHaveBeenCalled();

    // Invalidate
    clearCronProviderCache('ws-custom-set');

    mockAdmin.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { cron_provider: 'fastcron' },
            error: null,
          }),
        }),
      }),
    });

    const res2 = await getGlobalCronProvider('ws-custom-set');
    expect(res2).toBe('fastcron');
    expect(mockAdmin.from).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  describe('humanCron Formatter Suite', () => {
    it('humanizes 0 2 * * * with full breakdown', () => {
      const desc = humanCron('0 2 * * *');
      expect(desc).toBe('Daily at 02:00 UTC — 1/day, 7/week, ~30/month');

      const title = humanCronTitle('0 2 * * *');
      expect(title).toBe('Daily at 02:00 UTC');
    });

    it('humanizes 0 4 * * * and 0 0 * * *', () => {
      expect(humanCron('0 4 * * *')).toBe('Daily at 04:00 UTC — 1/day, 7/week, ~30/month');
      expect(humanCronTitle('0 4 * * *')).toBe('Daily at 04:00 UTC');

      expect(humanCron('0 0 * * *')).toBe('Daily at 00:00 UTC — 1/day, 7/week, ~30/month');
      expect(humanCronTitle('0 0 * * *')).toBe('Daily at 00:00 UTC');
    });

    it('humanizes minute interval expressions (e.g. */15 * * * *)', () => {
      const desc = humanCron('*/15 * * * *');
      expect(desc).toBe('Every 15 minutes — 96/day, 672/week, ~2880/month');
      expect(humanCronTitle('*/15 * * * *')).toBe('Every 15 minutes');
    });

    it('humanizes specific days of week (e.g. 0 4 * * 1,3,5)', () => {
      const desc = humanCron('0 4 * * 1,3,5');
      expect(desc).toBe('At 04:00 UTC on [1,3,5] — 3/week, ~12/month');
    });

    it('supports custom timezones in humanCron', () => {
      const desc = humanCron('0 2 * * *', 'America/New_York');
      expect(desc).toBe('Daily at 02:00 America/New_York — 1/day, 7/week, ~30/month');

      const title = humanCronTitle('0 2 * * *', 'America/New_York');
      expect(title).toBe('Daily at 02:00 America/New_York');
    });
  });
});

