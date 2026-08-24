import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as overviewHandler } from '../../pages/api/pinarchive/overview';
import { GET as pinsHandler } from '../../pages/api/pinarchive/pins';
import { GET as topicsHandler } from '../../pages/api/pinarchive/topics';
import { dbClients } from '../db/clients';
import { assertWorkspaceAccess } from '../auth/workspace-guard';

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

describe('PinArchive Dashboard UI Read Layer API Suite', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
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

  describe('1. GET /api/pinarchive/overview', () => {
    it('returns 401 when user session is missing', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/overview');
      const res = await overviewHandler({
        request: req,
        locals: { user: null, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('missing session');
    });

    it('returns 400 when workspace ID format is invalid', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/overview');
      const res = await overviewHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: 'not-a-uuid' },
      } as any);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Invalid workspace identifier format');
    });

    it('returns 200 with accounts and aggregated totals', async () => {
      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'acc-1',
                      username: 'roseisabelle555',
                      status: 'active',
                      pins_count: 6,
                      follower_count: 891,
                      last_run_at: '2026-08-23T00:00:00Z',
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockImplementation((fields: string, options?: any) => {
              if (options?.head) {
                return {
                  eq: vi.fn().mockResolvedValue({
                    count: 2,
                    error: null,
                  }),
                };
              }
              return {
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    range: vi.fn().mockResolvedValue({
                      data: [
                        { saves: 100, share_count: 20, archived_at: '2026-08-23T00:00:00Z' },
                        { saves: 50, share_count: 5, archived_at: null },
                      ],
                      error: null,
                    }),
                  }),
                }),
              };
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/overview');
      const res = await overviewHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.accounts.length).toBe(1);
      expect(json.accounts[0].username).toBe('roseisabelle555');
      expect(json.totals.accounts).toBe(1);
      expect(json.totals.archived_pins).toBe(2);
      expect(json.totals.sum_saves).toBe(150);
      expect(json.totals.sum_shares).toBe(25);
      expect(json.totals.total_pins).toBe(2);
    });
  });

  describe('2. GET /api/pinarchive/pins', () => {
    it('returns 200 with archived pins sorted by saves or velocity', async () => {
      const mockPins = [
        {
          pin_id: '1079245498222414527',
          title: 'Best Low Carb Recipes',
          saves: 23887,
          repins: 21346,
          share_count: 1602,
          velocity: 120.5,
          archived_at: '2026-08-23T00:00:00Z',
          annotations: [{ name: 'Bread Recipes Sweet' }],
          seo_category: 'Food And Drinks',
          canonical_pin_id: '1075797429758900343',
        },
      ];

      const limitMock = vi.fn().mockResolvedValue({ data: mockPins, error: null });
      const orderMock = vi.fn().mockReturnValue({ limit: limitMock });
      const eqMock = vi.fn().mockReturnValue({ order: orderMock });
      const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
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
          return { select: selectMock };
        }
        if (table === 'pa_pin_metrics') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/pins?sort=velocity&limit=25');
      const res = await pinsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.pins.length).toBe(1);
      expect(json.pins[0].pin_id).toBe('1079245498222414527');
      expect(json.sort).toBe('velocity');
      expect(orderMock).toHaveBeenCalledWith('velocity', { ascending: false });
      expect(limitMock).toHaveBeenCalledWith(25);
    });
  });

  describe('3. GET /api/pinarchive/topics', () => {
    it('aggregates jsonb annotations into top topics ranked by saves', async () => {
      const mockData = [
        {
          pin_id: 'pin-1',
          saves: 1000,
          annotations: [
            { name: 'Bread Recipes Sweet' },
            { name: 'Easy Homemade Bread' },
          ],
        },
        {
          pin_id: 'pin-2',
          saves: 500,
          annotations: [
            { name: 'Bread Recipes Sweet' },
            'Baking Basics',
          ],
        },
      ];

      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            not: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: mockData, error: null }),
            }),
          }),
        }),
      });

      const req = new Request('http://localhost:4321/api/pinarchive/topics');
      const res = await topicsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.topics.length).toBe(3);

      // Topic "Bread Recipes Sweet" appeared in 2 pins with sum 1500 saves
      expect(json.topics[0].name).toBe('Bread Recipes Sweet');
      expect(json.topics[0].pins).toBe(2);
      expect(json.topics[0].sum_saves).toBe(1500);

      // Topic "Easy Homemade Bread" has 1000 saves
      expect(json.topics[1].name).toBe('Easy Homemade Bread');
      expect(json.topics[1].pins).toBe(1);
      expect(json.topics[1].sum_saves).toBe(1000);

      // Topic "Baking Basics" has 500 saves
      expect(json.topics[2].name).toBe('Baking Basics');
      expect(json.topics[2].pins).toBe(1);
      expect(json.topics[2].sum_saves).toBe(500);
    });
  });
});
