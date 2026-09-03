import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleDispatch } from '../../pages/api/internal/pinterest/dispatch-due-pin';
import { dbClients } from '../db/clients';

describe('Thread-Safe Dispatch Due Pin Concurrency & Hardening Suite', () => {
  const scheduleId = '11111111-1111-1111-1111-111111111111';
  const dispatchToken = 'test-dispatch-token-secret-12345';
  const workspaceId = '22222222-2222-2222-2222-222222222222';
  const accountId = '33333333-3333-3333-3333-333333333333';
  const webhookId = '44444444-4444-4444-4444-444444444444';
  const webhookUrl = 'https://hook.make.com/test-pin-receiver';

  let mockRuntimeEnv: Record<string, any>;
  let mockLocals: any;
  let activeLeaseScheduleId: string | null = null;
  let webhookCalls: any[] = [];
  let pinsDb: any[] = [];
  let schedulesDb: any[] = [];
  let webhooksDb: any[] = [];
  let boardsDb: any[] = [];
  let simulatePinDisappearedBeforeFetch = false;
  let lastClaimLimit: number | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    activeLeaseScheduleId = null;
    webhookCalls = [];
    simulatePinDisappearedBeforeFetch = false;
    lastClaimLimit = null;

    mockRuntimeEnv = {
      SCHEDULING_SUPABASE_SECRET_KEY: 'test-secret-key-123',
    };
    mockLocals = {
      runtimeEnv: mockRuntimeEnv,
    };

    schedulesDb = [
      {
        id: scheduleId,
        workspace_id: workspaceId,
        account_id: accountId,
        webhook_id: webhookId,
        dispatch_token: dispatchToken,
        status: 'active',
        batch: 1,
        locked_until: null,
        window_start: '00:00',
        window_end: '23:59',
      },
    ];

    webhooksDb = [
      {
        id: webhookId,
        account_id: accountId,
        webhook_url: webhookUrl,
        is_active: true,
        remaining_capacity: 100,
        executions_used: 0,
        priority: 1,
      },
    ];

    boardsDb = [
      {
        account_id: accountId,
        board_name: 'Tech News',
        pinterest_board_id: 'pb-tech-123',
      },
    ];

    pinsDb = [
      {
        id: 'pin-001',
        workspace_id: workspaceId,
        account_id: accountId,
        title: 'Future of AI',
        description: 'Deep dive into AI',
        image_url: 'https://images.example.com/ai.jpg',
        board_name: 'Tech News',
        status: 'pending',
        attempts: 0,
        claimed_at: null,
        claimed_by_schedule_id: null,
      },
    ];

    // Mock global fetch to capture webhook calls with realistic async network duration
    global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      if (url === webhookUrl) {
        // Asynchronous delay to simulate in-flight HTTP push (e.g. Make.com processing time)
        await new Promise((resolve) => setTimeout(resolve, 80));
        webhookCalls.push({ url, body: JSON.parse(opts.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    // Mock dbClients.getSchedulingAdmin
    vi.spyOn(dbClients, 'getSchedulingAdmin').mockImplementation(() => {
      return {
        from: (table: string) => {
          let selectedCols: any = null;
          let filterEq: Record<string, any> = {};
          let filterOr: string[] = [];
          let filterIn: Record<string, any[]> = {};
          let filterLt: Record<string, any> = {};
          let filterGte: Record<string, any> = {};
          let updatePayload: any = null;

          const queryBuilder: any = {
            select: vi.fn((cols: string = '*') => {
              selectedCols = cols;
              return queryBuilder;
            }),
            eq: vi.fn((col: string, val: any) => {
              filterEq[col] = val;
              return queryBuilder;
            }),
            or: vi.fn((clause: string) => {
              filterOr.push(clause);
              return queryBuilder;
            }),
            in: vi.fn((col: string, vals: any[]) => {
              filterIn[col] = vals;
              return queryBuilder;
            }),
            lt: vi.fn((col: string, val: any) => {
              filterLt[col] = val;
              return queryBuilder;
            }),
            gte: vi.fn((col: string, val: any) => {
              filterGte[col] = val;
              return queryBuilder;
            }),
            order: vi.fn(() => queryBuilder),
            limit: vi.fn(() => queryBuilder),
            not: vi.fn(() => queryBuilder),
            ilike: vi.fn(() => queryBuilder),
            maybeSingle: vi.fn(async () => {
              if (table === 'posting_schedules') {
                const s = schedulesDb.find((x) => x.id === filterEq.id);
                return { data: s || null, error: null };
              }
              if (table === 'workspace_retention_settings') {
                return { data: { processing_timeout_minutes: 45 }, error: null };
              }
              if (table === 'accounts') {
                return { data: { id: filterEq.id, is_active: true, max_pins_per_day: 20 }, error: null };
              }
              if (table === 'boards') {
                const b = boardsDb.find((x) => x.account_id === filterEq.account_id);
                return { data: b || null, error: null };
              }
              if (table === 'pins') {
                if (simulatePinDisappearedBeforeFetch) {
                  return { data: null, error: null };
                }
                const p = pinsDb.find((x) => x.id === filterEq.id);
                if (filterEq.status && p && p.status !== filterEq.status) {
                  return { data: null, error: null };
                }
                return { data: p || null, error: null };
              }
              if (table === 'board_provisioning_requests') {
                return { data: null, error: null };
              }
              return { data: null, error: null };
            }),
            update: vi.fn((payload: any) => {
              updatePayload = payload;
              return {
                eq: vi.fn((col: string, val: any) => {
                  filterEq[col] = val;
                  return {
                    eq: vi.fn((col2: string, val2: any) => {
                      filterEq[col2] = val2;
                      return {
                        then: (cb: any) => {
                          applyUpdate();
                          return Promise.resolve(cb());
                        },
                      };
                    }),
                    in: vi.fn((col2: string, vals: any[]) => {
                      filterIn[col2] = vals;
                      return {
                        then: (cb: any) => {
                          applyUpdate();
                          return Promise.resolve(cb());
                        },
                      };
                    }),
                    or: vi.fn((orClause: string) => {
                      filterOr.push(orClause);
                      return {
                        or: vi.fn((orClause2: string) => {
                          filterOr.push(orClause2);
                          return {
                            lt: vi.fn((ltCol: string, ltVal: any) => {
                              filterLt[ltCol] = ltVal;
                              return {
                                then: (cb: any) => {
                                  applyUpdate();
                                  return Promise.resolve(cb());
                                },
                              };
                            }),
                          };
                        }),
                        lt: vi.fn((ltCol: string, ltVal: any) => {
                          filterLt[ltCol] = ltVal;
                          return {
                            then: (cb: any) => {
                              applyUpdate();
                              return Promise.resolve(cb());
                            },
                          };
                        }),
                      };
                    }),
                    then: (cb: any) => {
                      applyUpdate();
                      return Promise.resolve(cb());
                    },
                  };
                }),
                in: vi.fn((col: string, vals: any[]) => {
                  filterIn[col] = vals;
                  applyUpdate();
                  return Promise.resolve({ data: null, error: null });
                }),
              };

              function applyUpdate() {
                if (table === 'pins') {
                  for (const p of pinsDb) {
                    if (filterEq.id && p.id !== filterEq.id) continue;
                    if (filterIn.id && !filterIn.id.includes(p.id)) continue;
                    if (filterEq.status && p.status !== filterEq.status) continue;
                    // Scope check for orphan sweep:
                    if (filterOr.length > 0) {
                      const scopeClause = filterOr.find((c) => c.includes('claimed_by_schedule_id'));
                      if (scopeClause) {
                        const matchesSchedule =
                          p.claimed_by_schedule_id === scheduleId ||
                          (!p.claimed_by_schedule_id && p.account_id === accountId);
                        if (!matchesSchedule) continue;
                      }
                      // Check stale condition: do not sweep fresh pins!
                      if (p.claimed_at) {
                        const isStale = new Date(p.claimed_at).getTime() < Date.now() - 40 * 60000;
                        if (!isStale) continue;
                      }
                    }
                    Object.assign(p, updatePayload);
                  }
                }
                if (table === 'posting_schedules') {
                  for (const s of schedulesDb) {
                    if (filterEq.id && s.id !== filterEq.id) continue;
                    Object.assign(s, updatePayload);
                  }
                }
              }
            }),
            then: vi.fn((cb: any) => {
              let res: any[] = [];
              if (table === 'pins') {
                res = pinsDb.filter((p) => {
                  if (filterIn.id && !filterIn.id.includes(p.id)) return false;
                  return true;
                });
              }
              if (table === 'account_webhooks') {
                res = webhooksDb.filter((w) => w.account_id === filterEq.account_id);
              }
              if (table === 'boards') {
                res = boardsDb.filter((b) => b.account_id === filterEq.account_id);
              }
              return Promise.resolve(cb({ data: res, error: null }));
            }),
          };

          return queryBuilder;
        },
        rpc: vi.fn(async (proc: string, args: any) => {
          if (proc === 'increment_webhook_execution') {
            const hook = webhooksDb.find((w) => w.id === args.p_webhook_id);
            if (hook) {
              const count = args.p_count || 1;
              hook.executions_used = (hook.executions_used || 0) + count;
              hook.monthly_usage = (hook.monthly_usage || 0) + count;
              if (typeof hook.remaining_capacity === 'number') {
                hook.remaining_capacity = Math.max(0, hook.remaining_capacity - count);
              }
            }
            return { data: null, error: null };
          }
          if (proc === 'acquire_schedule_dispatch_lease') {
            const sid = args.p_schedule_id;
            if (activeLeaseScheduleId === sid) {
              return { data: false, error: null }; // Lease already held by concurrent worker
            }
            activeLeaseScheduleId = sid;
            return { data: true, error: null };
          }
          if (proc === 'release_schedule_dispatch_lease') {
            if (activeLeaseScheduleId === args.p_schedule_id) {
              activeLeaseScheduleId = null;
            }
            return { data: null, error: null };
          }
          if (proc === 'claim_due_pins_simple') {
            lastClaimLimit = args.p_limit;
            const due = pinsDb.filter((p) => p.status === 'pending' && p.account_id === args.p_account_id).slice(0, args.p_limit || 1);
            for (const p of due) {
              p.status = 'processing';
              p.claimed_at = new Date().toISOString();
              p.claimed_by_schedule_id = args.p_schedule_id || null;
              p.attempts += 1;
            }
            return {
              data: due.map((d) => ({ id: d.id, account_id: d.account_id, workspace_id: d.workspace_id })),
              error: null,
            };
          }
          return { data: null, error: null };
        }),
      } as any;
    });
  });

  it('1. Concurrency Stress Test: Blocks duplicate in-flight FastCron calls with same dispatch_token', async () => {
    // Simulate 5 simultaneous FastCron HTTP calls for the exact same schedule and dispatch_token
    const body = { schedule_id: scheduleId, dispatch_token: dispatchToken };

    const results = await Promise.all([
      handleDispatch(body, mockLocals).then((r) => r.json()),
      handleDispatch(body, mockLocals).then((r) => r.json()),
      handleDispatch(body, mockLocals).then((r) => r.json()),
      handleDispatch(body, mockLocals).then((r) => r.json()),
      handleDispatch(body, mockLocals).then((r) => r.json()),
    ]);

    // Exactly 1 execution should succeed in dispatching
    const dispatchedRuns = results.filter((r) => r.dispatched === 1);
    expect(dispatchedRuns.length).toBe(1);

    // The other 4 concurrent runs must be blocked by the concurrency lease guard or dispatch debounce
    const blockedRuns = results.filter((r) => r.reason === 'already_processing' || r.reason === 'recently_dispatched');
    expect(blockedRuns.length).toBe(4);

    // Verify webhook was pushed exactly ONCE (zero double-dispatch)
    expect(webhookCalls.length).toBe(1);
    expect(webhookCalls[0].body.pin_id).toBe('pin-001');
    expect(webhookCalls[0].body.idempotency_key).toBe('pin.post:pin-001:1');
  });

  it('2. Per-Schedule Orphan Sweep: Sweeps only target schedule pins without touching other schedules in workspace', async () => {
    const otherScheduleId = '99999999-9999-9999-9999-999999999999';
    const otherAccountId = '88888888-8888-8888-8888-888888888888';

    pinsDb = [
      // Pin from target schedule (orphaned > 45m ago)
      {
        id: 'pin-sched-A',
        workspace_id: workspaceId,
        account_id: accountId,
        title: 'Schedule A Pin',
        image_url: 'https://images.example.com/a.jpg',
        board_name: 'Tech News',
        status: 'processing',
        attempts: 1,
        claimed_at: new Date(Date.now() - 60 * 60000).toISOString(),
        claimed_by_schedule_id: scheduleId,
      },
      // Pin from other schedule in the SAME workspace (also in processing)
      {
        id: 'pin-sched-B',
        workspace_id: workspaceId,
        account_id: otherAccountId,
        title: 'Schedule B Pin',
        image_url: 'https://images.example.com/b.jpg',
        board_name: 'Tech News',
        status: 'processing',
        attempts: 1,
        claimed_at: new Date(Date.now() - 60 * 60000).toISOString(),
        claimed_by_schedule_id: otherScheduleId,
      },
    ];

    const body = { schedule_id: scheduleId, dispatch_token: dispatchToken };
    await handleDispatch(body, mockLocals);

    const pinA = pinsDb.find((p) => p.id === 'pin-sched-A');
    const pinB = pinsDb.find((p) => p.id === 'pin-sched-B');

    // Pin from schedule A was swept and then claimed for processing
    expect(pinA.claimed_by_schedule_id).toBe(scheduleId);

    // Pin from schedule B in the same workspace was NOT swept by schedule A!
    expect(pinB.status).toBe('processing');
    expect(pinB.claimed_by_schedule_id).toBe(otherScheduleId);
  });

  it('3. Pre-Fetch Idempotency Guard: Skips fetch if pin transitions out of processing before webhook call', async () => {
    pinsDb = [
      {
        id: 'pin-racing',
        workspace_id: workspaceId,
        account_id: accountId,
        title: 'Racing Pin',
        image_url: 'https://images.example.com/racing.jpg',
        board_name: 'Tech News',
        status: 'pending',
        attempts: 0,
        claimed_at: null,
      },
    ];

    // Simulate pin transitioning out of processing right before pre-fetch verification
    simulatePinDisappearedBeforeFetch = true;

    const body = { schedule_id: scheduleId, dispatch_token: dispatchToken };
    const res = await handleDispatch(body, mockLocals).then((r) => r.json());

    // Verified: Webhook push was skipped due to idempotency guard
    expect(res.skipped).toBe(1);
    expect(res.dispatched).toBe(0);
    expect(webhookCalls.length).toBe(0);
  });

  it('4. Missing Board Path: Reverts attempt count and backs off without spinning', async () => {
    boardsDb = []; // No boards configured

    pinsDb = [
      {
        id: 'pin-no-board',
        workspace_id: workspaceId,
        account_id: accountId,
        title: 'No Board Pin',
        image_url: 'https://images.example.com/art.jpg',
        board_name: 'Uncreated Board',
        status: 'pending',
        attempts: 1,
        claimed_at: null,
      },
    ];

    const body = { schedule_id: scheduleId, dispatch_token: dispatchToken };
    const res = await handleDispatch(body, mockLocals).then((r) => r.json());

    expect(res.skipped).toBe(1);
    expect(webhookCalls.length).toBe(0);

    const pin = pinsDb.find((p) => p.id === 'pin-no-board');
    expect(pin.status).toBe('pending');
    // Attempts was reverted back so it didn't inflate while waiting for board
    expect(pin.attempts).toBe(1);
    expect(pin.next_retry_at).toBeDefined();
  });

  it('5. Rapid Sequential Retry: Rejects calls within 15s debounce window after dispatch', async () => {
    // Set schedule.last_dispatched_at to 3 seconds ago
    schedulesDb[0].last_dispatched_at = new Date(Date.now() - 3000).toISOString();

    const body = { schedule_id: scheduleId, dispatch_token: dispatchToken };
    const res = await handleDispatch(body, mockLocals).then((r) => r.json());

    expect(res.success).toBe(true);
    expect(res.dispatched).toBe(0);
    expect(res.reason).toBe('recently_dispatched');
    expect(webhookCalls.length).toBe(0);
  });

  it('6. Atomic Webhook Counter: Correctly updates executions_used and capacity', async () => {
    const body = { schedule_id: scheduleId, dispatch_token: dispatchToken };
    const res = await handleDispatch(body, mockLocals).then((r) => r.json());

    expect(res.dispatched).toBe(1);
    const hook = webhooksDb.find((w) => w.id === webhookId);
    expect(hook.executions_used).toBe(1);
    expect(hook.monthly_usage).toBe(1);
    expect(hook.remaining_capacity).toBe(99);
  });

  it('7. P1-03: Clamps batch limit to 50 when schedule.batch exceeds 50', async () => {
    const sched = schedulesDb.find((s) => s.id === scheduleId);
    if (sched) sched.batch = 100;

    const body = { schedule_id: scheduleId, dispatch_token: dispatchToken, force: true };
    const res = await handleDispatch(body, mockLocals).then((r) => r.json());

    expect(res.success).toBe(true);
    expect(lastClaimLimit).toBe(50);
  });
});
