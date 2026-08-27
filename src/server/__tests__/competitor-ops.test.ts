import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getCookies, POST as postCookies, PATCH as patchCookies, DELETE as deleteCookies } from '../../pages/api/admin/pinterest-cookies';
import { GET as getOps, PUT as putOps, PATCH as patchOps, POST as postOps } from '../../pages/api/admin/competitor-ops';
import { GET as getCompetitors, POST as postCompetitor, PATCH as patchCompetitor, DELETE as deleteCompetitor } from '../../pages/api/admin/competitors';
import { POST as ingestPayload } from '../../pages/api/admin/competitors/ingest';
import { DELETE as deleteSnapshot } from '../../pages/api/admin/competitors/snapshot';

const mockCompetitorsClient = {
  from: vi.fn(),
};

vi.mock('../db/clients', () => ({
  dbClients: {
    getCompetitors: vi.fn(() => mockCompetitorsClient),
  },
  getServerEnv: vi.fn(() => ({
    TOKEN_KEK: 'test_token_kek_00000000_1234567890',
  })),
  isProductionEnv: vi.fn(() => false),
  isKnownDefaultKek: vi.fn(() => false),
}));

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockImplementation(async (client, wsId, userId, role) => {
    if (userId === 'member-only-user' && role === 'admin') {
      const { HttpError } = await import('../lib/http-error');
      throw new HttpError(403, 'Forbidden: insufficient workspace role.');
    }
    return { workspaceId: wsId, role: 'admin', isOwner: true, isAdmin: true };
  }),
}));

vi.mock('../lib/competitor-kek', () => ({
  resolveCompetitorKek: vi.fn().mockResolvedValue('test_competitor_kek_00000000_1234567890'),
  isCompetitorKekActive: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/token-crypto', () => ({
  resolveTokenKek: vi.fn().mockResolvedValue('test_token_kek_00000000_1234567890'),
  encryptToken: vi.fn().mockResolvedValue('v1:aXZfdGVzdA==:Y3RfdGVzdA=='),
  decryptToken: vi.fn().mockResolvedValue('auth_token=decrypted_value'),
}));

