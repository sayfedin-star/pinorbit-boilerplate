import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as configHandler } from '../../pages/api/internal/pinarchive/config';
import { dbClients, isProductionEnv, isKnownDefaultIngestSecret } from '../db/clients';

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

describe('PinArchive Internal Config Endpoint Suite (/api/internal/pinarchive/config)', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockSecret = 'correct_test_secret_999';

  let mockKvStore: Map<string, string>;
  let mockRuntimeEnv: Record<string, any>;
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
    };

    mockPinArchiveClient = dbClients.getPinArchive();
    mockKvStore.set(`ingest_secret:ws:${mockWsId}`, mockSecret);
  });

  it('returns 400 when workspace_id is missing or not a valid UUID', async () => {
    const req1 = new Request('http://localhost:4321/api/internal/pinarchive/config');
    const res1 = await configHandler({ request: req1, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res1.status).toBe(400);

    const req2 = new Request('http://localhost:4321/api/internal/pinarchive/config?workspace_id=invalid-uuid');
    const res2 = await configHandler({ request: req2, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res2.status).toBe(400);
  });

  it('returns 401 when x-ingest-secret header is missing or incorrect', async () => {
    const req = new Request(`http://localhost:4321/api/internal/pinarchive/config?workspace_id=${mockWsId}`, {
      headers: { 'x-ingest-secret': 'wrong_secret' },
    });
    const res = await configHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('Unauthorized');
  });

  it('returns 503 when production environment uses default unconfigured secret', async () => {
    vi.mocked(isProductionEnv).mockReturnValueOnce(true);
    vi.mocked(isKnownDefaultIngestSecret).mockReturnValueOnce(true);
    mockKvStore.clear(); // Falls back to env default

    const req = new Request(`http://localhost:4321/api/internal/pinarchive/config?workspace_id=${mockWsId}`, {
      headers: { 'x-ingest-secret': 'env_secret_default_999' },
    });
    const res = await configHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(503);
  });

  it('returns 200 with stored filter values when authenticated and row exists', async () => {
    mockPinArchiveClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              pin_filter_min_saves: 500,
              pin_filter_min_repins: 100,
              pin_filter_rising_age_days: 7,
              pin_filter_rising_saves: 25,
            },
            error: null,
          }),
        }),
      }),
    });

    const req = new Request(`http://localhost:4321/api/internal/pinarchive/config?workspace_id=${mockWsId}`, {
      headers: { 'x-ingest-secret': mockSecret },
    });
    const res = await configHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.pin_filter_min_saves).toBe(500);
    expect(json.pin_filter_min_repins).toBe(100);
    expect(json.pin_filter_rising_age_days).toBe(7);
    expect(json.pin_filter_rising_saves).toBe(25);
    expect(json.pin_filter_max_age_days).toBeUndefined();
  });

  it('FAIL-LAZY: returns 200 with fallback {0,0,14,34} when row is absent or on any DB query error', async () => {
    mockPinArchiveClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'relation pa_workspace_settings does not exist' },
          }),
        }),
      }),
    });

    const req = new Request(`http://localhost:4321/api/internal/pinarchive/config?workspace_id=${mockWsId}`, {
      headers: { 'x-ingest-secret': mockSecret },
    });
    const res = await configHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.pin_filter_min_saves).toBe(0);
    expect(json.pin_filter_min_repins).toBe(0);
    expect(json.pin_filter_rising_age_days).toBe(14);
    expect(json.pin_filter_rising_saves).toBe(34);
    expect(json.pin_filter_max_age_days).toBeUndefined();
  });
});
