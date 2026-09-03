import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  pausePublishingSchedule,
  resumePublishingSchedule,
  deletePublishingSchedule,
  clonePublishingSchedule,
  syncPublishingSchedule,
} from '../services/fastcron-service';
import { dbClients } from '../db/clients';
import { resolveToken } from '../lib/token-resolver';

vi.mock('../lib/token-resolver', () => ({
  resolveToken: vi.fn().mockResolvedValue({ token: 'mock-fastcron-token-12345', source: 'workspace_registry' }),
  listWorkspaceTokens: vi.fn(),
  saveWorkspaceToken: vi.fn(),
  deleteWorkspaceToken: vi.fn(),
}));

describe('Publishing Schedules Multi-Tenant Isolation (Service Layer)', () => {
  const workspaceA = '11111111-1111-1111-1111-111111111111';
  const workspaceB = '22222222-2222-2222-2222-222222222222';
  const scheduleId = 'sched-uuid-9999';
  const mockRuntimeEnv = { FASTCRON_API_TOKEN: 'token_123' };

  let mockFrom: any;
  let queryLog: { table: string; method: string; args: any[]; chained: { method: string; args: any[] }[] }[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    queryLog = [];

    mockFrom = vi.fn((table: string) => {
      const entry: any = { table, chained: [] };

      const builder: any = {
        select: vi.fn((...args: any[]) => {
          entry.chained.push({ method: 'select', args });
          return builder;
        }),
        update: vi.fn((...args: any[]) => {
          entry.chained.push({ method: 'update', args });
          return builder;
        }),
        delete: vi.fn((...args: any[]) => {
          entry.chained.push({ method: 'delete', args });
          return builder;
        }),
        insert: vi.fn((...args: any[]) => {
          entry.chained.push({ method: 'insert', args });
          return builder;
        }),
        limit: vi.fn((...args: any[]) => {
          entry.chained.push({ method: 'limit', args });
          return Promise.resolve({
            data: [{ id: 'hook-1', webhook_url: 'https://hook.make.com/valid-hook' }],
            error: null,
          });
        }),
        eq: vi.fn((...args: any[]) => {
          entry.chained.push({ method: 'eq', args });
          return builder;
        }),
        single: vi.fn(async () => {
          entry.chained.push({ method: 'single', args: [] });
          if (table === 'account_webhooks') {
            return {
              data: { id: 'hook-1', webhook_url: 'https://hook.make.com/valid-hook' },
              error: null,
            };
          }
          return {
            data: {
              id: scheduleId,
              workspace_id: workspaceA,
              account_id: 'acc-1',
              label: 'Test Schedule',
              timezone: 'UTC',
              dispatch_token: 'token-abc',
              fastcron_job_id: 12345,
            },
            error: null,
          };
        }),
        maybeSingle: vi.fn(async () => {
          entry.chained.push({ method: 'maybeSingle', args: [] });
          return {
            data: {
              id: scheduleId,
              workspace_id: workspaceA,
              account_id: 'acc-1',
              label: 'Test Schedule',
              timezone: 'UTC',
              dispatch_token: 'token-abc',
              fastcron_job_id: 12345,
            },
            error: null,
          };
        }),
      };

      queryLog.push(entry);
      return builder;
    });

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue({
      from: mockFrom,
    } as any);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'OK', id: 12345 }),
    } as any);
  });

  it('pausePublishingSchedule scopes both SELECT and UPDATE queries with workspace_id', async () => {
    const res = await pausePublishingSchedule(scheduleId, 12345, mockRuntimeEnv, workspaceA);
    expect(res.success).toBe(true);

    const selectQuery = queryLog.find((q) => q.table === 'posting_schedules' && q.chained.some((c) => c.method === 'select'));
    expect(selectQuery).toBeDefined();
    expect(selectQuery?.chained).toContainEqual({ method: 'eq', args: ['id', scheduleId] });
    expect(selectQuery?.chained).toContainEqual({ method: 'eq', args: ['workspace_id', workspaceA] });

    const updateQuery = queryLog.find((q) => q.table === 'posting_schedules' && q.chained.some((c) => c.method === 'update'));
    expect(updateQuery).toBeDefined();
    expect(updateQuery?.chained).toContainEqual({ method: 'eq', args: ['id', scheduleId] });
    expect(updateQuery?.chained).toContainEqual({ method: 'eq', args: ['workspace_id', workspaceA] });
  });

  it('resumePublishingSchedule scopes both SELECT and UPDATE queries with workspace_id', async () => {
    const res = await resumePublishingSchedule(scheduleId, 12345, mockRuntimeEnv, workspaceA);
    expect(res.success).toBe(true);

    const selectQuery = queryLog.find((q) => q.table === 'posting_schedules' && q.chained.some((c) => c.method === 'select'));
    expect(selectQuery).toBeDefined();
    expect(selectQuery?.chained).toContainEqual({ method: 'eq', args: ['id', scheduleId] });
    expect(selectQuery?.chained).toContainEqual({ method: 'eq', args: ['workspace_id', workspaceA] });

    const updateQuery = queryLog.find((q) => q.table === 'posting_schedules' && q.chained.some((c) => c.method === 'update'));
    expect(updateQuery).toBeDefined();
    expect(updateQuery?.chained).toContainEqual({ method: 'eq', args: ['id', scheduleId] });
    expect(updateQuery?.chained).toContainEqual({ method: 'eq', args: ['workspace_id', workspaceA] });
  });

  it('deletePublishingSchedule scopes both SELECT and DELETE queries with workspace_id', async () => {
    const res = await deletePublishingSchedule(scheduleId, 12345, mockRuntimeEnv, workspaceA);
    expect(res.success).toBe(true);

    const selectQuery = queryLog.find((q) => q.table === 'posting_schedules' && q.chained.some((c) => c.method === 'select'));
    expect(selectQuery).toBeDefined();
    expect(selectQuery?.chained).toContainEqual({ method: 'eq', args: ['id', scheduleId] });
    expect(selectQuery?.chained).toContainEqual({ method: 'eq', args: ['workspace_id', workspaceA] });

    const deleteQuery = queryLog.find((q) => q.table === 'posting_schedules' && q.chained.some((c) => c.method === 'delete'));
    expect(deleteQuery).toBeDefined();
    expect(deleteQuery?.chained).toContainEqual({ method: 'eq', args: ['id', scheduleId] });
    expect(deleteQuery?.chained).toContainEqual({ method: 'eq', args: ['workspace_id', workspaceA] });
  });

  it('clonePublishingSchedule scopes SELECT query with workspace_id', async () => {
    const res = await clonePublishingSchedule(scheduleId, mockRuntimeEnv, workspaceA);
    expect(res.success).toBe(true);

    const selectQuery = queryLog.find((q) => q.table === 'posting_schedules' && q.chained.some((c) => c.method === 'select'));
    expect(selectQuery).toBeDefined();
    expect(selectQuery?.chained).toContainEqual({ method: 'eq', args: ['id', scheduleId] });
    expect(selectQuery?.chained).toContainEqual({ method: 'eq', args: ['workspace_id', workspaceA] });
  });

  it('syncPublishingSchedule scopes UPDATE query with derived workspace_id', async () => {
    const mockSchedule = {
      id: scheduleId,
      workspace_id: workspaceA,
      account_id: 'acc-1',
      dispatch_token: 'dispatch-token-xyz',
      fastcron_job_id: null,
      timezone: 'UTC',
    };

    const res = await syncPublishingSchedule(mockSchedule, mockRuntimeEnv, workspaceA);
    expect(res.success).toBe(true);

    const updateQuery = queryLog.find((q) => q.table === 'posting_schedules' && q.chained.some((c) => c.method === 'update'));
    expect(updateQuery).toBeDefined();
    expect(updateQuery?.chained).toContainEqual({ method: 'eq', args: ['id', scheduleId] });
    expect(updateQuery?.chained).toContainEqual({ method: 'eq', args: ['workspace_id', workspaceA] });
  });
});
