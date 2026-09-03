import { describe, it, expect, beforeEach, vi } from 'vitest';
import { analyticsDb } from '../db/analytics';
import { dbClients } from '../db/clients';

describe('Regression: get_pin_leaderboard passes p_workspace_id guard (R-11 / M-02)', () => {
  const workspaceA = '00000000-0000-0000-0000-000000000001';
  const connectionId = '11111111-1111-1111-1111-111111111111';

  let rpcArgsPassed: Record<string, any> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    rpcArgsPassed = null;

    const mockAnalyticsClient = {
      rpc: vi.fn(async (procName: string, args: Record<string, any>) => {
        if (procName === 'get_pin_leaderboard') {
          rpcArgsPassed = args;
          return { data: [], error: null };
        }
        return { data: null, error: null };
      }),
    };

    vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient as any);
  });

  it('strictly passes p_workspace_id to get_pin_leaderboard RPC', async () => {
    await analyticsDb.getPinLeaderboard(
      workspaceA,
      connectionId,
      'IMPRESSION',
      30,
      25,
      null
    );

    expect(rpcArgsPassed).not.toBeNull();
    // Assert p_workspace_id is explicitly passed to enforce tenant isolation in PostgreSQL
    expect(rpcArgsPassed?.p_workspace_id).toBe(workspaceA);
    expect(rpcArgsPassed?.p_connection_id).toBe(connectionId);
    expect(rpcArgsPassed?.p_sort_by).toBe('IMPRESSION');
  });
});
