import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient, type CookieOptionsWithName } from '@supabase/ssr';

export interface ServerEnvConfig {
  SCHEDULING_SUPABASE_URL: string;
  SCHEDULING_SUPABASE_PUBLISHABLE_KEY: string;
  SCHEDULING_SUPABASE_SECRET_KEY: string;
  COMPETITORS_SUPABASE_URL: string;
  COMPETITORS_SUPABASE_PUBLISHABLE_KEY: string;
  COMPETITORS_SUPABASE_SECRET_KEY: string;
  ANALYTICS_SUPABASE_URL: string;
  ANALYTICS_SUPABASE_PUBLISHABLE_KEY: string;
  ANALYTICS_SUPABASE_SECRET_KEY: string;
  PINARCHIVE_SUPABASE_URL: string;
  PINARCHIVE_SUPABASE_SECRET_KEY: string;
  PINARCHIVE_GAS_URL: string;
  INGEST_SECRET_KEY: string;
  SNITCH_WEBHOOK_URL: string;
  FASTCRON_API_TOKEN: string;
  TOKEN_KEK: string;
}

export const KNOWN_DEFAULT_INGEST_SECRET = 'pinorbit_ingest_secret_dev';
export const KNOWN_DEFAULT_KEKS = ['pinorbit_dev_token_kek_00000000','pinorbit_prod_token_kek_00000000'] as const;

export function isProductionEnv(runtimeEnv?: Record<string, any>): boolean {
  const nodeProd = typeof process !== 'undefined' && process.env.NODE_ENV === 'production';
  const astroProd = typeof import.meta !== 'undefined' && Boolean((import.meta as any).env?.PROD);
  return Boolean(nodeProd || astroProd || runtimeEnv?.CF_ENVIRONMENT === 'production');
}
export function isKnownDefaultIngestSecret(v?: string | null): boolean { return v === KNOWN_DEFAULT_INGEST_SECRET; }
export function isKnownDefaultKek(v?: string | null): boolean { return (KNOWN_DEFAULT_KEKS as readonly string[]).includes(v as string); }
export function hasSchedulingSecretKey(runtimeEnv?: Record<string, any>): boolean {
  const env = { ...(typeof process !== 'undefined' ? process.env : {}), ...(runtimeEnv || {}) } as Record<string, string | undefined>;
  return Boolean(env.SCHEDULING_SUPABASE_SECRET_KEY && env.SCHEDULING_SUPABASE_SECRET_KEY.trim().length > 0);
}

/**
 * Validates and extracts server-only environment configuration.
 * Uses modern Supabase publishable/secret key naming conventions.
 */
