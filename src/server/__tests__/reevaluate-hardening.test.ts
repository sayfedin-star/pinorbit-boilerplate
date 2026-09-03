import { describe, it, expect, vi } from 'vitest';
import { POST as reevaluatePost } from '../../pages/api/internal/pinarchive/reevaluate';
import * as webhookSecrets from '../services/webhook-secrets';
import { dbClients } from '../db/clients';
import * as promotionService from '../services/promotion-service';

describe('Audit Defense: reevaluate.ts bidirectional contract (GAS body secret + client secrecy)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const testSecret = 'secret-test-abc-123';

  it('proves bidirectional contract: outbound GAS body MUST carry secret, client response NEVER echoes it', async () => {
    vi.spyOn(webhookSecrets, 'verifyIngestSecret').mockResolvedValue({
      valid: true,
      source: 'workspace',
      hasOverride: true,
    } as any);

    vi.spyOn(webhookSecrets, 'getEffectiveSecret').mockResolvedValue({
      value: testSecret,
      source: 'workspace',
      hasOverride: true,
    } as any);

    const mockPinArchive = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({ data: [], error: null })),
          })),
        })),
      })),
    };
    vi.spyOn(dbClients, 'getPinArchive').mockReturnValue(mockPinArchive as any);
    vi.spyOn(promotionService, 'promoteCandidates').mockResolvedValue({
      promoted: 0,
      checked: 0,
    });

    let capturedGasBody: any = null;
    let capturedGasHeaders: any = null;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedGasHeaders = opts.headers;
        capturedGasBody = JSON.parse(opts.body);

        // GAS Web App doPost contract simulation: fails if body.secret is missing
        if (!capturedGasBody?.secret || capturedGasBody.secret !== testSecret) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ ok: false, error: 'Unauthorized: missing body secret in doPost' }),
          };
        }

        return {
          ok: true,
          json: async () => ({ ok: true, synced: 2 }),
        };
      })
    );

    // Generate 70 usernames, including invalid ones
    const inputUsernames = [
      ...Array.from({ length: 60 }, (_, i) => `valid_user_${i}`),
      'invalid user name with spaces',
      'invalid$special#chars',
    ];

    const req = new Request('http://localhost:4321/api/internal/pinarchive/reevaluate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': testSecret,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        usernames: inputUsernames,
      }),
    });

    const res = await reevaluatePost({
      request: req,
      locals: {
        runtime: {
          env: {
            PINARCHIVE_GAS_URL: 'https://script.google.com/test-gas',
          },
        },
      },
    } as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // 1. Outbound contract to GAS: must carry secret and capped valid usernames
    expect(capturedGasBody).not.toBeNull();
    expect(capturedGasBody.secret).toBe(testSecret);
    expect(capturedGasHeaders['x-ingest-secret']).toBe(testSecret);
    expect(Array.isArray(capturedGasBody.usernames)).toBe(true);
    expect(capturedGasBody.usernames.length).toBe(50);

    // 2. Client-facing response contract: NEVER echoes secret or raw gas_result
    expect(body.gas_result).toBeUndefined();
    const serializedResponse = JSON.stringify(body);
    expect(serializedResponse).not.toContain(testSecret);
    expect(serializedResponse).not.toContain('secret=');

    vi.unstubAllGlobals();
  });
});
