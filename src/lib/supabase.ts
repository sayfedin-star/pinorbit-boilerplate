import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient, createBrowserClient } from '@supabase/ssr';
import type { AstroCookies } from 'astro';
import type { Account, Board, Pin, Log, AuditLog, AccountWebhook, ImportSession, DashboardKPIs, AccountPinStats, AccountWebhookSummary, PinDeliveryLog } from './types';

function getSchedulingUrl(): string {
  // 1. Check SSR / Process environment variables
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.PUBLIC_SCHEDULING_SUPABASE_URL) return process.env.PUBLIC_SCHEDULING_SUPABASE_URL;
    if (process.env.SCHEDULING_SUPABASE_URL) return process.env.SCHEDULING_SUPABASE_URL;
  }
  // 2. Check explicit client-safe public variable
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PUBLIC_SCHEDULING_SUPABASE_URL) {
    return import.meta.env.PUBLIC_SCHEDULING_SUPABASE_URL;
  }
  return 'https://eygdoetdwqllvsxpvoex.supabase.co';
}

function getSchedulingPublishableKey(): string {
  // 1. Check SSR / Process environment variables
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.PUBLIC_SCHEDULING_SUPABASE_PUBLISHABLE_KEY) return process.env.PUBLIC_SCHEDULING_SUPABASE_PUBLISHABLE_KEY;
    if (process.env.SCHEDULING_SUPABASE_PUBLISHABLE_KEY) return process.env.SCHEDULING_SUPABASE_PUBLISHABLE_KEY;
  }
  // 2. Check explicit client-safe public variable
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PUBLIC_SCHEDULING_SUPABASE_PUBLISHABLE_KEY) {
    return import.meta.env.PUBLIC_SCHEDULING_SUPABASE_PUBLISHABLE_KEY;
  }
  return 'sb_publishable_efxKrwXCOaj9CM5oxD-WjA_jqvB5iGD';
}

export const supabaseUrl = getSchedulingUrl();
export const supabaseAnonKey = getSchedulingPublishableKey();

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
  supabaseAnonKey &&
  supabaseUrl !== 'https://your-project-id.supabase.co' &&
  supabaseUrl !== 'https://your-project-1.supabase.co'
);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? (typeof window !== 'undefined'
      ? createBrowserClient(supabaseUrl, supabaseAnonKey, {
          cookieOptions: {
            path: '/',
            sameSite: 'lax',
            secure: typeof window !== 'undefined' && window.location.protocol === 'https:',
          },
        })
      : createClient(supabaseUrl, supabaseAnonKey))
  : null;

/**
 * Creates a request-scoped Supabase server client for Astro SSR using official @supabase/ssr cookie adapter.
 */
export function createAstroServerClient(
  cookies?: AstroCookies,
  request?: Request,
  responseHeaders?: Headers | any
) {
  if (!isSupabaseConfigured || !supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        let rawHeader = '';
        if (request && request.headers && typeof request.headers.get === 'function') {
          rawHeader = request.headers.get('cookie') || '';
        } else if (cookies && (cookies as any).headers) {
          const h = (cookies as any).headers;
          if (typeof h.get === 'function') {
            rawHeader = h.get('cookie') || '';
          } else if (typeof h === 'string') {
            rawHeader = h;
          }
        }

        if (!rawHeader) return [];

        return rawHeader
          .split(';')
          .map((cookieStr) => {
            const parts = cookieStr.trim().split('=');
            if (parts.length < 2) return null;
            const name = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            return { name, value };
          })
          .filter((c): c is { name: string; value: string } => Boolean(c && c.name));
      },
      setAll(cookiesToSet, headersToSet) {
        // 1. Apply cookies
        if (cookies && typeof cookies.set === 'function') {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookies.set(name, value, options as any);
            });
          } catch (cErr) {
            if (import.meta.env.DEV) {
              console.debug('@supabase/ssr cookies.set suppressed in SSR path:', cErr);
            }
          }
        }

        // 2. Apply Cache-Control / Response headers passed by @supabase/ssr during token refresh
        if (headersToSet && responseHeaders && typeof responseHeaders.set === 'function') {
          try {
            if (typeof (headersToSet as any).forEach === 'function') {
              (headersToSet as any).forEach((val: string, key: string) => {
                responseHeaders.set(key, val);
              });
            } else if (Array.isArray(headersToSet)) {
              (headersToSet as any[]).forEach(({ name, value }: any) => {
                responseHeaders.set(name, value);
              });
            }
          } catch (hErr) {
            if (import.meta.env.DEV) {
              console.debug('@supabase/ssr responseHeaders.set suppressed in SSR path:', hErr);
            }
          }
        }
      },
    },
  });
}

// Client Session State Tracking for Accounts Schedule & Settings
export const editedAccountScheduleSession = new Map<string, Partial<Account>>();

// Mock Data used only as preview fallback when Supabase env is not configured
let mockAccounts: Account[] = [
  {
    id: 'acc-1',
    account_name: 'HealthyBites_US',
    webhook_url: 'https://hook.make.com/abc123healthy1',
    max_pins_per_day: 20,
    is_active: true,
    pinning_started_at: new Date(Date.now() - 86400000 * 15).toISOString(),
    posting_window_start: '09:00',
    posting_window_end: '21:00',
    timezone: 'America/New_York',
    created_at: new Date(Date.now() - 86400000 * 10).toISOString(),
    boards_count: 3,
    webhooks_count: 2,
    active_webhooks_count: 2,
    primary_webhook_label: 'Primary Hook',
  },
  {
    id: 'acc-2',
    account_name: 'DessertLovers_Global',
    webhook_url: 'https://hook.make.com/def456dessert2',
    max_pins_per_day: 15,
    is_active: true,
    pinning_started_at: new Date(Date.now() - 86400000 * 30).toISOString(),
    posting_window_start: '10:00',
    posting_window_end: '22:00',
    timezone: 'Europe/London',
    created_at: new Date(Date.now() - 86400000 * 7).toISOString(),
    boards_count: 2,
    webhooks_count: 1,
    active_webhooks_count: 1,
    primary_webhook_label: 'Primary',
  },
  {
    id: 'acc-3',
    account_name: 'KetoRecipes_Hub',
    webhook_url: 'https://hook.make.com/ghi789keto3',
    max_pins_per_day: 25,
    is_active: false,
    pinning_started_at: null,
    posting_window_start: '08:00',
    posting_window_end: '20:00',
    timezone: 'UTC',
    created_at: new Date(Date.now() - 86400000 * 4).toISOString(),
    boards_count: 4,
    webhooks_count: 1,
    active_webhooks_count: 0,
    primary_webhook_label: 'Backup Hook',
  },
];

let mockWebhooks: AccountWebhook[] = [
  {
    id: 'hook-1',
    account_id: 'acc-1',
    label: 'Primary Hook',
    webhook_url: 'https://hook.make.com/abc123healthy1',
    monthly_capacity: 500,
    monthly_usage: 45,
    remaining_capacity: 455,
    priority: 1,
    is_active: true,
    is_primary: true,
    last_used_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    last_failed_at: null,
    last_failure_reason: null,
    created_at: new Date(Date.now() - 86400000 * 10).toISOString(),
    updated_at: new Date(Date.now() - 86400000 * 10).toISOString(),
  },
  {
    id: 'hook-2',
    account_id: 'acc-1',
    label: 'Secondary Channel',
    webhook_url: 'https://hook.make.com/abc123healthy2',
    monthly_capacity: 500,
    monthly_usage: 0,
    remaining_capacity: 500,
    priority: 2,
    is_active: true,
    is_primary: false,
    last_used_at: null,
    last_failed_at: null,
    last_failure_reason: null,
    created_at: new Date(Date.now() - 86400000 * 5).toISOString(),
    updated_at: new Date(Date.now() - 86400000 * 5).toISOString(),
  },
  {
    id: 'hook-3',
    account_id: 'acc-2',
    label: 'Primary',
    webhook_url: 'https://hook.make.com/def456dessert2',
    monthly_capacity: 500,
    monthly_usage: 120,
    remaining_capacity: 380,
    priority: 1,
    is_active: true,
    is_primary: true,
    last_used_at: new Date(Date.now() - 3600000 * 5).toISOString(),
    last_failed_at: null,
    last_failure_reason: null,
    created_at: new Date(Date.now() - 86400000 * 7).toISOString(),
    updated_at: new Date(Date.now() - 86400000 * 7).toISOString(),
  },
];

let mockBoards: Board[] = [
  {
    id: 'board-1',
    account_id: 'acc-1',
    board_name: 'Quick Dinner Recipes',
    board_id: '1092837465',
    created_at: new Date(Date.now() - 86400000 * 9).toISOString(),
    account_name: 'HealthyBites_US',
  },
  {
    id: 'board-2',
    account_id: 'acc-1',
    board_name: 'Healthy Meal Prep',
    board_id: '1092837466',
    created_at: new Date(Date.now() - 86400000 * 9).toISOString(),
    account_name: 'HealthyBites_US',
  },
  {
    id: 'board-3',
    account_id: 'acc-2',
    board_name: 'Easy Chocolate Desserts',
    board_id: '2092837467',
    created_at: new Date(Date.now() - 86400000 * 6).toISOString(),
    account_name: 'DessertLovers_Global',
  },
];

