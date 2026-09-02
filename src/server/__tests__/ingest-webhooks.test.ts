import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as ingestHandler } from '../../pages/api/internal/pinterest/ingest';
import { dbClients } from '../db/clients';
import * as webhookSecrets from '../services/webhook-secrets';

describe('Pinterest Ingest Webhook Engine Events Suite (boards.list, board.created, pin.posted, board.deleted)', () => {
  const wsId = '11111111-1111-1111-1111-111111111111';
  const accId = '22222222-2222-2222-2222-222222222222';
  const ingestSecret = 'test-ingest-secret-xyz';

  let mockRuntimeEnv: Record<string, any>;
  let mockLocals: any;
  let pinsDb: any[] = [];
  let boardsDb: any[] = [];
  let boardProvisioningDb: any[] = [];
  let accountsDb: any[] = [];
  let pinDeliveryLogs: any[] = [];
  let mockUpsertError: any = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertError = null;

    mockRuntimeEnv = {
      INGEST_SECRET_KEY: ingestSecret,
      SCHEDULING_SUPABASE_SECRET_KEY: 'test-secret',
    };
    mockLocals = {
      runtimeEnv: mockRuntimeEnv,
    };

    accountsDb = [
      {
        id: accId,
        workspace_id: wsId,
        is_active: true,
      },
    ];

    boardsDb = [
      {
        id: 'board-row-1',
        account_id: accId,
        workspace_id: wsId,
        board_id: 'board-existing-1',
        board_name: 'Existing Board 1',
        created_via: 'webhook_auto_create',
        pin_count: 42,
        follower_count: 150,
        board_created_at: '2026-01-01T00:00:00.000Z',
        board_pins_modified_at: '2026-02-01T00:00:00.000Z',
        last_synced_at: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'board-row-2',
        account_id: accId,
        workspace_id: wsId,
        board_id: 'board-existing-2',
        board_name: 'Existing Board 2',
        created_via: 'webhook_sync',
        pin_count: 88,
        follower_count: 500,
        board_created_at: '2026-01-10T00:00:00.000Z',
        board_pins_modified_at: '2026-02-10T00:00:00.000Z',
        last_synced_at: '2026-02-10T00:00:00.000Z',
      },
    ];

    boardProvisioningDb = [
      {
        id: 'prov-1',
        workspace_id: wsId,
        account_id: accId,
        board_name: '  Design & Architecture  ',
        idempotency_key: `create:${accId}:design & architecture`,
        status: 'provisioning',
        error_message: null,
      },
    ];

    pinsDb = [
      {
        id: 'pin-100',
        workspace_id: wsId,
        account_id: accId,
        title: 'Modern Architecture',
        image_url: 'https://images.example.com/original-image.jpg',
        board_name: 'Existing Board 1',
        status: 'processing',
        attempts: 1,
      },
    ];

    pinDeliveryLogs = [];

    // Mock getEffectiveSecret to match our ingestSecret
    vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
      source: 'workspace',
      value: ingestSecret,
    });

    // Mock dbClients.getSchedulingAdmin
    vi.spyOn(dbClients, 'getSchedulingAdmin').mockImplementation(() => {
      return {
        from: (table: string) => {
          let filterEq: Record<string, any> = {};
          let filterIn: Record<string, any[]> = {};
          let filterOr: string[] = [];
          let updatePayload: any = null;

          const queryBuilder: any = {
            select: vi.fn(() => queryBuilder),
            eq: vi.fn((col: string, val: any) => {
              filterEq[col] = val;
              return queryBuilder;
            }),
            in: vi.fn((col: string, vals: any[]) => {
              filterIn[col] = vals;
              return queryBuilder;
            }),
            or: vi.fn((clause: string) => {
              filterOr.push(clause);
              return queryBuilder;
            }),
            single: vi.fn(async () => {
              const res = executeSelect();
              return { data: res[0] || null, error: null };
            }),
            maybeSingle: vi.fn(async () => {
              const res = executeSelect();
              return { data: res[0] || null, error: null };
            }),
            insert: vi.fn(async (payload: any) => {
              if (table === 'pin_delivery_logs') {
                pinDeliveryLogs.push(payload);
              }
              return { data: payload, error: null };
            }),
            upsert: vi.fn((items: any | any[], opts?: { onConflict?: string }) => {
              if (mockUpsertError) {
                return {
                  select: vi.fn(() => ({
                    single: vi.fn(async () => ({ data: null, error: mockUpsertError })),
                  })),
                  then: (cb: any) => Promise.resolve(cb({ data: null, error: mockUpsertError })),
                };
              }
              const itemsArray = Array.isArray(items) ? items : [items];
              const applyUpsert = () => {
                if (table === 'boards') {
                  for (const item of itemsArray) {
                    const idx = boardsDb.findIndex(
                      (b) => b.account_id === item.account_id && b.board_id === item.board_id
                    );
                    if (idx >= 0) {
                      boardsDb[idx] = { ...boardsDb[idx], ...item };
                    } else {
                      boardsDb.push({ id: `board-gen-${Date.now()}-${Math.random()}`, ...item });
                    }
                  }
                }
              };

              const builder: any = {
                select: vi.fn(() => ({
                  single: vi.fn(async () => {
                    applyUpsert();
                    return { data: itemsArray[0], error: null };
                  }),
                })),
                then: (cb: any) => {
                  applyUpsert();
                  return Promise.resolve(cb({ data: itemsArray, error: null }));
                },
              };
              return builder;
            }),
            update: vi.fn((payload: any) => {
              updatePayload = payload;
              return {
                eq: vi.fn((col: string, val: any) => {
                  filterEq[col] = val;
                  return {
                    eq: vi.fn((col2: string, val2: any) => {
                      filterEq[col2] = val2;
                      applyUpdate();
                      return Promise.resolve({ data: null, error: null });
                    }),
                    then: (cb: any) => {
                      applyUpdate();
                      return Promise.resolve(cb({ data: null, error: null }));
                    },
                  };
                }),
              };

              function applyUpdate() {
                if (table === 'pins') {
                  for (const p of pinsDb) {
                    if (filterEq.id && p.id !== filterEq.id) continue;
                    if (filterEq.workspace_id && p.workspace_id !== filterEq.workspace_id) continue;
                    Object.assign(p, updatePayload);
                  }
                }
                if (table === 'board_provisioning_requests') {
                  for (const req of boardProvisioningDb) {
                    if (filterEq.idempotency_key && req.idempotency_key !== filterEq.idempotency_key) continue;
                    Object.assign(req, updatePayload);
                  }
                }
              }
            }),
            delete: vi.fn(() => {
              return {
                eq: vi.fn((col: string, val: any) => {
                  filterEq[col] = val;
                  return {
                    eq: vi.fn((col2: string, val2: any) => {
                      filterEq[col2] = val2;
                      return {
                        or: vi.fn((clause: string) => {
                          filterOr.push(clause);
                          applyDelete();
                          return Promise.resolve({ data: null, error: null });
                        }),
                        then: (cb: any) => {
                          applyDelete();
                          return Promise.resolve(cb({ data: null, error: null }));
                        },
                      };
                    }),
                  };
                }),
              };

              function applyDelete() {
                if (table === 'boards') {
                  boardsDb = boardsDb.filter((b) => {
                    if (filterEq.account_id && b.account_id !== filterEq.account_id) return true;
                    if (filterEq.workspace_id && b.workspace_id !== filterEq.workspace_id) return true;
                    if (filterOr.length > 0) {
                      const matchesOr = filterOr.some((clause) => {
                        return (
                          clause.includes(`board_id.eq.${b.board_id}`) ||
                          clause.includes(`pinterest_board_id.eq.${b.board_id}`) ||
                          clause.includes(`id.eq.${b.id}`)
                        );
                      });
                      if (matchesOr) return false; // Deleted
                    }
                    return true;
                  });
                }
              }
            }),
            then: vi.fn((cb: any) => {
              const res = executeSelect();
              return Promise.resolve(cb({ data: res, error: null }));
            }),
          };

          function executeSelect() {
            if (table === 'accounts') {
              return accountsDb.filter((a) => {
                if (filterEq.id && a.id !== filterEq.id) return false;
                return true;
              });
            }
            if (table === 'pins') {
              return pinsDb.filter((p) => {
                if (filterEq.id && p.id !== filterEq.id) return false;
                if (filterEq.workspace_id && p.workspace_id !== filterEq.workspace_id) return false;
                return true;
              });
            }
            if (table === 'boards') {
              return boardsDb.filter((b) => {
                if (filterEq.account_id && b.account_id !== filterEq.account_id) return false;
                if (filterIn.board_id && !filterIn.board_id.includes(b.board_id)) return false;
                return true;
              });
            }
            return [];
          }

          return queryBuilder;
        },
      } as any;
    });
  });

  it('1. boards.list: Never deletes unmentioned boards (ARCHITECTURE.md:89 safety) and upserts new boards', async () => {
    // We send only 1 board in boards.list; boardsDb initially has 2 boards!
    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'boards.list',
        workspace_id: wsId,
        account_id: accId,
        boards: [
          {
            id: 'board-new-3',
            name: 'New Synced Board 3',
            pin_count: 10,
            follower_count: 50,
          },
        ],
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.handled).toBe('boards.list');
    expect(json.synced).toBe(1);

    // CRITICAL SAFETY CHECK: Existing board 1 and board 2 were NOT deleted!
    expect(boardsDb.length).toBe(3);
    expect(boardsDb.some((b) => b.board_id === 'board-existing-1')).toBe(true);
    expect(boardsDb.some((b) => b.board_id === 'board-existing-2')).toBe(true);
    expect(boardsDb.some((b) => b.board_id === 'board-new-3')).toBe(true);
  });

  it('2. boards.list: Preserves existing pin_count and follower_count when incoming listing omits metrics', async () => {
    // Lightweight Pinterest board list omitting metrics
    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'boards.list',
        workspace_id: wsId,
        account_id: accId,
        boards: [
          {
            id: 'board-existing-1',
            name: 'Renamed Existing Board 1',
            // Notice: pin_count and follower_count are omitted!
          },
        ],
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);

    const b1 = boardsDb.find((b) => b.board_id === 'board-existing-1');
    expect(b1.board_name).toBe('Renamed Existing Board 1');
    // Existing metrics must NOT be wiped out/nullified!
    expect(b1.pin_count).toBe(42);
    expect(b1.follower_count).toBe(150);
    expect(b1.board_created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('3. pin.posted: Rejects Make template leaks ({{...}}, undefined, null) and preserves valid image_url', async () => {
    // 3a. Make unparsed mustache template string
    const reqTemplate = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.posted',
        workspace_id: wsId,
        pin_id: 'pin-100',
        id: 'pinterest-pin-999',
        image_url: '{{3.media.images.1200x.url}}',
      }),
    });

    const resTemplate = await ingestHandler({ request: reqTemplate, locals: mockLocals } as any);
    expect(resTemplate.status).toBe(200);

    const pin = pinsDb.find((p) => p.id === 'pin-100');
    expect(pin.status).toBe('posted');
    expect(pin.pinterest_pin_id).toBe('pinterest-pin-999');
    // Original valid image_url was preserved, NOT overwritten with {{...}}
    expect(pin.image_url).toBe('https://images.example.com/original-image.jpg');

    // 3b. Stringified 'undefined'
    const reqUndefined = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.posted',
        workspace_id: wsId,
        pin_id: 'pin-100',
        id: 'pinterest-pin-999',
        image_url: 'undefined',
      }),
    });
    await ingestHandler({ request: reqUndefined, locals: mockLocals } as any);
    expect(pin.image_url).toBe('https://images.example.com/original-image.jpg');

    // 3c. Valid image_url updates cleanly
    const reqValid = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.posted',
        workspace_id: wsId,
        pin_id: 'pin-100',
        id: 'pinterest-pin-999',
        image_url: 'https://i.pinimg.com/1200x/clean-cdn-image.jpg',
      }),
    });
    await ingestHandler({ request: reqValid, locals: mockLocals } as any);
    expect(pin.image_url).toBe('https://i.pinimg.com/1200x/clean-cdn-image.jpg');
  });

  it('4. board.created: Normalizes whitespace in idempotency key and marks provisioning completed', async () => {
    // In provisioning DB, we have: '  Design & Architecture  '
    // Pinterest callback sends trimmed: 'Design & Architecture'
    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'board.created',
        workspace_id: wsId,
        account_id: accId,
        board_id: 'pb-design-arch-123',
        board_name: 'Design & Architecture',
        pin_count: 5,
        follower_count: 12,
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);

    // Board was inserted with created_via_idempotency_key
    const newBoard = boardsDb.find((b) => b.board_id === 'pb-design-arch-123');
    expect(newBoard).toBeDefined();
    expect(newBoard.created_via_idempotency_key).toBe(`create:${accId}:design & architecture`);

    // Board provisioning request was marked completed
    const prov = boardProvisioningDb.find((p) => p.id === 'prov-1');
    expect(prov.status).toBe('completed');
  });

  it('5. board.deleted: Deletes specific board identifier cleanly', async () => {
    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'board.deleted',
        workspace_id: wsId,
        account_id: accId,
        board_id: 'board-existing-1',
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.handled).toBe('board.deleted');

    // board-existing-1 was removed, board-existing-2 remains intact
    expect(boardsDb.some((b) => b.board_id === 'board-existing-1')).toBe(false);
    expect(boardsDb.some((b) => b.board_id === 'board-existing-2')).toBe(true);
  });

  it('6. boards.list: returns HTTP 500 when batch upsert fails completely to trigger Make.com retry', async () => {
    mockUpsertError = { message: 'database connection error' };

    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'boards.list',
        workspace_id: wsId,
        account_id: accId,
        boards: [
          { id: 'board-fail-1', name: 'Failed Board' },
        ],
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.synced).toBe(0);
    expect(json.errors?.[0]).toContain('Batch upsert: database connection error');
  });

  it('7. board.created: respects explicit forwarded payload.idempotency_key', async () => {
    boardProvisioningDb.push({
      id: 'prov-custom-key',
      workspace_id: wsId,
      account_id: accId,
      board_name: 'Custom Key Board',
      idempotency_key: 'custom-make-key-xyz-123',
      status: 'provisioning',
      error_message: null,
    });

    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'board.created',
        workspace_id: wsId,
        account_id: accId,
        idempotency_key: 'custom-make-key-xyz-123',
        board_id: 'pb-custom-123',
        board_name: 'Custom Key Board (Pinterest Modified)',
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);

    const newBoard = boardsDb.find((b) => b.board_id === 'pb-custom-123');
    expect(newBoard).toBeDefined();
    expect(newBoard.created_via_idempotency_key).toBe('custom-make-key-xyz-123');

    const prov = boardProvisioningDb.find((p) => p.id === 'prov-custom-key');
    expect(prov.status).toBe('completed');
  });

  it('8. pin.posted: rejects template string in payload.id and preserves existing pinterest_pin_id', async () => {
    pinsDb[0].pinterest_pin_id = 'pin-original-pinterest-id';

    const req = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify({
        event: 'pin.posted',
        workspace_id: wsId,
        pin_id: 'pin-100',
        id: '{{1.id}}',
      }),
    });

    const res = await ingestHandler({ request: req, locals: mockLocals } as any);
    expect(res.status).toBe(200);

    const pin = pinsDb.find((p) => p.id === 'pin-100');
    expect(pin.pinterest_pin_id).toBe('pin-original-pinterest-id');
  });
});
