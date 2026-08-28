import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getEffectiveSecret,
  getSecretCandidates,
  verifyIngestSecret,
  ensureGlobalSecret,
  regenerate,
  removeWorkspaceOverride,
  getSecretStatus,
  GLOBAL_KEY,
  wsKey,
} from '../services/webhook-secrets';

describe('Cloudflare KV Webhook Secrets Service Suite (V19)', () => {
  const wsId = '00000000-0000-0000-0000-000000000001';

  let mockKvStore: Map<string, string>;
  let mockKvNamespace: any;
  let mockRuntimeEnv: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKvStore = new Map<string, string>();
    mockKvNamespace = {
      get: vi.fn(async (key: string) => mockKvStore.get(key) || null),
      put: vi.fn(async (key: string, val: string) => {
        mockKvStore.set(key, val);
      }),
      delete: vi.fn(async (key: string) => {
        mockKvStore.delete(key);
      }),
    };

    mockRuntimeEnv = {
      INGEST_SECRETS_KV: mockKvNamespace,
      INGEST_SECRET_KEY: 'env_fallback_secret_123',
    };
  });

  it('B2: Strict 3-step resolution order: ws override -> global secret -> env fallback', async () => {
    // 1. Initially only env exists
    mockRuntimeEnv.INGEST_SECRETS_KV = undefined;
    const resEnv = await getEffectiveSecret(wsId, mockRuntimeEnv);
    expect(resEnv.source).toBe('env');
    expect(resEnv.value).toBe('env_fallback_secret_123');

    // 2. Global secret in KV takes precedence over env
    mockRuntimeEnv.INGEST_SECRETS_KV = mockKvNamespace;
    mockKvStore.set(GLOBAL_KEY, 'global_secret_uuid_abc');
    const resGlobal = await getEffectiveSecret(wsId, mockRuntimeEnv);
    expect(resGlobal.source).toBe('global');
    expect(resGlobal.value).toBe('global_secret_uuid_abc');

    // 3. Workspace override takes highest precedence over global and env
    mockKvStore.set(wsKey(wsId), 'ws_override_uuid_xyz');
    const resWs = await getEffectiveSecret(wsId, mockRuntimeEnv);
    expect(resWs.source).toBe('workspace');
    expect(resWs.value).toBe('ws_override_uuid_xyz');
  });

  it('B2: Auto-generates global secret on first view if KV is uninitialized', async () => {
    expect(mockKvStore.has(GLOBAL_KEY)).toBe(false);

    const generated = await ensureGlobalSecret(mockRuntimeEnv);
    expect(generated).toBeDefined();
    expect(generated.length).toBeGreaterThan(10);
    expect(mockKvStore.get(GLOBAL_KEY)).toBe(generated);

    // Subsequent calls return the existing global secret
    const secondCall = await ensureGlobalSecret(mockRuntimeEnv);
    expect(secondCall).toBe(generated);
  });

  it('N-2: Regenerate rotates value and preserves old secret under :prev with 300s TTL', async () => {
    mockKvStore.set(GLOBAL_KEY, 'old_global_secret');

    const rotatedGlobal = await regenerate('global', undefined, mockRuntimeEnv);
    expect(rotatedGlobal).not.toBe('old_global_secret');
    expect(mockKvStore.get(GLOBAL_KEY)).toBe(rotatedGlobal);
    expect(mockKvStore.get(`${GLOBAL_KEY}:prev`)).toBe('old_global_secret');
    expect(mockKvNamespace.put).toHaveBeenCalledWith(
      `${GLOBAL_KEY}:prev`,
      'old_global_secret',
      { expirationTtl: 300 }
    );

    // Old secret is accepted via getEffectiveSecret within grace period
    const effAfterGlobalRegen = await getEffectiveSecret(wsId, mockRuntimeEnv);
    expect(effAfterGlobalRegen.value).toBe(rotatedGlobal);

    // Workspace regenerate preserves old ws secret
    mockKvStore.set(wsKey(wsId), 'old_ws_secret');
    const rotatedWs = await regenerate('workspace', wsId, mockRuntimeEnv);
    expect(rotatedWs).toBeDefined();
    expect(mockKvStore.get(wsKey(wsId))).toBe(rotatedWs);
    expect(mockKvStore.get(`${wsKey(wsId)}:prev`)).toBe('old_ws_secret');

    // When primary key is removed or during grace period fallback, prev is resolved
    mockKvStore.delete(wsKey(wsId));
    const effWithPrevWs = await getEffectiveSecret(wsId, mockRuntimeEnv);
    expect(effWithPrevWs.value).toBe('old_ws_secret');
    expect(effWithPrevWs.source).toBe('workspace');

    // After 300s grace period expires (key:prev deleted), old secret is rejected
    mockKvStore.delete(`${wsKey(wsId)}:prev`);
    const effExpired = await getEffectiveSecret(wsId, mockRuntimeEnv);
    expect(effExpired.value).toBe(rotatedGlobal);
    expect(effExpired.source).toBe('global');
  });

  it('B2: removeWorkspaceOverride deletes ONLY ws key; global secret remains untouched', async () => {
    mockKvStore.set(GLOBAL_KEY, 'persistent_global_secret');
    mockKvStore.set(wsKey(wsId), 'temporary_ws_override');

    await removeWorkspaceOverride(wsId, mockRuntimeEnv);

    expect(mockKvStore.has(wsKey(wsId))).toBe(false);
    expect(mockKvStore.get(GLOBAL_KEY)).toBe('persistent_global_secret');

    // After removing override, effective secret falls back to global
    const effective = await getEffectiveSecret(wsId, mockRuntimeEnv);
    expect(effective.source).toBe('global');
    expect(effective.value).toBe('persistent_global_secret');
  });

  it('getSecretStatus returns full UI metadata', async () => {
    mockKvStore.set(GLOBAL_KEY, 'global_secret_123');

    const status1 = await getSecretStatus(wsId, mockRuntimeEnv);
    expect(status1.hasOverride).toBe(false);
    expect(status1.source).toBe('global');
    expect(status1.secret).toBe('global_secret_123');

    mockKvStore.set(wsKey(wsId), 'override_secret_456');
    const status2 = await getSecretStatus(wsId, mockRuntimeEnv);
    expect(status2.hasOverride).toBe(true);
    expect(status2.source).toBe('workspace');
    expect(status2.secret).toBe('override_secret_456');
  });

  describe('Candidate-set verification (TIER 1)', () => {
    it('getSecretCandidates returns all valid candidates in order', async () => {
      mockKvStore.set(wsKey(wsId), 'ws_secret_1');
      mockKvStore.set(`${wsKey(wsId)}:prev`, 'ws_secret_prev');
      mockKvStore.set(GLOBAL_KEY, 'global_secret_1');
      mockKvStore.set(`${GLOBAL_KEY}:prev`, 'global_secret_prev');

      const candidates = await getSecretCandidates(wsId, mockRuntimeEnv);
      expect(candidates).toEqual([
        { value: 'ws_secret_1', source: 'workspace' },
        { value: 'ws_secret_prev', source: 'workspace:prev' },
        { value: 'global_secret_1', source: 'global' },
        { value: 'global_secret_prev', source: 'global:prev' },
        { value: 'env_fallback_secret_123', source: 'env' },
      ]);
    });

    it('verifyIngestSecret validates against any candidate timing-safely', async () => {
      mockKvStore.set(wsKey(wsId), 'ws_secret_active');
      mockKvStore.set(GLOBAL_KEY, 'global_secret_active');

      // Validates workspace secret
      const v1 = await verifyIngestSecret('ws_secret_active', wsId, mockRuntimeEnv);
      expect(v1.valid).toBe(true);
      expect(v1.matchedSource).toBe('workspace');

      // Validates global secret even if workspace override exists
      const v2 = await verifyIngestSecret('global_secret_active', wsId, mockRuntimeEnv);
      expect(v2.valid).toBe(true);
      expect(v2.matchedSource).toBe('global');

      // Validates env fallback secret
      const v3 = await verifyIngestSecret('env_fallback_secret_123', wsId, mockRuntimeEnv);
      expect(v3.valid).toBe(true);
      expect(v3.matchedSource).toBe('env');

      // Rejects invalid secret
      const v4 = await verifyIngestSecret('completely_wrong_secret', wsId, mockRuntimeEnv);
      expect(v4.valid).toBe(false);

      // Rejects empty / null / whitespace secret
      const v5 = await verifyIngestSecret('', wsId, mockRuntimeEnv);
      expect(v5.valid).toBe(false);
      const v6 = await verifyIngestSecret(null as any, wsId, mockRuntimeEnv);
      expect(v6.valid).toBe(false);
    });
  });
});