let mockPins: Pin[] = [
  {
    id: 'pin-1',
    account_id: 'acc-1',
    title: '30-Minute Creamy Garlic Chicken',
    description: 'Easy and delicious one-pan creamy garlic chicken recipe perfect for busy weeknights.',
    image_url: 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=600&q=80',
    board_name: 'Quick Dinner Recipes',
    link: 'https://myrecipeblog.com/creamy-garlic-chicken',
    status: 'posted',
    source: 'google_sheets',
    posted_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    scheduled_for: null,
    created_at: new Date(Date.now() - 3600000 * 5).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 0,
    max_retries: 3,
  },
  {
    id: 'pin-2',
    account_id: 'acc-1',
    title: 'Keto Cauliflower Rice Bowl',
    description: 'Low carb cauliflower bowl with avocado, roasted chickpeas and tahini dressing.',
    image_url: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=600&q=80',
    board_name: 'Healthy Meal Prep',
    link: 'https://myrecipeblog.com/cauliflower-bowl',
    status: 'pending',
    source: 'google_sheets',
    posted_at: null,
    scheduled_for: new Date(Date.now() + 3600000 * 4).toISOString(),
    created_at: new Date(Date.now() - 3600000 * 3).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 0,
    max_retries: 3,
  },
  {
    id: 'pin-3',
    account_id: 'acc-1',
    title: 'Matcha Green Tea Smoothie Bowl',
    description: 'Antioxidant packed smoothie bowl with kiwi, chia seeds and coconut flakes.',
    image_url: 'https://images.unsplash.com/photo-1590301157890-4810ed352733?auto=format&fit=crop&w=600&q=80',
    board_name: 'Healthy Meal Prep',
    link: 'https://myrecipeblog.com/matcha-smoothie',
    status: 'pending',
    source: 'csv_upload',
    posted_at: null,
    scheduled_for: new Date(Date.now() + 3600000 * 1).toISOString(),
    created_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 1,
    max_retries: 3,
    next_retry_at: new Date(Date.now() + 3600000 * 0.25).toISOString(),
    last_failure_reason: 'Webhook dispatch timed out (504 Gateway Timeout)',
    last_attempt_at: new Date(Date.now() - 3600000 * 0.5).toISOString(),
    failure_type: 'transient',
  },
  {
    id: 'pin-4',
    account_id: 'acc-1',
    title: 'Avocado Toast with Poached Eggs',
    description: 'Crispy sourdough topped with smashed avocado, red pepper flakes and poached eggs.',
    image_url: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?auto=format&fit=crop&w=600&q=80',
    board_name: 'Breakfast & Brunch',
    link: 'https://myrecipeblog.com/avocado-toast',
    status: 'failed',
    source: 'google_sheets',
    posted_at: null,
    scheduled_for: null,
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 3,
    max_retries: 3,
    next_retry_at: null,
    last_failure_reason: 'HTTP 400 Bad Request: Invalid board ID provided',
    last_attempt_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    failure_type: 'permanent',
  },
  {
    id: 'pin-5',
    account_id: 'acc-1',
    title: 'Berry Protein Pancake Stack',
    description: 'Fluffy high-protein pancakes served with fresh blueberry syrup.',
    image_url: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?auto=format&fit=crop&w=600&q=80',
    board_name: 'Breakfast & Brunch',
    link: 'https://myrecipeblog.com/protein-pancakes',
    status: 'posted',
    source: 'google_sheets',
    posted_at: new Date(Date.now() - 3600000 * 18).toISOString(),
    scheduled_for: null,
    created_at: new Date(Date.now() - 3600000 * 30).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 0,
    max_retries: 3,
  },
];

let mockLogs: Log[] = [];
let mockAuditLogs: AuditLog[] = [];
let mockImportSessions: ImportSession[] = [];

interface RawAccount extends Account {
  boards?: { id: string }[];
  account_webhooks?: {
    id: string;
    label: string;
    is_active: boolean;
    is_primary: boolean;
  }[];
}

interface RawBoard extends Board {
  accounts?: { account_name: string } | null;
}

interface RawPin extends Pin {
  accounts?: { account_name: string } | null;
}

interface RawLog extends Log {
  accounts?: { account_name: string } | null;
  pins?: { title: string } | null;
  account_webhooks?: { label: string } | null;
}

const DEFAULT_WS_ID = '00000000-0000-0000-0000-000000000001';

/** Escapes special characters for LIKE/ILIKE patterns: %, _, and backslash. */
export function escapeLike(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function matchesWorkspace(entityWsId?: string, targetWsId?: string): boolean {
  if (!targetWsId) return true;
  const actualWs = entityWsId || DEFAULT_WS_ID;
  return actualWs === targetWsId;
}

// 1. Fetch Accounts with Webhook Summary
export async function getAccounts(workspaceId?: string): Promise<Account[]> {
  let list: Account[] = [];
  if (!supabase) {
    list = workspaceId ? mockAccounts.filter((a) => matchesWorkspace(a.workspace_id, workspaceId)) : mockAccounts;
  } else {
    try {
      let query = supabase
        .from('accounts')
        .select('*, boards(id), account_webhooks!account_webhooks_account_id_fkey(id, label, is_active, is_primary)')
        .order('created_at', { ascending: false });

      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }

      const { data, error } = await query;

      if (error) {
        let basicQuery = supabase
          .from('accounts')
          .select('*')
          .order('created_at', { ascending: false });

        if (workspaceId) {
          basicQuery = basicQuery.eq('workspace_id', workspaceId);
        }

        const { data: basicData } = await basicQuery;

        list = (basicData as Account[] || []).map((acc) => ({
          ...acc,
          boards_count: 0,
          webhooks_count: 0,
          active_webhooks_count: 0,
          primary_webhook_label: 'None',
        }));
      } else if (data) {
        list = (data as RawAccount[]).map((acc) => {
          const hooks = acc.account_webhooks || [];
          const primaryHook = hooks.find((h) => h.is_primary);

          return {
            ...acc,
            boards_count: acc.boards ? acc.boards.length : 0,
            webhooks_count: hooks.length,
            active_webhooks_count: hooks.filter((h) => h.is_active).length,
            primary_webhook_label: primaryHook ? primaryHook.label : 'None',
          };
        });
      }
    } catch (err) {
      console.warn('Supabase fetch accounts error, using fallback:', err);
      list = workspaceId ? mockAccounts.filter((a) => !a.workspace_id || a.workspace_id === workspaceId) : mockAccounts;
    }
  }

  return list.map((acc) => {
    if (editedAccountScheduleSession.has(acc.id)) {
      return { ...acc, ...editedAccountScheduleSession.get(acc.id) };
    }
    return acc;
  });
}

// 2. Fetch Account Webhooks
export async function getAccountWebhooks(accountId?: string, workspaceId?: string): Promise<AccountWebhook[]> {
  if (!supabase) {
    if (!accountId) return mockWebhooks;
    return mockWebhooks.filter((w) => w.account_id === accountId);
  }
  try {
    let query = supabase
      .from('account_webhooks')
      .select('*')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true });

    if (accountId) {
      query = query.eq('account_id', accountId);
    } else if (workspaceId) {
      // Find accounts for workspaceId
      const { data: accs } = await supabase.from('accounts').select('id').eq('workspace_id', workspaceId);
      if (accs && accs.length > 0) {
        const accIds = accs.map((a: any) => a.id);
        query = query.in('account_id', accIds);
      } else {
        return [];
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data as AccountWebhook[]) || [];
  } catch (err) {
    console.warn('Supabase fetch account_webhooks error, using fallback:', err);
    if (!accountId) return mockWebhooks;
    return mockWebhooks.filter((w) => w.account_id === accountId);
  }
}

// 3. Fetch Boards
export async function getBoards(workspaceId?: string): Promise<Board[]> {
  if (!supabase) {
    return workspaceId ? mockBoards.filter((b) => matchesWorkspace(b.workspace_id, workspaceId)) : mockBoards;
  }
  try {
    let query = supabase
      .from('boards')
      .select('*, accounts(account_name)')
      .order('created_at', { ascending: false });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    const { data, error } = await query;

    if (error) {
      let basicQuery = supabase
        .from('boards')
        .select('*')
        .order('created_at', { ascending: false });

      if (workspaceId) {
        basicQuery = basicQuery.eq('workspace_id', workspaceId);
      }

      const { data: basicData, error: basicErr } = await basicQuery;

      if (basicErr || !basicData) throw basicErr || new Error('No data');
      return basicData as Board[];
    }

    if (!data) return [];
    return (data as RawBoard[]).map((b) => ({
      ...b,
      account_name: b.accounts?.account_name || 'Account #' + b.account_id.slice(0, 6),
    }));
  } catch (err) {
    console.warn('Supabase fetch boards error, using fallback:', err);
    return workspaceId ? mockBoards.filter((b) => matchesWorkspace(b.workspace_id, workspaceId)) : mockBoards;
  }
}

// Fetch Boards for specific account
export async function getBoardsForAccount(accountId: string): Promise<Board[]> {
  if (!supabase) {
    return mockBoards.filter((b) => b.account_id === accountId);
  }
  try {
    const { data, error } = await supabase
      .from('boards')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as Board[]) || [];
  } catch (err) {
    console.warn('Supabase fetch boards for account error, using fallback:', err);
    return mockBoards.filter((b) => b.account_id === accountId);
  }
}

/**
 * Bulk fetch webhooks for a list of account IDs in a single query.
 * Returns a Map of accountId -> AccountWebhook[] for O(1) memory lookup.
 */
export async function getBulkAccountWebhooks(accountIds: string[]): Promise<Map<string, AccountWebhook[]>> {
  const map = new Map<string, AccountWebhook[]>();
  if (!accountIds || accountIds.length === 0) return map;

  if (!supabase) {
    mockWebhooks.forEach((w) => {
      if (accountIds.includes(w.account_id)) {
        const list = map.get(w.account_id) || [];
        list.push(w);
        map.set(w.account_id, list);
      }
    });
    return map;
  }

  try {
    const { data, error } = await supabase
      .from('account_webhooks')
      .select('*')
      .in('account_id', accountIds)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true });

    if (error || !data) return map;

    (data as AccountWebhook[]).forEach((w) => {
      const list = map.get(w.account_id) || [];
      list.push(w);
      map.set(w.account_id, list);
    });
    return map;
  } catch (err) {
    console.warn('Supabase getBulkAccountWebhooks error:', err);
    return map;
  }
}

/**
 * Bulk fetch boards for a list of account IDs in a single query.
 * Returns a Map of accountId -> Board[] for O(1) memory lookup.
 */
export async function getBulkAccountBoards(accountIds: string[]): Promise<Map<string, Board[]>> {
  const map = new Map<string, Board[]>();
  if (!accountIds || accountIds.length === 0) return map;

  if (!supabase) {
    mockBoards.forEach((b) => {
      if (accountIds.includes(b.account_id)) {
        const list = map.get(b.account_id) || [];
        list.push(b);
        map.set(b.account_id, list);
      }
    });
    return map;
  }

  try {
    const { data, error } = await supabase
      .from('boards')
      .select('*, accounts(account_name)')
      .in('account_id', accountIds)
      .order('created_at', { ascending: false });

    if (error || !data) return map;

    (data as RawBoard[]).forEach((raw) => {
      const b: Board = {
        ...raw,
        account_name: raw.accounts?.account_name || 'Account #' + raw.account_id.slice(0, 6),
      };
      const list = map.get(b.account_id) || [];
      list.push(b);
      map.set(b.account_id, list);
    });
    return map;
  } catch (err) {
    console.warn('Supabase fetch boards error, using fallback:', err);
    return map;
  }
}

