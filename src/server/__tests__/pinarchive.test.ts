import { describe, it, expect, beforeEach, vi } from 'vitest';
import { timingSafeEqual } from '../lib/timing-safe';
import { gasCall } from '../lib/gas-bridge';
import { POST as ingestHandler } from '../../pages/api/internal/pinarchive/ingest';
import { POST as dispatchHandler } from '../../pages/api/internal/pinarchive/dispatch';
import { dbClients } from '../db/clients';

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
    getServerEnv: vi.fn().mockReturnValue({
      SCHEDULING_SUPABASE_URL: 'https://eygdoetdwqllvsxpvoex.supabase.co',
      SCHEDULING_SUPABASE_PUBLISHABLE_KEY: 'sb_pub_p1',
      SCHEDULING_SUPABASE_SECRET_KEY: 'sb_secret_p1',
      PINARCHIVE_SUPABASE_URL: 'https://kuuugffvyokywtgmdrfk.supabase.co',
      PINARCHIVE_SUPABASE_SECRET_KEY: 'sb_secret_p4',
      PINARCHIVE_GAS_URL: 'https://script.google.com/macros/s/test-gas-app/exec',
      INGEST_SECRET_KEY: 'env_secret_default_999',
    }),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockReturnValue(mockSchedulingAdmin),
      getPinArchive: vi.fn().mockReturnValue(mockPinArchive),
      getConfig: vi.fn().mockReturnValue({
        PINARCHIVE_GAS_URL: 'https://script.google.com/macros/s/test-gas-app/exec',
        INGEST_SECRET_KEY: 'env_secret_default_999',
      }),
    },
  };
});

