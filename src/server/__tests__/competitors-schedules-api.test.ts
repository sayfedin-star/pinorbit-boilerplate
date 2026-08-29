import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schedulesIndexApi from '../../pages/api/competitors/schedules/index';
import * as schedulesIdApi from '../../pages/api/competitors/schedules/[id]';
import * as schedulesBulkApi from '../../pages/api/competitors/schedules/bulk';
import * as schedulesSyncMissingApi from '../../pages/api/competitors/schedules/sync-missing';

const mockWorkspaceId = '44444444-5555-6666-7777-888888888888';
const mockUserId = '99999999-8888-7777-6666-555555555555';

let mockSchedulesData: any[] = [];
let mockTokensData: any[] = [];

function createMockCompAdmin() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'competitor_schedules') {
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          in: vi.fn(() => builder),
          order: vi.fn(() => builder),
          single: vi.fn(async () => ({ data: mockSchedulesData[0] || null, error: null })),
          maybeSingle: vi.fn(async () => ({ data: mockSchedulesData[0] || null, error: null })),
          insert: vi.fn((payload: any) => {
            const row = { id: 'sched-new-123', ...payload, created_at: new Date().toISOString() };
            mockSchedulesData.push(row);
            const subBuilder: any = {
              select: vi.fn(() => subBuilder),
              single: vi.fn(async () => ({ data: row, error: null })),
            };
            return subBuilder;
          }),
          update: vi.fn((payload: any) => {
            const updated = { ...(mockSchedulesData[0] || {}), ...payload };
            const subBuilder: any = {
              eq: vi.fn(() => subBuilder),
              select: vi.fn(() => subBuilder),
              single: vi.fn(async () => ({ data: updated, error: null })),
            };
            return subBuilder;
          }),
          delete: vi.fn(() => {
            const subBuilder: any = {
              eq: vi.fn(() => subBuilder),
              then: (resolve: any) => resolve({ error: null }),
            };
            return subBuilder;
          }),
          then: (resolve: any) => resolve({ data: mockSchedulesData, error: null }),
        };
        return builder;
      }

      if (table === 'competitor_fastcron_tokens') {
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          order: vi.fn(() => builder),
          single: vi.fn(async () => ({ data: mockTokensData[0] || null, error: null })),
          maybeSingle: vi.fn(async () => ({ data: mockTokensData[0] || null, error: null })),
          then: (resolve: any) => resolve({ data: mockTokensData, error: null }),
        };
        return builder;
      }

      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: any) => resolve({ data: [], error: null }),
      };
    }),
  };
}

const mockCompAdmin = createMockCompAdmin();

const mockSupabase = {
  from: vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn(async () => ({ data: { id: 'm1', role: 'admin', cron_provider: 'fastcron', name: 'TestWS' }, error: null })),
    maybeSingle: vi.fn(async () => ({ data: { id: 'm1', role: 'admin', cron_provider: 'fastcron', name: 'TestWS' }, error: null })),
  })),
};

vi.mock('../../server/db/clients', () => ({
  dbClients: {
    getCompetitorsAdmin: vi.fn(() => mockCompAdmin),
    getCompetitors: vi.fn(() => mockCompAdmin),
    getSchedulingAdmin: vi.fn(() => mockSupabase),
  },
  getServerEnv: vi.fn(() => ({
    TOKEN_KEK: 'test_token_kek_secret_key_12345678',
  })),
}));

vi.mock('../../server/auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(async () => ({
    workspaceId: mockWorkspaceId,
    role: 'admin',
    user: { id: mockUserId },
  })),
}));

vi.mock('../../server/services/webhook-secrets', () => ({
  getEffectiveSecret: vi.fn(async () => ({
    value: 'secret_test_xyz_12345',
    source: 'workspace',
  })),
}));

vi.mock('../../server/lib/fastcron-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/fastcron-client')>();
  return {
    ...actual,
    fastcronCall: vi.fn(async (action: string, params: any) => {
    if (action === 'cron_add') {
      return { success: true, data: { id: 888123, name: params.name, expression: params.expression } };
    }
    if (action === 'cron_edit') {
      return { success: true, data: { id: params.id, expression: params.expression } };
    }
    if (action === 'cron_delete' || action === 'cron_disable' || action === 'cron_enable' || action === 'cron_run') {
      return { success: true, data: { status: 'OK' } };
    }
    if (action === 'cron_get') {
      return { success: true, data: { id: params.id, status: 'enabled', paused: false, next_run: 1700000000 } };
    }
    if (action === 'cron_next') {
      return { success: true, data: [1700000000, 1700086400] };
    }
    if (action === 'cron_logs') {
      return { success: true, data: [{ date: '2026-08-28 02:00:00', status: 'OK', http_status_code: 202, duration: 0.8 }] };
    }
    return { success: true, data: {} };
  }),
};
});

