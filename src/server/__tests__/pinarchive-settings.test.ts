import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as getSettingsHandler, PATCH as patchSettingsHandler } from '../../pages/api/pinarchive/settings';
import { POST as toggleAccountIngestHandler } from '../../pages/api/pinarchive/accounts-ingest-toggle';
import { dbClients } from '../db/clients';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { HttpError } from '../lib/http-error';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(),
}));

vi.mock('../db/clients', () => {
  const mockSchedulingAdmin = {
    from: vi.fn(),
  };

  const mockPinArchive = {
    from: vi.fn(),
  };

  return {
    isProductionEnv: vi.fn().mockReturnValue(false),
    isKnownDefaultIngestSecret: vi.fn().mockReturnValue(false),
    isKnownDefaultKek: vi.fn().mockReturnValue(false),
    getServerEnv: vi.fn().mockReturnValue({}),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockReturnValue(mockSchedulingAdmin),
      getPinArchive: vi.fn().mockReturnValue(mockPinArchive),
      getConfig: vi.fn().mockReturnValue({}),
    },
  };
});

describe('PinArchive Ingest Settings & Account Toggle API Suite', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockUser = { id: '00000000-0000-0000-0000-000000000099', email: 'admin@example.com' };
  let mockPinArchiveClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPinArchiveClient = dbClients.getPinArchive();
    vi.mocked(assertWorkspaceAccess).mockResolvedValue({
      workspaceId: mockWsId,
      role: 'admin',
      isAdmin: true,
      isOwner: true,
    });
  });

  describe('1. GET /api/pinarchive/settings', () => {
    it('returns 401 when session or supabase is missing', async () => {
      const req = new Request(`http://localhost:4321/api/pinarchive/settings?workspace_id=${mockWsId}`);
      const res = await getSettingsHandler({
        request: req,
        locals: { user: null, supabase: null, activeWorkspaceId: mockWsId },
      } as any);
      expect(res.status).toBe(401);
    });

    it('returns default settings with is_default: true when no row exists without writing to DB', async () => {
      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/settings?workspace_id=${mockWsId}`);
      const res = await getSettingsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.workspace_id).toBe(mockWsId);
      expect(json.ingest_enabled).toBe(true);
      expect(json.paused_account_policy).toBe('reject');
      expect(json.default_interval_days).toBe(3);
      expect(json.max_batch_pins).toBe(500);
      expect(json.pin_filter_min_saves).toBe(0);
      expect(json.pin_filter_min_repins).toBe(0);
      expect(json.pin_filter_max_age_days).toBe(0);
      expect(json.is_default).toBe(true);
    });

    it('returns stored row when settings exist', async () => {
      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                workspace_id: mockWsId,
                ingest_enabled: false,
                paused_account_policy: 'accept',
                default_interval_days: 7,
                max_batch_pins: 1200,
                pin_filter_min_saves: 500,
                pin_filter_min_repins: 100,
                pin_filter_max_age_days: 90,
                updated_at: '2026-08-23T12:00:00Z',
              },
              error: null,
            }),
          }),
        }),
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/settings?workspace_id=${mockWsId}`);
      const res = await getSettingsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.ingest_enabled).toBe(false);
      expect(json.paused_account_policy).toBe('accept');
      expect(json.default_interval_days).toBe(7);
      expect(json.max_batch_pins).toBe(1200);
      expect(json.pin_filter_min_saves).toBe(500);
      expect(json.pin_filter_min_repins).toBe(100);
      expect(json.pin_filter_max_age_days).toBe(90);
      expect(json.is_default).toBe(false);
    });
  });

  describe('2. PATCH /api/pinarchive/settings', () => {
    it('returns 403 when user is only a member', async () => {
      vi.mocked(assertWorkspaceAccess).mockRejectedValueOnce(
        new HttpError(403, 'Forbidden: insufficient workspace role.')
      );

      const req = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, ingest_enabled: false }),
      });

      const res = await patchSettingsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(403);
    });

    it('rejects unknown payload keys with 422', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, malicious_key: 'hacked' }),
      });

      const res = await patchSettingsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Unknown setting key');
    });

    it('validates ranges and enums (paused_account_policy, default_interval_days, max_batch_pins, pin_filter_*)', async () => {
      // Invalid policy
      const req1 = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, paused_account_policy: 'invalid_policy' }),
      });
      const res1 = await patchSettingsHandler({
        request: req1,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res1.status).toBe(422);

      // Invalid interval < 1
      const req2 = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, default_interval_days: 0 }),
      });
      const res2 = await patchSettingsHandler({
        request: req2,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res2.status).toBe(422);

      // Invalid interval > 30
      const req3 = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, default_interval_days: 35 }),
      });
      const res3 = await patchSettingsHandler({
        request: req3,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res3.status).toBe(422);

      // Invalid max batch > 5000
      const req4 = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, max_batch_pins: 9999 }),
      });
      const res4 = await patchSettingsHandler({
        request: req4,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res4.status).toBe(422);

      // Invalid min_saves > 1000000 or negative
      const req5 = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, pin_filter_min_saves: -1 }),
      });
      const res5 = await patchSettingsHandler({
        request: req5,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res5.status).toBe(422);

      // Invalid min_repins > 1000000
      const req6 = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, pin_filter_min_repins: 2000000 }),
      });
      const res6 = await patchSettingsHandler({
        request: req6,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res6.status).toBe(422);

      // Invalid max_age_days > 3650
      const req7 = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, pin_filter_max_age_days: 4000 }),
      });
      const res7 = await patchSettingsHandler({
        request: req7,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res7.status).toBe(422);
    });

    it('successfully upserts settings for admin and returns saved row', async () => {
      let savedPayload: any = null;

      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        upsert: vi.fn().mockImplementation((payload: any) => {
          savedPayload = payload;
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { ...payload, updated_at: '2026-08-23T20:00:00Z' },
                error: null,
              }),
            }),
          };
        }),
      });

      const req = new Request('http://localhost:4321/api/pinarchive/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          ingest_enabled: false,
          paused_account_policy: 'accept',
          default_interval_days: 5,
          max_batch_pins: 1000,
          pin_filter_min_saves: 250,
          pin_filter_min_repins: 50,
          pin_filter_max_age_days: 180,
        }),
      });

      const res = await patchSettingsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.ingest_enabled).toBe(false);
      expect(json.paused_account_policy).toBe('accept');
      expect(json.default_interval_days).toBe(5);
      expect(json.max_batch_pins).toBe(1000);
      expect(json.pin_filter_min_saves).toBe(250);
      expect(json.pin_filter_min_repins).toBe(50);
      expect(json.pin_filter_max_age_days).toBe(180);
      expect(savedPayload.workspace_id).toBe(mockWsId);
      expect(savedPayload.pin_filter_min_saves).toBe(250);
    });
  });

  describe('3. POST /api/pinarchive/accounts-ingest-toggle', () => {
    const mockAccId1 = '00000000-0000-0000-0000-000000000011';
    const mockAccId2 = '00000000-0000-0000-0000-000000000022';

    it('returns 403 when non-admin tries to toggle account ingestion', async () => {
      vi.mocked(assertWorkspaceAccess).mockRejectedValueOnce(
        new HttpError(403, 'Forbidden: insufficient workspace role.')
      );

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-ingest-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          account_ids: [mockAccId1],
          ingest_enabled: false,
        }),
      });

      const res = await toggleAccountIngestHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(403);
    });

    it('successfully updates ingest_enabled for specified accounts scoped to workspace', async () => {
      let updatePayload: any = null;
      let scopedWsId: string | null = null;
      let scopedInIds: string[] | null = null;

      mockPinArchiveClient.from.mockReturnValue({
        update: vi.fn().mockImplementation((payload: any) => {
          updatePayload = payload;
          return {
            eq: vi.fn().mockImplementation((col: string, val: string) => {
              if (col === 'workspace_id') scopedWsId = val;
              return {
                in: vi.fn().mockImplementation((inCol: string, inVals: string[]) => {
                  if (inCol === 'id') scopedInIds = inVals;
                  return {
                    select: vi.fn().mockResolvedValue({
                      data: [{ id: mockAccId1 }, { id: mockAccId2 }],
                      count: 2,
                      error: null,
                    }),
                  };
                }),
              };
            }),
          };
        }),
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-ingest-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          account_ids: [mockAccId1, mockAccId2],
          ingest_enabled: false,
        }),
      });

      const res = await toggleAccountIngestHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.updated).toBe(2);
      expect(updatePayload).toEqual({ ingest_enabled: false });
      expect(scopedWsId).toBe(mockWsId);
      expect(scopedInIds).toEqual([mockAccId1, mockAccId2]);
    });
  });
});
