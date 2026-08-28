import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dispatchApi from '../../pages/api/internal/pinarchive/dispatch';
import * as cronApi from '../../pages/api/pinarchive/cron';
import fs from 'fs';
import path from 'path';

describe('PinArchive FastCron Migration & Dispatch Test Suite (v3 Delta)', () => {
  const mockWorkspaceId = '11111111-2222-3333-4444-555555555555';
  const validSecret = 'sec_valid_ingest_test_secret_12345';
  const mockToken = 'fastcron_test_api_token_12345678';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. W3 Isolation & Helper Usage Guarantees', () => {
    it('verifies dispatch.ts and cron.ts do not import analyticsDb or competitor clients', () => {
      const dispatchSrc = fs.readFileSync(
        path.resolve(__dirname, '../../pages/api/internal/pinarchive/dispatch.ts'),
        'utf8'
      );
      const cronSrc = fs.readFileSync(
        path.resolve(__dirname, '../../pages/api/pinarchive/cron.ts'),
        'utf8'
      );

      expect(dispatchSrc).not.toMatch(/analyticsDb/);
      expect(dispatchSrc).not.toMatch(/getCompetitors/);
      expect(dispatchSrc).not.toMatch(/from\(['"]analytics_/);
      expect(dispatchSrc).not.toMatch(/from\(['"]competitors/);
      expect(dispatchSrc).not.toMatch(/CRON_DISPATCH_SECRET/);

      expect(cronSrc).not.toMatch(/analyticsDb/);
      expect(cronSrc).not.toMatch(/getCompetitors/);
      expect(cronSrc).not.toMatch(/from\(['"]analytics_/);
      expect(cronSrc).not.toMatch(/from\(['"]competitors/);
      expect(cronSrc).not.toMatch(/CRON_DISPATCH_SECRET/);
    });

    it('verifies resolveScheduleToken is used in cron.ts and 0 direct FASTCRON_API_TOKEN reads exist', () => {
      const cronSrc = fs.readFileSync(
        path.resolve(__dirname, '../../pages/api/pinarchive/cron.ts'),
        'utf8'
      );

      expect(cronSrc).toMatch(/resolveScheduleToken/);
      expect(cronSrc).not.toMatch(/FASTCRON_API_TOKEN/);
    });

    it('verifies old schedule block is removed from pinarchive-refresh.yml', () => {
      const workflowSrc = fs.readFileSync(
        path.resolve(__dirname, '../../../.github/workflows/pinarchive-refresh.yml'),
        'utf8'
      );
      expect(workflowSrc).not.toMatch(/schedule:/);
      expect(workflowSrc).toMatch(/force:/);
      expect(workflowSrc).toMatch(/REFRESH_FORCE/);
    });
  });

  describe('2. Internal Dispatch Endpoint (/api/internal/pinarchive/dispatch)', () => {
    it('returns 400 for empty or malformed body', async () => {
      const res = await dispatchApi.POST({
        request: new Request('https://example.com/api/internal/pinarchive/dispatch', {
          method: 'POST',
          body: '',
        }),
        locals: {},
      } as any);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it('returns 422 when workspace_id is missing or invalid UUID', async () => {
      const res1 = await dispatchApi.POST({
        request: new Request('https://example.com/api/internal/pinarchive/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        locals: {},
      } as any);

      expect(res1.status).toBe(422);

      const res2 = await dispatchApi.POST({
        request: new Request('https://example.com/api/internal/pinarchive/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: 'invalid-id' }),
        }),
        locals: {},
      } as any);

      expect(res2.status).toBe(422);
    });

    it('returns 401 when x-ingest-secret header is missing or incorrect', async () => {
      const res = await dispatchApi.POST({
        request: new Request('https://example.com/api/internal/pinarchive/dispatch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-ingest-secret': 'wrong_secret',
          },
          body: JSON.stringify({ workspace_id: mockWorkspaceId }),
        }),
        locals: {
          runtimeEnv: {
            INGEST_SECRET_KEY: validSecret,
          },
        },
      } as any);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toMatch(/Unauthorized/);
    });

    it('returns 503 when in production and ingest secret is default placeholder', async () => {
      const res = await dispatchApi.POST({
        request: new Request('https://example.com/api/internal/pinarchive/dispatch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-ingest-secret': 'pinorbit_ingest_secret_dev',
          },
          body: JSON.stringify({ workspace_id: mockWorkspaceId }),
        }),
        locals: {
          runtimeEnv: {
            CF_ENVIRONMENT: 'production',
            INGEST_SECRET_KEY: 'pinorbit_ingest_secret_dev',
          },
        },
      } as any);

      expect(res.status).toBe(503);
    });

    it('returns 202 when authorized and forwards workflow_dispatch with force flag', async () => {
      let capturedUrl = '';
      let capturedBody: any = null;

      global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (url.includes('api.github.com')) {
          capturedUrl = url;
          capturedBody = JSON.parse(opts.body);
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const res = await dispatchApi.POST({
        request: new Request('https://example.com/api/internal/pinarchive/dispatch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-ingest-secret': validSecret,
          },
          body: JSON.stringify({
            workspace_id: mockWorkspaceId,
            force: 'true',
          }),
        }),
        locals: {
          runtimeEnv: {
            INGEST_SECRET_KEY: validSecret,
            GITHUB_DISPATCH_TOKEN: 'ghp_mock_token_12345',
            GITHUB_REPO: 'sayfedin-star/PinOrbit-v2',
            SCHEDULING_SUPABASE_SECRET_KEY: 'sb_mock_sec',
          },
        },
      } as any);

      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.dispatched).toBe(true);
      expect(json.force).toBe(true);
      expect(capturedUrl).toContain('sayfedin-star/PinOrbit-v2/actions/workflows/pinarchive-refresh.yml/dispatches');
      expect(capturedBody.inputs.workspace_id).toBe(mockWorkspaceId);
      expect(capturedBody.inputs.force).toBe('true');
    });
  });

  describe('3. Cron CRUD & Discovery Endpoint (/api/pinarchive/cron)', () => {
    it('parseTimeToCron validates HH:MM 24h format', () => {
      expect(cronApi.parseTimeToCron('04:00')).toEqual({ valid: true, cron: '0 4 * * *' });
      expect(cronApi.parseTimeToCron('23:59')).toEqual({ valid: true, cron: '59 23 * * *' });
      expect(cronApi.parseTimeToCron('0:00')).toEqual({ valid: true, cron: '0 0 * * *' });
      expect(cronApi.parseTimeToCron('25:00').valid).toBe(false);
      expect(cronApi.parseTimeToCron('invalid').valid).toBe(false);
      expect(cronApi.parseTimeToCron('').valid).toBe(false);
    });

    it('discoverPinArchiveJob statelessly matches pipeline:pinarchive and workspace_id in postData', async () => {
      const mockJobs = [
        {
          id: 101,
          name: 'PinOrbit analytics — other',
          post_data: JSON.stringify({ workspace_id: mockWorkspaceId, pipeline: 'analytics' }),
        },
        {
          id: 202,
          name: `PinOrbit pinarchive — ${mockWorkspaceId.slice(0, 8)}`,
          post_data: JSON.stringify({ workspace_id: mockWorkspaceId, pipeline: 'pinarchive' }),
          expression: '0 4 * * *',
          timezone: 'UTC',
          status: 'enabled',
        },
      ];

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('cron_list')) {
          return new Response(JSON.stringify({ status: 'OK', data: mockJobs }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
      });

      const discovered = await cronApi.discoverPinArchiveJob(mockToken, mockWorkspaceId);
      expect(discovered).not.toBeNull();
      expect(discovered.id).toBe(202);
    });

    it('GET returns discovered job with token_source, masked_token, cron_next and last 10 logs', async () => {
      const mockJob = {
        id: 202,
        name: `PinOrbit pinarchive — ${mockWorkspaceId.slice(0, 8)}`,
        post_data: JSON.stringify({ workspace_id: mockWorkspaceId, pipeline: 'pinarchive' }),
        expression: '0 4 * * *',
        timezone: 'UTC',
        status: 'enabled',
      };

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('cron_list')) {
          return new Response(JSON.stringify({ status: 'OK', data: [mockJob] }), { status: 200 });
        }
        if (url.includes('cron_next')) {
          return new Response(JSON.stringify({ status: 'OK', data: ['2026-08-27 04:00:00', '2026-08-28 04:00:00'] }), { status: 200 });
        }
        if (url.includes('cron_logs')) {
          return new Response(JSON.stringify({ status: 'OK', data: [{ id: 1, status: 'OK', http_status_code: 202, duration: 0.85 }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
      });

      const mockSupabase = {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: { id: 'm1', role: 'admin' }, error: null }),
                maybeSingle: async () => ({ data: { name: 'Main Registry Token', token_masked: 'fastcron...' }, error: null }),
              }),
            }),
          }),
        }),
      };

      const res = await cronApi.GET({
        locals: {
          user: { id: '99999999-8888-7777-6666-555555555555' },
          supabase: mockSupabase,
          activeWorkspaceId: mockWorkspaceId,
          runtimeEnv: {
            FASTCRON_API_TOKEN: mockToken,
          },
        },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.configured).toBe(true);
      expect(json.token_source).toBe('workspace_registry');
      expect(json.token_name).toBe('Workspace Default');
      expect(json.masked_token).toBe('••••5678');
      expect(json.job.id).toBe(202);
      expect(json.job.cron_next.length).toBe(2);
      expect(json.job.cron_logs.length).toBe(1);
    });

    it('POST with action: "run_now" dispatches GitHub Actions workflow immediately', async () => {
      let capturedPayload: any = null;
      global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (url.includes('api.github.com')) {
          capturedPayload = JSON.parse(opts.body);
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
      });

      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: { id: 'm1', role: 'admin' }, error: null }),
              }),
            }),
          }),
        }),
      };

      const res = await cronApi.POST({
        request: new Request('https://example.com/api/pinarchive/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run_now' }),
        }),
        locals: {
          user: { id: '99999999-8888-7777-6666-555555555555' },
          supabase: mockSupabase,
          activeWorkspaceId: mockWorkspaceId,
          runtimeEnv: {
            GITHUB_DISPATCH_TOKEN: 'ghp_mock_token_123',
          },
        },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(capturedPayload.inputs.force).toBe('true');
      expect(capturedPayload.inputs.workspace_id).toBe(mockWorkspaceId);
    });

    it('POST with {sync_time, timezone, enabled} creates or edits FastCron job', async () => {
      let capturedAction = '';
      let capturedParams: any = null;

      global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (url.includes('cron_list')) {
          return new Response(JSON.stringify({ status: 'OK', data: [] }), { status: 200 });
        }
        if (url.includes('cron_add')) {
          capturedAction = 'cron_add';
          capturedParams = JSON.parse(opts.body);
          return new Response(JSON.stringify({ status: 'OK', data: { id: 303 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
      });

      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: { id: 'm1', role: 'admin' }, error: null }),
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
      };

      const res = await cronApi.POST({
        request: new Request('https://example.com/api/pinarchive/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sync_time: '04:00',
            timezone: 'America/New_York',
            enabled: true,
          }),
        }),
        locals: {
          user: { id: '99999999-8888-7777-6666-555555555555' },
          supabase: mockSupabase,
          activeWorkspaceId: mockWorkspaceId,
          runtimeEnv: {
            FASTCRON_API_TOKEN: mockToken,
            INGEST_SECRET_KEY: validSecret,
          },
        },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(capturedAction).toBe('cron_add');
      expect(capturedParams.expression).toBe('0 4 * * *');
      expect(capturedParams.timezone).toBe('America/New_York');
      expect(capturedParams.http_headers).toContain(validSecret);
      expect(capturedParams.post_data).toContain('pinarchive');
    });

    it('DELETE removes discovered FastCron job', async () => {
      let deletedId = 0;
      const mockJob = {
        id: 404,
        name: `PinOrbit pinarchive — ${mockWorkspaceId.slice(0, 8)}`,
        post_data: JSON.stringify({ workspace_id: mockWorkspaceId, pipeline: 'pinarchive' }),
      };

      global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (url.includes('cron_list')) {
          return new Response(JSON.stringify({ status: 'OK', data: [mockJob] }), { status: 200 });
        }
        if (url.includes('cron_delete')) {
          const body = JSON.parse(opts.body);
          deletedId = body.id;
          return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'OK' }), { status: 200 });
      });

      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: { id: 'm1', role: 'admin' }, error: null }),
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
      };

      const res = await cronApi.DELETE({
        locals: {
          user: { id: '99999999-8888-7777-6666-555555555555' },
          supabase: mockSupabase,
          activeWorkspaceId: mockWorkspaceId,
          runtimeEnv: {
            FASTCRON_API_TOKEN: mockToken,
          },
        },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(deletedId).toBe(404);
    });
  });
});
