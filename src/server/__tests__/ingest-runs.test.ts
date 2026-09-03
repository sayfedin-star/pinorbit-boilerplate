import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pinnerETL } from '../services/pinner-etl';
import { analyticsDb } from '../db/analytics';
import { dbClients } from '../db/clients';
import type { PinnerIngestPayload } from '../../lib/types';

vi.mock('../db/analytics', () => ({
  analyticsDb: {
    createIngestionRun: vi.fn(),
    completeIngestionRun: vi.fn(),
    failIngestionRun: vi.fn(),
    checkConsecutiveFailures: vi.fn(),
    upsertAccountDailyMetrics: vi.fn().mockResolvedValue(1),
    upsertAccountSummary: vi.fn().mockResolvedValue(undefined),
    upsertTopPinsSnapshots: vi.fn().mockResolvedValue(1),
    upsertDailyWorkspaceMetrics: vi.fn().mockResolvedValue(1),
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
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: 'a1b2c3d4-e5f6-7890-1234-56789abcdef0',
            workspace_id: '00000000-0000-0000-0000-000000000001',
            analytics_enabled: true,
          },
          error: null,
        }),
      })),
    }),
  },
}));

describe('Project 3 Ingestion Runs Lifecycle & Snitch Alerting (V17)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const connectionId = 'a1b2c3d4-e5f6-7890-1234-56789abcdef0';

  beforeEach(() => {
    vi.clearAllMocks();
    pinnerETL.resetFailureStreak(workspaceId);
  });

  it('records run lifecycle: processing -> completed with rows_processed on success', async () => {
    (analyticsDb.createIngestionRun as any).mockResolvedValue({
      id: 'run-uuid-1',
      workspace_id: workspaceId,
      connection_id: connectionId,
      channel: 'account_analytics',
      job_type: 'daily_sync',
      status: 'processing',
    });

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
      account_analytics: {
        all: {
          daily_metrics: [
            {
              date: '2026-08-07',
              data_status: 'READY',
              metrics: { IMPRESSION: 1000, ENGAGEMENT: 50, SAVE: 10, PIN_CLICK: 30, OUTBOUND_CLICK: 5 },
            },
          ],
          summary_metrics: { IMPRESSION: 1000, ENGAGEMENT: 50 },
        },
      },
    };

    const result = await pinnerETL.processIngestionPayload(payload);

    expect(result.success).toBe(true);
    expect(analyticsDb.createIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: workspaceId,
        connection_id: connectionId,
        channel: 'account_analytics',
        job_type: 'daily_sync',
        status: 'processing',
      })
    );

    expect(analyticsDb.completeIngestionRun).toHaveBeenCalledWith(
      'run-uuid-1',
      2 // 1 daily metric + 1 summary
    );
  });

  it('records run failure and fires Dead Mans Snitch when 2 consecutive failures occur in Project 3', async () => {
    (analyticsDb.createIngestionRun as any).mockResolvedValue({
      id: 'run-uuid-fail-2',
      workspace_id: workspaceId,
      connection_id: connectionId,
      channel: 'account_analytics',
      job_type: 'daily_sync',
      status: 'failed',
    });

    (analyticsDb.checkConsecutiveFailures as any).mockResolvedValue(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return { ok: true, status: 200 } as any;
    }) as any);

    const payload: PinnerIngestPayload = {
      success: false,
      channel: 'account_analytics',
      workspace_id: workspaceId,
      connection_id: connectionId,
      error_details: {
        http_status: 500,
        error_code: 'INTERNAL_SERVER_ERROR',
        error_message: 'Pinterest upstream 500 error',
      },
    };

    // First failure
    await pinnerETL.processIngestionPayload(payload);

    // Second failure -> triggers snitch
    const result2 = await pinnerETL.processIngestionPayload(payload);

    expect(result2.success).toBe(false);
    expect(result2.snitchAlerted).toBe(true);
    expect(analyticsDb.failIngestionRun).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://webhook.site/test-snitch',
      expect.objectContaining({ method: 'POST' })
    );

    fetchSpy.mockRestore();
  });
});
