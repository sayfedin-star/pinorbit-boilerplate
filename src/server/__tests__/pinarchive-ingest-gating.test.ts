import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as ingestHandler } from '../../pages/api/internal/pinarchive/ingest';
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
    getServerEnv: vi.fn().mockReturnValue({}),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockReturnValue(mockSchedulingAdmin),
      getPinArchive: vi.fn().mockReturnValue(mockPinArchive),
      getConfig: vi.fn().mockReturnValue({}),
    },
  };
});

describe('PinArchive Ingest Gating & Safety Guardrails Suite', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockSecret = 'test_secret_pinarchive_gating';

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
    };

    mockAdminClient = dbClients.getSchedulingAdmin();
    mockPinArchiveClient = dbClients.getPinArchive();

    // Default valid workspace in P1
    mockAdminClient.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
    });

    mockKvStore.set(`ingest_secret:ws:${mockWsId}`, mockSecret);
  });

  it('GATING 1: returns 409 ingest_disabled when workspace-level ingest is disabled', async () => {
    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_workspace_settings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { workspace_id: mockWsId, ingest_enabled: false },
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify({
        workspace_id: mockWsId,
        username: 'test_creator',
        pins: [{ pin_id: '111', title: 'P1', saves: 10 }],
      }),
    });

    const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('ingest_disabled');
    expect(json.skipped).toBe(true);
  });

  it('GATING 2: skips write and returns 200 account_ingest_disabled when account ingest_enabled is false', async () => {
    let pinArchiveWrites = 0;

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
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: 'acc-uuid-1',
                    status: 'active',
                    ingest_enabled: false,
                    interval_days: 3,
                  },
                  error: null,
                }),
              }),
            }),
          }),
          upsert: vi.fn().mockImplementation(() => {
            pinArchiveWrites++;
            return { select: vi.fn().mockReturnValue({ single: vi.fn() }) };
          }),
        };
      }
      if (table === 'pa_pins') {
        return {
          upsert: vi.fn().mockImplementation(() => {
            pinArchiveWrites++;
            return { select: vi.fn() };
          }),
        };
      }
      if (table === 'pa_runs') {
        return {
          insert: vi.fn().mockImplementation(() => {
            pinArchiveWrites++;
            return Promise.resolve();
          }),
        };
      }
      return {};
    });

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify({
        workspace_id: mockWsId,
        username: 'test_creator',
        pins: [{ pin_id: '111', title: 'P1', saves: 10 }],
      }),
    });

    const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.skipped).toBe('account_ingest_disabled');
    expect(pinArchiveWrites).toBe(0);
  });

  it('GATING 3: skips write and preserves status when account is paused and policy is reject', async () => {
    let pinArchiveWrites = 0;

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_workspace_settings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  workspace_id: mockWsId,
                  ingest_enabled: true,
                  paused_account_policy: 'reject',
                },
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
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: 'acc-uuid-1',
                    status: 'paused',
                    ingest_enabled: true,
                    interval_days: 3,
                  },
                  error: null,
                }),
              }),
            }),
          }),
          upsert: vi.fn().mockImplementation(() => {
            pinArchiveWrites++;
            return { select: vi.fn().mockReturnValue({ single: vi.fn() }) };
          }),
        };
      }
      if (table === 'pa_pins' || table === 'pa_runs') {
        return {
          upsert: vi.fn().mockImplementation(() => {
            pinArchiveWrites++;
            return { select: vi.fn() };
          }),
          insert: vi.fn().mockImplementation(() => {
            pinArchiveWrites++;
            return Promise.resolve();
          }),
        };
      }
      return {};
    });

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify({
        workspace_id: mockWsId,
        username: 'paused_creator',
        account_meta: { status: 'active' }, // GAS payload trying to unpause
        pins: [{ pin_id: '111', title: 'P1', saves: 10 }],
      }),
    });

    const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.skipped).toBe('account_paused');
    expect(pinArchiveWrites).toBe(0);
  });

  it('GATING 4: truncates pins when exceeding max_batch_pins and reports truncated count in response', async () => {
    let processedPinsCount = 0;

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_workspace_settings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  workspace_id: mockWsId,
                  ingest_enabled: true,
                  max_batch_pins: 3,
                },
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
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }),
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'acc-uuid-1', workspace_id: mockWsId, username: 'testuser' },
                error: null,
              }),
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
          upsert: vi.fn().mockImplementation((pins: any[]) => {
            processedPinsCount = pins.length;
            return {
              select: vi.fn().mockResolvedValue({
                data: pins.map((p, idx) => ({ id: `p-ref-${idx}`, pin_id: p.pin_id, saves: p.saves })),
                error: null,
              }),
            };
          }),
        };
      }
      if (table === 'pa_pin_metrics') {
        return { upsert: vi.fn().mockResolvedValue({ data: [], error: null }) };
      }
      if (table === 'pa_runs') {
        return { insert: vi.fn().mockResolvedValue({ data: {}, error: null }) };
      }
      return {};
    });

    const pinsArray = [
      { pin_id: 'p1', title: 'P1', saves: 10 },
      { pin_id: 'p2', title: 'P2', saves: 20 },
      { pin_id: 'p3', title: 'P3', saves: 30 },
      { pin_id: 'p4', title: 'P4', saves: 40 },
      { pin_id: 'p5', title: 'P5', saves: 50 },
    ];

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify({
        workspace_id: mockWsId,
        username: 'testuser',
        pins: pinsArray,
      }),
    });

    const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.accepted).toBe(3);
    expect(json.truncated).toBe(5);
    expect(processedPinsCount).toBe(3);
  });

  it('GATING 5: assigns workspace default_interval_days on newly created account when omitted in payload', async () => {
    let upsertedAccountPayload: any = null;

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_workspace_settings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  workspace_id: mockWsId,
                  ingest_enabled: true,
                  default_interval_days: 7,
                },
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
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }),
          upsert: vi.fn().mockImplementation((accData: any) => {
            upsertedAccountPayload = accData;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'acc-uuid-new', workspace_id: mockWsId, username: 'brand_new_creator' },
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
            eq: vi.fn().mockReturnValue({ in: vi.fn().mockResolvedValue({ data: [], error: null }) }),
          }),
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        };
      }
      if (table === 'pa_pin_metrics') return { upsert: vi.fn().mockResolvedValue({ data: [], error: null }) };
      if (table === 'pa_runs') return { insert: vi.fn().mockResolvedValue({ data: {}, error: null }) };
      return {};
    });

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify({
        workspace_id: mockWsId,
        username: 'brand_new_creator',
        pins: [],
      }),
    });

    const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(200);
    expect(upsertedAccountPayload.interval_days).toBe(7);
  });

  it('GATING 6: stamps archived_at with fetchedAt on brand-new pin, and PRESERVES existing archived_at on re-push', async () => {
    let upsertedPinsPayload: any[] = [];
    const priorStamp = '2026-08-20T10:00:00.000Z';
    const currentFetchedAt = '2026-08-24T12:00:00.000Z';

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
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }),
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'acc-uuid-1', workspace_id: mockWsId, username: 'testuser' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'pa_pins') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'existing-p1-id',
                    pin_id: 'p_existing',
                    saves: 100,
                    repins: 50,
                    comments: 5,
                    share_count: 10,
                    archived_at: priorStamp,
                  },
                ],
                error: null,
              }),
            }),
          }),
          upsert: vi.fn().mockImplementation((pins: any[]) => {
            upsertedPinsPayload = pins;
            return {
              select: vi.fn().mockResolvedValue({
                data: pins.map((p, idx) => ({ id: `p-ref-${idx}`, pin_id: p.pin_id, saves: p.saves })),
                error: null,
              }),
            };
          }),
        };
      }
      if (table === 'pa_pin_metrics') return { upsert: vi.fn().mockResolvedValue({ data: [], error: null }) };
      if (table === 'pa_runs') return { insert: vi.fn().mockResolvedValue({ data: {}, error: null }) };
      return {};
    });

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify({
        workspace_id: mockWsId,
        username: 'testuser',
        fetched_at: currentFetchedAt,
        pins: [
          { pin_id: 'p_existing', title: 'Existing Pin' },
          { pin_id: 'p_new', title: 'New Pin' },
        ],
      }),
    });

    const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(200);

    expect(upsertedPinsPayload).toHaveLength(2);
    const existingPinUpsert = upsertedPinsPayload.find((p) => p.pin_id === 'p_existing');
    const newPinUpsert = upsertedPinsPayload.find((p) => p.pin_id === 'p_new');

    // (a) re-push WITHOUT archived_at PRESERVES existing stamp
    expect(existingPinUpsert?.archived_at).toBe(priorStamp);

    // (b) first push STAMPS archived_at = fetchedAt
    expect(newPinUpsert?.archived_at).toBe(currentFetchedAt);
  });
});
