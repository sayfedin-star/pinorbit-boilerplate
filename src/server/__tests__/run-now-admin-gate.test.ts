import { describe, it, expect, vi } from 'vitest';
import { POST as pinarchiveCronPost } from '../../pages/api/pinarchive/cron';
import * as workspaceGuard from '../auth/workspace-guard';

describe('Audit Defense: pinarchive/cron mutating actions require admin role', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';

  it('POST /api/pinarchive/cron with action: run_now rejects member with 403 Forbidden', async () => {
    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockImplementation(
      async (_client, _wsId, _userId, requiredRole) => {
        if (requiredRole === 'admin') {
          const err: any = new Error('Forbidden: admin access required.');
          err.status = 403;
          throw err;
        }
        return { role: 'member', isMaster: false, workspace: { id: workspaceId } } as any;
      }
    );

    const req = new Request('http://localhost:4321/api/pinarchive/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'run_now', workspace_id: workspaceId }),
    });

    const res = await pinarchiveCronPost({
      request: req,
      locals: {
        user: { id: 'user-member-123' },
        supabase: {},
        activeWorkspaceId: workspaceId,
        runtime: { env: {} },
      },
    } as any);

    const body = await res.json();
    console.log('run-now body:', body);
    expect(res.status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Forbidden');
  });
});
