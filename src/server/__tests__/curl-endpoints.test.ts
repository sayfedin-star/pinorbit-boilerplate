import { describe, it, expect, vi } from 'vitest';
import { GET as getConnections, POST as postConnections } from '../../pages/api/analytics/connections/index';
import { PATCH as patchConnById, DELETE as deleteConnById } from '../../pages/api/analytics/connections/[id]';
import { GET as getConnSettings, POST as postConnSettings } from '../../pages/api/analytics/connections/[id]/settings';
import { GET as getConnDaily } from '../../pages/api/analytics/connections/[id]/daily';
import { DELETE as deleteConnDailyDate } from '../../pages/api/analytics/connections/[id]/daily/[date]';
import { GET as getConnTopPins } from '../../pages/api/analytics/connections/[id]/top-pins';
import { GET as getCronLogs } from '../../pages/api/analytics/cron/logs';
import { GET as getOverview } from '../../pages/api/analytics/overview';
import { GET as getRuns } from '../../pages/api/analytics/runs';
import { POST as postScheduleSync } from '../../pages/api/analytics/schedule/sync';
import { GET as getSecrets } from '../../pages/api/analytics/secrets/index';
import { POST as postSecretsRegenerate } from '../../pages/api/analytics/secrets/regenerate';
import { POST as postSecretsRemoveOverride } from '../../pages/api/analytics/secrets/remove-override';
import { GET as getSettings, POST as postSettings } from '../../pages/api/analytics/settings';
import { GET as getTimeseries } from '../../pages/api/analytics/timeseries';
import { GET as getTopPins } from '../../pages/api/analytics/top-pins';
import { POST as postTriggerSync } from '../../pages/api/analytics/trigger-sync';
import { GET as getPinLeaderboard } from '../../pages/api/analytics/connections/[id]/pin-leaderboard';
import { GET as getPinTrends } from '../../pages/api/analytics/connections/[id]/pin-trends';
import { POST as postDailyDispatch } from '../../pages/api/internal/pinterest/daily-dispatch';
import { POST as postIngest } from '../../pages/api/internal/pinterest/ingest';
import { POST as postCleanupRetention } from '../../pages/api/internal/pinterest/cleanup-retention';
import { GET as getPurgePreview } from '../../pages/api/analytics/connections/[id]/purge-preview';
import { POST as postPurge } from '../../pages/api/analytics/connections/[id]/purge';

const { mockDbTable } = vi.hoisted(() => {
  const createQueryBuilder = () => {
    const builder: any = {
      select: vi.fn(() => builder),
      insert: vi.fn(() => builder),
      update: vi.fn(() => builder),
      delete: vi.fn(() => builder),
      upsert: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      neq: vi.fn(() => builder),
      is: vi.fn(() => builder),
      in: vi.fn(() => builder),
      lt: vi.fn(() => builder),
      lte: vi.fn(() => builder),
      gt: vi.fn(() => builder),
      gte: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      single: vi.fn().mockResolvedValue({ data: { id: 'mock-id', workspace_id: '9f08ca03-e79c-46fa-9518-6858216daf65', display_name: 'test' }, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'mock-id', workspace_id: '9f08ca03-e79c-46fa-9518-6858216daf65', display_name: 'test' }, error: null }),
      then: (resolve: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
    };
    return builder;
  };
  const mockDbTable = () => createQueryBuilder();
  return { mockDbTable };
});

vi.mock('../../server/db/clients', () => ({
  dbClients: {
    getSchedulingAdmin: vi.fn().mockReturnValue({ from: mockDbTable, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    getAnalytics: vi.fn().mockReturnValue({ from: mockDbTable, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    getCompetitors: vi.fn().mockReturnValue({ from: mockDbTable, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }),
  },
  getServerEnv: vi.fn().mockReturnValue({ INGEST_SECRET_KEY: 'test_sec' }),
  isProductionEnv: vi.fn().mockReturnValue(false),
  isKnownDefaultIngestSecret: vi.fn().mockReturnValue(false),
}));

vi.mock('../../server/auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue({
    id: 'member-1',
    role: 'owner',
    isAdmin: true,
    isOwner: true,
  }),
}));

