import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { POST as refreshHandler } from '../../pages/api/internal/pinarchive/refresh';
import { assertWorkspaceAccess } from '../auth/workspace-guard';
import { validateUserSession } from '../auth/session';
import { getEffectiveSecret } from '../services/webhook-secrets';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(),
}));

vi.mock('../auth/session', () => ({
  validateUserSession: vi.fn(),
}));

vi.mock('../services/webhook-secrets', () => ({
  getEffectiveSecret: vi.fn(),
}));

describe('PinArchive Refresh Relay Endpoint (/api/internal/pinarchive/refresh)', () => {
  const mockWsId = '00000000-0000-0000-0000-000000000001';
  const mockUser = { id: '00000000-0000-0000-0000-000000000002', email: 'admin@pinorbit.test' };
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns 400 for empty or invalid JSON payload', async () => {
    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      body: '',
    });
    const res = await refreshHandler({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('returns 400 for missing or invalid workspace_id', async () => {
    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'invalid-uuid' }),
    });
    const res = await refreshHandler({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid workspace');
  });

  it('returns 400 for invalid username format', async () => {
    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: mockWsId, username: 'invalid username with spaces!' }),
    });
    const res = await refreshHandler({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid username');
  });

  it('returns 401 when neither x-ingest-secret nor session admin is present', async () => {
    vi.mocked(getEffectiveSecret).mockResolvedValue({ source: 'workspace', value: 'secret-123' });
    vi.mocked(validateUserSession).mockResolvedValue({ user: null, isAuthenticated: false });

    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: mockWsId }),
    });
    const res = await refreshHandler({ request: req, locals: {} } as any);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('Unauthorized');
  });

  it('returns 503 when authenticated but GH_REFRESH_TOKEN is absent', async () => {
    vi.mocked(getEffectiveSecret).mockResolvedValue({ source: 'workspace', value: 'secret-123' });

    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': 'secret-123',
      },
      body: JSON.stringify({ workspace_id: mockWsId }),
    });

    const res = await refreshHandler({
      request: req,
      locals: { runtime: { env: { GH_REFRESH_TOKEN: '' } } },
    } as any);

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('refresh_not_configured');
  });

  it('returns 202 queued when authenticated via x-ingest-secret header', async () => {
    vi.mocked(getEffectiveSecret).mockResolvedValue({ source: 'workspace', value: 'valid-secret-xyz' });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
    } as any);

    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': 'valid-secret-xyz',
      },
      body: JSON.stringify({ workspace_id: mockWsId, username: 'foodblogger' }),
    });

    const res = await refreshHandler({
      request: req,
      locals: { runtime: { env: { GH_REFRESH_TOKEN: 'ghp_secret_token_123' } } },
    } as any);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.queued).toBe(true);
    expect(json.workspace_id).toBe(mockWsId);
    expect(json.username).toBe('foodblogger');

    // Verify GitHub dispatch call
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/sayfedin-star/pinorbit-v2/actions/workflows/pinarchive-refresh.yml/dispatches',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer ghp_secret_token_123',
          'Accept': 'application/vnd.github+json',
        }),
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            workspace_id: mockWsId,
            username: 'foodblogger',
            usernames: '',
          },
        }),
      })
    );
  });

  it('returns 202 queued when authenticated via session-admin mock', async () => {
    vi.mocked(assertWorkspaceAccess).mockResolvedValue({
      workspaceId: mockWsId,
      role: 'admin',
      isAdmin: true,
      isOwner: false,
    });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
    } as any);

    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: mockWsId }),
    });

    const res = await refreshHandler({
      request: req,
      locals: {
        user: mockUser,
        supabase: {},
        runtime: { env: { GH_REFRESH_TOKEN: 'ghp_secret_token_123' } },
      },
    } as any);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.queued).toBe(true);
    expect(json.workspace_id).toBe(mockWsId);
  });

  it('returns 503 refresh_token_invalid when GitHub returns 401 or 403', async () => {
    vi.mocked(getEffectiveSecret).mockResolvedValue({ source: 'workspace', value: 'valid-secret-xyz' });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 401,
      ok: false,
      text: vi.fn().mockResolvedValue('Bad credentials'),
    } as any);

    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': 'valid-secret-xyz',
      },
      body: JSON.stringify({ workspace_id: mockWsId }),
    });

    const res = await refreshHandler({
      request: req,
      locals: { runtime: { env: { GH_REFRESH_TOKEN: 'invalid_pat' } } },
    } as any);

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('refresh_token_invalid');
  });

  it('returns 502 github_dispatch_failed on network error / timeout', async () => {
    vi.mocked(getEffectiveSecret).mockResolvedValue({ source: 'workspace', value: 'valid-secret-xyz' });

    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network timeout'));

    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': 'valid-secret-xyz',
      },
      body: JSON.stringify({ workspace_id: mockWsId }),
    });

    const res = await refreshHandler({
      request: req,
      locals: { runtime: { env: { GH_REFRESH_TOKEN: 'valid_pat' } } },
    } as any);

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('github_dispatch_failed');
  });

  it('never echoes secret or PAT in error responses', async () => {
    const rawPAT = 'ghp_super_secret_pat_987654321';
    vi.mocked(getEffectiveSecret).mockResolvedValue({ source: 'workspace', value: 'ingest_secret_xyz' });
    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 500,
      ok: false,
      text: vi.fn().mockResolvedValue('Internal server error'),
    } as any);

    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': 'ingest_secret_xyz',
      },
      body: JSON.stringify({ workspace_id: mockWsId }),
    });

    const res = await refreshHandler({
      request: req,
      locals: { runtime: { env: { GH_REFRESH_TOKEN: rawPAT } } },
    } as any);

    const text = await res.text();
    expect(text).not.toContain(rawPAT);
    expect(text).not.toContain('ingest_secret_xyz');
  });

  it('returns 202 queued when usernames array is provided, sending comma-joined usernames to GitHub', async () => {
    vi.mocked(getEffectiveSecret).mockResolvedValue({ source: 'workspace', value: 'valid-secret-xyz' });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
    } as any);

    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': 'valid-secret-xyz',
      },
      body: JSON.stringify({
        workspace_id: mockWsId,
        usernames: ['foodblogger', 'Travel_Tips', 'foodblogger'], // with casing & dupes
      }),
    });

    const res = await refreshHandler({
      request: req,
      locals: { runtime: { env: { GH_REFRESH_TOKEN: 'ghp_secret_token_123' } } },
    } as any);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.queued).toBe(true);
    expect(json.queued_runs).toBe(1);
    expect(json.workspace_id).toBe(mockWsId);
    expect(json.usernames).toEqual(['foodblogger', 'travel_tips']);
    expect(json.accounts).toBe(2);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/sayfedin-star/pinorbit-v2/actions/workflows/pinarchive-refresh.yml/dispatches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            workspace_id: mockWsId,
            username: '',
            usernames: 'foodblogger,travel_tips',
          },
        }),
      })
    );
  });

  it('returns 202 queued when comma-separated usernames string is provided and prefers usernames over username', async () => {
    vi.mocked(getEffectiveSecret).mockResolvedValue({ source: 'workspace', value: 'valid-secret-xyz' });

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 204,
      ok: true,
      headers: new Headers(),
    } as any);

    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': 'valid-secret-xyz',
      },
      body: JSON.stringify({
        workspace_id: mockWsId,
        username: 'single_account',
        usernames: 'acc_one, acc_two',
      }),
    });

    const res = await refreshHandler({
      request: req,
      locals: { runtime: { env: { GH_REFRESH_TOKEN: 'ghp_secret_token_123' } } },
    } as any);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.queued_runs).toBe(1);
    expect(json.accounts).toBe(2);
    expect(json.usernames).toEqual(['acc_one', 'acc_two']);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/sayfedin-star/pinorbit-v2/actions/workflows/pinarchive-refresh.yml/dispatches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            workspace_id: mockWsId,
            username: '',
            usernames: 'acc_one,acc_two',
          },
        }),
      })
    );
  });

  it('returns 400 when usernames contains an invalid username string', async () => {
    const req = new Request('http://localhost:4321/api/internal/pinarchive/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: mockWsId,
        usernames: ['valid_name', 'bad name with spaces!'],
      }),
    });

    const res = await refreshHandler({ request: req, locals: {} } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('Invalid username format');
  });
});
