import { getServerEnv } from '../db/clients';
import { timingSafeEqual } from '../lib/timing-safe';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GLOBAL_KEY = 'ingest_secret:global';
export const wsKey = (wsId: string) => {
  if (!wsId || !UUID_REGEX.test(wsId)) {
    throw new Error('Invalid workspace UUID for secret key.');
  }
  return `ingest_secret:ws:${wsId.toLowerCase()}`;
};

export interface IngestSecretResolution {
  value: string;
  source: 'workspace' | 'global' | 'env';
}

export interface IngestSecretStatus {
  secret: string;
  source: 'workspace' | 'global' | 'env';
  hasOverride: boolean;
}

export interface SecretCandidate {
  value: string;
  source: 'workspace' | 'workspace:prev' | 'global' | 'global:prev' | 'env';
}

/**
 * Returns ALL valid secret candidates for verification.
 * Used by dispatch endpoints to accept any currently or previously-issued secret.
 */
export async function getSecretCandidates(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<SecretCandidate[]> {
  const candidates: SecretCandidate[] = [];

  // Try to read from KV (Cloudflare Workers binding or fallback to global environment)
  let kv =
    runtimeEnv?.INGEST_SECRETS_KV ||
    (typeof globalThis !== 'undefined'
      ? (globalThis as any)?.INGEST_SECRETS_KV || (globalThis as any)?.env?.INGEST_SECRETS_KV
      : undefined);

  if (kv && wsId && UUID_REGEX.test(wsId)) {
    // 1. Workspace override (current)
    const ws = await kv.get(wsKey(wsId));
    if (ws) candidates.push({ value: ws, source: 'workspace' });

    // 2. Workspace override (grace period - 300s)
    const wsPrev = await kv.get(`${wsKey(wsId)}:prev`);
    if (wsPrev) candidates.push({ value: wsPrev, source: 'workspace:prev' });

    // 3. Global secret (current)
    const g = await kv.get(GLOBAL_KEY);
    if (g) candidates.push({ value: g, source: 'global' });

    // 4. Global secret (grace period - 300s)
    const gPrev = await kv.get(`${GLOBAL_KEY}:prev`);
    if (gPrev) candidates.push({ value: gPrev, source: 'global:prev' });
  } else if (kv) {
    // If wsId is missing or invalid UUID but KV is present, still allow global candidates
    const g = await kv.get(GLOBAL_KEY);
    if (g) candidates.push({ value: g, source: 'global' });
    const gPrev = await kv.get(`${GLOBAL_KEY}:prev`);
    if (gPrev) candidates.push({ value: gPrev, source: 'global:prev' });
  }

  // 5. Environment fallback
  const serverConfig = getServerEnv(runtimeEnv);
  if (serverConfig.INGEST_SECRET_KEY) {
    candidates.push({ value: serverConfig.INGEST_SECRET_KEY, source: 'env' });
  }

  return candidates;
}

/**
 * Verifies provided secret against ALL valid candidates.
 * Returns true if provided secret matches any candidate (timing-safe).
 */
export async function verifyIngestSecret(
  providedSecret: string | null | undefined,
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<{ valid: boolean; matchedSource?: SecretCandidate['source'] }> {
  if (!providedSecret || typeof providedSecret !== 'string' || !providedSecret.trim()) {
    return { valid: false };
  }

  const candidates = await getSecretCandidates(wsId, runtimeEnv);

  for (const candidate of candidates) {
    if (candidate.value && (await timingSafeEqual(providedSecret.trim(), candidate.value.trim()))) {
      return { valid: true, matchedSource: candidate.source };
    }
  }

  return { valid: false };
}

/**
 * Resolves the effective ingest secret in strict immutable order:
 * 1. ingest_secret:ws:{wsId} (Workspace override)
 * 2. ingest_secret:ws:{wsId}:prev (Workspace override grace period - 300s)
 * 3. ingest_secret:global (Global secret)
 * 4. ingest_secret:global:prev (Global secret grace period - 300s)
 * 5. INGEST_SECRET_KEY env (Fallback)
 */
export async function getEffectiveSecret(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<IngestSecretResolution> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (kv) {
    if (wsId && UUID_REGEX.test(wsId)) {
      const ws = await kv.get(wsKey(wsId));
      if (ws) return { value: ws, source: 'workspace' };
      const wsPrev = await kv.get(`${wsKey(wsId)}:prev`);
      if (wsPrev) return { value: wsPrev, source: 'workspace' };
    }
    const g = await kv.get(GLOBAL_KEY);
    if (g) return { value: g, source: 'global' };
    const gPrev = await kv.get(`${GLOBAL_KEY}:prev`);
    if (gPrev) return { value: gPrev, source: 'global' };
  }

  const serverConfig = getServerEnv(runtimeEnv);
  return { value: serverConfig.INGEST_SECRET_KEY ?? '', source: 'env' };
}

/**
 * Auto-generates global secret in KV on first view if absent.
 */
export async function ensureGlobalSecret(
  runtimeEnv: Record<string, any>
): Promise<string> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (!kv) {
    const serverConfig = getServerEnv(runtimeEnv);
    return serverConfig.INGEST_SECRET_KEY || '';
  }

  let g = await kv.get(GLOBAL_KEY);
  if (!g) {
    g = crypto.randomUUID();
    await kv.put(GLOBAL_KEY, g);
  }
  return g;
}

/**
 * Rotates secret with a 300s grace period (storing previous secret under ${key}:prev).
 */
export async function regenerate(
  scope: 'global' | 'workspace',
  wsId: string | undefined,
  runtimeEnv: Record<string, any>
): Promise<string> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (!kv) {
    throw new Error('Cloudflare KV namespace INGEST_SECRETS_KV is not configured in runtime environment.');
  }

  if (scope === 'workspace' && !wsId) {
    throw new Error('Workspace ID is required to generate workspace override secret.');
  }

  const key = scope === 'global' ? GLOBAL_KEY : wsKey(wsId!);
  const current = await kv.get(key);
  if (current) {
    await kv.put(`${key}:prev`, current, { expirationTtl: 300 });
  }

  const next = crypto.randomUUID();
  await kv.put(key, next);
  return next;
}

/**
 * Deletes ONLY the workspace override key; global secret remains untouched.
 */
export async function removeWorkspaceOverride(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<void> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (kv && wsId && UUID_REGEX.test(wsId)) {
    await kv.delete(wsKey(wsId));
  }
}

/**
 * Retrieves the secret status for UI view, ensuring global secret exists if KV available.
 */
export async function getSecretStatus(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<IngestSecretStatus> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (kv && wsId && UUID_REGEX.test(wsId)) {
    const ws = await kv.get(wsKey(wsId));
    if (ws) {
      return { secret: ws, source: 'workspace', hasOverride: true };
    }
  }

  const secret = await ensureGlobalSecret(runtimeEnv);
  return {
    secret,
    source: kv ? 'global' : 'env',
    hasOverride: false,
  };
}

/**
 * Masks a secret for display in UI (shows first 8 chars + ellipsis).
 */
export function maskSecret(secret: string): string {
  if (!secret || secret.length <= 8) return '********';
  return secret.slice(0, 8) + '...';
}

/**
 * Retrieves masked secret status for UI display.
 */
export async function getSecretStatusMasked(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<{ masked: string; source: string; hasOverride: boolean }> {
  const status = await getSecretStatus(wsId, runtimeEnv);
  return {
    masked: maskSecret(status.secret),
    source: status.source,
    hasOverride: status.hasOverride,
  };
}