vi.mock('../../server/db/analytics', () => ({
  analyticsDb: {
    listWorkspaceConnections: vi.fn().mockResolvedValue([
      { id: '8aa5b660-e54a-4e44-b8bd-28e9d3ab8596', display_name: 'hymumdotcom', analytics_enabled: true },
    ]),
    getWorkspaceConnectionsWithStats: vi.fn().mockResolvedValue([
      { id: '8aa5b660-e54a-4e44-b8bd-28e9d3ab8596', display_name: 'hymumdotcom', analytics_enabled: true },
    ]),
    getWorkspaceConnection: vi.fn().mockResolvedValue({
      id: '8aa5b660-e54a-4e44-b8bd-28e9d3ab8596',
      workspace_id: '9f08ca03-e79c-46fa-9518-6858216daf65',
      display_name: 'hymumdotcom',
      analytics_enabled: true,
      analytics_fastcron_job_id: 1234,
      top_pins_fastcron_job_id: 5678,
      top_pins_num_of_pins: 50,
      top_pins_sort_modes: ['IMPRESSION'],
    }),
    createWorkspaceConnection: vi.fn().mockResolvedValue({
      id: 'mock-new-id',
      display_name: 'new_conn',
      analytics_enabled: true,
    }),
    updateWorkspaceConnection: vi.fn().mockResolvedValue({
      id: '8aa5b660-e54a-4e44-b8bd-28e9d3ab8596',
      display_name: 'hymumdotcom',
    }),
    deleteWorkspaceConnection: vi.fn().mockResolvedValue(undefined),
    softDeleteWorkspaceConnection: vi.fn().mockResolvedValue(undefined),
    getWorkspaceDailyMetrics: vi.fn().mockResolvedValue({ rows: [], totals: {} }),
    getPinLeaderboard: vi.fn().mockResolvedValue([]),
    getPinTrends: vi.fn().mockResolvedValue([]),
    previewPurge: vi.fn().mockResolvedValue({ daily_count: 0, summaries_count: 0, top_pins_count: 0, affected_rollup_dates: [], total_records: 0 }),
    purgeAnalyticsData: vi.fn().mockResolvedValue({ purge_log_id: 'mock-purge-id', counts: { daily_deleted: 0, summaries_deleted: 0, rollups_rebuilt: 0, top_pins_deleted: 0 } }),
    getDailyMetricsForConnection: vi.fn().mockResolvedValue({ rows: [], totals: {} }),
    getConnectionDailyMetrics: vi.fn().mockResolvedValue({ rows: [], totals: {} }),
    deleteDailySnapshotRecord: vi.fn().mockResolvedValue(undefined),
    deleteDailyMetricAndRecompute: vi.fn().mockResolvedValue(undefined),
    getRankedTopPins: vi.fn().mockResolvedValue([]),
    getTopPinsForConnection: vi.fn().mockResolvedValue([]),
    listIngestionRuns: vi.fn().mockResolvedValue([]),
    createIngestionRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
    updateIngestionRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
    completeIngestionRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
    failIngestionRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
    updateConnectionLastSync: vi.fn().mockResolvedValue({}),
    upsertAccountDailyMetrics: vi.fn().mockResolvedValue({}),
    recomputeWorkspaceSummaries: vi.fn().mockResolvedValue({}),
    getWorkspaceAnalyticsSettings: vi.fn().mockResolvedValue({
      workspace_id: '9f08ca03-e79c-46fa-9518-6858216daf65',
      timezone: 'UTC',
      is_sync_enabled: true,
    }),
    upsertWorkspaceAnalyticsSettings: vi.fn().mockResolvedValue({}),
    getTimeseriesMetrics: vi.fn().mockResolvedValue([]),
    getConnectionHealth: vi.fn().mockResolvedValue({ total_runs: 10, consecutive_failures: 0, last_success_at: '2026-08-10T12:00:00Z', revoked: false }),
    getLatestFailedRun: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../server/services/fastcron-service', () => ({
  fastcronService: {
    validateWebhookUrl: vi.fn().mockReturnValue({ valid: true }),
    parseTimeToCron: vi.fn().mockReturnValue({ valid: true, cron: '0 4 * * *' }),
    syncScheduleWithFastCron: vi.fn().mockResolvedValue({ success: true, fastcron_job_id: 1234 }),
    triggerManualSync: vi.fn().mockResolvedValue({ success: true, message: 'Triggered' }),
    getCronLogs: vi.fn().mockResolvedValue({ success: true, logs: [] }),
    disableFastCronJob: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../server/services/pinner-analytics-service', () => ({
  pinnerAnalyticsService: {
    getOverview: vi.fn().mockResolvedValue({
      data: {
        impressions: 48730,
        engagements: 1936,
        pin_clicks: 1588,
        outbound_clicks: 79,
        saves: 247,
      },
      cacheStatus: 'MISS',
    }),
    getTimeseries: vi.fn().mockResolvedValue({
      data: [],
      cacheStatus: 'MISS',
    }),
    getTopPins: vi.fn().mockResolvedValue({
      data: [],
      cacheStatus: 'MISS',
    }),
    getTopPinsServerPaginated: vi.fn().mockResolvedValue({
      data: { rows: [], total: 0, window: null },
      cacheStatus: 'MISS',
    }),
    getAccountOverviewMetrics: vi.fn().mockResolvedValue({
      impressions: 48730,
      engagements: 1936,
      pin_clicks: 1588,
      outbound_clicks: 79,
      saves: 247,
    }),
    getWorkspaceConnectionsWithStats: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../server/services/webhook-secrets', () => ({
  regenerate: vi.fn().mockResolvedValue('new_secret_val_123'),
  getSecretStatus: vi.fn().mockResolvedValue({ secret: 'test_sec', source: 'global', hasOverride: false }),
  getSecretStatusMasked: vi.fn().mockResolvedValue({ masked: '••••1234', source: 'global', hasOverride: false }),
  getSecretForWorkspace: vi.fn().mockResolvedValue({ secret: 'test_sec', source: 'global', hasOverride: false }),
  getEffectiveSecret: vi.fn().mockResolvedValue({ value: 'test_sec', source: 'global' }),
  getSecretCandidates: vi.fn().mockResolvedValue([{ value: 'test_sec', source: 'global' }]),
  verifyIngestSecret: vi.fn().mockResolvedValue({ valid: true, matchedSource: 'global' }),
  removeWorkspaceOverride: vi.fn().mockResolvedValue(true),
  maskSecret: vi.fn((s: string) => (s ? `••••${s.slice(-4)}` : '••••')),
}));

vi.mock('../../server/services/kv-webhook-secrets', () => ({
  kvWebhookSecrets: {
    getSecretForWorkspace: vi.fn().mockResolvedValue({ secret: 'test_sec', source: 'global', hasOverride: false }),
    rotateSecret: vi.fn().mockResolvedValue({ success: true, secret: 'new_sec' }),
    removeWorkspaceOverride: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../server/db/clients', () => {
  const createQueryBuilder = () => {
    const q: any = {
      select: vi.fn(() => q),
      delete: vi.fn(() => q),
      update: vi.fn(() => q),
      eq: vi.fn(() => q),
      lt: vi.fn(() => q),
      in: vi.fn(() => q),
      is: vi.fn(() => q),
      limit: vi.fn(() => q),
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: [{ id: 'pin-1', window_end: '2026-01-01T00:00:00Z', workspace_id: '9f08ca03-e79c-46fa-9518-6858216daf65', connection_id: '8aa5b660-e54a-4e44-b8bd-28e9d3ab8596', sort_by: 'SAVE' }], count: 15, error: null }).then(resolve, reject),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: '8aa5b660-e54a-4e44-b8bd-28e9d3ab8596',
          workspace_id: '9f08ca03-e79c-46fa-9518-6858216daf65',
          display_name: 'hymumdotcom',
          analytics_enabled: true,
          make_webhook_url: 'https://webhook.site/test',
          retention_posted_days: 30,
          processing_timeout_minutes: 45,
        },
        error: null,
      }),
    };
    return q;
  };

  return {
    isProductionEnv: vi.fn().mockReturnValue(false),
    isKnownDefaultIngestSecret: vi.fn().mockReturnValue(false),
    isKnownDefaultKek: vi.fn().mockReturnValue(false),
    dbClients: {
      getAnalytics: vi.fn().mockReturnValue({
        from: vi.fn(() => createQueryBuilder()),
      }),
      getSchedulingAdmin: vi.fn().mockReturnValue({
        from: vi.fn(() => createQueryBuilder()),
      }),
      getConfig: vi.fn().mockReturnValue({}),
    },
    getServerEnv: vi.fn().mockReturnValue({
      INGEST_SECRET_KEY: 'test_sec',
    }),
  };
});

