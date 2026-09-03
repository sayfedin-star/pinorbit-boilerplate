import { describe, it, expect, beforeEach, vi } from 'vitest';
import { analyticsDb } from '../db/analytics';
import { dbClients } from '../db/clients';

describe('Regression: Account daily metrics totals paginate beyond 1000 rows (R-07 / S-06)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const connectionId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('correctly aggregates all rows across multiple 1000-row chunks', async () => {
    // Total 2500 rows, each row has impressions: 10, engagements: 2, outbound_clicks: 1, pin_clicks: 1, saves: 1
    const totalRows = 2500;
    const allRows = Array.from({ length: totalRows }, (_, i) => ({
      impressions: 10,
      engagements: 2,
      outbound_clicks: 1,
      pin_clicks: 1,
      saves: 1,
      metric_date: `2026-01-01`,
      data_status: 'READY',
      id: `row-${i}`,
    }));

    const mockAnalyticsClient = {
      from: vi.fn((_table: string) => {
        const query: any = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          gte: vi.fn(() => query),
          lte: vi.fn(() => query),
          order: vi.fn(() => query),
          range: vi.fn(async (start: number, end: number) => {
            const chunk = allRows.slice(start, end + 1);
            return { data: chunk, count: totalRows, error: null };
          }),
        };
        return query;
      }),
    };

    vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient as any);

    const result = await analyticsDb.getConnectionDailyMetrics(
      workspaceId,
      connectionId,
      undefined,
      undefined,
      { page: 1, pageSize: 50 }
    );

    // Total impressions should be 2500 * 10 = 25,000
    expect(result.totals.impressions).toBe(25000);
    // Total engagements should be 2500 * 2 = 5,000
    expect(result.totals.engagements).toBe(5000);
    // Total saves should be 2500 * 1 = 2,500
    expect(result.totals.saves).toBe(2500);
    // Total outbound clicks should be 2500 * 1 = 2,500
    expect(result.totals.outbound_clicks).toBe(2500);
  });
});
