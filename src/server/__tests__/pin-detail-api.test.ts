import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as pinDetailHandler } from '../../pages/api/pinarchive/pin';
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

describe('PinArchive Pin Detail API Suite (GET /api/pinarchive/pin)', () => {
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
      membershipId: 'mem-1',
    });
  });

  it('returns 401 when session is missing', async () => {
    const req = new Request(`http://localhost:4321/api/pinarchive/pin?id=${mockPinId}`);
    const res = await pinDetailHandler({
      request: req,
      locals: { user: null, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toContain('missing session');
  });

  it('returns 400 when id param is missing or not a valid UUID', async () => {
    const req1 = new Request('http://localhost:4321/api/pinarchive/pin');
    const res1 = await pinDetailHandler({
      request: req1,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res1.status).toBe(400);

    const req2 = new Request('http://localhost:4321/api/pinarchive/pin?id=not-a-uuid');
    const res2 = await pinDetailHandler({
      request: req2,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res2.status).toBe(400);
    const json2 = await res2.json();
    expect(json2.error).toContain('Invalid pin identifier format');
  });

  it('returns 404 when pin is not found in the workspace', async () => {
    mockPinArchiveClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    });

    const req = new Request(`http://localhost:4321/api/pinarchive/pin?id=${mockPinId}`);
    const res = await pinDetailHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain('Pin not found');
  });

  it('returns 200 with pin, metrics, and canonical siblings', async () => {
    const mockPin = {
      id: mockPinId,
      pin_id: '1079245498222414527',
      title: 'Best Low Carb Recipes',
      saves: 23887,
      repins: 21346,
      comments: 34,
      share_count: 1602,
      velocity: 120.5,
      canonical_pin_id: '1075797429758900343',
      annotations: [{ name: 'Bread Recipes Sweet' }],
      workspace_id: mockWsId,
    };

    const mockMetrics = [
      { recorded_at: '2026-08-22T00:00:00Z', saves: 20000, repins: 18000, comments: 10, shares: 500, reactions_total: 100 },
      { recorded_at: '2026-08-23T00:00:00Z', saves: 23887, repins: 21346, comments: 34, shares: 1602, reactions_total: 705 },
    ];

    const mockSiblings = [
      { id: mockPinId, pin_id: '1079245498222414527', title: 'Best Low Carb Recipes', saves: 23887 },
      { id: 'sibling-uuid-2222', pin_id: '1075797429758900343', title: 'Low Carb Bread Bun', saves: 15000 },
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
            // siblings select
            return {
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({ data: mockSiblings, error: null }),
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
    expect(json.pin.id).toBe(mockPinId);
    expect(json.pin.saves).toBe(23887);
    expect(json.metrics.length).toBe(2);
    expect(json.canonical_siblings.length).toBe(1);
    expect(json.canonical_siblings[0].id).toBe('sibling-uuid-2222');
  });
});
