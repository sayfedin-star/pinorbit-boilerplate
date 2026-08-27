import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as tokensIndexApi from '../../pages/api/competitors/tokens/index';
import * as tokensIdApi from '../../pages/api/competitors/tokens/[id]';

describe('Competitors FastCron Token Vault API Suite', () => {
  const mockWorkspaceId = '22222222-3333-4444-5555-666666666666';
  const mockUserId = '99999999-8888-7777-6666-555555555555';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /api/competitors/tokens returns 401 when unauthorized', async () => {
    const res = await tokensIndexApi.GET({
      locals: {
        user: null,
        supabase: null,
      },
    } as any);

    expect(res.status).toBe(401);
  });

  it('GET /api/competitors/tokens returns token list for workspace', async () => {
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
                      id: 'tok-1',
                      name: 'Production FastCron Key',
                      token_encrypted: 'v1:mockiv:mockct',
                      token_masked: '••••1234',
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
        },
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json)).toBe(true);
  });

  it('POST /api/competitors/tokens creates new token in competitor_fastcron_tokens', async () => {
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
              single: async () => ({ data: { id: 'new-tok-123' }, error: null }),
            }),
          }),
        };
      }),
    };

    const res = await tokensIndexApi.POST({
      request: new Request('https://example.com/api/competitors/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New FastCron Token',
          token: 'fc_secret_key_valid_123456',
          is_default: true,
        }),
      }),
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          TOKEN_KEK: 'test_token_kek_secret_key_12345678',
          supabaseClient: mockSupabase,
        },
      },
    } as any);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.id).toBe('new-tok-123');
  });

  it('DELETE /api/competitors/tokens/:id deletes token', async () => {
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
      params: { id: 'tok-to-delete' },
      locals: {
        user: { id: mockUserId },
        supabase: mockSupabase,
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {
          TOKEN_KEK: 'test_token_kek_secret_key_12345678',
          supabaseClient: mockSupabase,
        },
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });
});
