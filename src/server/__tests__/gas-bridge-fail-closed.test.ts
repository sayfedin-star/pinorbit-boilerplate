import { describe, it, expect, vi } from 'vitest';
import { gasCall } from '../lib/gas-bridge';
import * as webhookSecrets from '../services/webhook-secrets';

describe('Audit Defense: gas-bridge fail-closed behavior', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';

  it('fails closed when ingest secret is missing or empty', async () => {
    vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
      value: '',
      source: 'none',
      hasOverride: false,
    } as any);

    const result = await gasCall(
      { PINARCHIVE_GAS_URL: 'https://script.google.com/test' },
      workspaceId,
      'sheet_sync',
      { test: true }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Ingest secret is not configured for workspace.');
  });

  it('fails closed when GAS returns non-JSON/HTML error response', async () => {
    vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
      value: 'valid-secret-123',
      source: 'workspace',
      hasOverride: true,
    } as any);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => '<html><body><h1>502 Bad Gateway - Apps Script Service Unavailable</h1></body></html>',
      })
    );

    const result = await gasCall(
      { PINARCHIVE_GAS_URL: 'https://script.google.com/test' },
      workspaceId,
      'sheet_sync',
      { test: true }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('GAS returned non-JSON/HTML response');

    vi.unstubAllGlobals();
  });
});
