import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pinnerETL, COLUMN_ALLOWLISTS } from '../services/pinner-etl';
import { analyticsDb } from '../db/analytics';
import { dbClients } from '../db/clients';
import type { PinnerIngestPayload } from '../../lib/types';

// Mock DB layer
vi.mock('../db/analytics', () => ({
  analyticsDb: {
    createIngestionRun: vi.fn().mockResolvedValue({ id: 'mock-run-id' }),
    completeIngestionRun: vi.fn().mockResolvedValue(undefined),
    failIngestionRun: vi.fn().mockResolvedValue(undefined),
    checkConsecutiveFailures: vi.fn().mockResolvedValue(false),
    upsertAccountDailyMetrics: vi.fn().mockResolvedValue(2),
    upsertAccountSummary: vi.fn().mockResolvedValue(undefined),
    upsertTopPinsSnapshots: vi.fn().mockResolvedValue(5),
    upsertDailyWorkspaceMetrics: vi.fn().mockResolvedValue(2),
    updateConnectionLastSync: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../db/clients', () => ({
  dbClients: {
    getConfig: vi.fn().mockReturnValue({
      INGEST_SECRET_KEY: 'test-ingest-secret',
      SNITCH_WEBHOOK_URL: 'https://webhook.site/test-snitch',
    }),
    getAnalytics: vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        const chain: any = {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          lt: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          then: vi.fn().mockImplementation((fn: any) => Promise.resolve(fn ? fn({ error: null }) : { error: null })),
          maybeSingle: vi.fn().mockImplementation(async () => ({
            data: {
              id: 'a1b2c3d4-e5f6-7890-1234-56789abcdef0',
              workspace_id: '00000000-0000-0000-0000-000000000001',
              analytics_enabled: true,
            },
            error: null,
          })),
        };
        return chain;
      }),
    }),
  },
}));

