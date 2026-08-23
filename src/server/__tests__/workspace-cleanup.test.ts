import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanupWorkspaceAnalytics } from '../services/workspace-cleanup';
import { analyticsDb } from '../db/analytics';
import { fastcronService } from '../services/fastcron-service';
import { GLOBAL_KEY, wsKey } from '../services/webhook-secrets';
import { POST as deleteWorkspaceHandler } from '../../pages/api/workspaces/delete';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { dbClients } from '../db/clients';

vi.mock('../db/analytics', () => ({
  analyticsDb: {
    listWorkspaceConnections: vi.fn(),
    getWorkspaceAnalyticsSettings: vi.fn(),
  },
}));

vi.mock('../services/fastcron-service', () => ({
  fastcronService: {
    disableFastCronJob: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(),
}));

vi.mock('../db/clients', async () => {
  const actual = await vi.importActual<any>('../db/clients');
  return {
    ...actual,
    dbClients: {
      ...actual.dbClients,
      getSchedulingAdmin: vi.fn(),
      getCompetitorsAdmin: vi.fn(),
      getAnalyticsAdmin: vi.fn(),
    },
  };
});

describe('Safety-Critical Workspace Cleanup Suite (V19 Strict Mandate C)', () => {
  const targetWsId = '00000000-0000-0000-0000-000000000001';
  const otherWsId = '00000000-0000-0000-0000-000000000002';
  const pristineGlobalSecret = 'pristine-global-uuid-9999-8888-7777';

  let mockKvStore: Map<string, string>;
  let mockRuntimeEnv: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKvStore = new Map<string, string>();

    // Pre-populate KV store with global secret and workspace overrides
    mockKvStore.set(GLOBAL_KEY, pristineGlobalSecret);
    mockKvStore.set(wsKey(targetWsId), 'target-workspace-override-secret');
    mockKvStore.set(wsKey(otherWsId), 'other-workspace-override-secret');

    mockRuntimeEnv = {
      INGEST_SECRETS_KV: {
        get: vi.fn(async (k: string) => mockKvStore.get(k) || null),
        put: vi.fn(async (k: string, v: string) => mockKvStore.set(k, v)),
        delete: vi.fn(async (k: string) => mockKvStore.delete(k)),
      },
    };
  });

  it('Section C: Deletes ONLY target ws override; global secret is 100% byte-identical before & after', async () => {
    (analyticsDb.listWorkspaceConnections as any).mockResolvedValue([
      {
        id: 'conn-1',
        workspace_id: targetWsId,
        analytics_fastcron_job_id: 101,
        top_pins_fastcron_job_id: 102,
      },
      {
        id: 'conn-2',
        workspace_id: targetWsId,
        analytics_fastcron_job_id: 201,
        top_pins_fastcron_job_id: null,
      },
    ]);

    const globalBefore = mockKvStore.get(GLOBAL_KEY);
    expect(globalBefore).toBe(pristineGlobalSecret);

    const result = await cleanupWorkspaceAnalytics(targetWsId, mockRuntimeEnv);

    expect(result.success).toBe(true);

    // 1. Target workspace override is deleted
    expect(mockKvStore.has(wsKey(targetWsId))).toBe(false);

    // 2. Other workspace override is preserved
    expect(mockKvStore.get(wsKey(otherWsId))).toBe('other-workspace-override-secret');

    // 3. Global secret is strictly byte-identical and untouched
    const globalAfter = mockKvStore.get(GLOBAL_KEY);
    expect(globalAfter).toBe(pristineGlobalSecret);
    expect(globalAfter).toBe(globalBefore);

    // 4. FastCron disable was called for all active jobs
    expect(fastcronService.disableFastCronJob).toHaveBeenCalledWith(
      targetWsId,
      101,
      mockRuntimeEnv
    );
    expect(fastcronService.disableFastCronJob).toHaveBeenCalledWith(
      targetWsId,
      102,
      mockRuntimeEnv
    );
    expect(fastcronService.disableFastCronJob).toHaveBeenCalledWith(
      targetWsId,
      201,
      mockRuntimeEnv
    );
    expect(result.disabledJobsCount).toBe(3);
  });

  describe('POST /api/workspaces/delete (F1 Fatal Fix Regression)', () => {
    it('rejects deletion when user is not workspace owner', async () => {
      (assertWorkspaceAccess as any).mockResolvedValue({
        isOwner: false,
        isAdmin: true,
        role: 'admin',
        workspaceId: targetWsId,
      });

      const req = new Request('http://localhost:4321/api/workspaces/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: targetWsId }),
      });

      const res = await deleteWorkspaceHandler({
        request: req,
        locals: { user: { id: 'user-2' }, supabase: {} },
      } as any);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('Only workspace owners can delete workspaces');
    });

    it('successfully deletes empty workspace calling getCompetitorsAdmin and getAnalyticsAdmin', async () => {
      (assertWorkspaceAccess as any).mockResolvedValue({
        isOwner: true,
        isAdmin: true,
        role: 'owner',
        workspaceId: targetWsId,
      });

      const createTableMock = () => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
        }),
      });

      const mockP1Admin = {
        from: vi.fn().mockImplementation(() => createTableMock()),
      };
      const mockP2Admin = {
        from: vi.fn().mockImplementation(() => createTableMock()),
      };
      const mockP3Admin = {
        from: vi.fn().mockImplementation(() => createTableMock()),
      };

      const mockSchedulingClient = {
        from: vi.fn().mockReturnValue({
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        }),
      };

      (dbClients.getSchedulingAdmin as any).mockReturnValue(mockP1Admin);
      (dbClients.getCompetitorsAdmin as any).mockReturnValue(mockP2Admin);
      (dbClients.getAnalyticsAdmin as any).mockReturnValue(mockP3Admin);

      const req = new Request('http://localhost:4321/api/workspaces/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: targetWsId }),
      });

      const res = await deleteWorkspaceHandler({
        request: req,
        locals: { user: { id: 'owner-1' }, supabase: mockSchedulingClient },
      } as any);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ success: true, deleted: targetWsId });
      expect(dbClients.getCompetitorsAdmin).toHaveBeenCalled();
      expect(dbClients.getAnalyticsAdmin).toHaveBeenCalled();
    });
  });
});
