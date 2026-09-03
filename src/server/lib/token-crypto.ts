import { isKnownDefaultKek, isProductionEnv, getServerEnv } from '../db/clients';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b))));
const ub64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(kek: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(kek));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function resolveTokenKek(runtimeEnv: Record<string, any>): Promise<string | null> {
  const env = getServerEnv(runtimeEnv);
  // 1) Explicit env secret wins (and must not be the known default in prod)
  if (env.TOKEN_KEK && !(isProductionEnv(runtimeEnv) && isKnownDefaultKek(env.TOKEN_KEK))) return env.TOKEN_KEK;
  // 2) KV-stored key (same namespace as ingest secrets)
  const kv = (runtimeEnv as any)?.INGEST_SECRETS_KV;
  if (kv) {
    try {
      const existing = await kv.get('token_kek:global');
      if (existing && String(existing).trim().length >= 32) return String(existing).trim();
      // 3) Lazy seed: generate once, persist, read back (last-write-wins safety)
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      await kv.put('token_kek:global', hex);
      const verified = await kv.get('token_kek:global');
      if (verified && String(verified).trim().length >= 32) return String(verified).trim();
    } catch { /* fall through */ }
  }
  // 4) Last resort: env value even if default (dev only; prod guard still applies at use-site)
  return env.TOKEN_KEK || null;
}

export async function encryptToken(plain: string, kek: string, runtimeEnv?: Record<string, any>) {
  if (isProductionEnv(runtimeEnv) && isKnownDefaultKek(kek)) {
    throw new Error("Refusing to encrypt with default TOKEN_KEK in production. Set via 'wrangler secret put TOKEN_KEK'.");
  }
  if (!kek || typeof kek !== 'string' || kek.trim().length < 16) {
    throw new Error('Encryption KEK must be at least 16 characters of entropy.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(kek), enc.encode(plain));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function decryptToken(stored: string, kek: string, runtimeEnv?: Record<string, any>): Promise<string | null> {
  if (isProductionEnv(runtimeEnv) && isKnownDefaultKek(kek)) return null;
  if (!kek || typeof kek !== 'string' || kek.trim().length < 16) {
    console.error('TOKEN_KEK is too short for decryption (must be >= 16 chars)');
    return null;
  }
  const [ver, iv, ct] = stored.split(':');
  if (ver !== 'v1') return null;
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) }, await key(kek), ub64(ct)));
  } catch {
    return null;
  }
}
