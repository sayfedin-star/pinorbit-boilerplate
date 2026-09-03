import { describe, it, expect, vi } from 'vitest';
import { GET as competitorsCronGet } from '../../pages/api/competitors/cron';
import { GET as pinarchiveCronGet } from '../../pages/api/pinarchive/cron';
import * as workspaceGuard from '../auth/workspace-guard';
import * as tokenResolver from '../lib/token-resolver';
import * as fastcronClient from '../lib/fastcron-client';

describe('Audit Defense: Cron Responses Secrecy & URL Masking', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const testSecret = 'live-super-secret-ingest-token-xyz987';

  it('GET /api/competitors/cron NEVER returns url or secret= in response to members', async () => {
    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
      role: 'member',
      isMaster: false,
      workspace: { id: workspaceId, name: 'Test Workspace' },
    } as any);

    vi.spyOn(tokenResolver, 'listWorkspaceTokens').mockResolvedValue([
      {
        id: 'tok-1',
        name: 'Default Token',
        masked_token: '••••1234',
        is_default: true,
        source: 'workspace_registry',
        token: 'fc_live_token',
      },
    ] as any);

    vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
      token: 'fc_live_token',
      source: 'workspace_registry',
      tokenId: 'tok-1',
      name: 'Default Token',
      maskedToken: '••••1234',
    } as any);

    vi.spyOn(fastcronClient, 'fastcronCall').mockImplementation(async (action: string) => {
      if (action === 'cron_list') {
        return {
          success: true,
          data: {
            jobs: [
              {
                id: '12345',
                name: `PinOrbit competitors — Test Workspace — Daily — ${workspaceId.slice(0, 8)}`,
                expression: '0 2 * * *',
                timezone: 'UTC',
                url: `https://pinorbit.com/api/internal/competitors/dispatch?workspace_id=${workspaceId}&secret=${testSecret}`,
                status: 'enabled',
              },
            ],
          },
        };
      }
      return { success: true, data: {} };
    });

    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: { id: workspaceId, name: 'Test Workspace' }, error: null })),
          })),
        })),
      })),
    };

    const req = new Request(`http://localhost:4321/api/competitors/cron?workspace_id=${workspaceId}`);
    const res = await competitorsCronGet({
      request: req,
      locals: {
        user: { id: 'user-member-123' },
        supabase: mockSupabase,
        activeWorkspaceId: workspaceId,
        runtime: { env: { COMPETITORS_SUPABASE_URL: 'https://mock.supabase.co' } },
      },
    } as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs.length).toBe(1);

    const job = body.jobs[0];
    // Assert url is completely omitted or stripped
    expect(job.url).toBeUndefined();

    // Serialize entire JSON response and assert zero secret exposure
    const jsonStr = JSON.stringify(body);
    expect(jsonStr).not.toContain(testSecret);
    expect(jsonStr).not.toContain('secret=');
  });

  it('GET /api/pinarchive/cron NEVER returns url or secret= in response to members', async () => {
    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
      role: 'member',
      isMaster: false,
      workspace: { id: workspaceId, name: 'Test Workspace' },
    } as any);

    vi.spyOn(tokenResolver, 'listWorkspaceTokens').mockResolvedValue([
      {
        id: 'tok-1',
        name: 'Default Token',
        masked_token: '••••1234',
        is_default: true,
        source: 'workspace_registry',
        token: 'fc_live_token',
      },
    ] as any);

    vi.spyOn(tokenResolver, 'resolveToken').mockResolvedValue({
      token: 'fc_live_token',
      source: 'workspace_registry',
      tokenId: 'tok-1',
      name: 'Default Token',
      maskedToken: '••••1234',
    } as any);

    vi.spyOn(fastcronClient, 'fastcronCall').mockImplementation(async (action: string) => {
      if (action === 'cron_list') {
        return {
          success: true,
          data: {
            jobs: [
              {
                id: '99999',
                name: `PinOrbit pinarchive — Test Workspace — Daily Refresh — ${workspaceId.slice(0, 8)}`,
                expression: '0 3 * * *',
                timezone: 'UTC',
                url: `https://pinorbit.com/api/internal/pinarchive/dispatch?workspace_id=${workspaceId}&secret=${testSecret}`,
                status: 'enabled',
              },
            ],
          },
        };
      }
      return { success: true, data: {} };
    });

    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: { id: workspaceId, name: 'Test Workspace' }, error: null })),
          })),
        })),
      })),
    };

    const req = new Request(`http://localhost:4321/api/pinarchive/cron?workspace_id=${workspaceId}`);
    const res = await pinarchiveCronGet({
      request: req,
      locals: {
        user: { id: 'user-member-123' },
        supabase: mockSupabase,
        activeWorkspaceId: workspaceId,
        runtime: { env: { PINARCHIVE_SUPABASE_URL: 'https://mock.supabase.co' } },
      },
    } as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.jobs)).toBe(true);

    const jsonStr = JSON.stringify(body);
    expect(jsonStr).not.toContain(testSecret);
    expect(jsonStr).not.toContain('secret=');
  });
});
