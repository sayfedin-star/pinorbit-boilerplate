import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as getPurgePreviewHandler } from '../../pages/api/analytics/connections/[id]/purge-preview';
import { POST as postPurgeHandler } from '../../pages/api/analytics/connections/[id]/purge';
import { analyticsDb } from '../db/analytics';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { edgeCache } from '../services/edge-cache';

vi.mock('../db/analytics', () => ({
  analyticsDb: {
    previewPurge: vi.fn(),
    purgeAnalyticsData: vi.fn(),
    getWorkspaceConnection: vi.fn(),
  },
}));

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(),
}));

vi.mock('../services/edge-cache', () => ({
  edgeCache: {
    invalidateConnection: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Data Purge Suite (V27)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const connectionId = 'conn-uuid-12345';
  const displayName = 'hymumdotcom';

  beforeEach(() => {
    vi.clearAllMocks();
    (assertWorkspaceAccess as any).mockResolvedValue({
      id: 'mem-1',
      role: 'owner',
      isAdmin: true,
      isOwner: true,
    });
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      display_name: displayName,
    });
  });

  describe('GET /api/analytics/connections/[id]/purge-preview', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await getPurgePreviewHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge-preview?from=2026-08-01&to=2026-08-05&targets=daily'),
        locals: {},
      } as any);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Unauthorized');
    });

    it('returns 403 when user is not owner/admin', async () => {
      (assertWorkspaceAccess as any).mockResolvedValue({
        id: 'mem-2',
        role: 'member',
        isAdmin: false,
        isOwner: false,
      });

      const locals = { user: { id: 'u2' }, supabase: {}, activeWorkspaceId: workspaceId };
      const res = await getPurgePreviewHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge-preview?from=2026-08-01&to=2026-08-05&targets=daily'),
        locals,
      } as any);

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('Forbidden');
    });

    it('rejects invalid date formats with 422', async () => {
      const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };
      const res = await getPurgePreviewHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge-preview?from=bad-date&to=2026-08-05&targets=daily'),
        locals,
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Invalid from date format');
    });

    it('rejects from > to with 422', async () => {
      const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };
      const res = await getPurgePreviewHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge-preview?from=2026-08-10&to=2026-08-05&targets=daily'),
        locals,
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('from date cannot be after to date');
    });

    it('rejects date range span > 90 days with 422', async () => {
      const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };
      const res = await getPurgePreviewHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge-preview?from=2026-01-01&to=2026-05-01&targets=daily'),
        locals,
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('cannot exceed 90 days');
    });

    it('rejects future to date with 422', async () => {
      const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };
      const res = await getPurgePreviewHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge-preview?from=2026-08-01&to=2099-01-01&targets=daily'),
        locals,
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('cannot be in the future');
    });

    it('rejects invalid targets with 422', async () => {
      const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };
      const res = await getPurgePreviewHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge-preview?from=2026-08-01&to=2026-08-05&targets=invalid_target'),
        locals,
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('targets must be a non-empty subset');
    });

    it('returns preview counts on valid request', async () => {
      const mockPreview = {
        daily_count: 5,
        summaries_count: 1,
        top_pins_count: 50,
        affected_rollup_dates: ['2026-08-01', '2026-08-02'],
        total_records: 56,
      };
      (analyticsDb.previewPurge as any).mockResolvedValue(mockPreview);

      const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };
      const res = await getPurgePreviewHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge-preview?from=2026-08-01&to=2026-08-05&targets=daily,top_pins'),
        locals,
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.preview.total_records).toBe(56);
      expect(json.preview.daily_count).toBe(5);
    });
  });

  describe('POST /api/analytics/connections/[id]/purge', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await postPurgeHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge', {
          method: 'POST',
          body: JSON.stringify({
            from_date: '2026-08-01',
            to_date: '2026-08-05',
            targets: ['daily'],
            confirm_name: displayName,
          }),
        }),
        locals: {},
      } as any);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Unauthorized');
    });

    it('returns 422 if confirmation name does not match display name', async () => {
      const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };
      const res = await postPurgeHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge', {
          method: 'POST',
          body: JSON.stringify({
            from_date: '2026-08-01',
            to_date: '2026-08-05',
            targets: ['daily'],
            confirm_name: 'wrong_name',
          }),
        }),
        locals,
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Confirmation name mismatch');
      expect(analyticsDb.purgeAnalyticsData).not.toHaveBeenCalled();
    });

    it('executes atomic purge and invalidates edge cache when inputs are valid', async () => {
      (analyticsDb.purgeAnalyticsData as any).mockResolvedValue({
        purge_log_id: 'purge-log-uuid-999',
        counts: {
          daily_deleted: 5,
          summaries_deleted: 1,
          rollups_rebuilt: 2,
          top_pins_deleted: 50,
        },
      });

      const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };
      const res = await postPurgeHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge', {
          method: 'POST',
          body: JSON.stringify({
            from_date: '2026-08-01',
            to_date: '2026-08-05',
            targets: ['daily', 'top_pins'],
            confirm_name: displayName,
          }),
        }),
        locals,
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.purge_log_id).toBe('purge-log-uuid-999');
      expect(json.counts.daily_deleted).toBe(5);

      expect(analyticsDb.purgeAnalyticsData).toHaveBeenCalledWith(
        workspaceId,
        connectionId,
        '2026-08-01',
        '2026-08-05',
        ['daily', 'top_pins'],
        'u1'
      );
      expect(edgeCache.invalidateConnection).toHaveBeenCalledWith(workspaceId, connectionId, undefined);
    });

    it('passes runtime.env.ANALYTICS_KV to edgeCache.invalidateConnection on purge execution', async () => {
      (analyticsDb.purgeAnalyticsData as any).mockResolvedValue({
        purge_log_id: 'purge-log-uuid-101',
        counts: { daily_deleted: 2, summaries_deleted: 1, rollups_rebuilt: 1, top_pins_deleted: 10 },
      });

      const mockKvNamespace = { list: vi.fn(), delete: vi.fn(), get: vi.fn(), put: vi.fn() };
      const locals = {
        user: { id: 'u1' },
        supabase: {},
        activeWorkspaceId: workspaceId,
        runtime: { env: { ANALYTICS_KV: mockKvNamespace } },
      };

      const res = await postPurgeHandler({
        params: { id: connectionId },
        request: new Request('http://localhost/api/analytics/connections/conn-uuid-12345/purge', {
          method: 'POST',
          body: JSON.stringify({
            from_date: '2026-08-01',
            to_date: '2026-08-05',
            targets: ['daily', 'top_pins'],
            confirm_name: displayName,
          }),
        }),
        locals,
      } as any);

      expect(res.status).toBe(200);
      expect(edgeCache.invalidateConnection).toHaveBeenCalledWith(workspaceId, connectionId, mockKvNamespace);
    });
  });
});
