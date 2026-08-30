import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as accountBoardsHandler } from '../../pages/api/pinarchive/account-boards';
import { GET as pinsHandler } from '../../pages/api/pinarchive/pins';
import { POST as accountsGasHandler } from '../../pages/api/pinarchive/accounts-gas';

const { mockWsId, mockAccId, mockUser, mockPinArchiveClient } = vi.hoisted(() => ({
  mockWsId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  mockAccId: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e',
  mockUser: { id: 'usr-123', email: 'test@example.com' },
  mockPinArchiveClient: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('../../server/db/clients', () => ({
  dbClients: {
    getPinArchive: vi.fn(() => mockPinArchiveClient),
  },
}));

vi.mock('../../server/auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue({ workspaceId: mockWsId }),
}));

vi.mock('../../server/services/promotion-service', () => ({
  promoteCandidates: vi.fn().mockResolvedValue({
    promoted: 5,
    checked: 10,
  }),
}));

describe('PinArchive Features & RPCs Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. GET /api/pinarchive/account-boards', () => {
    it('validates account_id and calls pa_account_boards RPC', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: [
          { board_name: 'Desserts', pins: 42 },
          { board_name: 'Dinner Ideas', pins: 18 },
        ],
        error: null,
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/account-boards?workspace_id=${mockWsId}&account_id=${mockAccId}`);
      const res = await accountBoardsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      expect(mockPinArchiveClient.rpc).toHaveBeenCalledWith('pa_account_boards', {
        p_workspace_id: mockWsId,
        p_account_id: mockAccId,
      });

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.boards.length).toBe(2);
      expect(json.boards[0]).toEqual({ board_name: 'Desserts', pins: 42 });
    });

    it('rejects invalid account_id format with 422', async () => {
      const req = new Request(`http://localhost:4321/api/pinarchive/account-boards?workspace_id=${mockWsId}&account_id=invalid-not-uuid`);
      const res = await accountBoardsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.success).toBe(false);
    });
  });

  describe('2. GET /api/pinarchive/pins?mode=page', () => {
    it('calls pa_account_pins_page RPC and returns pagination metadata and deltas', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: [
          {
            id: 'pin-uuid-1',
            pin_id: '123456789',
            title: 'Chocolate Chip Cookies',
            saves: 1500,
            repins: 300,
            comments: 12,
            share_count: 5,
            velocity: 15.5,
            delta_saves: 25,
            delta_shares: 2,
            delta_reactions: 0,
            last_snapshot_at: '2026-08-25T12:00:00Z',
            created_at_pinterest: '2026-08-01T00:00:00Z',
            total_count: 85,
          },
        ],
        error: null,
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/pins?mode=page&account_id=${mockAccId}&sort=saves&limit=50&page=1`);
      const res = await pinsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      expect(mockPinArchiveClient.rpc).toHaveBeenCalledWith('pa_account_pins_page', {
        p_workspace_id: mockWsId,
        p_account_id: mockAccId,
        p_q: null,
        p_board: null,
        p_stage: null,
        p_sort: 'saves',
        p_asc: false,
        p_limit: 50,
        p_offset: 0,
      });

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.count).toBe(1);
      expect(json.total).toBe(85);
      expect(json.page).toBe(1);
      expect(json.page_size).toBe(50);
      expect(json.total_pages).toBe(2);
      expect(json.pins[0].delta_saves).toBe(25);
      expect(json.pins[0].stage).toBe('GROWING');
    });
  });

  describe('3. POST /api/pinarchive/accounts-gas', () => {
    it('executes sync_now action sequentially and returns gas bridge summary', async () => {
      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [{ id: mockAccId, username: 'foodblogger', status: 'active', interval_days: 3 }],
              error: null,
            }),
          }),
        }),
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-gas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          action: 'sync_now',
          usernames: ['foodblogger'],
        }),
      });

      const res = await accountsGasHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.action).toBe('sync_now');
      expect(json.results.length).toBe(1);
      expect(json.results[0].ok).toBe(true);
      expect(json.results[0].summary.promoted).toBe(5);
      expect(json.results[0].summary.checked).toBe(10);
    });

    it('rejects unauthorized action strings with 422', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/accounts-gas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          action: 'invalid_action',
          usernames: ['foodblogger'],
        }),
      });

      const res = await accountsGasHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.success).toBe(false);
    });
  });
});