export function getServerEnv(runtimeEnv?: Record<string, any>): ServerEnvConfig {
  const env = {
    ...(typeof process !== 'undefined' ? process.env : {}),
    ...(runtimeEnv || {}),
  } as Record<string, string | undefined>;

  const SCHEDULING_SUPABASE_URL =
    env.SCHEDULING_SUPABASE_URL ||
    env.PUBLIC_SCHEDULING_SUPABASE_URL ||
    'https://eygdoetdwqllvsxpvoex.supabase.co';
  const SCHEDULING_SUPABASE_PUBLISHABLE_KEY =
    env.SCHEDULING_SUPABASE_PUBLISHABLE_KEY ||
    env.PUBLIC_SCHEDULING_SUPABASE_PUBLISHABLE_KEY ||
    'sb_publishable_efxKrwXCOaj9CM5oxD-WjA_jqvB5iGD';
  const SCHEDULING_SUPABASE_SECRET_KEY = env.SCHEDULING_SUPABASE_SECRET_KEY || '';

  const COMPETITORS_SUPABASE_URL =
    env.COMPETITORS_SUPABASE_URL || 'https://guycnhvwfzdzbpgsnavg.supabase.co';
  const COMPETITORS_SUPABASE_PUBLISHABLE_KEY =
    env.COMPETITORS_SUPABASE_PUBLISHABLE_KEY ||
    env.PUBLIC_COMPETITORS_SUPABASE_PUBLISHABLE_KEY ||
    'sb_publishable_LOp8kfbsTQy1zCP5xj-g_g_zRffw1Va';
  const COMPETITORS_SUPABASE_SECRET_KEY = env.COMPETITORS_SUPABASE_SECRET_KEY || '';

  const ANALYTICS_SUPABASE_URL =
    env.ANALYTICS_SUPABASE_URL || 'https://jxdkbwnwtjelznmauwpc.supabase.co';
  const ANALYTICS_SUPABASE_PUBLISHABLE_KEY =
    env.ANALYTICS_SUPABASE_PUBLISHABLE_KEY ||
    env.PUBLIC_ANALYTICS_SUPABASE_PUBLISHABLE_KEY ||
    'sb_publishable_cg8skREWZBWdUyJvuGCn_w_Y-WrWU55';
  const ANALYTICS_SUPABASE_SECRET_KEY = env.ANALYTICS_SUPABASE_SECRET_KEY || '';

  const PINARCHIVE_SUPABASE_URL =
    env.PINARCHIVE_SUPABASE_URL || 'https://kuuugffvyokywtgmdrfk.supabase.co';
  const PINARCHIVE_SUPABASE_SECRET_KEY = env.PINARCHIVE_SUPABASE_SECRET_KEY || '';
  const PINARCHIVE_GAS_URL =
    env.PINARCHIVE_GAS_URL ||
    'https://script.google.com/macros/s/AKfycbwBFmyisJ59ejbOLimfgLHAfPcGx4E_WhIiSEI56BhFSJ6HkHrM2wfoPeO-v3nJa5CA/exec';

  const INGEST_SECRET_KEY = env.INGEST_SECRET_KEY || 'pinorbit_ingest_secret_dev';

  const isProd =
    (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.PROD);
  const isDev = !isProd && Boolean(
    (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.DEV) ||
    (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== undefined)
  );

  const SNITCH_WEBHOOK_URL = env.SNITCH_WEBHOOK_URL || '';
  const FASTCRON_API_TOKEN = env.FASTCRON_API_TOKEN || '';

  let rawTokenKek: string | undefined;
  if (runtimeEnv && 'TOKEN_KEK' in runtimeEnv) {
    rawTokenKek = runtimeEnv.TOKEN_KEK;
  } else if (typeof process !== 'undefined' && process.env.TOKEN_KEK !== undefined) {
    rawTokenKek = process.env.TOKEN_KEK;
  }

  let TOKEN_KEK: string;
  if (rawTokenKek !== undefined && rawTokenKek.trim().length >= 16) {
    TOKEN_KEK = rawTokenKek.trim();
  } else if (isDev) {
    TOKEN_KEK = 'pinorbit_dev_token_kek_00000000';
  } else if (isProd) {
    console.error("TOKEN_KEK is required in production (>= 16 chars). Set via 'wrangler secret put TOKEN_KEK'.");
    TOKEN_KEK = (rawTokenKek !== undefined && rawTokenKek.trim().length >= 16)
      ? rawTokenKek.trim()
      : 'pinorbit_prod_token_kek_00000000';
  } else {
    TOKEN_KEK = 'pinorbit_dev_token_kek_00000000';
  }

  return {
    SCHEDULING_SUPABASE_URL,
    SCHEDULING_SUPABASE_PUBLISHABLE_KEY,
    SCHEDULING_SUPABASE_SECRET_KEY,
    COMPETITORS_SUPABASE_URL,
    COMPETITORS_SUPABASE_PUBLISHABLE_KEY,
    COMPETITORS_SUPABASE_SECRET_KEY,
    ANALYTICS_SUPABASE_URL,
    ANALYTICS_SUPABASE_PUBLISHABLE_KEY,
    ANALYTICS_SUPABASE_SECRET_KEY,
    PINARCHIVE_SUPABASE_URL,
    PINARCHIVE_SUPABASE_SECRET_KEY,
    PINARCHIVE_GAS_URL,
    INGEST_SECRET_KEY,
    SNITCH_WEBHOOK_URL,
    FASTCRON_API_TOKEN,
    TOKEN_KEK,
  };
}

