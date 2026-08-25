import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as pinsHandler } from '../../pages/api/pinarchive/pins';
import { POST as ingestHandler } from '../../pages/api/internal/pinarchive/ingest';
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

describe('PinArchive Phase R2: OR Semantics & Enrichment-Preserving Merge Suite', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockUser = { id: '00000000-0000-0000-0000-000000000099', email: 'admin@example.com' };
  const mockSecret = 'test_secret_or_semantics';

  let mockPinArchiveClient: any;
  let mockSchedulingAdminClient: any;
  let mockKvStore: Map<string, string>;
  let mockRuntimeEnv: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPinArchiveClient = dbClients.getPinArchive();
    mockSchedulingAdminClient = dbClients.getSchedulingAdmin();
    vi.mocked(assertWorkspaceAccess).mockResolvedValue({
      workspaceId: mockWsId,
      role: 'admin',
      isAdmin: true,
      isOwner: true,
    });

    mockKvStore = new Map<string, string>();
    mockRuntimeEnv = {
      INGEST_SECRETS_KV: {
        get: vi.fn(async (key: string) => mockKvStore.get(key) || null),
        put: vi.fn(async (key: string, val: string) => mockKvStore.set(key, val)),
        delete: vi.fn(async (key: string) => mockKvStore.delete(key)),
      },
      INGEST_SECRET_KEY: 'env_secret_default_999',
    };
    mockKvStore.set(`ingest_secret:ws:${mockWsId}`, mockSecret);
  });

  describe('1. Pins Route OR Semantics Filtering (/api/pinarchive/pins)', () => {
    it('constructs correct PostgREST OR clause with and() for Rule 3 rising condition', async () => {
      let orClauseReceived = '';

      const queryBuilder: any = {
        eq: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        or: vi.fn().mockImplementation((clause: string) => {
          orClauseReceived = clause;
          return queryBuilder;
        }),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      };

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    pin_filter_min_saves: 40,
                    pin_filter_min_repins: 20,
                    pin_filter_rising_age_days: 14,
                    pin_filter_rising_saves: 34,
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
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/pins');
      const res = await pinsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.filters).toEqual({
        minSaves: 40,
        minRepins: 20,
        risingAgeDays: 14,
        risingSaves: 34,
      });

      expect(queryBuilder.or).toHaveBeenCalled();
      expect(orClauseReceived).toContain('saves.gte.40');
      expect(orClauseReceived).toContain('repins.gte.20');
      expect(orClauseReceived).toContain('and(created_at_pinterest.gte.');
      expect(orClauseReceived).toContain('saves.gte.34');
    });

    it('omits disabled (0) rules and calls or() only when at least one rule is active', async () => {
      let orClauseReceived = '';

      const queryBuilder: any = {
        eq: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        or: vi.fn().mockImplementation((clause: string) => {
          orClauseReceived = clause;
          return queryBuilder;
        }),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      };

      // Only Rule 1 active (min_saves = 100), others disabled (0)
      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    pin_filter_min_saves: 100,
                    pin_filter_min_repins: 0,
                    pin_filter_rising_age_days: 0,
                    pin_filter_rising_saves: 0,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'pa_pins') {
          return { select: vi.fn().mockReturnValue(queryBuilder) };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/pins');
      const res = await pinsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      expect(queryBuilder.or).toHaveBeenCalledTimes(1);
      expect(orClauseReceived).toBe('saves.gte.100');
    });

    it('does not invoke query.or() when all rules are disabled (0)', async () => {
      const queryBuilder: any = {
        eq: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      };

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    pin_filter_min_saves: 0,
                    pin_filter_min_repins: 0,
                    pin_filter_rising_age_days: 0,
                    pin_filter_rising_saves: 0,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'pa_pins') {
          return { select: vi.fn().mockReturnValue(queryBuilder) };
        }
        return {};
      });

      const req = new Request('http://localhost:4321/api/pinarchive/pins');
      const res = await pinsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      expect(queryBuilder.or).not.toHaveBeenCalled();
    });
  });

  describe('2. Ingest Enrichment-Preserving Merge (Two-Writer Protection)', () => {
    it('preserves existing annotations (idea_id & url) when incoming GAS data only has tag names', async () => {
      // Setup Project 1 workspace verification
      mockSchedulingAdminClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
          }),
        }),
      });

      // Existing pin in DB with rich annotations from GitHub Actions workflow
      const existingDbPin = {
        id: '11111111-1111-1111-1111-111111111111',
        pin_id: 'pin_enrich_001',
        saves: 100,
        repins: 50,
        comments: 10,
        share_count: 5,
        archived_at: '2026-08-20T10:00:00Z',
        annotations: [
          { name: 'Keto Breakfast', idea_id: '998877', url: 'https://www.pinterest.com/ideas/keto-breakfast/998877/' },
          { name: 'Low Carb Diet', idea_id: '112233', url: 'https://www.pinterest.com/ideas/low-carb-diet/112233/' },
        ],
        board_pin_count: 385,
        board_last_modified_at: '2026-08-15T00:00:00Z',
        seo_category: 'Food & Drink',
        canonical_pin_id: 'canon_999',
        utm_link: 'https://example.com/recipe?utm_source=pinterest',
        image_signature: 'sig_abc123',
        dominant_color: '#fafafa',
        seo_alt_text: 'Keto breakfast recipe easy',
      };

      let upsertedPayload: any = null;

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { ingest_enabled: true },
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
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'acc-1', ingest_enabled: true }, error: null }),
                }),
              }),
            }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: 'acc-1', workspace_id: mockWsId, username: 'testuser' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [existingDbPin], error: null }),
              }),
            }),
            upsert: vi.fn().mockImplementation((rows: any[]) => {
              upsertedPayload = rows;
              return {
                select: vi.fn().mockResolvedValue({
                  data: rows.map(r => ({ id: existingDbPin.id, ...r })),
                  error: null,
                }),
              };
            }),
          };
        }
        if (table === 'pa_pin_metrics' || table === 'pa_runs') {
          return {
            upsert: vi.fn().mockResolvedValue({ data: [], error: null }),
            insert: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {};
      });

      // Incoming GAS push: only has tag names in annotations, board_pin_count is null, but fresher metrics (saves=250)
      const gasPayload = {
        workspace_id: mockWsId,
        username: 'testuser',
        fetched_at: '2026-08-24T12:00:00Z',
        pins: [
          {
            pin_id: 'pin_enrich_001',
            title: 'Keto Breakfast Updated Title',
            saves: 250, // fresher scrape
            repins: 120, // fresher scrape
            comments: 15,
            share_count: 8,
            annotations: [
              { name: 'Keto Breakfast' }, // name only! url/idea_id must be preserved
              { name: 'Healthy Recipes' }, // newly added annotation without url
            ],
            board_pin_count: null, // null incoming must NOT overwrite existing 385
            board_last_modified_at: null, // null incoming must NOT overwrite existing
            seo_category: null, // null incoming must NOT overwrite existing
            canonical_pin_id: null,
            utm_link: null,
            image_signature: null,
            dominant_color: null,
            seo_alt_text: null,
          },
        ],
      };

      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify(gasPayload),
      });

      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(200);

      expect(upsertedPayload).toHaveLength(1);
      const savedPin = upsertedPayload[0];

      // (a) Preserved annotations by name: Keto Breakfast retained idea_id and url
      const ketoAnnotation = savedPin.annotations.find((a: any) => a.name === 'Keto Breakfast');
      expect(ketoAnnotation).toEqual({
        name: 'Keto Breakfast',
        idea_id: '998877',
        url: 'https://www.pinterest.com/ideas/keto-breakfast/998877/',
      });

      // Low Carb Diet from DB was also preserved
      const lowCarbAnnotation = savedPin.annotations.find((a: any) => a.name === 'Low Carb Diet');
      expect(lowCarbAnnotation).toEqual({
        name: 'Low Carb Diet',
        idea_id: '112233',
        url: 'https://www.pinterest.com/ideas/low-carb-diet/112233/',
      });

      // Healthy Recipes was added
      const healthyAnnotation = savedPin.annotations.find((a: any) => a.name === 'Healthy Recipes');
      expect(healthyAnnotation).toEqual({
        name: 'Healthy Recipes',
        idea_id: null,
        url: null,
      });

      // (b) Scalar enrichment: null incoming preserves existing values
      expect(savedPin.board_pin_count).toBe(385);
      expect(savedPin.board_last_modified_at).toBe('2026-08-15T00:00:00Z');
      expect(savedPin.seo_category).toBe('Food & Drink');
      expect(savedPin.canonical_pin_id).toBe('canon_999');
      expect(savedPin.utm_link).toBe('https://example.com/recipe?utm_source=pinterest');
      expect(savedPin.image_signature).toBe('sig_abc123');
      expect(savedPin.dominant_color).toBe('#fafafa');
      expect(savedPin.seo_alt_text).toBe('Keto breakfast recipe easy');

      // (c) Fresh metrics always win
      expect(savedPin.saves).toBe(250);
      expect(savedPin.repins).toBe(120);
      expect(savedPin.comments).toBe(15);
      expect(savedPin.share_count).toBe(8);
      expect(savedPin.title).toBe('Keto Breakfast Updated Title');

      // (d) archived_at preserved from existing row
      expect(savedPin.archived_at).toBe('2026-08-20T10:00:00Z');
    });

    it('metrics-only push preserves static fields', async () => {
      const existingDbPin = {
        id: 'db-pin-static-001',
        pin_id: 'pin_static_001',
        workspace_id: mockWsId,
        saves: 10,
        repins: 5,
        comments: 2,
        share_count: 1,
        archived_at: '2026-08-20T10:00:00Z',
        title: 'Old Title',
        description: 'Old Desc',
        link: 'https://old.example',
        domain: 'old.example',
        board_name: 'Old Board',
        board_id: 'board_old_123',
        image_url: 'https://img/old.jpg',
        created_at_pinterest: '2026-01-01T00:00:00Z',
        node_id: 'node_old_456',
        annotations: [],
        board_pin_count: 50,
        board_last_modified_at: '2026-01-01T00:00:00Z',
        seo_category: null,
        canonical_pin_id: null,
        utm_link: null,
        image_signature: null,
        dominant_color: null,
        seo_alt_text: null,
      };

      let upsertedPayload: any = null;

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { ingest_enabled: true },
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
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'acc-1', ingest_enabled: true }, error: null }),
                }),
              }),
            }),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: 'acc-1', workspace_id: mockWsId, username: 'testuser' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: [existingDbPin], error: null }),
              }),
            }),
            upsert: vi.fn().mockImplementation((rows: any[]) => {
              upsertedPayload = rows;
              return {
                select: vi.fn().mockResolvedValue({
                  data: rows.map(r => ({ id: existingDbPin.id, ...r })),
                  error: null,
                }),
              };
            }),
          };
        }
        if (table === 'pa_pin_metrics' || table === 'pa_runs') {
          return {
            upsert: vi.fn().mockResolvedValue({ data: [], error: null }),
            insert: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {};
      });

      // Incoming payload pin object contains ONLY volatile metrics + empty annotations (no static keys at all)
      const metricsOnlyPayload = {
        workspace_id: mockWsId,
        username: 'testuser',
        fetched_at: '2026-08-25T12:00:00Z',
        pins: [
          {
            pin_id: 'pin_static_001',
            saves: 50,
            repins: 25,
            comments: 10,
            share_count: 5,
            velocity: 3.2,
            reactions: { type_1: 4 },
            annotations: [],
          },
        ],
      };

      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify(metricsOnlyPayload),
      });

      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(200);

      expect(upsertedPayload).toHaveLength(1);
      const savedPin = upsertedPayload[0];

      // Assert static fields are preserved from DB
      expect(savedPin.title).toBe('Old Title');
      expect(savedPin.description).toBe('Old Desc');
      expect(savedPin.link).toBe('https://old.example');
      expect(savedPin.board_name).toBe('Old Board');
      expect(savedPin.image_url).toBe('https://img/old.jpg');
      expect(savedPin.created_at_pinterest).toBe('2026-01-01T00:00:00Z');

      // Assert fresh metrics won
      expect(savedPin.saves).toBe(50);
      expect(savedPin.repins).toBe(25);
      expect(savedPin.comments).toBe(10);
      expect(savedPin.share_count).toBe(5);
    });
  });
});