// 4. Fetch Pins
export async function getPins(statusFilter?: string, accountIdFilter?: string, workspaceId?: string): Promise<Pin[]> {
  if (!supabase) {
    let pins = mockPins;
    if (workspaceId) {
      pins = pins.filter((p) => matchesWorkspace(p.workspace_id, workspaceId));
    }
    if (statusFilter && statusFilter !== 'all') {
      pins = pins.filter((p) => p.status === statusFilter);
    }
    if (accountIdFilter && accountIdFilter !== 'all') {
      pins = pins.filter((p) => p.account_id === accountIdFilter);
    }
    return pins;
  }
  try {
    let query = supabase
      .from('pins')
      .select('*, accounts(account_name)')
      .order('created_at', { ascending: false });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }
    if (statusFilter && statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }
    if (accountIdFilter && accountIdFilter !== 'all') {
      query = query.eq('account_id', accountIdFilter);
    }

    const { data, error } = await query;
    if (error) {
      let basicQuery = supabase.from('pins').select('*').order('created_at', { ascending: false });
      if (workspaceId) {
        basicQuery = basicQuery.eq('workspace_id', workspaceId);
      }
      if (statusFilter && statusFilter !== 'all') {
        basicQuery = basicQuery.eq('status', statusFilter);
      }
      if (accountIdFilter && accountIdFilter !== 'all') {
        basicQuery = basicQuery.eq('account_id', accountIdFilter);
      }
      const { data: basicData, error: basicErr } = await basicQuery;
      if (basicErr || !basicData) throw basicErr || new Error('No data');
      return basicData as Pin[];
    }

    if (!data) return [];
    return (data as RawPin[]).map((p) => ({
      ...p,
      account_name: p.accounts?.account_name || (p.account_id ? 'Account #' + p.account_id.slice(0, 6) : 'Unassigned'),
    }));
  } catch (err) {
    console.warn('Supabase fetch pins error, using fallback:', err);
    let pins = mockPins;
    if (workspaceId) {
      pins = pins.filter((p) => matchesWorkspace(p.workspace_id, workspaceId));
    }
    if (statusFilter && statusFilter !== 'all') {
      pins = pins.filter((p) => p.status === statusFilter);
    }
    if (accountIdFilter && accountIdFilter !== 'all') {
      pins = pins.filter((p) => p.account_id === accountIdFilter);
    }
    return pins;
  }
}

// 5. Fetch Logs
export async function getLogs(limit = 50, workspaceId?: string): Promise<Log[]> {
  if (!supabase) return mockLogs.slice(0, limit);
  try {
    let query = supabase
      .from('logs')
      .select('*, accounts(account_name), pins(title), account_webhooks(label)')
      .order('created_at', { ascending: false });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    query = query.limit(limit);

    const { data, error } = await query;

    if (error) {
      let basicQuery = supabase
        .from('logs')
        .select('*')
        .order('created_at', { ascending: false });

      if (workspaceId) {
        basicQuery = basicQuery.eq('workspace_id', workspaceId);
      }

      basicQuery = basicQuery.limit(limit);

      const { data: basicData, error: basicErr } = await basicQuery;

      if (basicErr || !basicData) throw basicErr || new Error('No data');
      return basicData as Log[];
    }

    if (!data) return [];
    return (data as RawLog[]).map((l) => ({
      ...l,
      account_name: l.accounts?.account_name || (l.account_id ? 'Account #' + l.account_id.slice(0, 6) : 'System'),
      pin_title: l.pins?.title || 'System Operation',
      webhook_label: l.account_webhooks?.label || 'Default Webhook',
    }));
  } catch (err) {
    console.warn('Supabase fetch logs error, using fallback:', err);
    return mockLogs.slice(0, limit);
  }
}

// 5b. Fetch Pin Delivery Logs (Typed Read Helper for pin_delivery_logs table)
export async function getPinDeliveryLogs(limit = 50, pinId?: string, workspaceId?: string): Promise<PinDeliveryLog[]> {
  if (!supabase) return [];
  try {
    let query = supabase
      .from('pin_delivery_logs')
      .select('*, pins(title, account_id, accounts(account_name))')
      .order('created_at', { ascending: false });

    if (pinId) {
      query = query.eq('pin_id', pinId);
    }

    query = query.limit(limit);

    const { data, error } = await query;

    if (error) {
      // Fallback simple query if joins fail
      let basicQuery = supabase
        .from('pin_delivery_logs')
        .select('*')
        .order('created_at', { ascending: false });

      if (pinId) {
        basicQuery = basicQuery.eq('pin_id', pinId);
      }

      basicQuery = basicQuery.limit(limit);

      const { data: basicData, error: basicErr } = await basicQuery;
      if (basicErr || !basicData) throw basicErr || new Error('No delivery log data');
      return basicData as PinDeliveryLog[];
    }

    if (!data) return [];
    return data.map((item: any) => ({
      id: item.id,
      pin_id: item.pin_id,
      attempt_no: item.attempt_no,
      event_type: item.event_type,
      provider: item.provider,
      http_status: item.http_status,
      error_code: item.error_code,
      error_message: item.error_message,
      response_excerpt: item.response_excerpt,
      metadata: item.metadata,
      created_at: item.created_at,
      pin_title: item.pins?.title || 'Pin #' + item.pin_id.slice(0, 8),
      account_name: item.pins?.accounts?.account_name || 'System Account',
    }));
  } catch (err) {
    console.warn('Supabase fetch pin delivery logs error:', err);
    return [];
  }
}

// 6. Fetch Audit Logs
export async function getAuditLogs(limit = 100): Promise<AuditLog[]> {
  if (!supabase) return mockAuditLogs.slice(0, limit);
  try {
    const { data, error } = await supabase
      .from('audit_log')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data as AuditLog[]) || [];
  } catch (err) {
    console.warn('Supabase fetch audit logs error, using fallback:', err);
    return mockAuditLogs.slice(0, limit);
  }
}

// 7. Fetch Import Sessions History
export async function getImportSessions(limit = 10, workspaceId?: string): Promise<ImportSession[]> {
  if (!supabase) return mockImportSessions.slice(0, limit);
  try {
    let query = supabase
      .from('import_sessions')
      .select('*, accounts(account_name)')
      .order('created_at', { ascending: false });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    query = query.limit(limit);

    const { data, error } = await query;

    if (error) throw error;
    return (data as any[]).map((s) => ({
      ...s,
      account_name: s.accounts?.account_name || 'Account #' + s.account_id.slice(0, 6),
    }));
  } catch (err) {
    console.warn('Supabase fetch import_sessions error, using fallback:', err);
    return mockImportSessions.slice(0, limit);
  }
}

// 8. Fetch Dashboard KPIs
export async function getDashboardKPIs(workspaceId?: string): Promise<DashboardKPIs> {
  const [accounts, webhooks, pins, logs] = await Promise.all([
    getAccounts(workspaceId),
    getAccountWebhooks(undefined, workspaceId),
    getPins('all', undefined, workspaceId),
    getLogs(100, workspaceId),
  ]);

  return {
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter((a) => a.is_active).length,
    pendingPins: pins.filter((p) => p.status === 'pending' || p.status === 'processing').length,
    postedPins: pins.filter((p) => p.status === 'posted').length,
    failedPins: pins.filter((p) => p.status === 'failed').length,
    totalLogs: logs.length,
    totalWebhooks: webhooks.length,
    activeWebhooks: webhooks.filter((w) => w.is_active).length,
    exhaustedWebhooks: webhooks.filter((w) => w.remaining_capacity <= 0).length,
  };
}

// 9. Admin Mutations & Webhook Operations

export async function createAccount(payload: {
  account_name: string;
  webhook_url: string;
  max_pins_per_day: number;
  posting_interval_minutes?: number;
  is_active?: boolean;
  workspace_id?: string;
}): Promise<{ data: Account | null; error: string | null }> {
  const targetWsId = payload.workspace_id || '00000000-0000-0000-0000-000000000001';

  if (!supabase) {
    const newAcc: Account = {
      id: 'acc-' + Date.now(),
      workspace_id: targetWsId,
      account_name: payload.account_name,
      webhook_url: payload.webhook_url,
      max_pins_per_day: payload.max_pins_per_day,
      posting_interval_minutes: payload.posting_interval_minutes ?? 30,
      is_active: payload.is_active ?? true,
      created_at: new Date().toISOString(),
      boards_count: 0,
      webhooks_count: 1,
      active_webhooks_count: 1,
      primary_webhook_label: 'Primary',
    };
    mockAccounts.unshift(newAcc);
    return { data: newAcc, error: null };
  }

  const { data, error } = await supabase
    .from('accounts')
    .insert({
      workspace_id: targetWsId,
      account_name: payload.account_name,
      webhook_url: payload.webhook_url,
      max_pins_per_day: payload.max_pins_per_day,
      posting_interval_minutes: payload.posting_interval_minutes ?? 30,
      is_active: payload.is_active ?? true,
    })
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message };
  }

  if (data) {
    await supabase.from('account_webhooks').insert({
      account_id: data.id,
      label: 'Primary',
      webhook_url: payload.webhook_url,
      monthly_capacity: 500,
      monthly_usage: 0,
      priority: 1,
      is_active: payload.is_active ?? true,
      is_primary: true,
    });
  }

  return { data: data as Account, error: null };
}

export async function updateAccountDailyLimit(
  id: string,
  max_pins_per_day: number
): Promise<{ data: Account | null; error: string | null; success: boolean }> {
  if (!supabase) {
    const target = mockAccounts.find((a) => a.id === id);
    if (target) {
      target.max_pins_per_day = max_pins_per_day;
      return { data: target, error: null, success: true };
    }
    return { data: null, error: 'Account not found', success: false };
  }

  const { data, error } = await supabase
    .from('accounts')
    .update({ max_pins_per_day })
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message, success: false };
  }
  return { data: data as Account, error: null, success: true };
}

export async function toggleAccountActive(
  id: string,
  is_active: boolean
): Promise<{ data: Account | null; error: string | null; success: boolean }> {
  if (!supabase) {
    const target = mockAccounts.find((a) => a.id === id);
    if (target) {
      target.is_active = is_active;
      return { data: target, error: null, success: true };
    }
    return { data: null, error: 'Account not found', success: false };
  }

  const { data, error } = await supabase
    .from('accounts')
    .update({ is_active })
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message, success: false };
  }
  return { data: data as Account, error: null, success: true };
}

export async function createBoard(payload: {
  account_id: string;
  board_name: string;
  board_id: string;
}): Promise<{ data: Board | null; error: string | null }> {
  if (!supabase) {
    const acc = mockAccounts.find((a) => a.id === payload.account_id);
    const newBoard: Board = {
      id: 'board-' + Date.now(),
      account_id: payload.account_id,
      board_name: payload.board_name,
      board_id: payload.board_id,
      created_at: new Date().toISOString(),
      account_name: acc?.account_name || 'Account',
    };
    mockBoards.unshift(newBoard);
    if (acc) {
      acc.boards_count = (acc.boards_count || 0) + 1;
    }
    return { data: newBoard, error: null };
  }

  const { data, error } = await supabase
    .from('boards')
    .insert({
      account_id: payload.account_id,
      board_name: payload.board_name,
      board_id: payload.board_id,
    })
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message };
  }
  return { data: data as Board, error: null };
}