/**
 * Creates a request-scoped Supabase client for Project 1 (Scheduling / Auth Authority).
 * Compatible with Astro SSR cookies for identity and session management.
 */
export function createSchedulingSSRClient(
  context: {
    cookies: {
      get: (key: string) => any;
      set: (key: string, value: string, options?: Record<string, unknown>) => void;
      delete: (key: string, options?: Record<string, unknown>) => void;
    };
  },
  runtimeEnv?: Record<string, any>
): SupabaseClient {
  const env = getServerEnv(runtimeEnv);

  return createServerClient(env.SCHEDULING_SUPABASE_URL, env.SCHEDULING_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      get(key: string) {
        const raw = context.cookies.get(key);
        if (typeof raw === 'string') return raw;
        if (raw && typeof raw === 'object' && 'value' in raw) return raw.value;
        return undefined;
      },
      set(key: string, value: string, options: CookieOptionsWithName) {
        context.cookies.set(key, value, {
          path: '/',
          sameSite: 'lax',
          secure: true,
          ...options,
        });
      },
      remove(key: string, options: CookieOptionsWithName) {
        context.cookies.delete(key, {
          path: '/',
          ...options,
        });
      },
    },
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: false,
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getRequiredSecretKey(secretKey?: string, serviceName: string = 'Service', runtimeEnv?: Record<string, any>): string {
  if (!secretKey || secretKey.trim().length === 0) {
    if (isProductionEnv(runtimeEnv)) {
      throw new Error(`[DatabaseConfigError] ${serviceName} secret key is missing.`);
    }
    return 'missing-secret-key-dev-placeholder';
  }
  return secretKey.trim();
}

/**
 * Creates a server-only administrative client for Project 1 (Scheduling).
 * Used exclusively for background queues, cron dispatch, and audit logging.
 */
export function createSchedulingAdminClient(runtimeEnv?: Record<string, any>): SupabaseClient {
  const env = getServerEnv(runtimeEnv);
  const key = getRequiredSecretKey(env.SCHEDULING_SUPABASE_SECRET_KEY, 'Scheduling', runtimeEnv);
  return createClient(env.SCHEDULING_SUPABASE_URL, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        'x-client-info': 'pinorbit-v2-scheduling-admin',
      },
    },
  });
}

/**
 * Creates a server-only client for Project 2 (Competitors).
 * NEVER accessible or exposed to the browser.
 */
export function createCompetitorsClient(runtimeEnv?: Record<string, any>): SupabaseClient {
  const env = getServerEnv(runtimeEnv);
  const key = getRequiredSecretKey(env.COMPETITORS_SUPABASE_SECRET_KEY, 'Competitors', runtimeEnv);
  return createClient(env.COMPETITORS_SUPABASE_URL, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        'x-client-info': 'pinorbit-v2-competitors-server',
      },
    },
  });
}

/**
 * Creates a server-only client for Project 3 (Analytics).
 * NEVER accessible or exposed to the browser.
 */
export function createAnalyticsClient(runtimeEnv?: Record<string, any>): SupabaseClient {
  const env = getServerEnv(runtimeEnv);
  const key = getRequiredSecretKey(env.ANALYTICS_SUPABASE_SECRET_KEY, 'Analytics', runtimeEnv);
  return createClient(env.ANALYTICS_SUPABASE_URL, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        'x-client-info': 'pinorbit-v2-analytics-server',
      },
    },
  });
}

/**
 * Creates a server-only client for Project 4 (PinArchive).
 * NEVER accessible or exposed to the browser.
 */
