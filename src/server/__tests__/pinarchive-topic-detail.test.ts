import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as topicDetailHandler } from '../../pages/api/pinarchive/topic-detail';
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
    rpc: vi.fn().mockResolvedValue({ data: null, error: new Error('fallback') }),
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

describe('PinArchive Topic Detail API Suite (GET /api/pinarchive/topic-detail)', () => {
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

  // 1) 401 no session
  it('returns 401 when session is missing', async () => {
    const req = new Request('http://localhost:4321/api/pinarchive/topic-detail?name=Baking');
    const res = await topicDetailHandler({
      request: req,
      locals: { user: null, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toContain('missing session');
  });

  // 2) 400 missing name
  it('returns 400 when topic name parameter is missing or empty', async () => {
    const req = new Request('http://localhost:4321/api/pinarchive/topic-detail?name=');
    const res = await topicDetailHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Validation Error: name');
  });

  // 3) 400 name longer than 120 chars
  it('returns 400 when topic name exceeds 120 characters', async () => {
    const req = new Request(`http://localhost:4321/api/pinarchive/topic-detail?name=${encodeURIComponent('A'.repeat(121))}`);
    const res = await topicDetailHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Validation Error: name');
  });

  // 4) 200 happy: assert .contains called with ('annotations', [{ name: 'X' }]) and .eq('workspace_id', ws);
  //    response has kpis/stage_distribution/boards/accounts/cooccurring/top_pins
  it('returns 200 with full topic intelligence breakdown and verifies query builder constraints', async () => {
    const queryTopic = 'Bread Recipes Sweet';
    const mockPins = [
      {
        id: 'pin-uuid-1',
        pin_id: '1001',
        title: 'Sweet Brioche Bread',
        saves: 1500,
        repins: 300,
        share_count: 50,
        velocity: 12.0, // GROWING
        created_at_pinterest: '2026-08-01T00:00:00Z',
        board_name: 'Baking Desserts',
        account_id: 'acc-uuid-1',
        annotations: [{ name: 'Bread Recipes Sweet' }, { name: 'Brioche' }],
        seo_category: 'Food And Drinks',
      },
      {
        id: 'pin-uuid-2',
        pin_id: '1002',
        title: 'Sweet Cinnamon Rolls',
        saves: 500,
        repins: 100,
        share_count: 20,
        velocity: 0.2, // DORMANT
        created_at_pinterest: '2026-01-01T00:00:00Z',
        board_name: 'Breakfast Ideas',
        account_id: 'acc-uuid-2',
        annotations: [{ name: 'Bread Recipes Sweet' }, { name: 'Cinnamon Pastry' }],
        seo_category: 'Food And Drinks',
      },
      {
        id: 'pin-uuid-3',
        pin_id: '1003',
        title: 'Sweet Flatbread (string annotation)',
        saves: 700,
        repins: 50,
        share_count: 10,
        velocity: 3.0,
        created_at_pinterest: '2026-05-01T00:00:00Z',
        board_name: 'Baking Desserts',
        account_id: 'acc-uuid-1',
        annotations: ['Bread Recipes Sweet', 'Flatbread'],
        seo_category: 'Food And Drinks',
      },
      {
        id: 'pin-uuid-4',
        pin_id: '1004',
        title: 'Non-matching pin (must be excluded)',
        saves: 9999,
        repins: 0,
        share_count: 0,
        velocity: 1.0,
        created_at_pinterest: '2026-05-01T00:00:00Z',
        board_name: 'Other',
        account_id: 'acc-uuid-1',
        annotations: [{ name: 'Unrelated Topic' }],
        seo_category: 'Other',
      },
    ];

    const mockAccounts = [
      { id: 'acc-uuid-1', username: 'bakingqueen' },
      { id: 'acc-uuid-2', username: 'pastrychef' },
    ];

    const orderMock = vi.fn().mockResolvedValue({ data: mockPins.slice(0, 3), error: null });
    const containsSpy = vi.fn().mockReturnValue({ order: orderMock });
    const eqMock = vi.fn().mockReturnValue({ contains: containsSpy, order: orderMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_pins') {
        return { select: selectMock };
      }
      if (table === 'pa_accounts') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: mockAccounts, error: null }),
            }),
          }),
        };
      }
      return {};
    });

    const req = new Request(`http://localhost:4321/api/pinarchive/topic-detail?name=${encodeURIComponent(queryTopic)}`);
    const res = await topicDetailHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.topic).toBe(queryTopic);

    // Verify query builder calls
    expect(eqMock).toHaveBeenCalledWith('workspace_id', mockWsId);
    expect(containsSpy).toHaveBeenCalledWith('annotations', JSON.stringify([{ name: queryTopic }]));
    expect(orderMock).toHaveBeenCalledWith('saves', { ascending: false });

    // Verify response schema
    expect(json).toHaveProperty('kpis');
    expect(json).toHaveProperty('stage_distribution');
    expect(json).toHaveProperty('boards');
    expect(json).toHaveProperty('accounts');
    expect(json).toHaveProperty('cooccurring');
    expect(json).toHaveProperty('top_pins');

    // KPI values (3 matching pins; pin-uuid-4 excluded by JS annotation filter)
    expect(json.kpis.pins).toBe(3);
    expect(json.kpis.total_saves).toBe(2700);
    expect(json.kpis.avg_saves).toBe(900);
    expect(json.kpis.median_saves).toBe(700);
    expect(json.kpis.total_repins).toBe(450);
    expect(json.kpis.total_shares).toBe(80);
    expect(json.kpis.avg_velocity).toBe(5.1);

    // Stage distribution
    expect(json.stage_distribution.GROWING).toBe(1);
    expect(json.stage_distribution.DORMANT).toBe(1);
    expect(json.stage_distribution.MATURE).toBe(1);

    // JS filter proof: highest-saves pin (9999) must be excluded
    expect(json.top_pins.length).toBe(3);
    expect(json.top_pins.some((p: any) => p.pin_id === '1004')).toBe(false);
  });

  // 5) cooccurring EXCLUDES the queried name and counts distinct pin_ids
  it('excludes the queried topic name from cooccurring keywords and deduplicates pin counts', async () => {
    const queryTopic = 'Keto Diet';
    const mockPins = [
      {
        id: 'pin-1',
        pin_id: '101',
        saves: 100,
        velocity: 2.0,
        annotations: [{ name: 'Keto Diet' }, { name: 'Low Carb' }, { name: 'Healthy Recipes' }],
        created_at_pinterest: '2026-06-01T00:00:00Z',
      },
      {
        id: 'pin-2',
        pin_id: '102',
        saves: 200,
        velocity: 3.0,
        annotations: ['Keto Diet', 'Low Carb', 'Meal Prep'],
        created_at_pinterest: '2026-06-01T00:00:00Z',
      },
      {
        id: 'pin-3',
        pin_id: '103',
        saves: 300,
        velocity: 4.0,
        // Duplicate annotations on the same pin should only count once
        annotations: [{ name: 'Keto Diet' }, { name: 'Low Carb' }, { name: 'Low Carb' }],
        created_at_pinterest: '2026-06-01T00:00:00Z',
      },
    ];

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_pins') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              contains: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: mockPins, error: null }),
              }),
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: mockPins, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'pa_accounts') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      }
      return {};
    });

    const req = new Request(`http://localhost:4321/api/pinarchive/topic-detail?name=${encodeURIComponent(queryTopic)}`);
    const res = await topicDetailHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // 'Keto Diet' itself must be excluded
    const names = json.cooccurring.map((c: any) => c.name);
    expect(names).not.toContain('Keto Diet');

    // 'Low Carb' should appear in all 3 pins -> count 3
    const lowCarb = json.cooccurring.find((c: any) => c.name === 'Low Carb');
    expect(lowCarb).toBeDefined();
    expect(lowCarb.pins).toBe(3);

    const mealPrep = json.cooccurring.find((c: any) => c.name === 'Meal Prep');
    expect(mealPrep).toBeDefined();
    expect(mealPrep.pins).toBe(1);
  });

  // 6) accounts fallback 'unknown' when account_id not in pa_accounts map
  it('falls back to "unknown" when account_id is missing or not found in pa_accounts map', async () => {
    const queryTopic = 'Smoothies';
    const mockPins = [
      {
        id: 'pin-1',
        pin_id: '201',
        saves: 80,
        velocity: 1.0,
        account_id: 'unmatched-account-uuid',
        annotations: [{ name: 'Smoothies' }],
        created_at_pinterest: '2026-07-01T00:00:00Z',
      },
      {
        id: 'pin-2',
        pin_id: '202',
        saves: 120,
        velocity: 1.5,
        account_id: null,
        annotations: [{ name: 'Smoothies' }],
        created_at_pinterest: '2026-07-01T00:00:00Z',
      },
    ];

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_pins') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              contains: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: mockPins, error: null }),
              }),
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: mockPins, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'pa_accounts') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [{ id: 'other-acc', username: 'otheruser' }], error: null }),
            }),
          }),
        };
      }
      return {};
    });

    const req = new Request(`http://localhost:4321/api/pinarchive/topic-detail?name=${encodeURIComponent(queryTopic)}`);
    const res = await topicDetailHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.status).toBeUndefined();
    expect(json.accounts.length).toBe(1);
    expect(json.accounts[0].username).toBe('unknown');
    expect(json.accounts[0].pins).toBe(2);
    expect(json.accounts[0].sum_saves).toBe(200);
  });

  // 7) filters by account_id and board correctly
  it('filters rawPins by account_id and board before computing aggregations', async () => {
    const queryTopic = 'Smoothies';
    const mockPins = [
      {
        id: 'pin-1',
        pin_id: '201',
        saves: 80,
        velocity: 1.0,
        account_id: '00000000-0000-0000-0000-000000000010',
        board_name: 'Breakfast Drinks',
        annotations: [{ name: 'Smoothies' }],
        created_at_pinterest: '2026-07-01T00:00:00Z',
      },
      {
        id: 'pin-2',
        pin_id: '202',
        saves: 120,
        velocity: 1.5,
        account_id: '00000000-0000-0000-0000-000000000020',
        board_name: 'Healthy Snacks',
        annotations: [{ name: 'Smoothies' }],
        created_at_pinterest: '2026-07-01T00:00:00Z',
      },
    ];

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_pins') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              contains: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: mockPins, error: null }),
              }),
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: mockPins, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'pa_accounts') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [
                  { id: '00000000-0000-0000-0000-000000000010', username: 'drinkqueen' },
                  { id: '00000000-0000-0000-0000-000000000020', username: 'snackking' },
                ],
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    const req = new Request(`http://localhost:4321/api/pinarchive/topic-detail?name=${encodeURIComponent(queryTopic)}&account_id=00000000-0000-0000-0000-000000000010&board=Breakfast%20Drinks`);
    const res = await topicDetailHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.kpis.pins).toBe(1);
    expect(json.kpis.total_saves).toBe(80);
    expect(json.accounts.length).toBe(1);
    expect(json.accounts[0].username).toBe('drinkqueen');
    expect(json.boards.length).toBe(1);
    expect(json.boards[0].name).toBe('Breakfast Drinks');
  });
});