export async function updateBoard(
  id: string,
  payload: {
    board_name: string;
    board_id: string;
    account_id?: string;
  }
): Promise<{ data: Board | null; error: string | null }> {
  if (!supabase) {
    const target = mockBoards.find((b) => b.id === id);
    if (target) {
      target.board_name = payload.board_name;
      target.board_id = payload.board_id;
      if (payload.account_id) {
        target.account_id = payload.account_id;
        const acc = mockAccounts.find((a) => a.id === payload.account_id);
        if (acc) target.account_name = acc.account_name;
      }
      return { data: target, error: null };
    }
    return { data: null, error: 'Board not found' };
  }

  const updateData: { board_name: string; board_id: string; account_id?: string } = {
    board_name: payload.board_name,
    board_id: payload.board_id,
  };
  if (payload.account_id) {
    updateData.account_id = payload.account_id;
  }

  const { data, error } = await supabase
    .from('boards')
    .update(updateData)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message };
  }
  return { data: data as Board, error: null };
}

export async function createAccountWebhook(payload: {
  account_id: string;
  label: string;
  webhook_url: string;
  monthly_capacity?: number;
  priority?: number;
  is_active?: boolean;
  is_primary?: boolean;
}): Promise<{ data: AccountWebhook | null; error: string | null }> {
  if (!supabase) {
    if (payload.is_primary) {
      mockWebhooks.forEach((w) => {
        if (w.account_id === payload.account_id) w.is_primary = false;
      });
    }

    const cap = payload.monthly_capacity ?? 500;
    const newHook: AccountWebhook = {
      id: 'hook-' + Date.now(),
      account_id: payload.account_id,
      label: payload.label,
      webhook_url: payload.webhook_url,
      monthly_capacity: cap,
      monthly_usage: 0,
      remaining_capacity: cap,
      priority: payload.priority ?? 1,
      is_active: payload.is_active ?? true,
      is_primary: payload.is_primary ?? false,
      last_used_at: null,
      last_failed_at: null,
      last_failure_reason: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockWebhooks.unshift(newHook);
    return { data: newHook, error: null };
  }

  try {
    if (payload.is_primary) {
      await supabase
        .from('account_webhooks')
        .update({ is_primary: false })
        .eq('account_id', payload.account_id);
    }

    const { data, error } = await supabase
      .from('account_webhooks')
      .insert({
        account_id: payload.account_id,
        label: payload.label,
        webhook_url: payload.webhook_url,
        monthly_capacity: payload.monthly_capacity ?? 500,
        priority: payload.priority ?? 1,
        is_active: payload.is_active ?? true,
        is_primary: payload.is_primary ?? false,
      })
      .select('*')
      .single();

    if (error) return { data: null, error: error.message };
    return { data: data as AccountWebhook, error: null };
  } catch (err: any) {
    return { data: null, error: err.message || 'Error creating webhook' };
  }
}

export async function updateAccountWebhook(
  id: string,
  payload: Partial<{
    label: string;
    webhook_url: string;
    monthly_capacity: number;
    monthly_usage: number;
    priority: number;
    is_active: boolean;
    is_primary: boolean;
    last_failure_reason: string | null;
  }>
): Promise<{ data: AccountWebhook | null; error: string | null }> {
  if (!supabase) {
    const target = mockWebhooks.find((w) => w.id === id);
    if (target) {
      if (payload.is_primary) {
        mockWebhooks.forEach((w) => {
          if (w.account_id === target.account_id) w.is_primary = false;
        });
      }
      Object.assign(target, payload);
      target.remaining_capacity = target.monthly_capacity - target.monthly_usage;
      target.updated_at = new Date().toISOString();
      return { data: target, error: null };
    }
    return { data: null, error: 'Webhook not found' };
  }

  try {
    if (payload.is_primary) {
      const { data: targetHook } = await supabase
        .from('account_webhooks')
        .select('account_id')
        .eq('id', id)
        .single();

      if (targetHook) {
        await supabase
          .from('account_webhooks')
          .update({ is_primary: false })
          .eq('account_id', targetHook.account_id);
      }
    }

    const { data, error } = await supabase
      .from('account_webhooks')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return { data: null, error: error.message };
    return { data: data as AccountWebhook, error: null };
  } catch (err: any) {
    return { data: null, error: err.message || 'Error updating webhook' };
  }
}

export async function setPrimaryWebhook(
  id: string,
  accountId: string
): Promise<{ success: boolean; error: string | null }> {
  if (!supabase) {
    mockWebhooks.forEach((w) => {
      if (w.account_id === accountId) {
        w.is_primary = w.id === id;
      }
    });
    return { success: true, error: null };
  }

  try {
    await supabase
      .from('account_webhooks')
      .update({ is_primary: false })
      .eq('account_id', accountId);

    const { error } = await supabase
      .from('account_webhooks')
      .update({ is_primary: true })
      .eq('id', id);

    if (error) return { success: false, error: error.message };
    return { success: true, error: null };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed setting primary webhook' };
  }
}

export async function toggleAccountWebhookActive(
  id: string,
  is_active: boolean
): Promise<{ data: AccountWebhook | null; error: string | null }> {
  return updateAccountWebhook(id, { is_active });
}

export async function deleteAccountWebhook(
  id: string,
  workspaceId?: string
): Promise<{ success: boolean; error: string | null }> {
  if (!supabase) {
    mockWebhooks = mockWebhooks.filter((w) => w.id !== id);
    return { success: true, error: null };
  }
  try {
    let query = supabase.from('account_webhooks').delete().eq('id', id);
    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }
    const { error } = await query;
    if (error) return { success: false, error: error.message };
    return { success: true, error: null };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to delete webhook' };
  }
}

// 10. Importer Bulk Pin Operations

export async function bulkInsertPins(
  pins: Partial<Pin>[],
  sessionMeta?: {
    account_id: string;
    source_type: string;
    source_label?: string;
    total_rows: number;
    valid_rows: number;
    invalid_rows: number;
  }
): Promise<{ count: number; error: string | null }> {
  if (!pins || pins.length === 0) {
    return { count: 0, error: null };
  }

  if (!supabase) {
    pins.forEach((p, idx) => {
      const newPin: Pin = {
        id: 'pin-imp-' + Date.now() + '-' + idx,
        account_id: p.account_id || 'acc-1',
        title: p.title || 'Untitled Pin',
        description: p.description || null,
        image_url: p.image_url || '',
        board_name: p.board_name || null,
        link: p.link || null,
        status: 'pending',
        source: p.source || 'csv_import',
        posted_at: null,
        scheduled_for: p.scheduled_for || null,
        created_at: new Date().toISOString(),
        account_name: 'Imported Account',
      };
      mockPins.unshift(newPin);
    });

    if (sessionMeta) {
      mockImportSessions.unshift({
        id: 'session-' + Date.now(),
        account_id: sessionMeta.account_id,
        source_type: sessionMeta.source_type,
        source_label: sessionMeta.source_label || null,
        total_rows: sessionMeta.total_rows,
        valid_rows: sessionMeta.valid_rows,
        invalid_rows: sessionMeta.invalid_rows,
        imported_rows: pins.length,
        created_at: new Date().toISOString(),
      });
    }

    return { count: pins.length, error: null };
  }

  try {
    const chunkSize = 50;
    let totalInserted = 0;

    for (let i = 0; i < pins.length; i += chunkSize) {
      const chunk = pins.slice(i, i + chunkSize);
      const { data, error } = await supabase
        .from('pins')
        .insert(chunk)
        .select('id');

      if (error) {
        return { count: totalInserted, error: error.message };
      }
      totalInserted += (data ? data.length : chunk.length);
    }

    // Log import session if metadata provided
    if (sessionMeta) {
      const { data: userRes } = await supabase.auth.getUser();
      await supabase.from('import_sessions').insert({
        account_id: sessionMeta.account_id,
        source_type: sessionMeta.source_type,
        source_label: sessionMeta.source_label || null,
        total_rows: sessionMeta.total_rows,
        valid_rows: sessionMeta.valid_rows,
        invalid_rows: sessionMeta.invalid_rows,
        imported_rows: totalInserted,
        created_by: userRes?.user ? userRes.user.id : null,
      });

      // Auto-trigger pacing engine for the account
      try {
        await supabase.rpc('reschedule_account_pending_pins', {
          target_account_id: sessionMeta.account_id,
        });
      } catch (e) {
        console.warn('RPC reschedule_account_pending_pins notice:', e);
      }
    }

    return { count: totalInserted, error: null };
  } catch (err: any) {
    return { count: 0, error: err.message || 'Bulk insert failed' };
  }
}

