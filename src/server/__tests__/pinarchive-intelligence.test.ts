import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as notesHandler } from '../../pages/api/pinarchive/notes';
import { GET as pinsHandler } from '../../pages/api/pinarchive/pins';
import { GET as pinDetailHandler } from '../../pages/api/pinarchive/pin';
import { POST as accountsDeleteHandler } from '../../pages/api/pinarchive/accounts-delete';
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

describe('PinArchive Intelligence Upgrade Test Suite (T1, T2, T3)', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockPinId = '09d8e32e-ecaf-4315-8776-d76d8b6e7067';
  const mockUser = { id: 'user-uuid-1234', email: 'user@example.com' };
  let mockPinArchiveClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPinArchiveClient = dbClients.getPinArchive();
    vi.mocked(assertWorkspaceAccess).mockResolvedValue({
      workspaceId: mockWsId,
      role: 'member',
      isAdmin: false,
      isOwner: false,
    });
  });

  describe('1. Notes Endpoint (POST /api/pinarchive/notes)', () => {
    it('returns 401 when session is missing', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/notes', {
        method: 'POST',
        body: JSON.stringify({ pin_id: mockPinId, notes: 'Test note' }),
      });
      const res = await notesHandler({
        request: req,
        locals: { user: null, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res.status).toBe(401);
    });

    it('returns 400 on invalid JSON or missing pin_id', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/notes', {
        method: 'POST',
        body: JSON.stringify({ pin_id: 'bad-id', notes: 'Test note' }),
      });
      const res = await notesHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Invalid pin identifier format');
    });

    it('returns 400 when notes exceed 2000 chars', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/notes', {
        method: 'POST',
        body: JSON.stringify({ pin_id: mockPinId, notes: 'a'.repeat(2001) }),
      });
      const res = await notesHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('2000 characters');
    });

    it('updates notes and returns 200 with timestamp', async () => {
      mockPinArchiveClient.from.mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: mockPinId, notes: 'Double chocolate angle', notes_updated_at: '2026-08-23T03:00:00Z' },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      });

      const req = new Request('http://localhost:4321/api/pinarchive/notes', {
        method: 'POST',
        body: JSON.stringify({ pin_id: mockPinId, notes: 'Double chocolate angle' }),
      });
      const res = await notesHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.notes).toBe('Double chocolate angle');
    });
  });

  describe('2. Pins Filters & Computed Stage / Anomaly (GET /api/pinarchive/pins)', () => {
    it('applies filters and computes stages and anomalies correctly', async () => {
      const mockRawPins = [
        {
          id: mockPinId,
          pin_id: '1079245498222414527',
          title: 'Delicious Keto Bread',
          saves: 25000,
          velocity: 15.2, // >= 10 -> GROWING
          created_at_pinterest: '2026-08-01T00:00:00Z',
          workspace_id: mockWsId,
        },
        {
          id: '00000000-0000-0000-0000-000000000002',
          pin_id: '1079245498222414528',
          title: 'Brand New Pin',
          saves: 100,
          velocity: 3.0,
          created_at_pinterest: new Date(Date.now() - 5 * 86400000).toISOString(), // 5 days old <= 14 -> NEW
          workspace_id: mockWsId,
        },
        {
          id: '00000000-0000-0000-0000-000000000003',
          pin_id: '1079245498222414529',
          title: 'Dormant Old Pin',
          saves: 500,
          velocity: 0.1, // < 0.5 -> DORMANT
          created_at_pinterest: '2025-01-01T00:00:00Z',
          workspace_id: mockWsId,
        },
      ];

      const mockMetrics = [
        // Snapshot 1 (latest)
        { pin_ref: mockPinId, recorded_at: '2026-08-23T00:00:00Z', saves: 25000 },
        // Snapshot 2 (prior 1 day ago) - delta = 500 saves >= max(20, 3*15.2*1) -> SPIKE anomaly!
        { pin_ref: mockPinId, recorded_at: '2026-08-22T00:00:00Z', saves: 24500 },
      ];

      const queryBuilder: any = {
        eq: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: mockRawPins, error: null }),
      };

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    pin_filter_min_saves: 50,
                    pin_filter_min_repins: 10,
                    pin_filter_max_age_days: 365,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockReturnValue(queryBuilder),
          };
        }
        if (table === 'pa_pin_metrics') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: mockMetrics, error: null }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/pins?q=Keto&in_cluster=1');
      const res = await pinsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.pins.length).toBe(3);
      expect(queryBuilder.gte).toHaveBeenCalledWith('saves', 50);
      expect(queryBuilder.gte).toHaveBeenCalledWith('repins', 10);

      // Verify computed properties
      const pin1 = json.pins[0];
      expect(pin1.stage).toBe('GROWING');
      expect(pin1.anomaly).toBe('SPIKE');
      expect(pin1.delta_saves).toBe(500);

      const pin2 = json.pins[1];
      expect(pin2.stage).toBe('NEW');

      const pin3 = json.pins[2];
      expect(pin3.stage).toBe('DORMANT');
    });

    it('validates account_id query param: 422 on invalid UUID, applies .eq on valid UUID', async () => {
      // Invalid UUID
      const reqInvalid = new Request('http://localhost:4321/api/pinarchive/pins?account_id=invalid-uuid');
      const resInvalid = await pinsHandler({
        request: reqInvalid,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(resInvalid.status).toBe(422);

      // Valid UUID
      const mockAccId = '00000000-0000-0000-0000-000000000099';
      const queryBuilder: any = {
        eq: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      };

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        if (table === 'pa_pins') {
          return { select: vi.fn().mockReturnValue(queryBuilder) };
        }
        return {};
      });

      const reqValid = new Request(`http://localhost:4321/api/pinarchive/pins?account_id=${mockAccId}`);
      const resValid = await pinsHandler({
        request: reqValid,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(resValid.status).toBe(200);
      expect(queryBuilder.eq).toHaveBeenCalledWith('account_id', mockAccId);
    });
  });

  describe('3. Single Pin Detail with Deltas and Cluster Consolidation (GET /api/pinarchive/pin)', () => {
    it('returns computed deltas, stage, anomaly, and cluster consolidation ranking', async () => {
      const mockPin = {
        id: mockPinId,
        pin_id: '1079245498222414527',
        title: 'Best Low Carb Recipes',
        saves: 23887,
        repins: 21346,
        velocity: 120.5,
        canonical_pin_id: '1075797429758900343',
        created_at_pinterest: '2026-07-01T00:00:00Z',
        workspace_id: mockWsId,
      };

      const mockMetrics = [
        { recorded_at: '2026-08-22T00:00:00Z', saves: 20000, repins: 18000, comments: 10, shares: 500, reactions_total: 100 },
        { recorded_at: '2026-08-23T00:00:00Z', saves: 23887, repins: 21346, comments: 34, shares: 1602, reactions_total: 705 },
      ];

      const mockClusterRows = [
        { id: mockPinId, pin_id: '1079245498222414527', title: 'Best Low Carb Recipes', saves: 23887 },
        { id: 'sibling-uuid-2222', pin_id: '1075797429758900343', title: 'Low Carb Bread Bun', saves: 10000 },
      ];

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockImplementation((cols: string) => {
              if (cols === '*') {
                return {
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({ data: mockPin, error: null }),
                    }),
                  }),
                };
              }
              // Cluster consolidation select
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({ data: mockClusterRows, error: null }),
                    }),
                  }),
                }),
              };
            }),
          };
        }
        if (table === 'pa_pin_metrics') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: mockMetrics, error: null }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/pin?id=${mockPinId}`);
      const res = await pinDetailHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.pin.stage).toBe('GROWING');
      expect(json.pin.deltas.saves).toBe(3887);
      expect(json.pin.deltas.repins).toBe(3346);
      expect(json.cluster_stats.total_saves).toBe(33887);
      expect(json.cluster_stats.variations_count).toBe(2);
      expect(json.cluster_stats.rank).toBe(1);
      expect(json.cluster_stats.share_pct).toBe(70);
    });
  });

  describe('4. Bulk Accounts Delete Endpoint (POST /api/pinarchive/accounts-delete)', () => {
    const mockAccId1 = '00000000-0000-0000-0000-000000000010';
    const mockAccId2 = '00000000-0000-0000-0000-000000000020';

    it('returns 401 when session is missing', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/accounts-delete', {
        method: 'POST',
        body: JSON.stringify({ account_ids: [mockAccId1] }),
      });
      const res = await accountsDeleteHandler({
        request: req,
        locals: { user: null, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res.status).toBe(401);
    });

    it('returns 403 when user is not an admin', async () => {
      vi.mocked(assertWorkspaceAccess).mockRejectedValueOnce(new HttpError(403, 'Forbidden: Admin access required'));

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-delete', {
        method: 'POST',
        body: JSON.stringify({ account_ids: [mockAccId1] }),
      });
      const res = await accountsDeleteHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res.status).toBe(403);
    });

    it('returns 400 when account_ids is missing or invalid', async () => {
      const req1 = new Request('http://localhost:4321/api/pinarchive/accounts-delete', {
        method: 'POST',
        body: JSON.stringify({ account_ids: [] }),
      });
      const res1 = await accountsDeleteHandler({
        request: req1,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res1.status).toBe(400);

      const req2 = new Request('http://localhost:4321/api/pinarchive/accounts-delete', {
        method: 'POST',
        body: JSON.stringify({ account_ids: ['not-a-uuid'] }),
      });
      const res2 = await accountsDeleteHandler({
        request: req2,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res2.status).toBe(400);
    });

    it('deletes accounts and returns 200 with deleted count', async () => {
      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ count: 2, error: null }),
              }),
            }),
            delete: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-delete', {
        method: 'POST',
        body: JSON.stringify({ account_ids: [mockAccId1, mockAccId2] }),
      });
      const res = await accountsDeleteHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.deleted).toBe(2);
    });
  });
});
