import { describe, it, expect, vi } from 'vitest';
import { DELETE as scheduleDelete } from '../../pages/api/competitors/schedules/[id]';
import * as workspaceGuard from '../auth/workspace-guard';
import * as tokenResolver from '../lib/token-resolver';
import * as fastcronClient from '../lib/fastcron-client';
import { dbClients } from '../db/clients';

describe('Audit Defense: schedule DELETE remote FastCron synchronization check', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const scheduleId = '11111111-1111-1111-1111-111111111111';

  it('DELETE /api/competitors/schedules/[id] aborts DB deletion and returns 502 when FastCron delete fails', async () => {
    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
      role: 'admin',
      isMaster: false,
      workspace: { id: workspaceId },
    } as any);

    vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
      token: 'fc_token_123',
      source: 'workspace_registry',
      tokenId: 'tok-1',
    } as any);

    // FastCron delete fails
    vi.spyOn(fastcronClient, 'fastcronCall').mockResolvedValue({
      success: false,
      error: 'FastCron API rate limited or internal error',
    });

    const dbDeleteMock = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn(async () => ({ error: null })),
      }),
    });

    const mockCompAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'competitor_schedules') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      id: scheduleId,
                      workspace_id: workspaceId,
                      fastcron_job_id: '999888',
                      fastcron_token_id: 'tok-1',
                    },
                    error: null,
                  })),
                })),
              })),
            })),
            delete: dbDeleteMock,
          };
        }
        return {};
      }),
    };

    vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockCompAdmin as any);

    const req = new Request(`http://localhost:4321/api/competitors/schedules/${scheduleId}?workspace_id=${workspaceId}`, {
      method: 'DELETE',
    });

    const res = await scheduleDelete({
      request: req,
      params: { id: scheduleId },
      locals: {
        user: { id: 'admin-123' },
        supabase: {},
        activeWorkspaceId: workspaceId,
        runtime: { env: {} },
      },
    } as any);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Remote FastCron delete failed');

    // Database delete must NOT have been called!
    expect(dbDeleteMock).not.toHaveBeenCalled();
  });
});
