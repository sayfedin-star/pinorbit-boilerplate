export interface EdgeKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
  delete(key: string): Promise<void>;
}

export function getAnalyticsKV(localsOrEnv: unknown): EdgeKVNamespace | undefined {
  if (!localsOrEnv || typeof localsOrEnv !== 'object') return undefined;

  if ('ANALYTICS_KV' in (localsOrEnv as Record<string, unknown>)) {
    return (localsOrEnv as Record<string, unknown>).ANALYTICS_KV as EdgeKVNamespace | undefined;
  }

  const runtimeEnvKV = (localsOrEnv as { runtimeEnv?: Record<string, unknown> })?.runtimeEnv?.ANALYTICS_KV;
  if (runtimeEnvKV) {
    return runtimeEnvKV as EdgeKVNamespace;
  }

  const env = (localsOrEnv as { runtime?: { env?: Record<string, unknown> } })?.runtime?.env;
  return (env?.ANALYTICS_KV as EdgeKVNamespace | undefined) ?? undefined;
}
