import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DELETE as deletePinsHandler } from '../../pages/api/pinarchive/pins';
import { dbClients } from '../db/clients';
import { assertWorkspaceAccess } from '../auth/workspace-guard';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(),
}));

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
    isKnownDefaultKek: vi.fn().mockReturnValue(false),
    getServerEnv: vi.fn().mockReturnValue({}),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockReturnValue(mockSchedulingAdmin),
      getPinArchive: vi.fn().mockReturnValue(mockPinArchive),
      getConfig: vi.fn().mockReturnValue({}),
    },
  };
});

describe('DELETE /api/pinarchive/pins Suite', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockAccountId = '00000000-0000-0000-0000-000000000002';
  const mockUser = { id: '00000000-0000-0000-0000-000000000099', email: 'admin@example.com' };
  let mockPinArchiveClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPinArchiveClient = dbClients.getPinArchive();
    vi.mocked(assertWorkspaceAccess).mockResolvedValue({
      workspaceId: mockWsId,
      role: 'admin',
      isAdmin: true,
      isOwner: true,
    });
  });

  it('returns 401 when session or supabase is missing', async () => {
    const req = new Request('http://localhost:4321/api/pinarchive/pins', {
      method: 'DELETE',
      body: JSON.stringify({ workspace_id: mockWsId, account_id: mockAccountId, max_saves: 25 }),
    });
    const res = await deletePinsHandler({
      request: req,
      locals: { user: null, supabase: null, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 when invalid json payload is passed', async () => {
    const req = new Request('http://localhost:4321/api/pinarchive/pins', {
      method: 'DELETE',
      body: 'invalid-json',
    });
    const res = await deletePinsHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 when neither max_saves nor pin_ids is provided', async () => {
    const req = new Request('http://localhost:4321/api/pinarchive/pins', {
      method: 'DELETE',
      body: JSON.stringify({ workspace_id: mockWsId, account_id: mockAccountId }),
    });
    const res = await deletePinsHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Either pin_ids array or max_saves threshold must be provided');
  });

  it('returns 422 when max_saves is invalid (negative or non-integer)', async () => {
    const req = new Request('http://localhost:4321/api/pinarchive/pins', {
      method: 'DELETE',
      body: JSON.stringify({ workspace_id: mockWsId, account_id: mockAccountId, max_saves: -5 }),
    });
    const res = await deletePinsHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('max_saves must be an integer');
  });

  it('successfully deletes pins by max_saves threshold and updates account pins_count', async () => {
    const deleteChain: any = {
      eq: vi.fn().mockReturnThis(),
      lte: vi.fn().mockResolvedValue({ count: 42, error: null }),
    };

    const selectChain: any = {
      eq: vi.fn().mockReturnThis(),
    };
    selectChain.eq.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ count: 150, error: null }),
    });

    const updateChain: any = {
      eq: vi.fn().mockReturnThis(),
    };
    updateChain.eq.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_pins') {
        return {
          delete: vi.fn().mockReturnValue(deleteChain),
          select: vi.fn().mockReturnValue(selectChain),
        };
      }
      if (table === 'pa_accounts') {
        return {
          update: vi.fn().mockReturnValue(updateChain),
        };
      }
      return {};
    });

    const req = new Request('http://localhost:4321/api/pinarchive/pins', {
      method: 'DELETE',
      body: JSON.stringify({ workspace_id: mockWsId, account_id: mockAccountId, max_saves: 25 }),
    });

    const res = await deletePinsHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.deleted_count).toBe(42);
    expect(json.remaining_count).toBe(150);
  });

  it('successfully deletes pins by pin_ids array (UUIDs)', async () => {
    const pinId1 = '11111111-1111-1111-1111-111111111111';
    const pinId2 = '22222222-2222-2222-2222-222222222222';

    const deleteChain: any = {
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ count: 2, error: null }),
    };

    const selectChain: any = {
      eq: vi.fn().mockReturnThis(),
    };
    selectChain.eq.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ count: 98, error: null }),
    });

    const updateChain: any = {
      eq: vi.fn().mockReturnThis(),
    };
    updateChain.eq.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_pins') {
        return {
          delete: vi.fn().mockReturnValue(deleteChain),
          select: vi.fn().mockReturnValue(selectChain),
        };
      }
      if (table === 'pa_accounts') {
        return {
          update: vi.fn().mockReturnValue(updateChain),
        };
      }
      return {};
    });

    const req = new Request('http://localhost:4321/api/pinarchive/pins', {
      method: 'DELETE',
      body: JSON.stringify({
        workspace_id: mockWsId,
        account_id: mockAccountId,
        pin_ids: [pinId1, pinId2],
      }),
    });

    const res = await deletePinsHandler({
      request: req,
      locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.deleted_count).toBe(2);
    expect(json.remaining_count).toBe(98);
    expect(deleteChain.in).toHaveBeenCalledWith('id', [pinId1, pinId2]);
  });
});
