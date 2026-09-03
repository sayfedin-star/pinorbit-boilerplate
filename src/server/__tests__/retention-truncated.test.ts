import { describe, it, expect, vi } from 'vitest';
import { batchedDelete } from '../services/retention-cleanup';

describe('Regression: Retention 25k cap returns hitCap=true and truncated=true (R-02 / S-01)', () => {
  it('detects when batchedDelete executes 50 full batch iterations and marks hitCap=true', async () => {
    let callCount = 0;
    const batchSize = 500;

    // Simulate a database with >25k rows available
    const mockClient = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            lt: vi.fn(() => ({
              limit: vi.fn(async (n: number) => {
                callCount++;
                // Always return full batch of 500 rows
                const rows = Array.from({ length: n }, (_, i) => ({ id: `row-${callCount}-${i}` }));
                return { data: rows, error: null };
              }),
            })),
          })),
        })),
        delete: vi.fn(() => ({
          in: vi.fn(() => ({
            eq: vi.fn(async () => ({ count: batchSize, error: null })),
          })),
        })),
      })),
    };

    const result = await batchedDelete(mockClient, 'pins', {
      column: 'workspace_id',
      value: 'ws-test-123',
      workspaceId: 'ws-test-123',
      dateColumn: 'posted_at',
      cutoff: new Date().toISOString(),
      batchSize,
    });

    expect(result.deleted).toBe(50 * 500); // 25,000 rows
    expect(result.hitCap).toBe(true);
  });

  it('marks hitCap=false when rows deplete before reaching 50 iterations', async () => {
    let callCount = 0;
    const batchSize = 500;

    const mockClient = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            lt: vi.fn(() => ({
              limit: vi.fn(async () => {
                callCount++;
                if (callCount <= 3) {
                  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `row-${callCount}-${i}` }));
                  return { data: rows, error: null };
                }
                // Depleted
                return { data: [], error: null };
              }),
            })),
          })),
        })),
        delete: vi.fn(() => ({
          in: vi.fn(() => ({
            eq: vi.fn(async () => ({ count: 500, error: null })),
          })),
        })),
      })),
    };

    const result = await batchedDelete(mockClient, 'pins', {
      column: 'workspace_id',
      value: 'ws-test-123',
      workspaceId: 'ws-test-123',
      dateColumn: 'posted_at',
      cutoff: new Date().toISOString(),
      batchSize,
    });

    expect(result.deleted).toBe(1500);
    expect(result.hitCap).toBe(false);
  });
});
