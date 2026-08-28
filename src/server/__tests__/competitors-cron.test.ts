import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as competitorCronApi from '../../pages/api/competitors/cron';

const mockWorkspaceId = '44444444-5555-6666-7777-888888888888';
const mockUserId = '99999999-8888-7777-6666-555555555555';

function createMockQueryBuilder() {
  const tokenData = [
    {
      id: 'tok-1',
      name: 'Vault Token',
      token_masked: '••••chVF',
      token_encrypted: 'v1:aXZfdGVzdA==:Y3RfdGVzdA==',
      is_default: true,
    },
  ];
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    single: vi.fn(async () => ({ data: tokenData[0], error: null })),
    maybeSingle: vi.fn(async () => ({ data: tokenData[0], error: null })),
    upsert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    then: (resolve: any) => resolve({ data: tokenData, error: null }),
  };
  return builder;
}

const mockTokenAdmin = {
  from: vi.fn(() => createMockQueryBuilder()),
};

const mockSupabase = {
  from: vi.fn(() => {
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      single: vi.fn(async () => ({ data: { id: 'm1', role: 'admin', cron_provider: 'fastcron' }, error: null })),
      maybeSingle: vi.fn(async () => ({ data: { id: 'm1', role: 'admin', cron_provider: 'fastcron' }, error: null })),
    };
    return builder;
  }),
};

vi.mock('../../server/db/clients', () => ({
  dbClients: {
    getCompetitorsAdmin: vi.fn(() => mockTokenAdmin),
    getCompetitors: vi.fn(() => mockTokenAdmin),
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
    isOwner: true,
    isAdmin: true,
  })),
}));

vi.mock('../../server/services/webhook-secrets', () => ({
  getEffectiveSecret: vi.fn(async () => ({
    value: 'test_ingest_secret_key_12345',
    source: 'workspace',
  })),
}));

vi.mock('../../server/lib/token-crypto', () => ({
  resolveTokenKek: vi.fn().mockResolvedValue('test_token_kek_00000000_1234567890'),
  encryptToken: vi.fn().mockResolvedValue('v1:aXZfdGVzdA==:Y3RfdGVzdA=='),
  decryptToken: vi.fn().mockResolvedValue('fc_mock_decrypted_token_12345678'),
}));

vi.mock('../../server/lib/fastcron-client', () => ({
  fastcronCall: vi.fn(async (action: string, params: any) => {
    if (action === 'cron_list') {
      return {
        success: true,
        data: [
          {
            id: 88801,
            name: 'PinOrbit competitors — Default Daily — 44444444',
            url: 'https://pinorbit-v2.o-i.workers.dev/api/internal/competitors/dispatch',
            expression: '0 2 * * *',
            status: 'enabled',
            post_data: JSON.stringify({
              workspace_id: mockWorkspaceId,
              pipeline: 'competitors',
              label: 'Default Daily',
            }),
          },
        ],
      };
    }
    if (action === 'cron_next') {
      return { success: true, data: [1700000000] };
    }
    if (action === 'cron_logs') {
      return { success: true, data: [{ date: 1699990000, status: 'success', http_status_code: 202 }] };
    }
    if (action === 'cron_add') {
      return {
        success: true,
        data: {
          id: 88802,
          name: params?.name,
          expression: params?.expression,
          status: 'enabled',
        },
      };
    }
    if (action === 'cron_edit') {
      return { success: true, data: { id: params?.id, ...params } };
    }
    if (action === 'cron_disable' || action === 'cron_enable') {
      return { success: true, data: { id: params?.id, status: action === 'cron_disable' ? 'disabled' : 'enabled' } };
    }
    if (action === 'cron_delete') {
      return { success: true, data: { id: params?.id } };
    }
    return { success: true, data: {} };
  }),
}));

describe('Competitors FastCron Control Plane API Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/competitors/cron lists matching FastCron jobs for workspace', async () => {
    const res = await competitorCronApi.GET({
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          TOKEN_KEK: 'test_token_kek_secret_key_12345678',
          competitorsClient: mockTokenAdmin,
        },
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.jobs)).toBe(true);
    expect(json.jobs.length).toBe(1);
    expect(json.jobs[0].id).toBe(88801);
    expect(json.jobs[0].status).toBe('active');
  });

  it('POST /api/competitors/cron action=sync_missing detects existing job and returns success', async () => {
    const res = await competitorCronApi.POST({
      request: new Request('https://example.com/api/competitors/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_missing' }),
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          TOKEN_KEK: 'test_token_kek_secret_key_12345678',
          competitorsClient: mockTokenAdmin,
        },
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.count).toBe(1);
  });

  it('POST /api/competitors/cron action=pause updates schedule status', async () => {
    const res = await competitorCronApi.POST({
      request: new Request('https://example.com/api/competitors/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause', job_id: 88801 }),
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          TOKEN_KEK: 'test_token_kek_secret_key_12345678',
          competitorsClient: mockTokenAdmin,
        },
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.message).toContain('paused');
  });

  it('DELETE /api/competitors/cron deletes schedule from FastCron and resets DB status', async () => {
    const res = await competitorCronApi.DELETE({
      request: new Request('https://example.com/api/competitors/cron?job_id=88801', {
        method: 'DELETE',
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          TOKEN_KEK: 'test_token_kek_secret_key_12345678',
          competitorsClient: mockTokenAdmin,
        },
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.message).toContain('deleted');
  });
});
