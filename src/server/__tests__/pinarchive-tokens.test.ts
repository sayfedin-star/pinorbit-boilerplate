import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as tokensIndexApi from '../../pages/api/pinarchive/tokens/index';
import * as tokensIdApi from '../../pages/api/pinarchive/tokens/[id]';

describe('PinArchive FastCron Token Vault API Suite', () => {
  const mockWorkspaceId = '44444444-5555-6666-7777-888888888888';
  const mockUserId = '99999999-8888-7777-6666-555555555555';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /api/pinarchive/tokens returns 401 when unauthorized', async () => {
    const res = await tokensIndexApi.GET({
      locals: {
        user: null,
        supabase: null,
      },
    } as any);

    expect(res.status).toBe(401);
  });

  it('GET /api/pinarchive/tokens returns token list for workspace', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'workspace_memberships') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: { id: 'm1', role: 'admin' }, error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: async () => ({
                  data: [
                    {
                      id: 'pa-tok-1',
                      name: 'PinArchive FastCron Key',
                      token_encrypted: 'v1:mockiv:mockct',
                      token_masked: '••••5678',
                      is_default: true,
                      created_at: new Date().toISOString(),
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }),
    };

    const res = await tokensIndexApi.GET({
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          TOKEN_KEK: 'test_token_kek_secret_key_12345678',
          pinarchiveClient: mockSupabase,
        },
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json)).toBe(true);
  });

  it('POST /api/pinarchive/tokens creates new token in pinarchive_fastcron_tokens', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'workspace_memberships') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: { id: 'm1', role: 'admin' }, error: null }),
                }),
              }),
            }),
          };
        }
        return {
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: 'new-pa-tok-123' }, error: null }),
            }),
          }),
        };
      }),
    };

    const res = await tokensIndexApi.POST({
      request: new Request('https://example.com/api/pinarchive/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New PinArchive FastCron Token',
          token: 'fc_secret_key_pa_valid_123456',
          is_default: true,
        }),
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          TOKEN_KEK: 'test_token_kek_secret_key_12345678',
          pinarchiveClient: mockSupabase,
        },
      },
    } as any);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.id).toBe('new-pa-tok-123');
  });

  it('DELETE /api/pinarchive/tokens/:id deletes token', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'workspace_memberships') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: { id: 'm1', role: 'admin' }, error: null }),
                }),
              }),
            }),
          };
        }
        return {
          delete: () => ({
            eq: () => ({
              eq: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }),
    };

    const res = await tokensIdApi.DELETE({
      params: { id: 'pa-tok-to-delete' },
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          TOKEN_KEK: 'test_token_kek_secret_key_12345678',
          pinarchiveClient: mockSupabase,
        },
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });
});