describe('PinArchive Module Test Suite', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockSecret = 'test_secret_pinarchive_123';

  let mockKvStore: Map<string, string>;
  let mockRuntimeEnv: Record<string, any>;
  let mockAdminClient: any;
  let mockPinArchiveClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKvStore = new Map<string, string>();
    mockRuntimeEnv = {
      INGEST_SECRETS_KV: {
        get: vi.fn(async (key: string) => mockKvStore.get(key) || null),
        put: vi.fn(async (key: string, val: string) => mockKvStore.set(key, val)),
        delete: vi.fn(async (key: string) => mockKvStore.delete(key)),
      },
      INGEST_SECRET_KEY: 'env_secret_default_999',
      PINARCHIVE_GAS_URL: 'https://script.google.com/macros/s/test-gas-app/exec',
    };

    mockAdminClient = dbClients.getSchedulingAdmin();
    mockPinArchiveClient = dbClients.getPinArchive();
  });

  describe('1. timingSafeEqual Helper', () => {
    it('returns true for matching strings', async () => {
      expect(await timingSafeEqual('secret123', 'secret123')).toBe(true);
      expect(await timingSafeEqual('', '')).toBe(true);
    });

    it('returns false for mismatched strings or differing lengths', async () => {
      expect(await timingSafeEqual('secret123', 'secret124')).toBe(false);
      expect(await timingSafeEqual('secret123', 'secret1234')).toBe(false);
      expect(await timingSafeEqual('secret1234', 'secret123')).toBe(false);
    });

    it('handles null, undefined, or non-string inputs safely without throwing', async () => {
      expect(await timingSafeEqual(null, 'secret')).toBe(false);
      expect(await timingSafeEqual('secret', null)).toBe(false);
      expect(await timingSafeEqual(undefined, undefined)).toBe(false);
      expect(await timingSafeEqual(undefined, 'secret')).toBe(false);
    });
  });

  describe('2. gasCall Bridge Fail-Lazy Behavior', () => {
    it('returns { ok: false, error } and never throws on network failure or timeout', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network connection refused / timeout'));

      const result = await gasCall(mockRuntimeEnv, mockWsId, 'run', { username: 'testuser' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network connection refused');

      globalThis.fetch = originalFetch;
    });

    it('returns { ok: false, error } on non-200 HTTP response', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('Internal GAS error', { status: 502, statusText: 'Bad Gateway' }));

      const result = await gasCall(mockRuntimeEnv, mockWsId, 'run', { username: 'testuser' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('502');

      globalThis.fetch = originalFetch;
    });

    it('returns parsed body on 200 OK response', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, status: 'dispatched', queued_pins: 15 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await gasCall(mockRuntimeEnv, mockWsId, 'run', { username: 'testuser' });
      expect(result.ok).toBe(true);
      expect(result.status).toBe('dispatched');
      expect(result.queued_pins).toBe(15);

      globalThis.fetch = originalFetch;
    });
  });

  describe('3. POST /api/internal/pinarchive/ingest', () => {
    it('returns 400 on empty or malformed JSON payload', async () => {
      const reqEmpty = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '',
      });
      const resEmpty = await ingestHandler({ request: reqEmpty, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(resEmpty.status).toBe(400);

      const reqMalformed = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ malformed json payload',
      });
      const resMalformed = await ingestHandler({ request: reqMalformed, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(resMalformed.status).toBe(400);
    });

    it('returns 422 on missing workspace_id', async () => {
      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', pins: [] }),
      });
      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('workspace_id is required');
    });

    it('returns 403 when workspace does not exist in Project 1', async () => {
      mockAdminClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      });

      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': 'env_secret_default_999',
        },
        body: JSON.stringify({ workspace_id: 'nonexistent-workspace', username: 'testuser', pins: [] }),
      });
      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(403);
    });

    it('returns 401 when x-ingest-secret header is missing or incorrect', async () => {
      mockAdminClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
      });

      mockKvStore.set(`ingest_secret:ws:${mockWsId}`, mockSecret);

      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': 'wrong_secret_value',
        },
        body: JSON.stringify({ workspace_id: mockWsId, username: 'testuser', pins: [] }),
      });
      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(401);
    });

    it('successfully processes ingest and is idempotent on duplicate push', async () => {
      mockAdminClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
      });

      mockKvStore.set(`ingest_secret:ws:${mockWsId}`, mockSecret);

      const mockAccountId = 'acc-uuid-1111';
      const mockPinRefId = 'pin-uuid-2222';
      const mockPinId = '1234567890';

      const metricsInserted: any[] = [];
      const runsInserted: any[] = [];

      // Setup pa_accounts upsert
      const mockAccountsQuery = {
        upsert: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: mockAccountId, workspace_id: mockWsId, username: 'testuser' },
          error: null,
        }),
      };

      // Mock database state for pins
      let storedPins: any[] = [];

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_accounts') {
          return mockAccountsQuery;
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockImplementation((_col: string, pinIds: string[]) => {
                  const matches = storedPins.filter(p => pinIds.includes(p.pin_id));
                  return Promise.resolve({ data: matches, error: null });
                }),
              }),
            }),
            upsert: vi.fn().mockImplementation((pinsArray: any[]) => {
              storedPins = pinsArray.map(p => ({
                id: mockPinRefId,
                pin_id: p.pin_id,
                saves: p.saves,
                repins: p.repins,
                comments: p.comments,
                share_count: p.share_count || 0,
                reactions: p.reactions || {},
              }));
              return {
                select: vi.fn().mockResolvedValue({
                  data: storedPins,
                  error: null,
                }),
              };
            }),
          };
        }
        if (table === 'pa_pin_metrics') {
          return {
            upsert: vi.fn().mockImplementation((metricsArray: any[]) => {
              metricsInserted.push(...metricsArray);
              return Promise.resolve({ data: metricsArray, error: null });
            }),
          };
        }
        if (table === 'pa_runs') {
          return {
            insert: vi.fn().mockImplementation((runObj: any) => {
              runsInserted.push(runObj);
              return Promise.resolve({ data: runObj, error: null });
            }),
          };
        }
        return {};
      });

      const payload = {
        run_id: 'run-alpha-001',
        workspace_id: mockWsId,
        username: 'testuser',
        fetched_at: '2026-08-22T00:00:00Z',
        account_meta: { status: 'active', interval_days: 3 },
        pins: [
          {
            pin_id: mockPinId,
            title: 'Test Pin Title',
            saves: 100,
            repins: 50,
            comments: 5,
            promoted: false,
          },
        ],
      };

      // --- FIRST PUSH: New pin -> should insert 1 metric snapshot ---
      const req1 = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify(payload),
      });

      const res1 = await ingestHandler({ request: req1, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.success).toBe(true);
      expect(json1.accepted).toBe(1);
      expect(json1.archived_pin_ids).toEqual([mockPinId]);
      expect(metricsInserted.length).toBe(1);
      expect(metricsInserted[0].saves).toBe(100);
      expect(runsInserted.length).toBe(1);
      expect(runsInserted[0].message).toBe('run-alpha-001');

      // --- SECOND PUSH: Duplicate push (identical saves/repins) -> should insert 0 new metric rows ---
      const req2 = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify(payload),
      });

      const res2 = await ingestHandler({ request: req2, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.success).toBe(true);
      // Total metrics rows inserted remains 1 (0 new rows added during second push)
      expect(metricsInserted.length).toBe(1);
      expect(runsInserted.length).toBe(2);
    });

    it('processes enriched relay payload with refresh trigger, follower_count, annotations, and shares', async () => {
      mockAdminClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
      });

      mockKvStore.set(`ingest_secret:ws:${mockWsId}`, mockSecret);

      const mockAccountId = 'acc-uuid-2222';
      const mockPinRefId = 'pin-uuid-3333';
      const mockPinId = '1079245498222414527';

      let upsertedAccountData: any = null;
      let upsertedPinsData: any = null;
      const metricsInserted: any[] = [];
      const runsInserted: any[] = [];

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_accounts') {
          return {
            upsert: vi.fn().mockImplementation((data: any) => {
              upsertedAccountData = data;
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: mockAccountId, workspace_id: mockWsId, username: 'testuser' },
                    error: null,
                  }),
                }),
              };
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
            upsert: vi.fn().mockImplementation((pinsArray: any[]) => {
              upsertedPinsData = pinsArray;
              const storedPins = pinsArray.map(p => ({
                id: mockPinRefId,
                pin_id: p.pin_id,
                saves: p.saves,
                repins: p.repins,
                comments: p.comments,
                share_count: p.share_count || 0,
                reactions: p.reactions || {},
              }));
              return {
                select: vi.fn().mockResolvedValue({
                  data: storedPins,
                  error: null,
                }),
              };
            }),
          };
        }
        if (table === 'pa_pin_metrics') {
          return {
            upsert: vi.fn().mockImplementation((metricsArray: any[]) => {
              metricsInserted.push(...metricsArray);
              return Promise.resolve({ data: metricsArray, error: null });
            }),
          };
        }
        if (table === 'pa_runs') {
          return {
            insert: vi.fn().mockImplementation((runObj: any) => {
              runsInserted.push(runObj);
              return Promise.resolve({ data: runObj, error: null });
            }),
          };
        }
        return {};
      });

      const enrichedPayload = {
        run_id: 'run-refresh-100',
        workspace_id: mockWsId,
        username: 'testuser',
        fetched_at: '2026-08-23T00:00:00Z',
        run_type: 'refresh',
        trigger: 'refresh',
        follower_count: 891,
        pins: [
          {
            pin_id: mockPinId,
            title: 'Best Low Carb Recipes',
            saves: 23887,
            repins: 21346,
            comments: 12,
            share_count: 1602,
            reactions: { total: 42, type_1: 40, type_7: 2 },
            annotations: [
              { name: 'Easy Bread', idea_id: '900909847694', url: '/ideas/easy-bread/900909847694/' },
              { name: 'Bread Bun' },
            ],
            seo_category: 'Food And Drinks',
            canonical_pin_id: '1075797429758900343',
            seo_alt_text: 'Healthy bread baking recipe',
            board_pin_count: 45,
            board_last_modified_at: '2026-08-20T12:00:00Z',
          },
        ],
      };

      const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify(enrichedPayload),
      });

      const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(200);

      expect(upsertedAccountData.follower_count).toBe(891);
      expect(upsertedPinsData[0].seo_category).toBe('Food And Drinks');
      expect(upsertedPinsData[0].canonical_pin_id).toBe('1075797429758900343');
      expect(upsertedPinsData[0].share_count).toBe(1602);
      expect(upsertedPinsData[0].annotations.length).toBe(2);

      expect(metricsInserted.length).toBe(1);
      expect(metricsInserted[0].shares).toBe(1602);
      expect(metricsInserted[0].reactions_total).toBe(42);

      expect(runsInserted.length).toBe(1);
      expect(runsInserted[0].trigger).toBe('refresh');
    });
  });

  describe('4. POST /api/internal/pinarchive/dispatch', () => {
    it('authenticates and dispatches active accounts to GAS bridge', async () => {
      mockAdminClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
      });

      mockKvStore.set(`ingest_secret:ws:${mockWsId}`, mockSecret);

      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((col: string, val: string) => {
          if (col === 'status') {
            return {
              data: [
                { username: 'account_one', status: 'active' },
                { username: 'account_two', status: 'active' },
              ],
              error: null,
            };
          }
          return {
            eq: vi.fn().mockResolvedValue({
              data: [
                { username: 'account_one', status: 'active' },
                { username: 'account_two', status: 'active' },
              ],
              error: null,
            }),
          };
        }),
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true, dispatched: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );

      const req = new Request('http://localhost:4321/api/internal/pinarchive/dispatch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({ workspace_id: mockWsId }),
      });

      const res = await dispatchHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.dispatched.length).toBe(2);
      expect(json.dispatched[0].username).toBe('account_one');
      expect(json.dispatched[0].ok).toBe(true);
      expect(json.dispatched[1].username).toBe('account_two');
      expect(json.dispatched[1].ok).toBe(true);

      globalThis.fetch = originalFetch;
    });

    it('dispatches a specific named username when provided in body', async () => {
      mockAdminClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
      });

      mockKvStore.set(`ingest_secret:ws:${mockWsId}`, mockSecret);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true, status: 'dispatched' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );

      const req = new Request('http://localhost:4321/api/internal/pinarchive/dispatch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({ workspace_id: mockWsId, username: 'custom_target_user' }),
      });

      const res = await dispatchHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.dispatched.length).toBe(1);
      expect(json.dispatched[0].username).toBe('custom_target_user');
      expect(json.dispatched[0].ok).toBe(true);

      globalThis.fetch = originalFetch;
    });
  });
});
