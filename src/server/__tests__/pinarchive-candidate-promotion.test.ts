import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as ingestHandler } from '../../pages/api/internal/pinarchive/ingest';
import { POST as reevaluateHandler } from '../../pages/api/internal/pinarchive/reevaluate';
import { promoteCandidates } from '../services/promotion-service';
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
    rpc: vi.fn(),
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

describe('PinArchive Tier 2 Suite: Candidates, Promotion & Re-evaluation', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockSecret = 'test_secret_candidate_promotion';
  const mockUser = { id: '00000000-0000-0000-0000-000000000099', email: 'admin@example.com' };

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

    // Default Project 1 workspace validation
    mockSchedulingAdminClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
        }),
      }),
    });
  });

  describe('1. Ingest Explicit archived_at Handling (Candidate vs Promoted Pins)', () => {
    it('respects explicit archived_at: null and writes null to DB for candidate pins', async () => {
      let upsertedPayload: any = null;

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { ingest_enabled: true }, error: null }),
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
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
            upsert: vi.fn().mockImplementation((rows: any[]) => {
              upsertedPayload = rows;
              return {
                select: vi.fn().mockResolvedValue({
                  data: rows.map(r => ({ id: 'new-pin-id', ...r })),
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

      const candidatePayload = {
        workspace_id: mockWsId,
        username: 'testuser',
        fetched_at: '2026-08-30T12:00:00Z',
        trigger: 'backfill',
        pins: [
          {
            pin_id: 'pin_candidate_001',
            title: 'Candidate Pin',
            saves: 5,
            repins: 2,
            archived_at: null, // EXPLICIT NULL
          },
        ],
      };

      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify(candidatePayload),
      });

      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(200);

      expect(upsertedPayload).toHaveLength(1);
      expect(upsertedPayload[0].pin_id).toBe('pin_candidate_001');
      expect(upsertedPayload[0].archived_at).toBeNull();
    });

    it('respects explicit archived_at: <timestamp> when provided', async () => {
      let upsertedPayload: any = null;

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { ingest_enabled: true }, error: null }),
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
                in: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
            upsert: vi.fn().mockImplementation((rows: any[]) => {
              upsertedPayload = rows;
              return {
                select: vi.fn().mockResolvedValue({
                  data: rows.map(r => ({ id: 'new-pin-id', ...r })),
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

      const explicitTs = '2026-08-25T10:00:00Z';
      const payload = {
        workspace_id: mockWsId,
        username: 'testuser',
        fetched_at: '2026-08-30T12:00:00Z',
        pins: [
          {
            pin_id: 'pin_explicit_ts_001',
            title: 'Qualifying Pin',
            saves: 200,
            repins: 50,
            archived_at: explicitTs,
          },
        ],
      };

      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify(payload),
      });

      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(200);

      expect(upsertedPayload).toHaveLength(1);
      expect(upsertedPayload[0].archived_at).toBe(explicitTs);
    });

    it('preserves existing archived_at when incoming payload omits the archived_at property', async () => {
      const existingPin = {
        id: 'existing-pin-uuid-1',
        pin_id: 'pin_legacy_gas_001',
        workspace_id: mockWsId,
        saves: 50,
        repins: 10,
        archived_at: '2026-08-20T08:00:00Z',
        annotations: [{ name: 'DIY Crafts', idea_id: '12345', url: 'https://pinterest.com/ideas/12345' }],
        share_count: 12,
      };

      let upsertedPayload: any = null;

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { ingest_enabled: true }, error: null }),
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
                in: vi.fn().mockResolvedValue({ data: [existingPin], error: null }),
              }),
            }),
            upsert: vi.fn().mockImplementation((rows: any[]) => {
              upsertedPayload = rows;
              return {
                select: vi.fn().mockResolvedValue({
                  data: rows.map(r => ({ id: existingPin.id, ...r })),
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

      // Legacy GAS payload omitting archived_at
      const legacyGasPayload = {
        workspace_id: mockWsId,
        username: 'testuser',
        fetched_at: '2026-08-30T12:00:00Z',
        pins: [
          {
            pin_id: 'pin_legacy_gas_001',
            title: 'Updated Title',
            saves: 75,
            repins: 15,
            // archived_at omitted!
          },
        ],
      };

      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify(legacyGasPayload),
      });

      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(200);

      expect(upsertedPayload).toHaveLength(1);
      expect(upsertedPayload[0].archived_at).toBe('2026-08-20T08:00:00Z');
      expect(upsertedPayload[0].share_count).toBe(12);
      expect(upsertedPayload[0].annotations).toEqual([
        { name: 'DIY Crafts', idea_id: '12345', url: 'https://pinterest.com/ideas/12345' },
      ]);
    });
  });

  describe('2. Promotion Service & RPC Execution', () => {
    it('calls pa_promote_candidates RPC and returns promoted & checked counts', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: [{ promoted: 14, checked: 50 }],
        error: null,
      });

      const result = await promoteCandidates(mockWsId, mockRuntimeEnv);
      expect(mockPinArchiveClient.rpc).toHaveBeenCalledWith('pa_promote_candidates', {
        p_workspace_id: mockWsId,
      });
      expect(result).toEqual({ promoted: 14, checked: 50 });
    });

    it('handles RPC error fail-safely without throwing', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: null,
        error: { message: 'relation pa_pins does not exist' },
      });

      const result = await promoteCandidates(mockWsId, mockRuntimeEnv);
      expect(result.promoted).toBe(0);
      expect(result.checked).toBe(0);
      expect(result.error).toContain('relation pa_pins does not exist');
    });
  });

  describe('3. Re-evaluate Endpoint (/api/internal/pinarchive/reevaluate)', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = new Request('http://localhost:4321/api/internal/pinarchive/reevaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': 'invalid_secret' },
        body: JSON.stringify({ workspace_id: mockWsId }),
      });

      const res = await reevaluateHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it('returns 200 with promotion counts when authorized via x-ingest-secret', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: [{ promoted: 8, checked: 30 }],
        error: null,
      });

      const req = new Request('http://localhost:4321/api/internal/pinarchive/reevaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': mockSecret },
        body: JSON.stringify({ workspace_id: mockWsId }),
      });

      const res = await reevaluateHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.promoted).toBe(8);
      expect(json.checked).toBe(30);
      expect(json.workspace_id).toBe(mockWsId);
    });

    it('returns 200 with promotion counts when authorized via session user with admin role', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: [{ promoted: 5, checked: 20 }],
        error: null,
      });

      const req = new Request('http://localhost:4321/api/internal/pinarchive/reevaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId }),
      });

      const res = await reevaluateHandler({
        request: req,
        locals: {
          runtime: { env: mockRuntimeEnv },
          user: mockUser,
          supabase: mockSchedulingAdminClient,
          activeWorkspaceId: mockWsId,
        },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.promoted).toBe(5);
      expect(json.checked).toBe(20);
    });
  });
});
