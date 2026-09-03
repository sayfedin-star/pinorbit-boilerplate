import { describe, it, expect, vi } from 'vitest';
import { POST as ingestPost } from '../../pages/api/internal/pinarchive/ingest';
import * as webhookSecrets from '../services/webhook-secrets';
import { dbClients } from '../db/clients';

describe('Audit Defense: pinarchive/ingest pre-truncation to maxBatchPins to prevent OOM', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const testSecret = 'secret-test-abc-123';

  it('pre-truncates oversized pins payload to maxBatchPins and sets truncated count', async () => {
    vi.spyOn(webhookSecrets, 'verifyIngestSecret').mockResolvedValue({
      valid: true,
      source: 'workspace',
      hasOverride: true,
    } as any);

    const mockSchedulingAdmin = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: { id: workspaceId }, error: null })),
          })),
        })),
      })),
    };

    let insertedPins: any[] = [];
    const mockPinArchive = {
      from: vi.fn((table: string) => {
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { ingest_enabled: true, max_batch_pins: 10 },
                  error: null,
                })),
              })),
            })),
          };
        }
        if (table === 'pa_accounts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: { id: 'acc-1', status: 'active', ingest_enabled: true },
                    error: null,
                  })),
                })),
              })),
            })),
            upsert: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn(async () => ({ data: { id: 'acc-1' }, error: null })),
                maybeSingle: vi.fn(async () => ({ data: { id: 'acc-1' }, error: null })),
              })),
            })),
          };
        }
        if (table === 'pa_pins') {
          const pinQuery: any = {
            select: vi.fn(() => pinQuery),
            eq: vi.fn(() => pinQuery),
            in: vi.fn(async () => ({ data: [], error: null })),
            upsert: vi.fn(() => ({
              select: vi.fn(async () => ({ data: [], error: null })),
              then: (res: any) => res({ error: null }),
            })),
            insert: vi.fn(async () => ({ error: null })),
          };
          return pinQuery;
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              in: vi.fn(async () => ({ data: [], error: null })),
            })),
          })),
          upsert: vi.fn(async () => ({ error: null })),
          insert: vi.fn(async () => ({ error: null })),
        };
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    };

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockSchedulingAdmin as any);
    vi.spyOn(dbClients, 'getPinArchive').mockReturnValue(mockPinArchive as any);

    // Send 50 pins when maxBatchPins is 10
    const oversizedPins = Array.from({ length: 50 }, (_, i) => ({
      pin_id: `pin_${i}`,
      title: `Pin Title ${i}`,
      saves: i,
    }));

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': testSecret,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        username: 'testuser',
        pins: oversizedPins,
      }),
    });

    const res = await ingestPost({
      request: req,
      locals: { runtime: { env: {} } },
    } as any);

    const body = await res.json();
    console.log('ingest body:', body);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.truncated).toBe(50);
    expect(body.accepted).toBeLessThanOrEqual(10);
  });
});
