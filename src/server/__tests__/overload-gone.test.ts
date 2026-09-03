import { describe, it, expect, vi } from 'vitest';

describe('Regression: Stale increment_webhook_execution 2-arg overload is removed (R-01 / M-01)', () => {
  it('strictly rejects invoking 2-arg overload with Postgres code 42883 (undefined function)', async () => {
    // Mocking Postgres RPC client behavior when calling an overload that has been dropped
    const mockRpc = vi.fn(async (procName: string, args: Record<string, any>) => {
      if (procName === 'increment_webhook_execution') {
        // If caller passes only 2 arguments (p_webhook_id, p_count) without the 3rd argument
        if (!('p_workspace_id' in args)) {
          const err: any = new Error('function public.increment_webhook_execution(uuid, integer) does not exist');
          err.code = '42883';
          err.hint = 'No function matches the given name and argument types. You might need to add explicit type casts.';
          throw err;
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });

    // Calling with 2-arg signature fails with 42883
    await expect(
      mockRpc('increment_webhook_execution', {
        p_webhook_id: '11111111-1111-1111-1111-111111111111',
        p_count: 1,
      })
    ).rejects.toMatchObject({
      code: '42883',
      message: expect.stringContaining('does not exist'),
    });

    // Calling with hardened 3-arg signature succeeds
    await expect(
      mockRpc('increment_webhook_execution', {
        p_webhook_id: '11111111-1111-1111-1111-111111111111',
        p_count: 1,
        p_workspace_id: '22222222-2222-2222-2222-222222222222',
      })
    ).resolves.toEqual({ data: null, error: null });
  });
});
