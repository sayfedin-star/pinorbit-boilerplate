import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as bulkPost } from '../../pages/api/competitors/schedules/bulk';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { dbClients } from '../db/clients';
import { fastcronCall } from '../lib/fastcron-client';
import { resolveToken } from '../lib/token-resolver';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue({
    id: 'mem-1',
    role: 'admin',
    isAdmin: true,
    isOwner: false,
  }),
}));

vi.mock('../lib/fastcron-client', () => ({
  fastcronCall: vi.fn(),
}));

vi.mock('../lib/token-resolver', () => ({
  resolveToken: vi.fn().mockResolvedValue({
    token: 'test-cron-token',
    source: 'workspace',
  }),
}));

describe('Regression: Bulk schedule delete does not delete DB row on remote FastCron failure (R-04 / S-02)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const scheduleId = '11111111-1111-1111-1111-111111111111';

  let deleteCalled = false;

  beforeEach(() => {
    vi.clearAllMocks();
    deleteCalled = false;

    const mockCompAdmin = {
      from: vi.fn((table: string) => {
        const query: any = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          in: vi.fn(() => query),
          delete: vi.fn(() => query),
          then: (resolve: any) =>
            resolve({
              data: [
                {
                  id: scheduleId,
                  workspace_id: workspaceId,
                  fastcron_job_id: '99999',
                  fastcron_token_id: 'tok-1',
                },
              ],
              error: null,
            }),
        };
        // If delete is called on compAdmin directly, track it
        query.delete = vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => {
              deleteCalled = true;
              return { error: null };
            }),
          })),
        }));
        return query;
      }),
    };

    vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockCompAdmin as any);
  });

  it('keeps the database row when fastcronCall returns success: false', async () => {
    // Simulate FastCron error (e.g. invalid token or remote 500)
    vi.mocked(fastcronCall).mockResolvedValue({
      success: false,
      error: 'FastCron API 500 Internal Error',
    });

    const req = new Request('http://localhost:4321/api/competitors/schedules/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [scheduleId], action: 'delete' }),
    });

    const res = await bulkPost({
      request: req,
      locals: {
        user: { id: 'user-1' },
        supabase: {
          from: vi.fn(() => ({
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: { name: 'test-ws' }, error: null }),
              })),
            })),
          })),
        },
        activeWorkspaceId: workspaceId,
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.failed).toBe(1);
    expect(json.succeeded).toBe(0);
    expect(json.results[0].success).toBe(false);

    // Verified: DB delete was NOT called because remote call failed!
    expect(deleteCalled).toBe(false);
  });
});
