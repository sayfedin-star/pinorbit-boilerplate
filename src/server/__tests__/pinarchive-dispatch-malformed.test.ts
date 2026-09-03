import { describe, it, expect } from 'vitest';
import { POST as pinArchiveDispatchPost } from '../../pages/api/internal/pinarchive/dispatch';

describe('Regression: PinArchive dispatch returns 400 on malformed JSON payload even with query params (R-08 / S-07)', () => {
  it('unconditionally returns HTTP 400 on malformed JSON body when workspace_id query param is present', async () => {
    const req = new Request('http://localhost:4321/api/internal/pinarchive/dispatch?workspace_id=test-ws-uuid-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{{invalid-json-payload',
    });

    const res = await pinArchiveDispatchPost({
      request: req,
      locals: {
        runtimeEnv: {},
      },
    } as any);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('Malformed JSON payload.');
  });
});