// 17. Fetch Single Account Details
export async function getAccountDetails(accountId: string): Promise<Account | null> {
  let resultAcc: Account | null = null;

  if (!supabase) {
    const acc = mockAccounts.find((a) => a.id === accountId);
    if (!acc) return null;
    const hooks = mockWebhooks.filter((w) => w.account_id === accountId);
    const primaryHook = hooks.find((h) => h.is_primary);
    const boards = mockBoards.filter((b) => b.account_id === accountId);
    const postedPins = mockPins.filter((p) => p.account_id === accountId && p.status === 'posted' && p.posted_at);
    const lastPublished = postedPins.length > 0
      ? [...postedPins].sort((a, b) => new Date(b.posted_at!).getTime() - new Date(a.posted_at!).getTime())[0].posted_at
      : null;

    resultAcc = {
      ...acc,
      board_webhook_id: acc.board_webhook_id || null,
      boards_count: boards.length,
      webhooks_count: hooks.length,
      active_webhooks_count: hooks.filter((h) => h.is_active).length,
      primary_webhook_label: primaryHook ? primaryHook.label : 'None',
      last_published_at: lastPublished || null,
    };
  } else {
    try {
      // 1. Attempt rich select with explicit foreign key disambiguation
      let raw: any = null;
      let hooks: any[] = [];
      let isFallback = false;

      const { data: accData, error: accError } = await supabase
        .from('accounts')
        .select('*, boards(id), account_webhooks!account_webhooks_account_id_fkey(id, label, is_active, is_primary)')
        .eq('id', accountId)
        .maybeSingle();

      if (accError || !accData) {
        if (accError) {
          console.warn(`Supabase getAccountDetails rich query failed for ${accountId}, attempting fallback:`, accError);
        }
        // Fallback: plain select without embedded relations to guarantee resilience
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('accounts')
          .select('*')
          .eq('id', accountId)
          .maybeSingle();

        if (fallbackError) {
          console.error(`Supabase getAccountDetails fallback error for ${accountId}:`, fallbackError);
          throw new Error(fallbackError.message || 'Database error fetching account');
        }

        if (!fallbackData) {
          return null;
        }

        raw = fallbackData;
        isFallback = true;
      } else {
        raw = accData;
        hooks = raw.account_webhooks || [];
      }

      // If fallback was invoked or relation arrays were absent, compute/fetch related counts
      let boardsCount = raw.boards ? raw.boards.length : 0;
      let webhooksCount = hooks.length;
      let activeWebhooksCount = hooks.filter((h: any) => h.is_active).length;
      const primaryHook = hooks.find((h: any) => h.is_primary);
      let primaryWebhookLabel = primaryHook ? primaryHook.label : (raw.primary_webhook_label || 'None');

      if (isFallback || !raw.boards) {
        try {
          const { count: bCount } = await supabase
            .from('boards')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', accountId);
          boardsCount = bCount || 0;
        } catch {}
      }

      if (isFallback || hooks.length === 0) {
        try {
          const { data: whList } = await supabase
            .from('account_webhooks')
            .select('id, label, is_active, is_primary')
            .eq('account_id', accountId);
          if (whList && whList.length > 0) {
            webhooksCount = whList.length;
            activeWebhooksCount = whList.filter((h: any) => h.is_active).length;
            const p = whList.find((h: any) => h.is_primary);
            primaryWebhookLabel = p ? p.label : (whList[0]?.label || 'None');
          }
        } catch {}
      }

      let lastPublishedAt: string | null = null;
      try {
        const { data: lastPin } = await supabase
          .from('pins')
          .select('posted_at')
          .eq('account_id', accountId)
          .eq('status', 'posted')
          .not('posted_at', 'is', null)
          .order('posted_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        lastPublishedAt = lastPin ? lastPin.posted_at : null;
      } catch {}

      resultAcc = {
        ...raw,
        board_webhook_id: raw.board_webhook_id || null,
        boards_count: boardsCount,
        webhooks_count: webhooksCount,
        active_webhooks_count: activeWebhooksCount,
        primary_webhook_label: primaryWebhookLabel,
        last_published_at: lastPublishedAt,
      };
    } catch (err: any) {
      console.error(`Supabase getAccountDetails error for ${accountId}:`, err);
      throw err;
    }
  }

  // Merge active session edits if any
  if (resultAcc && editedAccountScheduleSession.has(accountId)) {
    resultAcc = {
      ...resultAcc,
      ...editedAccountScheduleSession.get(accountId),
    };
  }

  return resultAcc;
}

// 18. Fetch Account Pin Stats (Derived metrics)
// ⚡ Bolt Optimization: Parallelize pins count query and account max_pins_per_day query using Promise.all()
// Impact: Reduces sequential network latency by ~50% (from 2 Sequential DB Roundtrips -> 1 Parallel Batch)
function getMockAccountPinStats(accountId: string): AccountPinStats {
  const accPins = mockPins.filter((p) => p.account_id === accountId);
  const total = accPins.length;
  const retrying = accPins.filter((p) => p.status === 'pending' && (p.retry_count || 0) > 0).length;
  const pending = accPins.filter((p) => (p.status === 'pending' && (!p.retry_count || p.retry_count === 0)) || p.status === 'processing').length;
  const posted = accPins.filter((p) => p.status === 'posted').length;
  const failed = accPins.filter((p) => p.status === 'failed').length;

  const acc = mockAccounts.find((a) => a.id === accountId);
  const maxDaily = acc ? acc.max_pins_per_day : 20;

  const todayStr = new Date().toISOString().slice(0, 10);
  const postedToday = accPins.filter(
    (p) => p.status === 'posted' && p.posted_at && p.posted_at.startsWith(todayStr)
  ).length;

  const remainingToday = Math.max(0, maxDaily - postedToday);

  return { total, pending, posted, failed, retrying, remainingToday };
}

export async function getAccountPinStats(accountId: string): Promise<AccountPinStats> {
  if (!supabase) {
    return getMockAccountPinStats(accountId);
  }

  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [
      totalRes,
      pendingRes,
      retryingRes,
      postedRes,
      failedRes,
      accRes,
      todayPostedRes,
    ] = await Promise.all([
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).in('status', ['pending', 'processing']),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'pending').gt('retry_count', 0),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'posted'),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'failed'),
      supabase.from('accounts').select('max_pins_per_day').eq('id', accountId).maybeSingle(),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'posted').gte('posted_at', todayStart.toISOString()),
    ]);

    const total = totalRes.count ?? 0;
    const pending = pendingRes.count ?? 0;
    const retrying = retryingRes.count ?? 0;
    const posted = postedRes.count ?? 0;
    const failed = failedRes.count ?? 0;

    const maxDaily = accRes.data ? accRes.data.max_pins_per_day : 20;
    const postedToday = todayPostedRes.count ?? 0;
    const remainingToday = Math.max(0, maxDaily - postedToday);

    return { total, pending, posted, failed, retrying, remainingToday };
  } catch (err) {
    console.warn(`Supabase getAccountPinStats error for ${accountId}:`, err);
    return getMockAccountPinStats(accountId);
  }
}

/**
 * Bulk fetch pin statistics for multiple accounts in a single aggregated DB roundtrip.
 */
export async function getBulkAccountPinStats(accountIds: string[]): Promise<Record<string, AccountPinStats>> {
  const result: Record<string, AccountPinStats> = {};
  if (!accountIds || accountIds.length === 0) return result;

  accountIds.forEach((id) => {
    result[id] = { total: 0, pending: 0, posted: 0, failed: 0, retrying: 0, remainingToday: 20 };
  });

  if (!supabase) {
    accountIds.forEach((id) => {
      result[id] = getMockAccountPinStats(id);
    });
    return result;
  }

  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStr = todayStart.toISOString();

    const [pinsRes, accsRes] = await Promise.all([
      supabase.from('pins').select('id, account_id, status, retry_count, posted_at').in('account_id', accountIds),
      supabase.from('accounts').select('id, max_pins_per_day').in('id', accountIds),
    ]);

    const maxDailyMap = new Map((accsRes.data || []).map((a) => [a.id, a.max_pins_per_day || 20]));

    accountIds.forEach((id) => {
      result[id].remainingToday = maxDailyMap.get(id) || 20;
    });

    if (pinsRes.error || !pinsRes.data) return result;

    const postedTodayMap = new Map<string, number>();

    for (const pin of pinsRes.data) {
      const stats = result[pin.account_id];
      if (!stats) continue;

      stats.total++;
      if (pin.status === 'pending' || pin.status === 'processing') {
        if ((pin.retry_count || 0) > 0) {
          stats.retrying++;
        } else {
          stats.pending++;
        }
      } else if (pin.status === 'posted') {
        stats.posted++;
        if (pin.posted_at && pin.posted_at >= todayStr) {
          const count = (postedTodayMap.get(pin.account_id) || 0) + 1;
          postedTodayMap.set(pin.account_id, count);
        }
      } else if (pin.status === 'failed') {
        stats.failed++;
      }
    }

    accountIds.forEach((id) => {
      const maxDaily = maxDailyMap.get(id) || 20;
      const postedToday = postedTodayMap.get(id) || 0;
      result[id].remainingToday = Math.max(0, maxDaily - postedToday);
    });

    return result;
  } catch (err) {
    console.warn('Supabase getBulkAccountPinStats error:', err);
    accountIds.forEach((id) => {
      result[id] = getMockAccountPinStats(id);
    });
    return result;
  }
}

// 19. Fetch Account Recent Pins
export async function getAccountRecentPins(accountId: string, limit = 10): Promise<Pin[]> {
  if (!supabase) {
    return mockPins.filter((p) => p.account_id === accountId).slice(0, limit);
  }

  try {
    const { data, error } = await supabase
      .from('pins')
      .select('*, accounts(account_name)')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return (data as RawPin[]).map((p) => ({
      ...p,
      account_name: p.accounts ? p.accounts.account_name : undefined,
    }));
  } catch (err) {
    console.warn(`Supabase getAccountRecentPins error for ${accountId}:`, err);
    return mockPins.filter((p) => p.account_id === accountId).slice(0, limit);
  }
}

// 20. Fetch Account Recent Logs
export async function getAccountRecentLogs(accountId: string, limit = 10): Promise<Log[]> {
  if (!supabase) {
    return mockLogs.filter((l) => l.account_id === accountId).slice(0, limit);
  }

  try {
    const { data, error } = await supabase
      .from('logs')
      .select('*, accounts(account_name), pins(title), account_webhooks(label)')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return (data as RawLog[]).map((l) => ({
      ...l,
      account_name: l.accounts ? l.accounts.account_name : undefined,
      pin_title: l.pins ? l.pins.title : undefined,
      webhook_label: l.account_webhooks ? l.account_webhooks.label : undefined,
    }));
  } catch (err) {
    console.warn(`Supabase getAccountRecentLogs error for ${accountId}:`, err);
    return mockLogs.filter((l) => l.account_id === accountId).slice(0, limit);
  }
}

// 21. Fetch Account Webhook Summary
export async function getAccountWebhookSummary(accountId: string): Promise<AccountWebhookSummary> {
  const webhooks = await getAccountWebhooks(accountId);
  const totalWebhooks = webhooks.length;
  const activeWebhooks = webhooks.filter((w) => w.is_active).length;
  const primaryHook = webhooks.find((w) => w.is_primary);
  const primaryWebhookLabel = primaryHook ? primaryHook.label : 'None';
  const totalRemainingCapacity = webhooks
    .filter((w) => w.is_active)
    .reduce((sum, w) => sum + (w.remaining_capacity || 0), 0);

  return {
    totalWebhooks,
    activeWebhooks,
    primaryWebhookLabel,
    totalRemainingCapacity,
  };
}