describe('Pinner Analytics ETL Processor Suite (R4 Schema Allowlist & R5 Lifecycle)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const connectionId = 'a1b2c3d4-e5f6-7890-1234-56789abcdef0';

  beforeEach(() => {
    vi.clearAllMocks();
    pinnerETL.resetFailureStreak(workspaceId);
  });

  // Real Pinterest API v5 sample response
  const samplePinterestDailyAnalytics = {
    all: {
      summary_metrics: {
        IMPRESSION: 72586,
        ENGAGEMENT: 2911,
        ENGAGEMENT_RATE: 0.04010415231587358,
        OUTBOUND_CLICK: 139,
        OUTBOUND_CLICK_RATE: 0.001914969828892624,
        PIN_CLICK: 2366,
        PIN_CLICK_RATE: 0.03259581737525143,
        SAVE: 406,
        SAVE_RATE: 0.005593365111729535,
        TOTAL_COMMENTS: 1,
        TOTAL_REACTIONS: 3,
        VIDEO_AVG_WATCH_TIME: 0,
        VIDEO_MRC_VIEW: 0,
        VIDEO_V50_WATCH_TIME: 0,
      },
      daily_metrics: [
        {
          data_status: 'READY',
          date: '2026-08-01',
          metrics: {
            IMPRESSION: 10000,
            ENGAGEMENT: 400,
            ENGAGEMENT_RATE: 0.04,
            OUTBOUND_CLICK: 20,
            OUTBOUND_CLICK_RATE: 0.002,
            PIN_CLICK: 300,
            PIN_CLICK_RATE: 0.03,
            SAVE: 80,
            SAVE_RATE: 0.008,
            TOTAL_COMMENTS: 5,
            TOTAL_REACTIONS: 2,
            UNKNOWN_FUTURE_KEY: 99,
          },
        },
        {
          data_status: 'READY',
          date: '2026-08-02',
          metrics: {
            IMPRESSION: 12000,
            ENGAGEMENT: 500,
            ENGAGEMENT_RATE: 0.0416,
            OUTBOUND_CLICK: 25,
            OUTBOUND_CLICK_RATE: 0.002,
            PIN_CLICK: 350,
            PIN_CLICK_RATE: 0.029,
            SAVE: 100,
            SAVE_RATE: 0.0083,
          },
        },
      ],
    },
  };

  const samplePinterestTopPins = {
    sort_by: 'IMPRESSION' as const,
    pins_by_sort_mode: {
      IMPRESSION: [
        {
          pin_id: '10485011674598527',
          title: 'Creamy Lemon Pasta',
          image_url: 'https://i.pinimg.com/236x/test1.jpg',
          destination_url: 'https://example.com/pasta',
          data_status: 'READY',
          metrics: {
            IMPRESSION: 4172,
            ENGAGEMENT: 121,
            ENGAGEMENT_RATE: 0.029,
            OUTBOUND_CLICK: 5,
            OUTBOUND_CLICK_RATE: 0.0012,
            PIN_CLICK: 98,
            PIN_CLICK_RATE: 0.0235,
            SAVE: 18,
            SAVE_RATE: 0.0043,
          },
        },
        {
          pin_id: '10485011674598528',
          title: 'Crispy Smashed Potatoes',
          image_url: 'https://i.pinimg.com/236x/test2.jpg',
          destination_url: 'https://example.com/potatoes',
          data_status: 'READY',
          metrics: {
            IMPRESSION: 3500,
            ENGAGEMENT: 95,
            ENGAGEMENT_RATE: 0.0271,
            OUTBOUND_CLICK: 3,
            OUTBOUND_CLICK_RATE: 0.0008,
            PIN_CLICK: 75,
            PIN_CLICK_RATE: 0.0214,
            SAVE: 17,
            SAVE_RATE: 0.0048,
          },
        },
      ],
      SAVE: [
        {
          pin_id: '10485011674598528',
          title: 'Crispy Smashed Potatoes',
          image_url: 'https://i.pinimg.com/236x/test2.jpg',
          destination_url: 'https://example.com/potatoes',
          data_status: 'READY',
          metrics: {
            IMPRESSION: 3500,
            ENGAGEMENT: 95,
            SAVE: 17,
          },
        },
      ],
    },
  };

  it('R4.5: processes payload containing unknown metric keys; upsert payload keys are strict subset of allowlist', async () => {
    const payload: PinnerIngestPayload = {
      success: true,
      workspace_id: workspaceId,
      connection_id: connectionId,
      request_context: {
        start_date: '2026-08-01',
        end_date: '2026-08-08',
        job_type: 'daily_sync',
      },
      account_analytics: samplePinterestDailyAnalytics,
      top_pins_analytics: samplePinterestTopPins,
    };

    const result = await pinnerETL.processIngestionPayload(payload);

    expect(result.success).toBe(true);
    expect(result.persisted).toBe(true);

    // Verify daily metrics upsert call args
    const dailyCalls = (analyticsDb.upsertAccountDailyMetrics as any).mock.calls;
    expect(dailyCalls.length).toBeGreaterThan(0);
    const dailyRows: any[] = dailyCalls[0][2];
    expect(dailyRows.length).toBe(2);

    for (const row of dailyRows) {
      // Must NOT contain total_comments or total_reactions as column keys
      expect(row.total_comments).toBeUndefined();
      expect(row.total_reactions).toBeUndefined();
      expect(row.UNKNOWN_FUTURE_KEY).toBeUndefined();

      // All keys must be subset of allowlist
      for (const key of Object.keys(row)) {
        expect(COLUMN_ALLOWLISTS.account_analytics_daily.has(key)).toBe(true);
      }
    }

    // Verify raw_metrics retained unknown keys for forward-compatibility
    const firstRow = dailyRows[0];
    expect(firstRow.raw_metrics).toBeDefined();
    expect(firstRow.raw_metrics.TOTAL_COMMENTS).toBe(5);
    expect(firstRow.raw_metrics.UNKNOWN_FUTURE_KEY).toBe(99);

    // Verify summaries upsert call args
    const summaryCalls = (analyticsDb.upsertAccountSummary as any).mock.calls;
    expect(summaryCalls.length).toBeGreaterThan(0);
    const summaryRow: any = summaryCalls[0][2];
    expect(summaryRow.total_comments).toBeUndefined();
    expect(summaryRow.total_reactions).toBeUndefined();
    for (const key of Object.keys(summaryRow)) {
      expect(COLUMN_ALLOWLISTS.account_analytics_summaries.has(key)).toBe(true);
    }
  });

  it('R5.3: fails ingestion run and records error details when exception is thrown during ETL execution', async () => {
    (analyticsDb.upsertAccountDailyMetrics as any).mockRejectedValueOnce(
      new Error('Simulated Project 3 DB Postgres Constraint Violation')
    );

    const payload: PinnerIngestPayload = {
      success: true,
      workspace_id: workspaceId,
      connection_id: connectionId,
      request_context: {
        start_date: '2026-08-01',
        end_date: '2026-08-08',
        job_type: 'daily_sync',
      },
      account_analytics: samplePinterestDailyAnalytics,
    };

    await expect(pinnerETL.processIngestionPayload(payload)).rejects.toThrow(
      'Simulated Project 3 DB Postgres Constraint Violation'
    );

    // Verify failIngestionRun was called so the run is NEVER left in 'processing'
    expect(analyticsDb.failIngestionRun).toHaveBeenCalledWith(
      'mock-run-id',
      expect.objectContaining({
        message: 'Simulated Project 3 DB Postgres Constraint Violation',
        error_code: 'ETL_EXCEPTION',
      })
    );
  });

  it('handles 401 Unauthorized by deactivating account in Project 3', async () => {
    const payload: PinnerIngestPayload = {
      success: false,
      workspace_id: workspaceId,
      connection_id: connectionId,
      request_context: { job_type: 'daily_sync' },
      error_details: {
        http_status: 401,
        error_code: 'UNAUTHORIZED',
        error_message: 'The OAuth token is expired or was revoked',
      },
    };

    const result = await pinnerETL.processIngestionPayload(payload);

    expect(result.success).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.revoked).toBe(true);

    expect(analyticsDb.failIngestionRun).toHaveBeenCalledWith(
      'mock-run-id',
      expect.objectContaining({ http_status: 401 })
    );
  });

  it('triggers Dead Mans Snitch alert on 2+ consecutive failures', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return { ok: true, status: 200 } as any;
    }) as any);

    const failurePayload: PinnerIngestPayload = {
      success: false,
      workspace_id: workspaceId,
      connection_id: connectionId,
      request_context: { job_type: 'daily_sync' },
      error_details: {
        http_status: 500,
        error_code: 'INTERNAL_SERVER_ERROR',
        error_message: 'Pinterest internal error',
      },
    };

    // Failure 1 -> No snitch yet
    const r1 = await pinnerETL.processIngestionPayload(failurePayload);
    expect(r1.snitchAlerted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Failure 2 -> Triggers Snitch
    const r2 = await pinnerETL.processIngestionPayload(failurePayload);
    expect(r2.snitchAlerted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://webhook.site/test-snitch',
      expect.objectContaining({ method: 'POST' })
    );

    fetchSpy.mockRestore();
  });

  it('processes Account Analytics-only payload without top_pins_analytics', async () => {
    const payload: PinnerIngestPayload = {
      success: true,
      channel: 'account_analytics',
      workspace_id: workspaceId,
      connection_id: connectionId,
      request_context: {
        start_date: '2026-08-01',
        end_date: '2026-08-08',
        job_type: 'daily_sync',
      },
      account_analytics: samplePinterestDailyAnalytics,
      top_pins_analytics: null,
    };

    const result = await pinnerETL.processIngestionPayload(payload);
    expect(result.success).toBe(true);
    expect(result.persisted).toBe(true);
    expect(analyticsDb.upsertAccountDailyMetrics).toHaveBeenCalled();
    expect(analyticsDb.upsertTopPinsSnapshots).not.toHaveBeenCalled();
  });

  it('processes Top Pins-only payload without account_analytics', async () => {
    const payload: PinnerIngestPayload = {
      success: true,
      channel: 'top_pins',
      workspace_id: workspaceId,
      connection_id: connectionId,
      request_context: {
        start_date: '2026-08-01',
        end_date: '2026-08-08',
        job_type: 'daily_sync',
      },
      account_analytics: null,
      top_pins_analytics: samplePinterestTopPins,
    };

    const result = await pinnerETL.processIngestionPayload(payload);
    expect(result.success).toBe(true);
    expect(result.persisted).toBe(true);
    expect(analyticsDb.upsertAccountDailyMetrics).not.toHaveBeenCalled();
    expect(analyticsDb.upsertTopPinsSnapshots).toHaveBeenCalled();
  });

  it('rejects payload when connection_id is not registered in Project 3 analytics_connections', async () => {
    (dbClients.getAnalytics as any).mockReturnValueOnce({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    });

    const payload: PinnerIngestPayload = {
      success: true,
      workspace_id: workspaceId,
      connection_id: 'unknown-conn-id',
      account_analytics: samplePinterestDailyAnalytics,
    };

    const result = await pinnerETL.processIngestionPayload(payload);
    expect(result.success).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.error).toContain('is not registered in Project 3 analytics_connections');
  });

  it('R13.5: parses Shape B (Make.com raw Pinterest body with sort_by and pins array) and populates date_availability', async () => {
    const rawShapeBPayload: any = {
      success: true,
      channel: 'top_pins',
      workspace_id: workspaceId,
      connection_id: connectionId,
      top_pins_analytics: {
        sort_by: 'ENGAGEMENT',
        pins: [
          {
            pin_id: 'pin_shape_b_1',
            title: 'Top Engagement Pin 1',
            metrics: {
              IMPRESSION: 5000,
              ENGAGEMENT: 250,
              PIN_CLICK: 150,
              OUTBOUND_CLICK: 20,
              SAVE: 80,
              ENGAGEMENT_RATE: 0.05,
            },
            data_status: 'READY',
          },
          {
            pin_id: 'pin_shape_b_2',
            title: 'Top Engagement Pin 2',
            metrics: {
              IMPRESSION: 3000,
              ENGAGEMENT: 120,
              PIN_CLICK: 80,
              OUTBOUND_CLICK: 10,
              SAVE: 30,
              ENGAGEMENT_RATE: 0.04,
            },
            data_status: 'READY',
          },
        ],
        date_availability: {
          latest_available_timestamp: '2026-08-09T00:00:00Z',
          is_realtime: false,
        },
      },
    };

    let capturedRows: any[] = [];
    (analyticsDb.upsertTopPinsSnapshots as any).mockImplementationOnce(
      (_ws: string, _conn: string, rows: any[]) => {
        capturedRows = rows;
        return Promise.resolve(rows.length);
      }
    );

    const result = await pinnerETL.processIngestionPayload(rawShapeBPayload);
    expect(result.success).toBe(true);
    expect(result.persisted).toBe(true);
    expect(capturedRows.length).toBe(2);

    expect(capturedRows[0].pin_id).toBe('pin_shape_b_1');
    expect(capturedRows[0].rank_position).toBe(1);
    expect(capturedRows[0].sort_by).toBe('ENGAGEMENT');
    expect(capturedRows[0].impressions).toBe(5000);
    expect(capturedRows[0].engagement).toBe(250);
    expect(capturedRows[0].date_availability).toEqual({
      latest_available_timestamp: '2026-08-09T00:00:00Z',
      is_realtime: false,
    });

    expect(capturedRows[1].pin_id).toBe('pin_shape_b_2');
    expect(capturedRows[1].rank_position).toBe(2);
    expect(capturedRows[1].sort_by).toBe('ENGAGEMENT');
  });
});

