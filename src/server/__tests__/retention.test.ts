import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as postRunCleanup } from '../../pages/api/settings/run-cleanup';
import { POST as postInternalCleanup } from '../../pages/api/internal/pinterest/cleanup-retention';
import { GET as getRetentionHandler, PATCH as patchRetentionHandler } from '../../pages/api/settings/retention';
import { runRetentionCleanup } from '../services/retention-cleanup';
import { dbClients } from '../db/clients';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { getEffectiveSecret } from '../services/webhook-secrets';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue({
    id: 'mem-1',
    role: 'admin',
    isAdmin: true,
    isOwner: false,
  }),
}));

vi.mock('../services/webhook-secrets', () => ({
  getEffectiveSecret: vi.fn().mockResolvedValue({ value: 'valid_test_secret_123', source: 'workspace' }),
}));

let mockUpsertFn: any;
let mockDeleteFn: any;
let mockUpdateFn: any;
let mockRpcFn: any;
let mockMaybeSingleData: any = {
  workspace_id: '00000000-0000-0000-0000-000000000001',
  auto_prune_enabled: true,
  p2_prune_enabled: false,
  p3_prune_enabled: true,
  retention_posted_days: 30,
  retention_terminal_days: 90,
  retention_logs_days: 14,
  import_sessions_days: 30,
  processing_timeout_minutes: 45,
  competitor_snapshots_days: 90,
  competitor_jobs_days: 30,
  ingestion_runs_days: 30,
  top_pins_raw_days: 180,
  top_pins_downsample_enabled: false,
  analytics_daily_keep_days: null,
  last_cleanup_at: '2026-08-20T12:00:00Z',
  last_cleanup_result: {
    at: '2026-08-20T12:00:00Z',
    trigger: 'api',
    swept_pins: 0,
    warnings: [],
    sections: {
      p1: { pins: 5, terminal: 0, logs: 0, sessions: 0 },
      p2: null,
      p3: { runs: 0, snapshots: 2 },
    },
  },
};