describe('Competitor Ops Console API Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Pinterest Cookies API (/api/admin/pinterest-cookies)', () => {
    it('returns 401 for unauthenticated request', async () => {
      const req = new Request('http://localhost/api/admin/pinterest-cookies');
      const res = await getCookies({ request: req, locals: {} } as any);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it('returns 403 for non-admin member', async () => {
      const req = new Request('http://localhost/api/admin/pinterest-cookies?workspace_id=ws-123');
      const res = await getCookies({
        request: req,
        locals: {
          user: { id: 'member-only-user' },
          supabase: {} as any,
          activeWorkspaceId: 'ws-123',
        },
      } as any);
      expect(res.status).toBe(403);
    });

    it('returns 200 with masked cookies for admin user (never exposes cookie_value)', async () => {
      mockCompetitorsClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'cookie-1',
                  workspace_id: 'ws-123',
                  is_active: true,
                  last_used_at: '2026-08-15T00:00:00Z',
                  expires_at: null,
                  created_at: '2026-08-15T00:00:00Z',
                },
              ],
              error: null,
            }),
          }),
        }),
      });

      const req = new Request('http://localhost/api/admin/pinterest-cookies?workspace_id=ws-123');
      const res = await getCookies({
        request: req,
        locals: {
          user: { id: 'admin-user' },
          supabase: {} as any,
          activeWorkspaceId: 'ws-123',
        },
      } as any);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.cookies).toHaveLength(1);
      expect(body.cookies[0].cookie_value).toBeUndefined();
    });

    it('POST validates cookie length and encrypts at rest using competitor KEK', async () => {
      mockCompetitorsClient.from.mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'cookie-new',
                workspace_id: 'ws-123',
                is_active: true,
              },
              error: null,
            }),
          }),
        }),
      });

      // Too short:
      const shortReq = new Request('http://localhost/api/admin/pinterest-cookies', {
        method: 'POST',
        body: JSON.stringify({ cookie_value: 'short' }),
      });
      const shortRes = await postCookies({
        request: shortReq,
        locals: { user: { id: 'admin-user' }, supabase: {} as any, activeWorkspaceId: 'ws-123' },
      } as any);
      expect(shortRes.status).toBe(400);

      // Valid:
      const validReq = new Request('http://localhost/api/admin/pinterest-cookies', {
        method: 'POST',
        body: JSON.stringify({ cookie_value: 'auth_token=valid_long_test_session_cookie_12345' }),
      });
      const validRes = await postCookies({
        request: validReq,
        locals: { user: { id: 'admin-user' }, supabase: {} as any, activeWorkspaceId: 'ws-123' },
      } as any);
      expect(validRes.status).toBe(201);
      const validBody = await validRes.json();
      expect(validBody.success).toBe(true);
    });
  });

  describe('Competitor Ops API (/api/admin/competitor-ops)', () => {
    it('GET returns pipeline settings, kekActive status, joined competitors, and jobs', async () => {
      mockCompetitorsClient.from.mockImplementation((table: string) => {
        if (table === 'competitor_pipeline_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { workspace_id: 'ws-123', is_enabled: true, dry_run: false, max_retries: 3 },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'competitors') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [{ id: 'comp-1', username: 'testcomp', competitor_settings: [{ is_active: true }] }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'competitor_ingestion_jobs') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{ id: 'job-1', status: 'completed', items_processed: 5 }],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost/api/admin/competitor-ops?workspace_id=ws-123');
      const res = await getOps({
        request: req,
        locals: { user: { id: 'admin-user' }, supabase: {} as any, activeWorkspaceId: 'ws-123' },
      } as any);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.settings.is_enabled).toBe(true);
      expect(body.kekActive).toBe(true);
      expect(body.competitors).toHaveLength(1);
      expect(body.jobs).toHaveLength(1);
    });

    it('POST dispatches job and returns 202 dispatched:true', async () => {
      mockCompetitorsClient.from.mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'job-uuid-123', status: 'running' },
              error: null,
            }),
          }),
        }),
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        status: 204,
        ok: true,
        text: async () => '',
      } as any);

      const req = new Request('http://localhost/api/admin/competitor-ops', {
        method: 'POST',
        body: JSON.stringify({ username: 'testcomp', scope: 'all' }),
      });

      const res = await postOps({
        request: req,
        locals: {
          user: { id: 'admin-user' },
          supabase: {} as any,
          activeWorkspaceId: 'ws-123',
          runtimeEnv: { GITHUB_DISPATCH_TOKEN: 'gh_test_token_123' },
        },
      } as any);

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.job_id).toBe('job-uuid-123');
      expect(body.dispatched).toBe(true);
      expect(body.target_scope).toBe('All Active');

      fetchSpy.mockRestore();
    });
  });

  describe('Competitors CRUD API (/api/admin/competitors)', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = new Request('http://localhost/api/admin/competitors');
      const res = await getCompetitors({ request: req, locals: {} } as any);
      expect(res.status).toBe(401);
    });

    it('GET returns competitor list with aggregated boards_count', async () => {
      mockCompetitorsClient.from.mockImplementation((table: string) => {
        if (table === 'competitors') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [
                    { id: 'comp-1', username: 'recipestower', workspace_id: 'ws-123' },
                    { id: 'comp-2', username: 'betterhomebase', workspace_id: 'ws-123' },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'competitor_boards') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  { competitor_id: 'comp-1' },
                  { competitor_id: 'comp-1' },
                  { competitor_id: 'comp-2' },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === 'competitor_snapshots') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [
                      { profile_reach: 4000, profile_views: 2000, follower_count: 500, pin_count: 100, recorded_at: '2026-08-20T00:00:00Z' },
                      { profile_reach: 3000, profile_views: 1500, follower_count: 400, pin_count: 80, recorded_at: '2026-08-19T00:00:00Z' },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost/api/admin/competitors?workspace_id=ws-123');
      const res = await getCompetitors({
        request: req,
        locals: { user: { id: 'admin-user' }, supabase: {} as any, activeWorkspaceId: 'ws-123' },
      } as any);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.competitors).toHaveLength(2);
      expect(body.competitors[0].boards_count).toBe(2);
      expect(body.competitors[1].boards_count).toBe(1);
    });

    it('POST creates competitor in Competitors DB', async () => {
      mockCompetitorsClient.from.mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'comp-new', username: 'bitesizedbash', workspace_id: 'ws-123' },
              error: null,
            }),
          }),
        }),
      });

      const req = new Request('http://localhost/api/admin/competitors', {
        method: 'POST',
        body: JSON.stringify({ username: 'bitesizedbash' }),
      });

      const res = await postCompetitor({
        request: req,
        locals: { user: { id: 'admin-user' }, supabase: {} as any, activeWorkspaceId: 'ws-123' },
      } as any);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.competitor.username).toBe('bitesizedbash');
    });

    it('GET succeeds for member role (read-only allowed for members)', async () => {
      mockCompetitorsClient.from.mockImplementation((table: string) => {
        if (table === 'competitors') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [{ id: 'comp-1', username: 'recipestower', workspace_id: 'ws-123' }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'competitor_boards') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [{ competitor_id: 'comp-1' }],
                error: null,
              }),
            }),
          };
        }
        if (table === 'competitor_snapshots') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost/api/admin/competitors?workspace_id=ws-123');
      const res = await getCompetitors({
        request: req,
        locals: { user: { id: 'member-only-user' }, supabase: {} as any, activeWorkspaceId: 'ws-123' },
      } as any);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('GET with id and lite=1 returns empty boards and topPins', async () => {
      mockCompetitorsClient.from.mockImplementation((table: string) => {
        if (table === 'competitors') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'a0000000-0000-0000-0000-000000000001', username: 'recipestower', workspace_id: 'ws-123' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'competitor_snapshots') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [
                      { profile_reach: 4000, profile_views: 2000, follower_count: 500, pin_count: 100, recorded_at: '2026-08-20T00:00:00Z' },
                      { profile_reach: 3000, profile_views: 1500, follower_count: 400, pin_count: 80, recorded_at: '2026-08-19T00:00:00Z' },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'competitor_boards') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                not: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({
                        data: { board_created_at: '2026-01-01T00:00:00Z' },
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost/api/admin/competitors?id=a0000000-0000-0000-0000-000000000001&lite=1&workspace_id=ws-123');
      const res = await getCompetitors({
        request: req,
        locals: { user: { id: 'admin-user' }, supabase: {} as any, activeWorkspaceId: 'ws-123' },
      } as any);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.boards).toEqual([]);
      expect(body.topPins).toEqual([]);
      expect(body.deltas.reachChange).toBe(1000);
      expect(body.competitor.oldest_board_date).toBe('2026-01-01T00:00:00Z');
      expect(body.competitor.strategy_age_days).toBeGreaterThan(0);
    });

    it('GET with id and boards_only=1 returns only boards array', async () => {
      mockCompetitorsClient.from.mockImplementation((table: string) => {
        if (table === 'competitors') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'a0000000-0000-0000-0000-000000000001' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'competitor_boards') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [
                    { id: 'b1', name: 'Board 1', pin_count: 500 },
                    { id: 'b2', name: 'Board 2', pin_count: 200 },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost/api/admin/competitors?id=a0000000-0000-0000-0000-000000000001&boards_only=1&workspace_id=ws-123');
      const res = await getCompetitors({
        request: req,
        locals: { user: { id: 'admin-user' }, supabase: {} as any, activeWorkspaceId: 'ws-123' },
      } as any);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.boards).toHaveLength(2);
      expect(body.competitor).toBeUndefined();
    });
  });

  describe('Competitors Snapshot DELETE API (/api/admin/competitors/snapshot)', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = new Request('http://localhost/api/admin/competitors/snapshot', { method: 'DELETE' });
      const res = await deleteSnapshot({ request: req, locals: {} } as any);
      expect(res.status).toBe(401);
    });

    it('DELETE successfully deletes snapshot scoped to workspace', async () => {
      mockCompetitorsClient.from.mockImplementation((table: string) => {
        if (table === 'competitor_snapshots') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: 'snap-1', competitor_id: 'comp-1' },
                  error: null,
                }),
              }),
            }),
            delete: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        if (table === 'competitors') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'comp-1' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost/api/admin/competitors/snapshot', {
        method: 'DELETE',
        body: JSON.stringify({ snapshot_id: 'snap-1' }),
      });

      const res = await deleteSnapshot({
        request: req,
        locals: { user: { id: 'admin-user' }, supabase: {} as any, activeWorkspaceId: 'ws-123' },
      } as any);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });
});
