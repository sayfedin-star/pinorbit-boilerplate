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
    getServerEnv: vi.fn().mockReturnValue({
      SCHEDULING_SUPABASE_URL: 'https://eygdoetdwqllvsxpvoex.supabase.co',
      SCHEDULING_SUPABASE_SECRET_KEY: 'sb_secret_p1',
      PINARCHIVE_SUPABASE_URL: 'https://kuuugffvyokywtgmdrfk.supabase.co',
      PINARCHIVE_SUPABASE_SECRET_KEY: 'sb_secret_p4',
      INGEST_SECRET_KEY: 'test_secret_key_123',
    }),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockReturnValue(mockSchedulingAdmin),
      getPinArchive: vi.fn().mockReturnValue(mockPinArchive),
    },
  };
});

describe('Phase 0 Hotfixes (F1-F4) — PinArchive Wipe Prevention & Ingest Stomp Guard', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockSecret = 'test_secret_key_123';
  let mockRuntimeEnv: Record<string, any>;
  let mockAdminClient: any;
  let mockPinArchiveClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntimeEnv = {
      INGEST_SECRET_KEY: mockSecret,
    };
    mockAdminClient = dbClients.getSchedulingAdmin();
    mockPinArchiveClient = dbClients.getPinArchive();

    mockAdminClient.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockWsId }, error: null }),
    });
  });

  it('F1: GAS-shaped payload without share_count and reactions preserves existing DB values', async () => {
    const existingPin = {
      id: 'pin-uuid-1',
      pin_id: '12345678',
      title: 'Original Title',
      saves: 500,
      repins: 200,
      comments: 10,
      share_count: 85,
      reactions: { total: 42, type_1: 40, type_7: 2 },
      annotations: [{ name: 'Idea A', idea_id: '111', url: '/ideas/a' }],
    };

    let upsertedPins: any[] = [];

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
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'acc-1', status: 'active' }, error: null }),
              }),
            }),
          }),
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'acc-1' }, error: null }),
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
          upsert: vi.fn().mockImplementation((pins: any[]) => {
            upsertedPins = pins;
            return {
              select: vi.fn().mockResolvedValue({ data: pins, error: null }),
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

    // GAS Collector payload: sends saves/repins/velocity, but DOES NOT send share_count or reactions
    const gasPayload = {
      workspace_id: mockWsId,
      username: 'creator1',
      fetched_at: '2026-08-25T12:00:00Z',
      pins: [
        {
          pin_id: '12345678',
          title: 'Updated Title by GAS',
          saves: 550,
          repins: 220,
          comments: 12,
          velocity: 15.5,
          // note: NO share_count or reactions key
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

    expect(upsertedPins.length).toBe(1);
    const pin = upsertedPins[0];
    expect(pin.saves).toBe(550);
    // Crucial: existing enrichment is preserved!
    expect(pin.share_count).toBe(85);
    expect(pin.reactions).toEqual({ total: 42, type_1: 40, type_7: 2 });
  });

  it('F1: Refresh payload with explicit share_count and reactions updates them properly', async () => {
    const existingPin = {
      id: 'pin-uuid-1',
      pin_id: '12345678',
      saves: 500,
      share_count: 85,
      reactions: { total: 42 },
    };

    let upsertedPins: any[] = [];

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
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'acc-1' }, error: null }),
              }),
            }),
          }),
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'acc-1' }, error: null }),
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
          upsert: vi.fn().mockImplementation((pins: any[]) => {
            upsertedPins = pins;
            return {
              select: vi.fn().mockResolvedValue({ data: pins, error: null }),
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

    const refreshPayload = {
      workspace_id: mockWsId,
      username: 'creator1',
      trigger: 'refresh',
      pins: [
        {
          pin_id: '12345678',
          saves: 600,
          share_count: 120,
          reactions: { total: 55, type_1: 50, type_7: 5 },
        },
      ],
    };

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify(refreshPayload),
    });

    const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(200);

    expect(upsertedPins.length).toBe(1);
    expect(upsertedPins[0].share_count).toBe(120);
    expect(upsertedPins[0].reactions).toEqual({ total: 55, type_1: 50, type_7: 5 });
  });

  it('F2: Ingest with trigger="refresh" does NOT overwrite pa_accounts.pins_count', async () => {
    let accountUpsertPayload: any = null;

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
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'acc-1', pins_count: 850 }, error: null }),
              }),
            }),
          }),
          upsert: vi.fn().mockImplementation((data: any) => {
            accountUpsertPayload = data;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: 'acc-1' }, error: null }),
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
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({ data: [], error: null }),
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

    // GAS sync batch sends trigger: 'refresh' and account_meta.pins_count = batch size (25)
    const syncPayload = {
      workspace_id: mockWsId,
      username: 'creator1',
      trigger: 'refresh',
      account_meta: {
        pins_count: 25,
        last_result: 'sync',
      },
      pins: [{ pin_id: 'p1', saves: 100 }],
    };

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify(syncPayload),
    });

    const res = await ingestHandler({ request: req, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(res.status).toBe(200);

    // pins_count must NOT be present in the upsert payload when trigger is 'refresh'
    expect(accountUpsertPayload).not.toHaveProperty('pins_count');
    // Generic 'sync' / 'refresh' must NOT overwrite last_result
    expect(accountUpsertPayload).not.toHaveProperty('last_result');

    // Discovery summary MUST be written to last_result
    const discoveryPayload = {
      workspace_id: mockWsId,
      username: 'creator1',
      account_meta: {
        last_result: 'pages=12 +161 qual=161 sheet=544',
      },
      pins: [{ pin_id: 'p2', saves: 200 }],
    };
    const reqDiscovery = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify(discoveryPayload),
    });
    const resDiscovery = await ingestHandler({ request: reqDiscovery, locals: { runtime: { env: mockRuntimeEnv } } } as any);
    expect(resDiscovery.status).toBe(200);
    expect(accountUpsertPayload.last_result).toBe('pages=12 +161 qual=161 sheet=544');
  });
});
