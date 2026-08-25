import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DELETE as metricsDeleteHandler } from '../../pages/api/pinarchive/metrics';
import { dbClients } from '../db/clients';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { HttpError } from '../lib/http-error';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(),
}));

vi.mock('../db/clients', () => {
  const mockPinArchive = {
    from: vi.fn(),
  };

  return {
    isProductionEnv: vi.fn().mockReturnValue(false),
    isKnownDefaultIngestSecret: vi.fn().mockReturnValue(false),
    isKnownDefaultKek: vi.fn().mockReturnValue(false),
    getServerEnv: vi.fn().mockReturnValue({}),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockReturnValue({}),
      getPinArchive: vi.fn().mockReturnValue(mockPinArchive),
      getConfig: vi.fn().mockReturnValue({}),
    },
  };
});

describe('PinArchive Metrics Snapshot Delete Endpoint (DELETE /api/pinarchive/metrics)', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockMetricId1 = '11111111-1111-1111-1111-111111111111';
  const mockMetricId2 = '22222222-2222-2222-2222-222222222222';
  const mockUser = { id: 'user-uuid-1234', email: 'user@example.com' };
  let mockPinArchiveClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPinArchiveClient = dbClients.getPinArchive();
    vi.mocked(assertWorkspaceAccess).mockResolvedValue({
      workspaceId: mockWsId,
      role: 'admin',
      isAdmin: true,
      isOwner: false,
    });
  });

  // 1) 401 when locals has no user/supabase
  it('returns 401 when user session or supabase client is missing', async () => {
    const req = new Request('http://localhost:4321/api/pinarchive/metrics', {
      method: 'DELETE',
      body: JSON.stringify({ metric_ids: [mockMetricId1] }),
    });

    const resNoUser = await metricsDeleteHandler({
      request: req,
      locals: { user: null, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(resNoUser.status).toBe(401);
    const jsonNoUser = await resNoUser.json();
    expect(jsonNoUser.error).toContain('Unauthorized: missing session');

    const resNoSb = await metricsDeleteHandler({
      request: req,
      locals: { user: mockUser, supabase: null, activeWorkspaceId: mockWsId },
    } as any);
    expect(resNoSb.status).toBe(401);
  });

  // 2) 400 invalid JSON body
  it('returns 400 on invalid JSON body', async () => {
    const req = new Request('http://localhost:4321/api/pinarchive/metrics', {
      method: 'DELETE',
      body: 'invalid-json-content',
    });
    const res = await metricsDeleteHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid JSON payload');
  });

  // 3) 400 non-UUID in metric_ids
  it('returns 400 when metric_ids is empty or contains non-UUID', async () => {
    const reqEmpty = new Request('http://localhost:4321/api/pinarchive/metrics', {
      method: 'DELETE',
      body: JSON.stringify({ metric_ids: [] }),
    });
    const resEmpty = await metricsDeleteHandler({
      request: reqEmpty,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(resEmpty.status).toBe(400);

    const reqInvalid = new Request('http://localhost:4321/api/pinarchive/metrics', {
      method: 'DELETE',
      body: JSON.stringify({ metric_ids: ['not-a-valid-uuid'] }),
    });
    const resInvalid = await metricsDeleteHandler({
      request: reqInvalid,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(resInvalid.status).toBe(400);
    const jsonInvalid = await resInvalid.json();
    expect(jsonInvalid.error).toContain('Invalid metric identifier format');
  });

  // 4) 422 when metric_ids.length > 100
  it('returns 422 when metric_ids batch limit exceeds 100', async () => {
    const overflowIds = Array.from({ length: 101 }, (_, i) =>
      `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
    );
    const req = new Request('http://localhost:4321/api/pinarchive/metrics', {
      method: 'DELETE',
      body: JSON.stringify({ metric_ids: overflowIds }),
    });
    const res = await metricsDeleteHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('metric_ids batch limit exceeded: max 100');
  });

  // 5) 403 when assertWorkspaceAccess throws (member role) — assert it was called with 'admin'
  it('returns 403 when assertWorkspaceAccess rejects and verifies admin role requirement', async () => {
    vi.mocked(assertWorkspaceAccess).mockRejectedValueOnce(
      new HttpError(403, 'Forbidden: insufficient workspace role.')
    );

    const req = new Request('http://localhost:4321/api/pinarchive/metrics', {
      method: 'DELETE',
      body: JSON.stringify({ metric_ids: [mockMetricId1] }),
    });
    const res = await metricsDeleteHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);

    expect(res.status).toBe(403);
    expect(assertWorkspaceAccess).toHaveBeenCalledWith(expect.anything(), mockWsId, mockUser.id, 'admin');
  });

  // 6) 200 happy path: assert delete builder used .eq('workspace_id', '<ws>') and .in('id', [<ids>]), response {success:true, deleted:N}
  it('deletes metric snapshots on happy path and verifies query builder filters', async () => {
    const inMock = vi.fn().mockReturnValue({
      select: vi.fn().mockResolvedValue({
        data: [{ id: mockMetricId1 }, { id: mockMetricId2 }],
        count: 2,
        error: null,
      }),
    });
    const eqMock = vi.fn().mockReturnValue({ in: inMock });
    const deleteMock = vi.fn().mockReturnValue({ eq: eqMock });

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_pin_metrics') {
        return { delete: deleteMock };
      }
      return {};
    });

    const req = new Request('http://localhost:4321/api/pinarchive/metrics', {
      method: 'DELETE',
      body: JSON.stringify({ metric_ids: [mockMetricId1, mockMetricId2] }),
    });
    const res = await metricsDeleteHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.deleted).toBe(2);

    expect(mockPinArchiveClient.from).toHaveBeenCalledWith('pa_pin_metrics');
    expect(eqMock).toHaveBeenCalledWith('workspace_id', mockWsId);
    expect(inMock).toHaveBeenCalledWith('id', [mockMetricId1, mockMetricId2]);
  });

  // 7) 500 when delete returns error
  it('returns 500 when delete operation returns an error', async () => {
    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_pin_metrics') {
        return {
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                select: vi.fn().mockResolvedValue({
                  data: null,
                  count: null,
                  error: { message: 'Database delete failed' },
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const req = new Request('http://localhost:4321/api/pinarchive/metrics', {
      method: 'DELETE',
      body: JSON.stringify({ metric_ids: [mockMetricId1] }),
    });
    const res = await metricsDeleteHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('Database delete failed');
  });
});
