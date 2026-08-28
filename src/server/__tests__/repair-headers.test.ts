import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as competitorRepairApi from '../../pages/api/competitors/schedules/repair-headers';
import * as pinArchiveRepairApi from '../../pages/api/pinarchive/repair-headers';
import { fastcronCall } from '../../server/lib/fastcron-client';

const mockWorkspaceId = '44444444-5555-6666-7777-888888888888';
const mockUserId = '99999999-8888-7777-6666-555555555555';

vi.mock('../../server/auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(async () => ({
    workspaceId: mockWorkspaceId,
    role: 'admin',
    isOwner: true,
    isAdmin: true,
  })),
}));

vi.mock('../../server/services/webhook-secrets', () => ({
  getEffectiveSecret: vi.fn(async () => ({
    value: 'test_ingest_secret_key_12345',
    source: 'workspace',
  })),
}));

vi.mock('../../server/lib/token-resolver', () => ({
  listWorkspaceTokens: vi.fn(async (_wsId: string, _project: string, _env: any, includePlain?: boolean) => {
    return [
      {
        id: 'tok-1',
        name: 'Workspace Default Token',
        masked_token: '••••5678',
        is_default: true,
        source: 'workspace_registry',
        token: includePlain ? 'fc_mock_plain_token_12345678' : undefined,
      },
    ];
  }),
}));

vi.mock('../../server/lib/fastcron-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/fastcron-client')>();
  return {
    ...actual,
    fastcronCall: vi.fn(),
  };
});

describe('FastCron Job Headers Repair Endpoints Suite (P2 & P4)', () => {
  let capturedFastCronCalls: Array<{ action: string; params: any; token: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedFastCronCalls = [];
  });

  it('POST /api/competitors/schedules/repair-headers updates matching jobs with x-ingest-secret and workspace_id URL', async () => {
    (fastcronCall as any).mockImplementation(async (action: string, params: any, token: string) => {
      capturedFastCronCalls.push({ action, params, token });
      if (action === 'cron_list') {
        return {
          success: true,
          data: [
            {
              id: 20840605,
              name: 'PinOrbit competitors — Default Daily — 44444444',
              url: 'https://pinorbit-v2.o-i.workers.dev/api/internal/competitors/dispatch',
              expression: '0 2 * * *',
              status: 'enabled',
              post_data: JSON.stringify({
                workspace_id: mockWorkspaceId,
                pipeline: 'competitors',
                label: 'Default Daily',
              }),
            },
          ],
        };
      }
      if (action === 'cron_edit') {
        return { success: true, data: { id: params.id } };
      }
      return { success: true };
    });

    const res = await competitorRepairApi.POST({
      request: new Request('https://example.com/api/competitors/schedules/repair-headers', {
        method: 'POST',
      }),
      locals: {
        user: { id: mockUserId },
        supabase: {},
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {},
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.count).toBe(1);
    expect(json.repaired_count).toBe(1);

    const editCall = capturedFastCronCalls.find((c) => c.action === 'cron_edit');
    expect(editCall).toBeDefined();
    expect(editCall?.params.id).toBe(20840605);
    expect(editCall?.params.url).toContain(`workspace_id=${mockWorkspaceId}`);
    expect(editCall?.params.httpHeaders).toBe('Content-Type: application/json\r\nx-ingest-secret: test_ingest_secret_key_12345');
    expect(editCall?.params.http_headers).toBe('Content-Type: application/json\r\nx-ingest-secret: test_ingest_secret_key_12345');
    expect(editCall?.params.httpMethod).toBe('POST');
    expect(editCall?.params.http_method).toBe('POST');
  });

  it('POST /api/pinarchive/repair-headers updates matching jobs with x-ingest-secret and workspace_id URL', async () => {
    (fastcronCall as any).mockImplementation(async (action: string, params: any, token: string) => {
      capturedFastCronCalls.push({ action, params, token });
      if (action === 'cron_list') {
        return {
          success: true,
          data: [
            {
              id: 20837728,
              name: 'PinOrbit pinarchive — Default Daily — 44444444',
              url: 'https://pinorbit-v2.o-i.workers.dev/api/internal/pinarchive/dispatch',
              expression: '0 3 * * *',
              status: 'enabled',
              post_data: JSON.stringify({
                workspace_id: mockWorkspaceId,
                pipeline: 'pinarchive',
                label: 'Default Daily',
              }),
            },
          ],
        };
      }
      if (action === 'cron_edit') {
        return { success: true, data: { id: params.id } };
      }
      return { success: true };
    });

    const res = await pinArchiveRepairApi.POST({
      request: new Request('https://example.com/api/pinarchive/repair-headers', {
        method: 'POST',
      }),
      locals: {
        user: { id: mockUserId },
        supabase: {},
        activeWorkspaceId: mockWorkspaceId,
        runtimeEnv: {},
      },
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.count).toBe(1);
    expect(json.repaired_count).toBe(1);

    const editCall = capturedFastCronCalls.find((c) => c.action === 'cron_edit');
    expect(editCall).toBeDefined();
    expect(editCall?.params.id).toBe(20837728);
    expect(editCall?.params.url).toContain(`workspace_id=${mockWorkspaceId}`);
    expect(editCall?.params.httpHeaders).toBe('Content-Type: application/json\r\nx-ingest-secret: test_ingest_secret_key_12345');
    expect(editCall?.params.http_headers).toBe('Content-Type: application/json\r\nx-ingest-secret: test_ingest_secret_key_12345');
    expect(editCall?.params.httpMethod).toBe('POST');
    expect(editCall?.params.http_method).toBe('POST');
  });
});