// 22. Update Account Scheduling Information
export async function updateAccountSchedule(
  accountId: string,
  data: {
    posting_window_start?: string | null;
    posting_window_end?: string | null;
    posting_interval_minutes?: number | null;
    random_delay_minutes?: number | null;
    timezone?: string;
    pinning_started_at?: string | null;
    active_days?: string[] | string;
  }
): Promise<{ data: Partial<Account> | null; error: string | null; success: boolean }> {
  // Always record edits in client session state map
  const existingSession = editedAccountScheduleSession.get(accountId) || {};
  const mergedSession = { ...existingSession, ...data };
  editedAccountScheduleSession.set(accountId, mergedSession);

  // Always update mock data fallback
  const mockAcc = mockAccounts.find((a) => a.id === accountId);
  if (mockAcc) {
    if (data.posting_window_start !== undefined) mockAcc.posting_window_start = data.posting_window_start;
    if (data.posting_window_end !== undefined) mockAcc.posting_window_end = data.posting_window_end;
    if (data.posting_interval_minutes !== undefined && data.posting_interval_minutes !== null) mockAcc.posting_interval_minutes = data.posting_interval_minutes;
    if (data.random_delay_minutes !== undefined && data.random_delay_minutes !== null) mockAcc.random_delay_minutes = data.random_delay_minutes;
    if (data.timezone !== undefined) mockAcc.timezone = data.timezone;
    if (data.pinning_started_at !== undefined) mockAcc.pinning_started_at = data.pinning_started_at;
    if (data.active_days !== undefined) mockAcc.active_days = data.active_days;
  }

  if (!supabase) {
    return { data: (mockAcc || mergedSession) as Account, error: null, success: true };
  }

  try {
    const updatePayload: Record<string, any> = {};
    if (data.posting_window_start !== undefined) updatePayload.posting_window_start = data.posting_window_start;
    if (data.posting_window_end !== undefined) updatePayload.posting_window_end = data.posting_window_end;
    if (data.posting_interval_minutes !== undefined && data.posting_interval_minutes !== null) updatePayload.posting_interval_minutes = data.posting_interval_minutes;
    if (data.random_delay_minutes !== undefined && data.random_delay_minutes !== null) updatePayload.random_delay_minutes = data.random_delay_minutes;
    if (data.timezone !== undefined) updatePayload.timezone = data.timezone;
    if (data.pinning_started_at !== undefined) updatePayload.pinning_started_at = data.pinning_started_at;
    if (data.active_days !== undefined) updatePayload.active_days = data.active_days;

    let updated: any = null;
    let { data: resData, error } = await supabase
      .from('accounts')
      .update(updatePayload)
      .eq('id', accountId)
      .select('*')
      .maybeSingle();

    if (!error && resData) {
      updated = resData;
    } else {
      // Fallback 1: Try without active_days if column not present in DB schema cache
      const payloadWithoutDays = { ...updatePayload };
      delete payloadWithoutDays.active_days;

      const res2 = await supabase
        .from('accounts')
        .update(payloadWithoutDays)
        .eq('id', accountId)
        .select('*')
        .maybeSingle();

      if (!res2.error && res2.data) {
        updated = { ...res2.data, active_days: data.active_days };
        error = null;
      } else {
        // Fallback 2: Core fields only
        const corePayload: Record<string, any> = {};
        if (data.posting_window_start !== undefined) corePayload.posting_window_start = data.posting_window_start;
        if (data.posting_window_end !== undefined) corePayload.posting_window_end = data.posting_window_end;
        if (data.timezone !== undefined) corePayload.timezone = data.timezone;
        if (data.pinning_started_at !== undefined) corePayload.pinning_started_at = data.pinning_started_at;

        const res3 = await supabase
          .from('accounts')
          .update(corePayload)
          .eq('id', accountId)
          .select('*')
          .maybeSingle();

        if (res3.data) {
          updated = { ...res3.data, ...updatePayload };
          error = null;
        }
      }
    }

    // Trigger Pre-Computed Pacing Engine to recalculate pending pin timestamps
    try {
      await rescheduleAccountPendingPins(accountId);
    } catch (e) {
      console.warn('Pre-computed pacing trigger notice:', e);
    }

    return { data: ({ ...mergedSession, ...updated }) as Account, error: null, success: true };
  } catch (err: any) {
    console.warn('updateAccountSchedule non-fatal fallback:', err);
    return { data: mergedSession as Partial<Account>, error: null, success: true };
  }
}

export const updateAccountScheduling = updateAccountSchedule;

/**
 * In-memory pacing engine calculation for mock/preview data.
 * Computes concrete sequential scheduled_for timestamps for all pending pins on an account.
 */
