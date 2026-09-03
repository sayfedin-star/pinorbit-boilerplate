import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as deleteWorkspaceHandler } from '../../pages/api/workspaces/delete';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { dbClients } from '../db/clients';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue({
    isOwner: true,
    isAdmin: true,
    role: 'owner',
    workspaceId: '00000000-0000-0000-0000-000000000001',
  }),
}));

describe('Regression: Workspace deletion fails closed on P4 count failure or cleanup error (R-03 / S-05)', () => {
  const targetWsId = '00000000-0000-0000-0000-000000000001';

  let workspaceDeleted = false;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceDeleted = false;
  });

  it('fails closed with 500 when P4 count check throws an error, preventing accidental deletion', async () => {
    const createTableMock = () => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
      }),
    });

    const mockP1Admin = { from: vi.fn(() => createTableMock()) };
    const mockP2Admin = { from: vi.fn(() => createTableMock()) };
    const mockP3Admin = { from: vi.fn(() => createTableMock()) };

    // P4 fails to count pins (e.g. database network glitch or constraint error)
    const mockP4Admin = {
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            count: null,
            error: { message: `Simulated error accessing ${table}` },
          }),
        }),
      })),
    };

    const mockSchedulingClient = {
      from: vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation(async () => {
            workspaceDeleted = true;
            return { error: null };
          }),
        }),
      }),
    };

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockP1Admin as any);
    vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockP2Admin as any);
    vi.spyOn(dbClients, 'getAnalyticsAdmin').mockReturnValue(mockP3Admin as any);
    vi.spyOn(dbClients, 'getPinArchive').mockReturnValue(mockP4Admin as any);

    const req = new Request('http://localhost:4321/api/workspaces/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: targetWsId }),
    });

    const res = await deleteWorkspaceHandler({
      request: req,
      locals: { user: { id: 'owner-1' }, supabase: mockSchedulingClient },
    } as any);

    // Verified: fails closed with status 500
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('P4 pa_accounts count error');
    // Verified: workspace delete query was NOT executed!
    expect(workspaceDeleted).toBe(false);
  });

  it('fails closed with 500 when pre-delete cleanup tasks are rejected in allSettled', async () => {
    const createTableMock = () => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
      }),
    });

    const mockP1Admin = {
      from: vi.fn(() => ({
        ...createTableMock(),
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockRejectedValue(new Error('P1 retention settings delete timeout')),
        }),
      })),
    };
    const mockP2Admin = { from: vi.fn(() => createTableMock()) };
    const mockP3Admin = { from: vi.fn(() => createTableMock()) };
    const mockP4Admin = { from: vi.fn(() => createTableMock()) };

    const mockSchedulingClient = {
      from: vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation(async () => {
            workspaceDeleted = true;
            return { error: null };
          }),
        }),
      }),
    };

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockP1Admin as any);
    vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockP2Admin as any);
    vi.spyOn(dbClients, 'getAnalyticsAdmin').mockReturnValue(mockP3Admin as any);
    vi.spyOn(dbClients, 'getPinArchive').mockReturnValue(mockP4Admin as any);

    const req = new Request('http://localhost:4321/api/workspaces/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: targetWsId }),
    });

    const res = await deleteWorkspaceHandler({
      request: req,
      locals: { user: { id: 'owner-1' }, supabase: mockSchedulingClient },
    } as any);

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('Failed to clean up workspace dependencies');
    expect(workspaceDeleted).toBe(false);
  });
});