vi.mock('../db/clients', () => {
  return {
    isProductionEnv: vi.fn().mockReturnValue(false),
    isKnownDefaultIngestSecret: vi.fn().mockReturnValue(false),
    isKnownDefaultKek: vi.fn().mockReturnValue(false),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockImplementation(() => {
        const q: any = {
          select: vi.fn(() => q),
          delete: vi.fn(() => {
            mockDeleteFn();
            return q;
          }),
          update: vi.fn(() => {
            mockUpdateFn();
            return q;
          }),
          upsert: vi.fn((data: any) => {
            mockUpsertFn(data);
            return q;
          }),
          eq: vi.fn(() => q),
          or: vi.fn(() => q),
          lt: vi.fn(() => q),
          gte: vi.fn(() => q),
          in: vi.fn(() => q),
          limit: vi.fn().mockImplementation((n: number) => {
            return Promise.resolve({
              data: [{ id: 'row-1' }, { id: 'row-2' }, { id: 'row-3' }, { id: 'row-4' }, { id: 'row-5' }],
              error: null,
            });
          }),
          single: vi.fn().mockResolvedValue({ data: mockMaybeSingleData, error: null }),
          maybeSingle: vi.fn().mockImplementation(() => Promise.resolve({ data: mockMaybeSingleData, error: null })),
          then: (resolve: any, reject: any) =>
            Promise.resolve({ data: mockMaybeSingleData, count: 5, error: null }).then(resolve, reject),
        };
        return {
          from: vi.fn(() => q),
          rpc: vi.fn((name: string, params: any) => {
            mockRpcFn(name, params);
            if (name === 'purge_old_pin_delivery_logs') return Promise.resolve({ data: 3, error: null });
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }),
      getAnalytics: vi.fn().mockImplementation(() => {
        const q: any = {
          select: vi.fn(() => q),
          delete: vi.fn(() => q),
          eq: vi.fn(() => q),
          lt: vi.fn(() => q),
          in: vi.fn(() => q),
          limit: vi.fn().mockResolvedValue({ data: [{ id: 'snap-1' }, { id: 'snap-2' }], error: null }),
          then: (resolve: any, reject: any) =>
            Promise.resolve({ count: 2, error: null }).then(resolve, reject),
        };
        return {
          from: vi.fn(() => q),
          rpc: vi.fn((name: string, params: any) => {
            mockRpcFn(name, params);
            if (name === 'purge_old_analytics_ingestion_runs') return Promise.resolve({ data: { deleted_runs: 4 }, error: null });
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }),
      getCompetitors: vi.fn().mockImplementation(() => {
        const q: any = {
          select: vi.fn(() => q),
          delete: vi.fn(() => q),
          eq: vi.fn(() => q),
          lt: vi.fn(() => q),
          then: (resolve: any, reject: any) =>
            Promise.resolve({ count: 0, error: null }).then(resolve, reject),
        };
        return {
          from: vi.fn(() => q),
          rpc: vi.fn((name: string, params: any) => {
            mockRpcFn(name, params);
            if (name === 'purge_competitor_retention') return Promise.resolve({ data: { snapshots: 10, jobs: 2 }, error: null });
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }),
    },
  };
});

describe('Retention & Recovery Telemetry & Manual Run Suite', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertFn = vi.fn();
    mockDeleteFn = vi.fn();
    mockUpdateFn = vi.fn();
    mockRpcFn = vi.fn();
    mockMaybeSingleData = {
      workspace_id: workspaceId,
      auto_prune_enabled: true,
      p2_prune_enabled: false,
      p3_prune_enabled: true,
      retention_posted_days: 30,
      retention_terminal_days: 90,
      retention_logs_days: 14,
      import_sessions_days: 30,
      processing_timeout_minutes: 45,
      competitor_snapshots_days: 90,
      competitor_jobs_days: 30,
      ingestion_runs_days: 30,
      top_pins_raw_days: 180,
      top_pins_downsample_enabled: false,
      analytics_daily_keep_days: null,
      last_cleanup_at: '2026-08-20T12:00:00Z',
      last_cleanup_result: {
        at: '2026-08-20T12:00:00Z',
        trigger: 'api',
        swept_pins: 0,
        warnings: [],
        sections: {
          p1: { pins: 5, terminal: 0, logs: 0, sessions: 0 },
          p2: null,
          p3: { runs: 0, snapshots: 2 },
        },
      },
    };
  });

  // Test 1: Null guards and access control
  it('returns 401 without user and 403 when assertWorkspaceAccess rejects', async () => {
    // 1. Missing user
    const res1 = await postRunCleanup({
      request: new Request('http://localhost/api/settings/run-cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, section: 'p1' }),
      }),
      locals: {},
    } as any);
    expect(res1.status).toBe(401);

    // 2. Forbidden access
    (assertWorkspaceAccess as any).mockRejectedValueOnce(new Error('Forbidden: not an admin'));
    const res2 = await postRunCleanup({
      request: new Request('http://localhost/api/settings/run-cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, section: 'p1' }),
      }),
      locals: { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId },
    } as any);
    expect(res2.status).toBe(403);
  });

  // Test 2: Manual P1 override executes even when toggle is false
  it('run-cleanup section=p1 with auto_prune_enabled:false STILL executes P1 deletes and upserts telemetry', async () => {
    mockMaybeSingleData.auto_prune_enabled = false;

    const res = await postRunCleanup({
      request: new Request('http://localhost/api/settings/run-cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, section: 'p1' }),
      }),
      locals: { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.section).toBe('p1');
    expect(json.deleted_pins_count).toBe(5);
    expect(mockDeleteFn).toHaveBeenCalled();
    expect(mockUpsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: workspaceId,
        last_cleanup_at: expect.any(String),
        last_cleanup_result: expect.objectContaining({
          trigger: 'manual',
          sections: expect.objectContaining({
            p1: expect.objectContaining({ pins: 5 }),
          }),
        }),
      })
    );
  });

  // Test 3: Internal endpoint regression with toggles disabled
  it('internal endpoint regression: auto_prune_enabled false skips P1 deletes and returns deleted_pins_count: 0 with empty warnings', async () => {
    mockMaybeSingleData.auto_prune_enabled = false;
    mockMaybeSingleData.p2_prune_enabled = false;
    mockMaybeSingleData.p3_prune_enabled = false;

    const res = await postInternalCleanup({
      request: new Request('http://localhost/api/internal/pinterest/cleanup-retention', {
        method: 'POST',
        headers: {
          'x-ingest-secret': 'valid_test_secret_123',
          'x-workspace-id': workspaceId,
        },
      }),
      locals: {},
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.deleted_pins_count).toBe(0);
    expect(json.warnings).toEqual([]);
  });

  // Test 4: Validation on invalid or missing section
  it('returns 400 when section is invalid or missing', async () => {
    const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };

    // Invalid section name
    const res1 = await postRunCleanup({
      request: new Request('http://localhost/api/settings/run-cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, section: 'invalid' }),
      }),
      locals,
    } as any);
    expect(res1.status).toBe(400);

    // Missing section
    const res2 = await postRunCleanup({
      request: new Request('http://localhost/api/settings/run-cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      }),
      locals,
    } as any);
    expect(res2.status).toBe(400);
  });

  // Test 5: Section P2 when p2_prune_enabled is false skips deletes without override
  it('runRetentionCleanup without override when p2_prune_enabled is false skips P2 deletes with empty warnings', async () => {
    mockMaybeSingleData.p2_prune_enabled = false;

    const payload = await runRetentionCleanup(workspaceId, {}, { trigger: 'api' });

    expect(payload.p2).toBeNull();
    expect(payload.warnings).toEqual([]);
  });

  // Test 6: Telemetry payload structure assertion
  it('verifies telemetry payload structure in upsert with complete sections schema', async () => {
    await runRetentionCleanup(workspaceId, {}, { overrides: { p1: true, p3: true }, trigger: 'manual' });

    expect(mockUpsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: workspaceId,
        auto_prune_enabled: expect.any(Boolean),
        p2_prune_enabled: expect.any(Boolean),
        p3_prune_enabled: expect.any(Boolean),
        retention_posted_days: expect.any(Number),
        last_cleanup_at: expect.any(String),
        last_cleanup_result: expect.objectContaining({
          at: expect.any(String),
          trigger: 'manual',
          swept_pins: expect.any(Number),
          warnings: expect.any(Array),
          sections: expect.objectContaining({
            p1: expect.objectContaining({
              pins: expect.any(Number),
              terminal: expect.any(Number),
              logs: expect.any(Number),
              sessions: expect.any(Number),
            }),
            p2: null,
            p3: expect.objectContaining({
              runs: expect.any(Number),
              snapshots: expect.any(Number),
            }),
          }),
        }),
      })
    );
  });

  // Test 7: GET /api/settings/retention includes telemetry fields
  it('GET /api/settings/retention returns last_cleanup_at and last_cleanup_result fields', async () => {
    const res = await getRetentionHandler({
      request: new Request(`http://localhost/api/settings/retention?workspace_id=${workspaceId}`),
      locals: { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.last_cleanup_at).toBe('2026-08-20T12:00:00Z');
    expect(json.last_cleanup_result).toEqual(mockMaybeSingleData.last_cleanup_result);
  });

  // Test 8: Tier 3 Regression Test - No settings row in DB => zero deletes and auto_prune_enabled: false
  it('no settings row => zero deletes and telemetry upsert with auto_prune_enabled:false', async () => {
    mockMaybeSingleData = null;

    const payload = await runRetentionCleanup(workspaceId, {}, { trigger: 'api' });

    expect(payload.deleted_pins_count).toBe(0);
    expect(payload.deleted_terminal_pins_count).toBe(0);
    expect(payload.deleted_delivery_logs).toBe(0);
    expect(payload.deleted_import_sessions).toBe(0);
    expect(payload.auto_prune_enabled).toBe(false);
    expect(payload.p2_prune_enabled).toBe(false);
    expect(payload.p3_prune_enabled).toBe(false);
    expect(payload.warnings).toEqual([]);

    expect(mockUpsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: workspaceId,
        auto_prune_enabled: false,
        p2_prune_enabled: false,
        p3_prune_enabled: false,
        top_pins_downsample_enabled: false,
        analytics_daily_keep_days: null,
        ingestion_runs_days: 30,
        top_pins_raw_days: 180,
      })
    );
  });
});
