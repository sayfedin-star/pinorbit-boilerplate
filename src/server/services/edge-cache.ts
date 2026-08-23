/**
 * Edge Caching Layer for Pinner Analytics.
 * Directives:
 * 1. Cloudflare KV is a post-persistence read cache only.
 * 2. In local dev or non-KV environments, seamlessly falls back to an in-memory TTL store.
 * 3. Never write cache before database persistence completes.
 * 4. Cache TTL defaults to 6 hours (21600 seconds).
 * 5. Returns cache metadata for diagnostic X-Cache-Status (HIT / MISS / STALE) headers.
 */

export type CacheStatus = 'HIT' | 'MISS' | 'STALE' | 'BYPASS';

export interface CachedResponse<T> {
  data: T;
  status: CacheStatus;
  cachedAt?: number;
  ttlRemaining?: number;
}

import type { EdgeKVNamespace } from '../lib/edge-kv';

interface InMemoryCacheEntry<T> {
  value: T;
  cachedAt: number;
  ttlMs: number;
}

// In-Memory fallback store for SSR and local environments
const MAX_MEMORY_ENTRIES = 500;
const memoryCache = new Map<string, InMemoryCacheEntry<unknown>>();

function setMemoryCache<T>(key: string, value: T, ttlMs: number): void {
  // Evict oldest if at capacity
  if (memoryCache.size >= MAX_MEMORY_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey) memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, { value, cachedAt: Date.now(), ttlMs });
}

const DEFAULT_TTL_SECONDS = 6 * 60 * 60; // 6 hours

export const edgeCache = {
  /**
   * Generates canonical cache keys.
   */
  keys: {
    overview(workspaceId: string, connectionId: string, windowDays = 30): string {
      return `analytics:${workspaceId}:${connectionId}:overview:${windowDays}d`;
    },
    topPins(
      workspaceId: string,
      connectionId: string,
      sortBy = 'IMPRESSION',
      windowDays = 30,
      fromDate?: string,
      toDate?: string,
      bypassCache = false,
      limit = 50
    ): string {
      const bypassPart = bypassCache ? ':bypass' : '';
      const limitPart = limit !== 50 ? `:l${limit}` : '';
      if (fromDate && toDate) {
        return `analytics:${workspaceId}:${connectionId}:top-pins:${fromDate}_${toDate}:${sortBy}${limitPart}${bypassPart}`;
      }
      return `analytics:${workspaceId}:${connectionId}:top-pins:${windowDays}d:${sortBy}${limitPart}${bypassPart}`;
    },
    topPinsPaged(
      workspaceId: string,
      connectionId: string,
      sortBy = 'IMPRESSION',
      fromDate?: string,
      toDate?: string,
      windowDays = 30,
      bypassCache = false,
      pageSize = 25,
      page = 1
    ): string {
      const bypassPart = bypassCache ? ':bypass' : '';
      const pagePart = (page !== 1 || pageSize !== 25) ? `:p${page}_ps${pageSize}` : '';
      if (fromDate && toDate) {
        return `analytics:${workspaceId}:${connectionId}:top-pins:paged:v1:${fromDate}_${toDate}:${sortBy}${pagePart}${bypassPart}`;
      }
      return `analytics:${workspaceId}:${connectionId}:top-pins:paged:v1:${windowDays}d:${sortBy}${pagePart}${bypassPart}`;
    },
    timeseries(workspaceId: string, connectionId: string, windowDays = 30): string {
      return `analytics:${workspaceId}:${connectionId}:timeseries:${windowDays}d`;
    },
  },

  /**
   * Reads a cached item with fallback.
   */
  async get<T>(
    key: string,
    kvNamespace?: EdgeKVNamespace | any,
    ttlSeconds = DEFAULT_TTL_SECONDS
  ): Promise<CachedResponse<T | null>> {
    const now = Date.now();
    const memoryEntry = memoryCache.get(key);

    // 1. Memory fresh → HIT (memory)
    if (memoryEntry) {
      const ageMs = now - memoryEntry.cachedAt;
      const ttlMs = memoryEntry.ttlMs;

      if (ageMs <= ttlMs) {
        return {
          data: memoryEntry.value as T,
          status: 'HIT',
          cachedAt: memoryEntry.cachedAt,
          ttlRemaining: Math.max(0, Math.floor((ttlMs - ageMs) / 1000)),
        };
      }
    }

    // If memory is stale or absent, consult Cloudflare KV if namespace is available
    if (kvNamespace && typeof kvNamespace.get === 'function') {
      try {
        const raw = await kvNamespace.get(key, 'json');
        if (raw) {
          // 2 & 4: KV is fresh → refresh memory entry and return HIT (KV)
          const ttlMs = ttlSeconds * 1000;
          setMemoryCache(key, raw, ttlMs);
          return {
            data: raw as T,
            status: 'HIT',
            cachedAt: now,
          };
        }
      } catch (e) {
        console.warn(`[EdgeCache] KV read error for key ${key}:`, e);
      }
    }

    // 3. Memory stale + KV stale/absent → STALE with memory data
    if (memoryEntry) {
      return {
        data: memoryEntry.value as T,
        status: 'STALE',
        cachedAt: memoryEntry.cachedAt,
        ttlRemaining: 0,
      };
    }

    // 5. No memory + KV stale/absent → MISS
    return {
      data: null,
      status: 'MISS',
    };
  },

  /**
   * Sets a value in the cache after database persistence.
   */
  async set<T>(
    key: string,
    value: T,
    kvNamespace?: EdgeKVNamespace | any,
    ttlSeconds = DEFAULT_TTL_SECONDS
  ): Promise<void> {
    const now = Date.now();
    const ttlMs = ttlSeconds * 1000;

    // 1. In-memory store
    setMemoryCache(key, value, ttlMs);

    // 2. Cloudflare KV namespace if provided
    if (kvNamespace && typeof kvNamespace.put === 'function') {
      try {
        await kvNamespace.put(key, JSON.stringify(value), {
          expirationTtl: ttlSeconds,
        });
      } catch (e) {
        console.warn(`[EdgeCache] KV put error for key ${key}:`, e);
      }
    }
  },

  /**
   * Invalidates all cache entries for a connection.
   */
  async invalidateConnection(
    workspaceId: string,
    connectionId: string,
    kvNamespace?: EdgeKVNamespace | any
  ): Promise<void> {
    const prefix = `analytics:${workspaceId}:${connectionId}:`;

    // Clear matching memory entries
    for (const key of memoryCache.keys()) {
      if (key.startsWith(prefix)) {
        memoryCache.delete(key);
      }
    }

    // KV list & delete with cursor pagination if supported
    if (kvNamespace && typeof kvNamespace.list === 'function' && typeof kvNamespace.delete === 'function') {
      try {
        let cursor: string | undefined = undefined;
        do {
          const list: any = await kvNamespace.list({ prefix, cursor });
          for (const k of list.keys || []) {
            await kvNamespace.delete(k.name);
          }
          cursor = list.list_complete ? undefined : list.cursor;
        } while (cursor);
      } catch (e) {
        console.warn(`[EdgeCache] KV invalidation error for prefix ${prefix}:`, e);
      }
    }
  },

  /**
   * Clears the entire in-memory cache (primarily for unit tests).
   */
  clearMemory(): void {
    memoryCache.clear();
  },
};