export function createPinArchiveClient(runtimeEnv?: Record<string, any>): SupabaseClient {
  const env = getServerEnv(runtimeEnv);
  const key = getRequiredSecretKey(env.PINARCHIVE_SUPABASE_SECRET_KEY, 'PinArchive', runtimeEnv);
  return createClient(env.PINARCHIVE_SUPABASE_URL, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        'x-client-info': 'pinorbit-v2-pinarchive-server',
      },
    },
  });
}

// Singleton instances for persistent server-side connection pooling
let competitorsClientInstance: SupabaseClient | null = null;
let analyticsClientInstance: SupabaseClient | null = null;
let pinArchiveClientInstance: SupabaseClient | null = null;
let schedulingAdminClientInstance: SupabaseClient | null = null;

/**
 * Single Canonical Server Client Access Module for PinOrbit Greenfield Architecture.
 *
 * Rules:
 * 1. Project 1 (Scheduling) is the sole authority for identity, sessions, and workspaces.
 * 2. Projects 2 (Competitors), 3 (Analytics), and 4 (PinArchive) are server-only and require prior Project 1 authorization.
 * 3. Browser code never receives secrets or direct access to Projects 2, 3, and 4.
 */
export const dbClients = {
  /**
   * Returns a request-scoped client for Project 1 (Scheduling / Auth)
   * used in Astro SSR pages and API endpoints.
   */
  getSchedulingSSR(
    context: {
      cookies: {
        get: (key: string) => any;
        set: (key: string, value: string, options?: Record<string, unknown>) => void;
        delete: (key: string, options?: Record<string, unknown>) => void;
      };
    },
    runtimeEnv?: Record<string, any>
  ): SupabaseClient {
    return createSchedulingSSRClient(context, runtimeEnv);
  },

  /**
   * Returns the server-only administrative client for Project 1 (Scheduling).
   */
  getSchedulingAdmin(runtimeEnv?: Record<string, any>): SupabaseClient {
    if (!schedulingAdminClientInstance || runtimeEnv) {
      schedulingAdminClientInstance = createSchedulingAdminClient(runtimeEnv);
    }
    return schedulingAdminClientInstance;
  },

  /**
   * Returns the server-only client for Project 2 (Competitors).
   * MUST only be called after verifying workspace membership via Project 1.
   */
  getCompetitors(runtimeEnv?: Record<string, any>): SupabaseClient {
    if (!competitorsClientInstance || runtimeEnv) {
      competitorsClientInstance = createCompetitorsClient(runtimeEnv);
    }
    return competitorsClientInstance;
  },

  /**
   * Returns the server-only administrative client for Project 2 (Competitors).
   */
  getCompetitorsAdmin(runtimeEnv?: Record<string, any>): SupabaseClient {
    return this.getCompetitors(runtimeEnv);
  },

  /**
   * Returns the server-only client for Project 3 (Analytics).
   * MUST only be called after verifying workspace membership via Project 1.
   */
  getAnalytics(runtimeEnv?: Record<string, any>): SupabaseClient {
    if (!analyticsClientInstance || runtimeEnv) {
      analyticsClientInstance = createAnalyticsClient(runtimeEnv);
    }
    return analyticsClientInstance;
  },

  /**
   * Returns the server-only administrative client for Project 3 (Analytics).
   */
  getAnalyticsAdmin(runtimeEnv?: Record<string, any>): SupabaseClient {
    return this.getAnalytics(runtimeEnv);
  },

  /**
   * Returns the server-only client for Project 4 (PinArchive).
   * MUST only be called after verifying workspace membership via Project 1.
   */
  getPinArchive(runtimeEnv?: Record<string, any>): SupabaseClient {
    if (!pinArchiveClientInstance || runtimeEnv) {
      pinArchiveClientInstance = createPinArchiveClient(runtimeEnv);
    }
    return pinArchiveClientInstance;
  },

  /**
   * Helper to inspect environment configuration on the server.
   */
  getConfig(runtimeEnv?: Record<string, any>): ServerEnvConfig {
    return getServerEnv(runtimeEnv);
  },
};
