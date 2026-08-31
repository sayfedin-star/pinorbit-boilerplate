import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as setMasterHandler } from '../../pages/api/workspaces/set-master';
import { assertWorkspaceAccess, getUserWorkspaces } from '../auth/workspace-guard';
import { dbClients } from '../db/clients';

vi.mock('../auth/workspace-guard', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    assertWorkspaceAccess: vi.fn(),
  };
});

vi.mock('../db/clients', () => {
  const mockSchedulingAdmin = {
    from: vi.fn(),
  };
  return {
    isProductionEnv: vi.fn().mockReturnValue(false),
    isKnownDefaultIngestSecret: vi.fn().mockReturnValue(false),
    getServerEnv: vi.fn().mockReturnValue({}),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockReturnValue(mockSchedulingAdmin),
    },
  };
});

describe('Master Workspace Orchestrator Suite', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockUser = { id: '00000000-0000-0000-0000-000000000099', email: 'owner@example.com' };
  let mockSchedulingAdmin: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSchedulingAdmin = dbClients.getSchedulingAdmin();
    vi.mocked(assertWorkspaceAccess).mockResolvedValue({
      workspaceId: mockWsId,
      role: 'owner',
      isAdmin: true,
      isOwner: true,
      isMaster: true,
    });
  });

  describe('1. POST /api/workspaces/set-master', () => {
    it('returns 401 when user is missing', async () => {
      const req = new Request('http://localhost:4321/api/workspaces/set-master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId }),
      });
      const res = await setMasterHandler({ request: req, locals: { user: null } } as any);
      expect(res.status).toBe(401);
    });

    it('returns 422 when workspace_id is invalid', async () => {
      const req = new Request('http://localhost:4321/api/workspaces/set-master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: 'invalid-id' }),
      });
      const res = await setMasterHandler({ request: req, locals: { user: mockUser } } as any);
      expect(res.status).toBe(422);
    });

    it('sets workspace as master and unsets all other workspaces', async () => {
      mockSchedulingAdmin.from.mockReturnValue({
        update: vi.fn().mockReturnValue({
          neq: vi.fn().mockResolvedValue({ data: null, error: null }),
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: mockWsId, name: 'HQ Master', is_master: true },
                error: null,
              }),
            }),
          }),
        }),
      });

      const req = new Request('http://localhost:4321/api/workspaces/set-master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: mockWsId, is_master: true }),
      });

      const res = await setMasterHandler({ request: req, locals: { user: mockUser } } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.workspace.is_master).toBe(true);
    });
  });
});