vi.mock('../../server/lib/token-resolver', () => ({
  listWorkspaceTokens: vi.fn(async () => [
    {
      id: 'tok-1',
      name: 'Vault Token',
      token: 'fc_live_secret_token_123',
      masked_token: '••••chVF',
      is_default: true,
      source: 'workspace_registry',
    },
  ]),
  resolveToken: vi.fn(async () => ({
    token: 'fc_live_secret_token_123',
    tokenId: 'tok-1',
    name: 'Vault Token',
    masked_token: '••••chVF',
    source: 'workspace_registry',
  })),
}));

describe('Competitor Schedules RESTful API Test Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTokensData = [
      {
        id: 'tok-1',
        name: 'Vault Token',
        token_masked: '••••chVF',
        token_encrypted: 'v1:aXZfdGVzdA==:Y3RfdGVzdA==',
        is_default: true,
      },
    ];
    mockSchedulesData = [
      {
        id: 'sched-1',
        workspace_id: mockWorkspaceId,
        label: 'Daily Ingestion',
        cron_expression: '0 2 * * *',
        timezone: 'UTC',
        fastcron_token_id: 'tok-1',
        fastcron_job_id: '888123',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
  });

  it('GET /api/competitors/schedules returns list of persistent competitor schedules with telemetry', async () => {
    const context: any = {
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
      },
    };

    const res = await schedulesIndexApi.GET(context);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.schedules)).toBe(true);
    expect(data.schedules.length).toBe(1);
    expect(data.schedules[0].label).toBe('Daily Ingestion');
    expect(data.schedules[0].expression).toBe('0 2 * * *');
    expect(data.schedules[0].fastcron_job_id).toBe(888123);
    expect(data.schedules[0].token_name).toBe('Vault Token');
    expect(data.schedules[0].cron_logs.length).toBe(1);
    expect(data.tokens.length).toBe(1);
  });

  it('POST /api/competitors/schedules validates 5-part cron expression and creates schedule', async () => {
    const payload = {
      label: 'Morning Scrape',
      cron_expression: '30 4 * * *',
      timezone: 'America/New_York',
      enabled: true,
    };

    const context: any = {
      request: new Request('http://localhost/api/competitors/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
      },
    };

    const res = await schedulesIndexApi.POST(context);
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.schedule).toBeDefined();
    expect(data.schedule.cron_expression).toBe('30 4 * * *');
    expect(data.schedule.fastcron_job_id).toBe('888123');

    const { fastcronCall } = await import('../../server/lib/fastcron-client');
    expect(fastcronCall).toHaveBeenCalledWith(
      'cron_add',
      expect.objectContaining({
        postData: expect.stringContaining('"trigger":"cron"'),
        post_data: expect.stringContaining('"trigger":"cron"'),
      }),
      expect.any(String)
    );
  });

  it('PATCH /api/competitors/schedules/:id updates label and cron expression', async () => {
    const context: any = {
      params: { id: 'sched-1' },
      request: new Request('http://localhost/api/competitors/schedules/sched-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Updated Daily', cron_expression: '0 3 * * *' }),
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
      },
    };

    const res = await schedulesIdApi.PATCH(context);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.schedule.label).toBe('Updated Daily');
    expect(data.schedule.cron_expression).toBe('0 3 * * *');
  });

  it('DELETE /api/competitors/schedules/:id deletes schedule from FastCron and DB', async () => {
    const context: any = {
      params: { id: 'sched-1' },
      request: new Request('http://localhost/api/competitors/schedules/sched-1', {
        method: 'DELETE',
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
      },
    };

    const res = await schedulesIdApi.DELETE(context);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toBe('Schedule deleted successfully.');
  });

  it('POST /api/competitors/schedules/bulk performs batch pause and resume actions', async () => {
    const context: any = {
      request: new Request('http://localhost/api/competitors/schedules/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause', ids: ['sched-1'] }),
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
      },
    };

    const res = await schedulesBulkApi.POST(context);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.action).toBe('pause');
    expect(data.succeeded).toBe(1);
  });

  it('POST /api/competitors/schedules/sync-missing creates default daily schedule when none exists', async () => {
    mockSchedulesData = []; // clear existing

    const context: any = {
      request: new Request('http://localhost/api/competitors/schedules/sync-missing', {
        method: 'POST',
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
      },
    };

    const res = await schedulesSyncMissingApi.POST(context);
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.schedule.cron_expression).toBe('0 2 * * *');
  });
});