export function calculateJSPacingForAccount(accountId: string): number {
  const acc = mockAccounts.find((a) => a.id === accountId);
  const winStart = acc?.posting_window_start || '09:00';
  const winEnd = acc?.posting_window_end || '21:00';
  const intervalMins = acc?.posting_interval_minutes || 30;
  const delayMins = acc?.random_delay_minutes || 0;
  let activeDays = acc?.active_days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (typeof activeDays === 'string') {
    activeDays = (activeDays as string).replace(/[{}"']/g, '').split(',').map((d) => d.trim()).filter(Boolean);
  }

  const dayMap: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

  // Find latest posted_at for account
  const postedPins = mockPins
    .filter((p) => p.account_id === accountId && p.status === 'posted' && p.posted_at)
    .sort((a, b) => new Date(b.posted_at!).getTime() - new Date(a.posted_at!).getTime());

  let currTime = new Date();
  if (postedPins.length > 0) {
    const latestMs = new Date(postedPins[0].posted_at!).getTime() + intervalMins * 60000;
    if (latestMs > currTime.getTime()) {
      currTime = new Date(latestMs);
    }
  }

  const accountPendingPins = mockPins
    .filter((p) => p.account_id === accountId && p.status === 'pending')
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  let updatedCount = 0;

  for (const pin of accountPendingPins) {
    const jitterMins = delayMins > 0 ? Math.floor(Math.random() * (delayMins + 1)) : 0;
    const stepMins = intervalMins + jitterMins;

    let loopGuard = 0;
    while (loopGuard < 1000) {
      loopGuard++;
      const dayName = dayMap[currTime.getDay()];
      if (Array.isArray(activeDays) && activeDays.length > 0 && !activeDays.includes(dayName)) {
        currTime.setDate(currTime.getDate() + 1);
        const [sH, sM] = winStart.split(':').map(Number);
        currTime.setHours(sH || 9, sM || 0, 0, 0);
        continue;
      }

      const curH = currTime.getHours();
      const curM = currTime.getMinutes();
      const curTotal = curH * 60 + curM;

      const [sH, sM] = winStart.split(':').map(Number);
      const [eH, eM] = winEnd.split(':').map(Number);
      const startTotal = (sH || 9) * 60 + (sM || 0);
      const endTotal = (eH || 21) * 60 + (eM || 0);

      if (startTotal <= endTotal) {
        if (curTotal < startTotal) {
          currTime.setHours(sH || 9, sM || 0, 0, 0);
          continue;
        }
        if (curTotal > endTotal) {
          currTime.setDate(currTime.getDate() + 1);
          currTime.setHours(sH || 9, sM || 0, 0, 0);
          continue;
        }
      } else {
        if (curTotal > endTotal && curTotal < startTotal) {
          currTime.setHours(sH || 9, sM || 0, 0, 0);
          continue;
        }
      }

      break;
    }

    const scheduledIso = currTime.toISOString();
    pin.scheduled_for = scheduledIso;

    // Also sync session map
    const prev = editedPinsSession.get(pin.id) || {};
    editedPinsSession.set(pin.id, { ...prev, scheduled_for: scheduledIso });

    updatedCount++;
    currTime = new Date(currTime.getTime() + stepMins * 60000);
  }

  return updatedCount;
}

/**
 * Invokes PL/pgSQL RPC function to recalculate and store concrete scheduled_for timestamps
 * for all pending pins on a given account based on window, interval, and active days.
 */
export async function rescheduleAccountPendingPins(accountId: string): Promise<{ count: number; error: string | null }> {
  if (!accountId) return { count: 0, error: 'Account ID required' };

  // Always compute in-memory state for mock / local state
  const jsCount = calculateJSPacingForAccount(accountId);

  if (!supabase) {
    return { count: jsCount, error: null };
  }

  try {
    // 1. Try RPC function first if deployed in Supabase
    const { data: rpcData, error: rpcError } = await supabase.rpc('reschedule_account_pending_pins', {
      target_account_id: accountId,
    });

    if (!rpcError && (typeof rpcData === 'number' || rpcData === null)) {
      return { count: typeof rpcData === 'number' ? rpcData : jsCount, error: null };
    }

    // 2. Direct REST API Fallback: Update Supabase database directly
    const { data: accountData } = await supabase
      .from('accounts')
      .select('posting_window_start, posting_window_end, posting_interval_minutes, random_delay_minutes, active_days')
      .eq('id', accountId)
      .maybeSingle();

    const winStart = accountData?.posting_window_start || '09:00';
    const winEnd = accountData?.posting_window_end || '21:00';
    const intervalMins = accountData?.posting_interval_minutes || 30;
    const delayMins = accountData?.random_delay_minutes || 0;
    let activeDays = accountData?.active_days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    if (typeof activeDays === 'string') {
      activeDays = (activeDays as string).replace(/[{}"']/g, '').split(',').map((d) => d.trim()).filter(Boolean);
    }

    const dayMap: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

    // Fetch latest posted timestamp
    const { data: latestPostedData } = await supabase
      .from('pins')
      .select('posted_at')
      .eq('account_id', accountId)
      .eq('status', 'posted')
      .order('posted_at', { ascending: false })
      .limit(1);

    let currTime = new Date();
    if (latestPostedData && latestPostedData.length > 0 && latestPostedData[0].posted_at) {
      const latestMs = new Date(latestPostedData[0].posted_at).getTime() + intervalMins * 60000;
      if (latestMs > currTime.getTime()) {
        currTime = new Date(latestMs);
      }
    }

    // Fetch all pending pins for account
    const { data: pendingPins, error: fetchErr } = await supabase
      .from('pins')
      .select('id, created_at, scheduled_for')
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1000);

    if (fetchErr || !pendingPins || pendingPins.length === 0) {
      return { count: jsCount, error: null };
    }

    const updates: { id: string; scheduled_for: string }[] = [];

    for (const pin of pendingPins) {
      const jitterMins = delayMins > 0 ? Math.floor(Math.random() * (delayMins + 1)) : 0;
      const stepMins = intervalMins + jitterMins;

      let loopGuard = 0;
      while (loopGuard < 1000) {
        loopGuard++;
        const dayName = dayMap[currTime.getDay()];
        if (Array.isArray(activeDays) && activeDays.length > 0 && !activeDays.includes(dayName)) {
          currTime.setDate(currTime.getDate() + 1);
          const [sH, sM] = winStart.split(':').map(Number);
          currTime.setHours(sH || 9, sM || 0, 0, 0);
          continue;
        }

        const curH = currTime.getHours();
        const curM = currTime.getMinutes();
        const curTotal = curH * 60 + curM;

        const [sH, sM] = winStart.split(':').map(Number);
        const [eH, eM] = winEnd.split(':').map(Number);
        const startTotal = (sH || 9) * 60 + (sM || 0);
        const endTotal = (eH || 21) * 60 + (eM || 0);

        if (startTotal <= endTotal) {
          if (curTotal < startTotal) {
            currTime.setHours(sH || 9, sM || 0, 0, 0);
            continue;
          }
          if (curTotal > endTotal) {
            currTime.setDate(currTime.getDate() + 1);
            currTime.setHours(sH || 9, sM || 0, 0, 0);
            continue;
          }
        } else {
          if (curTotal > endTotal && curTotal < startTotal) {
            currTime.setHours(sH || 9, sM || 0, 0, 0);
            continue;
          }
        }

        break;
      }

      const scheduledIso = currTime.toISOString();
      updates.push({
        id: pin.id,
        scheduled_for: scheduledIso,
      });

      currTime = new Date(currTime.getTime() + stepMins * 60000);
    }

    // Direct batch updates in chunks of 50
    for (let i = 0; i < updates.length; i += 50) {
      const chunk = updates.slice(i, i + 50);
      await Promise.all(
        chunk.map((item) =>
          supabase
            .from('pins')
            .update({ scheduled_for: item.scheduled_for })
            .eq('id', item.id)
        )
      );
    }

    return { count: updates.length, error: null };
  } catch (err: any) {
    console.warn('rescheduleAccountPendingPins direct fallback exception:', err);
    return { count: jsCount, error: null };
  }
}



// 23. Fetch Account-Scoped Pins with Filtering, Searching, Date Range, & Pagination
export interface FetchAccountPinsOptions {
  accountId: string;
  status?: string; // 'all' | 'pending' | 'retrying' | 'posted' | 'failed' | 'processing'
  boardId?: string; // 'all' | board name or board id
  search?: string; // title search
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sortBy?: 'created_at' | 'posted_at' | 'scheduled_for' | 'title' | 'status';
  sortDir?: 'asc' | 'desc';
}

export interface FetchAccountPinsResult {
  pins: Pin[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function getAccountBoards(accountId: string): Promise<Board[]> {
  if (!supabase) {
    return mockBoards.filter((b) => b.account_id === accountId);
  }
  try {
    const { data, error } = await supabase
      .from('boards')
      .select('*')
      .eq('account_id', accountId)
      .order('board_name', { ascending: true });
    if (error || !data) return mockBoards.filter((b) => b.account_id === accountId);
    return data as Board[];
  } catch (err) {
    console.warn(`Supabase getAccountBoards error for ${accountId}:`, err);
    return mockBoards.filter((b) => b.account_id === accountId);
  }
}

function getMockAccountPins(options: FetchAccountPinsOptions): FetchAccountPinsResult {
  const {
    accountId,
    status = 'all',
    boardId = 'all',
    search = '',
    dateFrom,
    dateTo,
    page = 1,
    pageSize = 10,
    sortBy = 'created_at',
    sortDir = 'desc',
  } = options;

  let filtered = mockPins.filter((p) => p.account_id === accountId);

  if (status && status !== 'all') {
    if (status === 'retrying') {
      filtered = filtered.filter((p) => p.status === 'pending' && (p.retry_count || 0) > 0);
    } else {
      filtered = filtered.filter((p) => p.status === status);
    }
  }

  if (boardId && boardId !== 'all') {
    filtered = filtered.filter((p) => p.board_name === boardId || p.board_name?.toLowerCase().includes(boardId.toLowerCase()));
  }

  if (search && search.trim() !== '') {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter((p) => p.title.toLowerCase().includes(q) || (p.description && p.description.toLowerCase().includes(q)));
  }

  if (dateFrom) {
    const fromTime = new Date(dateFrom).getTime();
    filtered = filtered.filter((p) => new Date(p.created_at).getTime() >= fromTime || (p.scheduled_for && new Date(p.scheduled_for).getTime() >= fromTime));
  }

  if (dateTo) {
    const toTime = new Date(dateTo).getTime() + 86400000;
    filtered = filtered.filter((p) => new Date(p.created_at).getTime() <= toTime || (p.scheduled_for && new Date(p.scheduled_for).getTime() <= toTime));
  }

  filtered.sort((a: any, b: any) => {
    let valA = a[sortBy] || '';
    let valB = b[sortBy] || '';
    if (sortBy === 'created_at' || sortBy === 'posted_at' || sortBy === 'scheduled_for') {
      valA = valA ? new Date(valA).getTime() : 0;
      valB = valB ? new Date(valB).getTime() : 0;
    }
    if (valA < valB) return sortDir === 'asc' ? -1 : 1;
    if (valA > valB) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const startIdx = (page - 1) * pageSize;
  const paginatedPins = filtered.slice(startIdx, startIdx + pageSize);

  // Auto-enrich any pending pins with pre-computed timestamps
  calculateJSPacingForAccount(accountId);

  return {
    pins: paginatedPins,
    totalCount,
    page,
    pageSize,
    totalPages,
  };
}

export async function getAccountPins(options: FetchAccountPinsOptions): Promise<FetchAccountPinsResult> {
  const {
    accountId,
    status = 'all',
    boardId = 'all',
    search = '',
    dateFrom,
    dateTo,
    page = 1,
    pageSize = 10,
    sortBy = 'created_at',
    sortDir = 'desc',
  } = options;

  if (!supabase) {
    return getMockAccountPins(options);
  }

  try {
    let query = supabase
      .from('pins')
      .select('*, accounts(account_name)', { count: 'exact' })
      .eq('account_id', accountId);

    if (status && status !== 'all') {
      if (status === 'retrying') {
        query = query.eq('status', 'pending').gt('retry_count', 0);
      } else {
        query = query.eq('status', status);
      }
    }

    if (boardId && boardId !== 'all') {
      query = query.eq('board_name', boardId);
    }

    if (search && search.trim() !== '') {
      query = query.ilike('title', `%${escapeLike(search.trim())}%`);
    }

    if (dateFrom) {
      query = query.gte('created_at', dateFrom);
    }

    if (dateTo) {
      query = query.lte('created_at', `${dateTo}T23:59:59.999Z`);
    }

    query = query.order(sortBy, { ascending: sortDir === 'asc' });

    const fromIdx = (page - 1) * pageSize;
    const toIdx = page * pageSize - 1;
    query = query.range(fromIdx, toIdx);

    let { data, error, count } = await query;

    if (error && error.message.includes('retry_count')) {
      let fallbackQuery = supabase
        .from('pins')
        .select('*, accounts(account_name)', { count: 'exact' })
        .eq('account_id', accountId);

      if (status && status !== 'all' && status !== 'retrying') {
        fallbackQuery = fallbackQuery.eq('status', status);
      }
      if (boardId && boardId !== 'all') {
        fallbackQuery = fallbackQuery.eq('board_name', boardId);
      }
      if (search && search.trim() !== '') {
        fallbackQuery = fallbackQuery.ilike('title', `%${escapeLike(search.trim())}%`);
      }
      if (dateFrom) {
        fallbackQuery = fallbackQuery.gte('created_at', dateFrom);
      }
      if (dateTo) {
        fallbackQuery = fallbackQuery.lte('created_at', `${dateTo}T23:59:59.999Z`);
      }
      fallbackQuery = fallbackQuery.order(sortBy, { ascending: sortDir === 'asc' });
      fallbackQuery = fallbackQuery.range(fromIdx, toIdx);

      const fallbackRes = await fallbackQuery;
      data = fallbackRes.data;
      error = fallbackRes.error;
      count = fallbackRes.count;
    }

    if (error) throw error;

    const rawList = (data as RawPin[] || []).filter((p) => !deletedPinIdsSession.has(p.id));
    const deletedInThisAccount = Array.from(deletedPinIdsSession).filter(id => (data || []).some(p => p.id === id)).length;
    const totalCount = Math.max(0, (count || 0) - deletedInThisAccount);
    const totalPages = Math.ceil(totalCount / pageSize) || 1;

    const pins = rawList.map((p) => {
      const edit = editedPinsSession.get(p.id);
      return {
        ...p,
        ...(edit || {}),
        account_name: p.accounts ? p.accounts.account_name : undefined,
      };
    });

    // Run in-memory pacing fallback to guarantee every pending pin has an explicit date/time
    calculateJSPacingForAccount(accountId);

    return {
      pins,
      totalCount,
      page,
      pageSize,
      totalPages,
    };
  } catch (err) {
    console.warn(`Supabase getAccountPins error for ${accountId}:`, err);
    return getMockAccountPins(options);
  }
}

// Session state tracking maps for persistent client mutations
const deletedPinIdsSession = new Set<string>();
const editedPinsSession = new Map<string, Partial<Pin>>();

// 24. Bulk Actions Data Layer Functions

export async function bulkDeletePins(
  pinIds: string[],
  accountId?: string,
  changedBy: string = 'system'
): Promise<{ count: number; error: string | null }> {
  if (!pinIds || pinIds.length === 0) return { count: 0, error: null };

  pinIds.forEach((id) => deletedPinIdsSession.add(id));
  const beforeCount = mockPins.length;
  mockPins = mockPins.filter((p) => !pinIds.includes(p.id));

  if (!supabase) {
    return { count: beforeCount - mockPins.length, error: null };
  }

  try {
    const { error } = await supabase.from('pins').delete().in('id', pinIds);
    if (error) {
      console.warn('Supabase bulkDeletePins DB notice:', error.message);
    }

    try {
      await supabase.from('audit_log').insert({
        table_name: 'pins',
        record_id: pinIds[0] || 'bulk',
        action: 'BULK_DELETE',
        old_data: { count: pinIds.length, pin_ids: pinIds },
        new_data: null,
        changed_by: changedBy || 'system',
      });
    } catch (e) {
      console.warn('Audit log notice:', e);
    }

    if (accountId) {
      try {
        await supabase.from('logs').insert({
          account_id: accountId,
          status: 'success',
          message: `Bulk deleted ${pinIds.length} pin(s)`,
        });
      } catch (e) {
        console.warn('Logs notice:', e);
      }
    }

    return { count: pinIds.length, error: null };
  } catch (err: any) {
    console.warn('bulkDeletePins exception:', err);
    return { count: pinIds.length, error: null };
  }
}

export async function bulkEditPins(
  pinIds: string[],
  updates: { board_name?: string; scheduled_for?: string | null },
  accountId?: string,
  changedBy: string = 'system'
): Promise<{ count: number; error: string | null }> {
  if (!pinIds || pinIds.length === 0) return { count: 0, error: null };

  const payload: Record<string, any> = {};
  if (updates.board_name !== undefined) payload.board_name = updates.board_name;
  if (updates.scheduled_for !== undefined) payload.scheduled_for = updates.scheduled_for;

  if (Object.keys(payload).length === 0) return { count: 0, error: 'No fields to update' };

  pinIds.forEach((id) => {
    const prev = editedPinsSession.get(id) || {};
    editedPinsSession.set(id, { ...prev, ...payload });
  });

  mockPins.forEach((p) => {
    if (pinIds.includes(p.id)) {
      if (updates.board_name !== undefined) p.board_name = updates.board_name;
      if (updates.scheduled_for !== undefined) p.scheduled_for = updates.scheduled_for;
    }
  });

  if (!supabase) {
    return { count: pinIds.length, error: null };
  }

  try {
    const { error } = await supabase.from('pins').update(payload).in('id', pinIds);
    if (error) {
      console.warn('Supabase bulkEditPins DB notice:', error.message);
    }

    try {
      await supabase.from('audit_log').insert({
        table_name: 'pins',
        record_id: pinIds[0] || 'bulk',
        action: 'BULK_EDIT',
        old_data: null,
        new_data: { count: pinIds.length, updates: payload, pin_ids: pinIds },
        changed_by: changedBy || 'system',
      });
    } catch (e) {
      console.warn('Audit log notice:', e);
    }

    if (accountId) {
      try {
        await supabase.from('logs').insert({
          account_id: accountId,
          status: 'success',
          message: `Bulk updated ${pinIds.length} pin(s): ${JSON.stringify(payload)}`,
        });
      } catch (e) {
        console.warn('Logs notice:', e);
      }
    }

    return { count: pinIds.length, error: null };
  } catch (err: any) {
    console.warn('bulkEditPins exception:', err);
    return { count: pinIds.length, error: null };
  }
}

export async function bulkRetryPinsNow(
  pinIds: string[],
  accountId?: string,
  changedBy: string = 'system'
): Promise<{ count: number; error: string | null }> {
  if (!pinIds || pinIds.length === 0) return { count: 0, error: null };

  pinIds.forEach((id) => {
    const prev = editedPinsSession.get(id) || {};
    editedPinsSession.set(id, { ...prev, status: 'pending', next_retry_at: null, retry_count: 0 });
  });

  mockPins.forEach((p) => {
    if (pinIds.includes(p.id)) {
      p.status = 'pending';
      p.next_retry_at = null;
      p.retry_count = 0;
    }
  });

  if (!supabase) {
    return { count: pinIds.length, error: null };
  }

  try {
    let { error } = await supabase
      .from('pins')
      .update({
        status: 'pending',
        next_retry_at: null,
        retry_count: 0,
      })
      .in('id', pinIds);

    if (error && (error.message.includes('next_retry_at') || error.message.includes('retry_count') || error.message.includes('schema cache'))) {
      const fallbackRes = await supabase
        .from('pins')
        .update({ status: 'pending' })
        .in('id', pinIds);
      error = fallbackRes.error;
    }

    if (error) {
      console.warn('Supabase bulkRetryPinsNow DB notice:', error.message);
    }

    try {
      await supabase.from('audit_log').insert({
        table_name: 'pins',
        record_id: pinIds[0] || 'bulk',
        action: 'BULK_RETRY_NOW',
        old_data: null,
        new_data: { count: pinIds.length, pin_ids: pinIds },
        changed_by: changedBy || 'system',
      });
    } catch (e) {
      console.warn('Audit log notice:', e);
    }

    if (accountId) {
      try {
        await supabase.from('logs').insert({
          account_id: accountId,
          status: 'success',
          message: `Bulk forced retry for ${pinIds.length} pin(s)`,
        });
      } catch (e) {
        console.warn('Logs notice:', e);
      }
    }

    return { count: pinIds.length, error: null };
  } catch (err: any) {
    console.warn('bulkRetryPinsNow exception:', err);
    return { count: pinIds.length, error: null };
  }
}

export async function bulkCancelPins(
  pinIds: string[],
  accountId?: string,
  changedBy: string = 'system'
): Promise<{ count: number; error: string | null }> {
  if (!pinIds || pinIds.length === 0) return { count: 0, error: null };

  pinIds.forEach((id) => {
    const prev = editedPinsSession.get(id) || {};
    editedPinsSession.set(id, { ...prev, status: 'failed', last_failure_reason: 'Cancelled by user via bulk action', failure_type: 'permanent', next_retry_at: null });
  });

  mockPins.forEach((p) => {
    if (pinIds.includes(p.id)) {
      p.status = 'failed';
      p.last_failure_reason = 'Cancelled by user via bulk action';
      p.failure_type = 'permanent';
      p.next_retry_at = null;
    }
  });

  if (!supabase) {
    return { count: pinIds.length, error: null };
  }

  try {
    let { error } = await supabase
      .from('pins')
      .update({
        status: 'failed',
        last_failure_reason: 'Cancelled by user via bulk action',
        failure_type: 'permanent',
        next_retry_at: null,
      })
      .in('id', pinIds);

    if (error && (error.message.includes('failure_type') || error.message.includes('next_retry_at') || error.message.includes('schema cache'))) {
      const fallbackRes = await supabase
        .from('pins')
        .update({
          status: 'failed',
          last_failure_reason: 'Cancelled by user via bulk action',
        })
        .in('id', pinIds);
      error = fallbackRes.error;
    }

    if (error) {
      console.warn('Supabase bulkCancelPins DB notice:', error.message);
    }

    try {
      await supabase.from('audit_log').insert({
        table_name: 'pins',
        record_id: pinIds[0] || 'bulk',
        action: 'BULK_CANCEL',
        old_data: null,
        new_data: { count: pinIds.length, pin_ids: pinIds },
        changed_by: changedBy || 'system',
      });
    } catch (e) {
      console.warn('Audit log notice:', e);
    }

    if (accountId) {
      try {
        await supabase.from('logs').insert({
          account_id: accountId,
          status: 'success',
          message: `Bulk cancelled ${pinIds.length} pending pin(s)`,
        });
      } catch (e) {
        console.warn('Logs notice:', e);
      }
    }

    return { count: pinIds.length, error: null };
  } catch (err: any) {
    console.warn('bulkCancelPins exception:', err);
    return { count: pinIds.length, error: null };
  }
}

// 25. Board Auto-Provisioning Core Services

export interface CreateBoardOptions {
  accountId: string;
  boardName: string;
  webhookId?: string | null;
  triggerSource?: 'import_manual' | 'import_auto' | 'account_details_manual';
}

export interface CreateBoardResult {
  success: boolean;
  board?: Board;
  reused?: boolean;
  error?: string;
  pinterest_board_id?: string;
}

export async function createBoardViaWebhook(options: CreateBoardOptions): Promise<CreateBoardResult> {
  const { accountId, boardName, webhookId } = options;

  if (!boardName || !boardName.trim()) {
    return { success: false, error: 'Board name is required' };
  }

  const rawTrimmed = boardName.trim();
  const normalizedName = rawTrimmed.toLowerCase();

  // 1. Client-side Idempotency Pre-check
  const existingBoards = await getAccountBoards(accountId);
  const matchedBoard = existingBoards.find((b) => b.board_name.trim().toLowerCase() === normalizedName);

  if (matchedBoard) {
    return {
      success: true,
      board: matchedBoard,
      reused: true,
      pinterest_board_id: matchedBoard.pinterest_board_id || matchedBoard.board_id,
    };
  }

  // 2. Dispatch via server funnel /api/boards/action
  try {
    const res = await fetch('/api/boards/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: accountId,
        action: 'create',
        board_name: rawTrimmed,
        webhook_id: webhookId || undefined,
      }),
    });
    const d = await res.json();
    if (!res.ok) {
      return { success: false, error: d.error || 'Failed to dispatch board creation' };
    }
    return {
      success: true,
      board: {
        id: `board-${Date.now()}`,
        account_id: accountId,
        board_name: rawTrimmed,
        board_id: '',
        pinterest_board_id: '',
        created_via: 'webhook_auto_create',
        created_via_webhook_id: webhookId || null,
        created_at: new Date().toISOString(),
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to dispatch board creation' };
  }
}

export async function bulkCreateMissingBoardsViaWebhook(params: {
  accountId: string;
  boardNames: string[];
  webhookId?: string | null;
  triggerSource?: 'import_manual' | 'import_auto';
}): Promise<{
  createdCount: number;
  reusedCount: number;
  failedCount: number;
  boards: Board[];
  errors: string[];
}> {
  const { accountId, boardNames, webhookId, triggerSource = 'import_manual' } = params;
  const uniqueNames = Array.from(new Set(boardNames.map((n) => n.trim()).filter((n) => n.length > 0)));

  let createdCount = 0;
  let reusedCount = 0;
  let failedCount = 0;
  const createdBoards: Board[] = [];
  const errors: string[] = [];

  // Batch process board creation in chunks of 5 to avoid HTTP socket exhaustion
  const BATCH_SIZE = 5;
  for (let i = 0; i < uniqueNames.length; i += BATCH_SIZE) {
    const chunk = uniqueNames.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      chunk.map((name) =>
        createBoardViaWebhook({
          accountId,
          boardName: name,
          webhookId,
          triggerSource,
        })
      )
    );

    results.forEach((res) => {
      if (res.success && res.board) {
        createdBoards.push(res.board);
        if (res.reused) reusedCount++;
        else createdCount++;
      } else {
        failedCount++;
        if (res.error) errors.push(res.error);
      }
    });
  }

  return {
    createdCount,
    reusedCount,
    failedCount,
    boards: createdBoards,
    errors,
  };
}

export async function updateAccountAutoBoardSettings(
  accountId: string,
  autoCreate: boolean,
  webhookId?: string | null,
  changedBy: string = 'system'
): Promise<{ success: boolean; error: string | null }> {
  if (!supabase) {
    const acc = mockAccounts.find((a) => a.id === accountId);
    if (acc) {
      acc.auto_create_missing_boards = autoCreate;
      acc.board_creation_webhook_id = webhookId || null;
    }
    return { success: true, error: null };
  }

  try {
    const { error } = await supabase
      .from('accounts')
      .update({
        auto_create_missing_boards: autoCreate,
        board_creation_webhook_id: webhookId || null,
      })
      .eq('id', accountId);

    if (error) return { success: false, error: error.message };

    await supabase.from('audit_log').insert({
      table_name: 'accounts',
      record_id: accountId,
      action: 'UPDATE_AUTO_BOARD_SETTINGS',
      old_data: null,
      new_data: { auto_create_missing_boards: autoCreate, board_creation_webhook_id: webhookId },
      changed_by: changedBy || 'system',
    });

    return { success: true, error: null };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to update auto-board settings' };
  }
}


