import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as getArchivedUsernamesHandler } from '../../pages/api/pinarchive/archived-usernames';
import { POST as importAccountsHandler } from '../../pages/api/pinarchive/accounts-import';
import { dbClients } from '../db/clients';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { HttpError } from '../lib/http-error';
import { gasCall } from '../lib/gas-bridge';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(),
}));

vi.mock('../lib/gas-bridge', () => ({
  gasCall: vi.fn(),
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

describe('PinArchive Competitor Import & Bridge Test Suite', () => {
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
    vi.mocked(gasCall).mockResolvedValue({ ok: true, action: 'add_account' });
  });

  describe('1. GET /api/pinarchive/archived-usernames', () => {
    it('returns 401 when user session is missing', async () => {
      const req = new Request(`http://localhost:4321/api/pinarchive/archived-usernames?workspace_id=${mockWsId}`);
      const res = await getArchivedUsernamesHandler({
        request: req,
        locals: { user: null, supabase: null, activeWorkspaceId: mockWsId },
      } as any);
      expect(res.status).toBe(401);
    });

    it('returns 400 on invalid workspace identifier', async () => {
      const req = new Request(`http://localhost:4321/api/pinarchive/archived-usernames?workspace_id=invalid-id`);
      const res = await getArchivedUsernamesHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: 'invalid-id' },
      } as any);
      expect(res.status).toBe(400);
    });

    it('guard is invoked with (client, workspaceId, userId, "member") — never (locals, ...)', async () => {
      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      });

      const mockSupabase = { from: vi.fn() };
      const req = new Request(`http://localhost:4321/api/pinarchive/archived-usernames?workspace_id=${mockWsId}`);
      await getArchivedUsernamesHandler({
        request: req,
        locals: { user: mockUser, supabase: mockSupabase, activeWorkspaceId: mockWsId },
      } as any);

      expect(assertWorkspaceAccess).toHaveBeenCalledWith(
        mockSupabase,
        mockWsId,
        mockUser.id,
        'member'
      );
    });

    it('returns normalized unique archived usernames scoped to workspace', async () => {
      let queriedWsId: string | null = null;

      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation((col: string, val: string) => {
            if (col === 'workspace_id') queriedWsId = val;
            return {
              limit: vi.fn().mockResolvedValue({
                data: [
                  { username: '@TastyKeto' },
                  { username: 'tastyketo' },
                  { username: 'BakingQueen' },
                  { username: null },
                ],
                error: null,
              }),
            };
          }),
        }),
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/archived-usernames?workspace_id=${mockWsId}`);
      const res = await getArchivedUsernamesHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(queriedWsId).toBe(mockWsId);
      expect(json.usernames).toEqual(['tastyketo', 'bakingqueen']);
    });
  });

  describe('2. POST /api/pinarchive/accounts-import', () => {
    it('guard is invoked with (client, workspaceId, userId, "admin") — never (locals, ...)', async () => {
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
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'acc-uuid-1', username: 'testuser' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      });

      const mockSupabase = { from: vi.fn() };
      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts: [{ username: 'testuser' }],
        }),
      });

      await importAccountsHandler({
        request: req,
        locals: { user: mockUser, supabase: mockSupabase, activeWorkspaceId: mockWsId },
      } as any);

      expect(assertWorkspaceAccess).toHaveBeenCalledWith(
        mockSupabase,
        mockWsId,
        mockUser.id,
        'admin'
      );
    });

    it('returns 403 when user does not have admin permissions', async () => {
      vi.mocked(assertWorkspaceAccess).mockRejectedValueOnce(
        new HttpError(403, 'Forbidden: insufficient workspace role.')
      );

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts: [{ username: 'competitor1' }],
        }),
      });

      const res = await importAccountsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(403);
    });

    it('returns 422 if accounts array is empty', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts: [],
        }),
      });

      const res = await importAccountsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(422);
    });

    it('returns 422 when batch size exceeds max limit (> 50)', async () => {
      const tooManyAccounts = Array.from({ length: 51 }, (_, i) => ({ username: `user_${i}` }));

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts: tooManyAccounts,
        }),
      });

      const res = await importAccountsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('max 50');
    });

    it('returns 422 when dispatch is true and accounts count > 5', async () => {
      const accounts = Array.from({ length: 6 }, (_, i) => ({ username: `user_${i}` }));

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts,
          dispatch: true,
        }),
      });

      const res = await importAccountsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('max 5');
    });

    it('R1 IMMUTABILITY: preserves existing account row without overwriting status or ingest_enabled', async () => {
      let upsertCalls = 0;

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { workspace_id: mockWsId, ingest_enabled: true },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'acc-existing-1',
                      username: 'paused_user',
                      status: 'paused',
                      ingest_enabled: false,
                    },
                  ],
                  error: null,
                }),
              }),
            }),
            upsert: vi.fn().mockImplementation(() => {
              upsertCalls++;
              return { select: vi.fn().mockReturnValue({ single: vi.fn() }) };
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts: [{ username: '@paused_user' }],
        }),
      });

      const res = await importAccountsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.imported).toBe(0);
      expect(json.skipped).toBe(1);
      expect(json.results[0].status).toBe('already_archived');
      expect(json.results[0].ingest_enabled).toBe(false);
      expect(upsertCalls).toBe(0); // Zero writes
    });

    it('NEW ACCOUNT: inserts row and triggers GAS add_account bridge', async () => {
      let insertedRowData: any = null;

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { workspace_id: mockWsId, ingest_enabled: true },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
            upsert: vi.fn().mockImplementation((data: any) => {
              insertedRowData = data;
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'acc-new-uuid', username: 'fresh_creator' },
                    error: null,
                  }),
                }),
              };
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts: [{ username: 'fresh_creator' }],
        }),
      });

      const res = await importAccountsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.imported).toBe(1);
      expect(insertedRowData.interval_days).toBe(1);
      expect(insertedRowData.status).toBe('active');
      expect(insertedRowData.ingest_enabled).toBe(true);

      expect(gasCall).toHaveBeenCalledWith(
        expect.anything(),
        mockWsId,
        'add_account',
        expect.objectContaining({
          username: 'fresh_creator',
          workspace_id: mockWsId,
        })
      );
    });

    it('FAIL-LAZY: handles GAS bridge failure gracefully without failing the entire request', async () => {
      vi.mocked(gasCall).mockResolvedValueOnce({
        ok: false,
        error: 'Google Apps Script timeout after 8000ms',
      });

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
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'acc-uuid-1', username: 'unlucky_user' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts: [{ username: 'unlucky_user' }],
        }),
      });

      const res = await importAccountsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.imported).toBe(1);
      expect(json.results[0].gas_bridge).toBe('failed');
      expect(json.results[0].gas_error).toContain('timeout');
    });

    it('FEATURE_DISPATCH_NOW flag active -> triggers run GAS action', async () => {
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
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'acc-uuid-dispatch', username: 'fast_creator' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts: [{ username: 'fast_creator' }],
          dispatch: true,
        }),
      });

      const res = await importAccountsHandler({
        request: req,
        locals: {
          user: mockUser,
          supabase: {},
          activeWorkspaceId: mockWsId,
          runtimeEnv: { FEATURE_DISPATCH_NOW: 'true' },
        },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.results[0].dispatch_status).toBe('dispatched');

      expect(gasCall).toHaveBeenCalledWith(
        expect.anything(),
        mockWsId,
        'run',
        expect.objectContaining({
          username: 'fast_creator',
        })
      );
    });

    it('FEATURE_DISPATCH_NOW flag off/absent -> records deferred_flag_off status', async () => {
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
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'acc-uuid-dispatch', username: 'fast_creator' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          accounts: [{ username: 'fast_creator' }],
          dispatch: true,
        }),
      });

      const res = await importAccountsHandler({
        request: req,
        locals: {
          user: mockUser,
          supabase: {},
          activeWorkspaceId: mockWsId,
          runtimeEnv: {}, // Flag absent
        },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.results[0].dispatch_status).toBe('deferred_flag_off');
    });
  });
});
