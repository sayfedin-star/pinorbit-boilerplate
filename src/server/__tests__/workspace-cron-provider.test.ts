import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '../../pages/api/workspace/cron-provider';
import { dbClients } from '../db/clients';
import * as workspaceGuard from '../auth/workspace-guard';
import * as tokenCrypto from '../lib/token-crypto';

describe('Workspace Cron Provider API Suite (/api/workspace/cron-provider)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GET returns 401 when unauthorized', async () => {
    const req = new Request('http://localhost/api/workspace/cron-provider');
    const res = await GET({
      request: req,
      locals: { user: null, supabase: null },
    } as any);

    expect(res.status).toBe(401);
  });

  it('GET returns workspace cron provider and key status for valid session', async () => {
    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
      workspaceId: 'ws-123',
      role: 'owner',
      isOwner: true,
      isAdmin: true,
    });

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'ws-123',
                cron_provider: 'cronjoborg',
                cron_provider_api_key_encrypted: 'v1:iv:cipher',
              },
              error: null,
            }),
          }),
        }),
      }),
    };

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    const req = new Request('http://localhost/api/workspace/cron-provider?workspace_id=ws-123');
    const res = await GET({
      request: req,
      locals: {
        user: { id: 'user-1' },
        supabase: {} as any,
        activeWorkspaceId: 'ws-123',
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.provider).toBe('cronjoborg');
    expect(json.has_custom_key).toBe(true);
  });

  it('POST updates workspaces.cron_provider and encrypts api_key', async () => {
    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
      workspaceId: 'ws-123',
      role: 'admin',
      isOwner: false,
      isAdmin: true,
    });

    vi.spyOn(tokenCrypto, 'resolveTokenKek').mockResolvedValue('test_kek_16_characters_min');
    vi.spyOn(tokenCrypto, 'encryptToken').mockResolvedValue('v1:mock_iv:mock_ct');

    let updatePayload: any = null;
    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockImplementation((payload) => {
          updatePayload = payload;
          return {
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: 'ws-123',
                    cron_provider: payload.cron_provider,
                    cron_provider_api_key_encrypted: payload.cron_provider_api_key_encrypted,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }),
      }),
    };

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    const mockDownstream = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }),
    };
    vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockDownstream as any);
    vi.spyOn(dbClients, 'getAnalyticsAdmin').mockReturnValue(mockDownstream as any);
    vi.spyOn(dbClients, 'getPinArchive').mockReturnValue(mockDownstream as any);

    const req = new Request('http://localhost/api/workspace/cron-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: 'ws-123',
        provider: 'cron-job.org',
        api_key: 'new_secret_key_123',
      }),
    });

    const res = await POST({
      request: req,
      locals: {
        user: { id: 'user-1' },
        supabase: {} as any,
        activeWorkspaceId: 'ws-123',
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.provider).toBe('cronjoborg');
    expect(updatePayload.cron_provider).toBe('cronjoborg');
    expect(updatePayload.cron_provider_api_key_encrypted).toBe('v1:mock_iv:mock_ct');
    expect(json.warnings).toEqual([]);
  });

  it('POST captures and surfaces downstream sync errors in warnings array without failing', async () => {
    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
      workspaceId: 'ws-123',
      role: 'admin',
      isOwner: true,
      isAdmin: true,
    });

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'ws-123',
                  cron_provider: 'fastcron',
                  cron_provider_api_key_encrypted: null,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockAdmin as any);

    // Mock P2 failure
    vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue({
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            error: new Error('P2 connection refused'),
          }),
        }),
      }),
    } as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const req = new Request('http://localhost/api/workspace/cron-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: 'ws-123',
        provider: 'fastcron',
      }),
    });

    const res = await POST({
      request: req,
      locals: {
        user: { id: 'user-1' },
        supabase: {} as any,
        activeWorkspaceId: 'ws-123',
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.warnings).toBeDefined();
    expect(json.warnings.length).toBeGreaterThan(0);
    expect(json.warnings[0]).toContain('P2:');
    expect(warnSpy).toHaveBeenCalled();
  });
});