describe('R12/R15 Full 17-Endpoint Route Verification Suite', () => {
  const wsId = '9f08ca03-e79c-46fa-9518-6858216daf65';
  const connId = '8aa5b660-e54a-4e44-b8bd-28e9d3ab8596';
  const locals = {
    user: { id: 'u1', email: 'test@example.com' },
    supabase: {},
    activeWorkspaceId: wsId,
    runtime: { env: { INGEST_SECRET_KEY: 'test_sec' } },
  };

  const results: Array<{ endpoint: string; method: string; status: number; contentType: string }> = [];

  it('verifies all 17 analytics API route endpoints return application/json Content-Type (never text/html)', async () => {
    // 1. GET /api/analytics/connections
    const r1 = await getConnections({ request: new Request('http://localhost/api/analytics/connections?window_days=30'), locals } as any);
    results.push({ endpoint: '/api/analytics/connections', method: 'GET', status: r1.status, contentType: r1.headers.get('content-type') || '' });

    // 2. POST /api/analytics/connections
    const r2 = await postConnections({ request: new Request('http://localhost/api/analytics/connections', { method: 'POST', body: JSON.stringify({ display_name: 'test' }) }), locals } as any);
    results.push({ endpoint: '/api/analytics/connections', method: 'POST', status: r2.status, contentType: r2.headers.get('content-type') || '' });

    // 3. PATCH /api/analytics/connections/[id]
    const r3 = await patchConnById({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}`, { method: 'PATCH', body: JSON.stringify({ display_name: 'updated' }) }), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]', method: 'PATCH', status: r3.status, contentType: r3.headers.get('content-type') || '' });

    // 4. DELETE /api/analytics/connections/[id]
    const r4 = await deleteConnById({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}`, { method: 'DELETE' }), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]', method: 'DELETE', status: r4.status, contentType: r4.headers.get('content-type') || '' });

    // 5. GET /api/analytics/connections/[id]/settings
    const r5 = await getConnSettings({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}/settings`), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]/settings', method: 'GET', status: r5.status, contentType: r5.headers.get('content-type') || '' });

    // 6. POST /api/analytics/connections/[id]/settings
    const r6 = await postConnSettings({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}/settings`, { method: 'POST', body: JSON.stringify({ top_pins_num_of_pins: 50, top_pins_sort_modes: ['IMPRESSION'] }) }), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]/settings', method: 'POST', status: r6.status, contentType: r6.headers.get('content-type') || '' });

    // 7. GET /api/analytics/connections/[id]/daily
    const r7 = await getConnDaily({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}/daily?from_date=2026-08-01&to_date=2026-08-08`), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]/daily', method: 'GET', status: r7.status, contentType: r7.headers.get('content-type') || '' });

    // 8. DELETE /api/analytics/connections/[id]/daily/[date]
    const r8 = await deleteConnDailyDate({ params: { id: connId, date: '2026-08-01' }, request: new Request(`http://localhost/api/analytics/connections/${connId}/daily/2026-08-01`, { method: 'DELETE' }), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]/daily/[date]', method: 'DELETE', status: r8.status, contentType: r8.headers.get('content-type') || '' });

    // 9. GET /api/analytics/connections/[id]/top-pins
    const r9 = await getConnTopPins({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}/top-pins?sort_by=IMPRESSION&from_date=2026-08-01&to_date=2026-08-08`), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]/top-pins', method: 'GET', status: r9.status, contentType: r9.headers.get('content-type') || '' });

    // 10. GET /api/analytics/cron/logs
    const r10 = await getCronLogs({ request: new Request(`http://localhost/api/analytics/cron/logs?connection_id=${connId}&channel=analytics`), locals } as any);
    results.push({ endpoint: '/api/analytics/cron/logs', method: 'GET', status: r10.status, contentType: r10.headers.get('content-type') || '' });

    // 11. GET /api/analytics/overview
    const r11 = await getOverview({ request: new Request(`http://localhost/api/analytics/overview?connection_id=${connId}`), locals } as any);
    results.push({ endpoint: '/api/analytics/overview', method: 'GET', status: r11.status, contentType: r11.headers.get('content-type') || '' });

    // 12. GET /api/analytics/runs
    const r12 = await getRuns({ request: new Request(`http://localhost/api/analytics/runs?connection_id=${connId}`), locals } as any);
    results.push({ endpoint: '/api/analytics/runs', method: 'GET', status: r12.status, contentType: r12.headers.get('content-type') || '' });

    // 13. POST /api/analytics/schedule/sync
    const r13 = await postScheduleSync({ request: new Request('http://localhost/api/analytics/schedule/sync', { method: 'POST', body: JSON.stringify({ connection_id: connId, channel: 'top_pins' }) }), locals } as any);
    results.push({ endpoint: '/api/analytics/schedule/sync', method: 'POST', status: r13.status, contentType: r13.headers.get('content-type') || '' });

    // 14. GET /api/analytics/secrets
    const r14 = await getSecrets({ request: new Request('http://localhost/api/analytics/secrets'), locals } as any);
    results.push({ endpoint: '/api/analytics/secrets', method: 'GET', status: r14.status, contentType: r14.headers.get('content-type') || '' });

    // 15. POST /api/analytics/secrets/regenerate
    const r15 = await postSecretsRegenerate({ request: new Request('http://localhost/api/analytics/secrets/regenerate', { method: 'POST', body: JSON.stringify({ scope: 'workspace' }) }), locals } as any);
    results.push({ endpoint: '/api/analytics/secrets/regenerate', method: 'POST', status: r15.status, contentType: r15.headers.get('content-type') || '' });

    // 16. POST /api/analytics/secrets/remove-override
    const r16 = await postSecretsRemoveOverride({ request: new Request('http://localhost/api/analytics/secrets/remove-override', { method: 'POST' }), locals } as any);
    results.push({ endpoint: '/api/analytics/secrets/remove-override', method: 'POST', status: r16.status, contentType: r16.headers.get('content-type') || '' });

    // 17. GET /api/analytics/settings
    const r17 = await getSettings({ request: new Request('http://localhost/api/analytics/settings'), locals } as any);
    results.push({ endpoint: '/api/analytics/settings', method: 'GET', status: r17.status, contentType: r17.headers.get('content-type') || '' });

    // 18. POST /api/analytics/settings
    const r18 = await postSettings({ request: new Request('http://localhost/api/analytics/settings', { method: 'POST', body: JSON.stringify({ timezone: 'UTC' }) }), locals } as any);
    results.push({ endpoint: '/api/analytics/settings', method: 'POST', status: r18.status, contentType: r18.headers.get('content-type') || '' });

    // 19. GET /api/analytics/timeseries
    const r19 = await getTimeseries({ request: new Request(`http://localhost/api/analytics/timeseries?connection_id=${connId}&window_days=30`), locals } as any);
    results.push({ endpoint: '/api/analytics/timeseries', method: 'GET', status: r19.status, contentType: r19.headers.get('content-type') || '' });

    // 20. GET /api/analytics/top-pins
    const r20 = await getTopPins({ request: new Request(`http://localhost/api/analytics/top-pins?connection_id=${connId}`), locals } as any);
    results.push({ endpoint: '/api/analytics/top-pins', method: 'GET', status: r20.status, contentType: r20.headers.get('content-type') || '' });

    // 21. POST /api/analytics/trigger-sync
    const r21 = await postTriggerSync({ request: new Request('http://localhost/api/analytics/trigger-sync', { method: 'POST', body: JSON.stringify({ connection_id: connId, channel: 'top_pins', mode: 'sync' }) }), locals } as any);
    results.push({ endpoint: '/api/analytics/trigger-sync', method: 'POST', status: r21.status, contentType: r21.headers.get('content-type') || '' });

    // 22. POST /api/internal/pinterest/daily-dispatch
    const r22 = await postDailyDispatch({ request: new Request('http://localhost/api/internal/pinterest/daily-dispatch', { method: 'POST', headers: { 'x-ingest-secret': 'test_sec' }, body: JSON.stringify({ connection_id: connId, channel: 'account_analytics' }) }), locals: { runtimeEnv: { INGEST_SECRET_KEY: 'test_sec' } } } as any);
    results.push({ endpoint: '/api/internal/pinterest/daily-dispatch', method: 'POST', status: r22.status, contentType: r22.headers.get('content-type') || '' });

    // 23. POST /api/internal/pinterest/ingest
    const r23 = await postIngest({ request: new Request('http://localhost/api/internal/pinterest/ingest', { method: 'POST', headers: { 'x-ingest-secret': 'test_sec' }, body: JSON.stringify({ connection_id: connId, channel: 'account_analytics', success: true, request_id: 'req1', account_analytics: {} }) }), locals: { runtimeEnv: { INGEST_SECRET_KEY: 'test_sec' } } } as any);
    results.push({ endpoint: '/api/internal/pinterest/ingest', method: 'POST', status: r23.status, contentType: r23.headers.get('content-type') || '' });

    // 24. GET /api/analytics/connections/[id]/pin-leaderboard
    const r24 = await getPinLeaderboard({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}/pin-leaderboard?sort_by=IMPRESSION`), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]/pin-leaderboard', method: 'GET', status: r24.status, contentType: r24.headers.get('content-type') || '' });

    // 25. GET /api/analytics/connections/[id]/pin-trends
    const r25 = await getPinTrends({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}/pin-trends?pin_id=pin123&sort_by=IMPRESSION`), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]/pin-trends', method: 'GET', status: r25.status, contentType: r25.headers.get('content-type') || '' });

    // 26. POST /api/internal/pinterest/cleanup-retention
    const r26 = await postCleanupRetention({ request: new Request('http://localhost/api/internal/pinterest/cleanup-retention', { method: 'POST', headers: { 'x-ingest-secret': 'test_sec', 'x-workspace-id': wsId } }), locals: { runtimeEnv: { INGEST_SECRET_KEY: 'test_sec' } } } as any);
    results.push({ endpoint: '/api/internal/pinterest/cleanup-retention', method: 'POST', status: r26.status, contentType: r26.headers.get('content-type') || '' });

    // 27. GET /api/analytics/connections/[id]/purge-preview
    const r27 = await getPurgePreview({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}/purge-preview?from=2026-08-01&to=2026-08-05&targets=daily`), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]/purge-preview', method: 'GET', status: r27.status, contentType: r27.headers.get('content-type') || '' });

    // 28. POST /api/analytics/connections/[id]/purge
    const r28 = await postPurge({ params: { id: connId }, request: new Request(`http://localhost/api/analytics/connections/${connId}/purge`, { method: 'POST', body: JSON.stringify({ from_date: '2026-08-01', to_date: '2026-08-05', targets: ['daily'], confirm_name: 'hymumdotcom' }) }), locals } as any);
    results.push({ endpoint: '/api/analytics/connections/[id]/purge', method: 'POST', status: r28.status, contentType: r28.headers.get('content-type') || '' });

    // Verify all returned application/json and NO text/html
    console.log('\n--- 28-ROUTE VERIFICATION TABLE ---');
    console.table(results);
    expect(results.length).toBe(28);
    for (const res of results) {
      expect(res.contentType).toContain('application/json');
      expect(res.contentType).not.toContain('text/html');
      expect(res.status).toBeLessThan(500);
    }
  }, 30000);

  it('R-05: validates date range bounds on GET /api/analytics/connections/[id]/daily', async () => {
    const connId = '8aa5b660-e54a-4e44-b8bd-28e9d3ab8596';
    const locals = {
      user: { id: 'user-1' },
      supabase: {},
      activeWorkspaceId: '9f08ca03-e79c-46fa-9518-6858216daf65',
    };

    // 1. from_date after to_date -> 422 JSON
    const resInverted = await getConnDaily({
      params: { id: connId },
      request: new Request(`http://localhost/api/analytics/connections/${connId}/daily?from_date=2026-08-10&to_date=2026-08-01`),
      locals,
    } as any);
    expect(resInverted.status).toBe(422);
    const dataInverted = await resInverted.json();
    expect(dataInverted).toEqual({ success: false, error: 'from_date cannot be after to_date.' });

    // 2. Span > 365 days -> 422 JSON
    const resExceed = await getConnDaily({
      params: { id: connId },
      request: new Request(`http://localhost/api/analytics/connections/${connId}/daily?from_date=2025-01-01&to_date=2026-01-02`),
      locals,
    } as any);
    expect(resExceed.status).toBe(422);
    const dataExceed = await resExceed.json();
    expect(dataExceed).toEqual({ success: false, error: 'Date range span cannot exceed 365 days.' });

    // 3. Valid date range -> 200 JSON
    const resValid = await getConnDaily({
      params: { id: connId },
      request: new Request(`http://localhost/api/analytics/connections/${connId}/daily?from_date=2026-08-01&to_date=2026-08-10`),
      locals,
    } as any);
    expect(resValid.status).toBe(200);
  });
});
