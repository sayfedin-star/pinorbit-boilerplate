/**
 * PinArchive Discovery: Discovers new pins for Pinterest accounts using vault cookies.
 *
 * Env Vars:
 * - PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY (P4 operational store)
 * - PINORBIT_WORKER_URL, PINARCHIVE_INGEST_SECRET (Internal Ingest API & Config)
 * - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (P1 / P2 cookie vault & KEK store)
 * - PINARCHIVE_GAS_URL (optional: GAS thin Sheet writer)
 *
 * Scope inputs:
 * - DISCOVERY_WORKSPACE_ID / WORKSPACE_ID
 * - DISCOVERY_USERNAME / USERNAME
 * - DISCOVERY_USERNAMES / USERNAMES
 * - AUDIT_SWEEP (true = full sweep, disable early-stop)
 * - FORCE_RUN (true = bypass schedule eligibility)
 * - SHARD_COUNT, DISCOVERY_SHARD (for parallel matrix execution)
 */

import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const CFG = {
  PAGE_SIZE: 50,
  SLEEP_MS_MIN: 2500,
  SLEEP_MS_MAX: 4000,
  MAX_BATCH_PINS: 250,
  CIRCUIT_BREAKER: 3,
  MAX_PAGES_DEFAULT: 50,
};

const SHARD_COUNT = Math.max(1, parseInt(process.env.SHARD_COUNT || '1', 10) || 1);
const DISCOVERY_SHARD = Math.max(0, parseInt(process.env.DISCOVERY_SHARD || '0', 10) || 0);

const {
  PINARCHIVE_SUPABASE_URL,
  PINARCHIVE_SUPABASE_KEY,
  PINORBIT_WORKER_URL,
  PINARCHIVE_INGEST_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PINARCHIVE_GAS_URL,
} = process.env;

const DISCOVERY_WORKSPACE_ID = (process.env.DISCOVERY_WORKSPACE_ID || process.env.WORKSPACE_ID || '').trim();
const DISCOVERY_USERNAME = (process.env.DISCOVERY_USERNAME || process.env.USERNAME || '').trim().toLowerCase();
const DISCOVERY_USERNAMES = (process.env.DISCOVERY_USERNAMES || process.env.USERNAMES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const IS_AUDIT_SWEEP = (process.env.AUDIT_SWEEP || '').trim().toLowerCase() === 'true';
const FORCE_RUN = (process.env.FORCE_RUN || process.env.DISCOVERY_FORCE || '').trim().toLowerCase() === 'true';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = b => btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b))));
const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const sleep = ms => new Promise(r => setTimeout(r, ms));

function randomJitterMs(min = CFG.SLEEP_MS_MIN, max = CFG.SLEEP_MS_MAX) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Egress IP Logging ──
async function logEgressIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      console.log(`🌐 Runner Egress IP: ${data.ip}`);
    }
  } catch (e) {
    console.warn(`⚠️ Could not determine egress IP: ${e.message}`);
  }
}

function checkEnv() {
  const missing = [];
  if (!PINARCHIVE_SUPABASE_URL) missing.push('PINARCHIVE_SUPABASE_URL');
  if (!PINARCHIVE_SUPABASE_KEY) missing.push('PINARCHIVE_SUPABASE_KEY');
  if (!PINORBIT_WORKER_URL) missing.push('PINORBIT_WORKER_URL');
  if (!PINARCHIVE_INGEST_SECRET) missing.push('PINARCHIVE_INGEST_SECRET');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ── Supabase REST query helper for Project 4 (PinArchive) ──
async function supaQuery(table, params = '') {
  const url = `${PINARCHIVE_SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const res = await fetch(url, {
    headers: {
      'apikey': PINARCHIVE_SUPABASE_KEY,
      'Authorization': `Bearer ${PINARCHIVE_SUPABASE_KEY}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: HTTP ${res.status}`);
  return res.json();
}

async function supaPatch(table, matchParams, body) {
  const url = `${PINARCHIVE_SUPABASE_URL}/rest/v1/${table}?${matchParams}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': PINARCHIVE_SUPABASE_KEY,
      'Authorization': `Bearer ${PINARCHIVE_SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.warn(`⚠️ Supabase PATCH ${table} failed (${res.status}): ${txt}`);
  }
}

async function supaInsert(table, body) {
  const url = `${PINARCHIVE_SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': PINARCHIVE_SUPABASE_KEY,
      'Authorization': `Bearer ${PINARCHIVE_SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.warn(`⚠️ Supabase POST ${table} failed (${res.status}): ${txt}`);
  }
}

// ── AES-GCM (v1:iv:ct, SHA-256(kek)) — Cookie Vault Crypto ──
async function aesKey(kek, usage) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(kek));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

async function decryptCookieValue(stored, kek) {
  if (!stored || typeof stored !== 'string') return null;
  if (!stored.startsWith('v1:')) return stored;
  const [, ivB64, ctB64] = stored.split(':');
  if (!ivB64 || !ctB64) return null;
  try {
    return dec.decode(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ub64(ivB64) },
        await aesKey(kek, 'decrypt'),
        ub64(ctB64)
      )
    );
  } catch {
    return null;
  }
}

async function resolveKek(vaultDb) {
  const { data } = await vaultDb.from('competitor_kek').select('kek').limit(1).maybeSingle();
  if (data?.kek) return data.kek;
  const hex = crypto.randomBytes(32).toString('hex');
  await vaultDb.from('competitor_kek').upsert({ id: true, kek: hex }, { onConflict: 'id' });
  const { data: d2 } = await vaultDb.from('competitor_kek').select('kek').limit(1).maybeSingle();
  return d2?.kek || null;
}

// ── Cookie Vault Picker + LRU ──
async function getVaultCookie(vaultDb, wsId, kek) {
  const { data } = await vaultDb
    .from('pinterest_cookies')
    .select('id, cookie_value')
    .eq('workspace_id', wsId)
    .eq('is_active', true)
    .order('last_used_at', { ascending: true, nullsFirst: true })
    .limit(5);

  for (const c of data || []) {
    const plain = await decryptCookieValue(c.cookie_value, kek);
    if (plain) {
      await vaultDb
        .from('pinterest_cookies')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', c.id);
      return { id: c.id, plain };
    }
  }

  // ONE-TIME legacy auto-import from env if present
  const legacy = process.env.PINTEREST_COOKIE;
  if (legacy && legacy.trim().length >= 20) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await aesKey(kek, 'encrypt'),
      enc.encode(legacy.trim())
    );
    const encStr = `v1:${b64(iv)}:${b64(ct)}`;
    await vaultDb.from('pinterest_cookies').insert({ workspace_id: wsId, cookie_value: encStr, is_active: true });
    console.log(`🔐 Legacy PINTEREST_COOKIE auto-imported into vault for workspace ${wsId}`);
    return { id: 'legacy', plain: legacy.trim() };
  }
  return null;
}

// ── Discovery Headers ──
function getDiscoveryHeaders(username, activeCookie) {
  const src = `/${username}/_created/`;
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
    'X-App-Version': '9302641',
    'X-Pinterest-AppState': 'active',
    'X-Pinterest-PWS-Handler': `www/${username}/_created.js`,
    'X-Pinterest-Source-Url': src,
    'Referer': `https://www.pinterest.com${src}`,
    'Cookie': activeCookie || '',
  };
}

// ── Fetch Pinterest with Self-Healing on 401/403 ──
async function pinterestFetch(url, username, cookiePlain, vaultDb, cookieId, maxRetries = 3) {
  let activeCookie = cookiePlain;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: getDiscoveryHeaders(username, activeCookie),
        signal: AbortSignal.timeout(15000),
      });

      if ((res.status === 401 || res.status === 403) && cookieId && cookieId !== 'legacy') {
        console.warn(`🚫 Cookie ${cookieId.slice(0, 8)} disabled for @${username} (HTTP ${res.status}) — retrying anonymously.`);
        await vaultDb.from('pinterest_cookies').update({ is_active: false }).eq('id', cookieId);
        activeCookie = '';
        return await fetch(url, {
          method: 'GET',
          headers: getDiscoveryHeaders(username, ''),
          signal: AbortSignal.timeout(15000),
        });
      }

      return res;
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await sleep(2 ** attempt * 1000 + Math.random() * 500);
      attempt++;
    }
  }
}

// ── UserActivityPinsResource URL builder ──
function buildDiscoveryUrl(username, cursor) {
  const src = `/${username}/_created/`;
  const options = {
    exclude_add_pin_rep: true,
    field_set_key: 'profile_created_grid_item',
    is_own_profile_pins: false,
    username: username,
    data: { page_size: CFG.PAGE_SIZE },
    noCache: true,
  };
  if (cursor) options.bookmarks = [cursor];

  return `https://www.pinterest.com/resource/UserActivityPinsResource/get/?source_url=${encodeURIComponent(
    src
  )}&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}&_=${Date.now()}`;
}

// ── Format Pin from UserActivityPinsResource ──
function mapDiscoveryPin(p) {
  const st = (p.aggregated_pin_data && p.aggregated_pin_data.aggregated_stats) || {};
  const saves = Number(st.saves || p.saves || 0);
  const repins = Number(p.repin_count || p.repins || 0);
  const comments = Number(p.comment_count || p.comments || 0);
  const created = p.created_at ? new Date(p.created_at) : new Date();
  const createdMs = created.getTime();
  const ageDays = Math.max(1, (Date.now() - createdMs) / 86400000);

  const tags = (p.pin_join && p.pin_join.visual_annotation) || p.visual_annotation || [];
  const tagList = Array.isArray(tags) ? tags : [];
  const annotations = tagList.map(t => (typeof t === 'string' ? { name: t } : t));

  return {
    pin_id: String(p.id || p.pin_id || '').trim(),
    title: p.title || p.grid_title || '',
    description: p.description || p.grid_description || '',
    link: p.link || '',
    domain: p.domain || '',
    board_name: (p.board && p.board.name) || '',
    board_id: p.board?.entityId ?? p.board?.id ?? null,
    created_at_pinterest: p.created_at || created.toISOString(),
    image_url: (p.images && p.images.orig && p.images.orig.url) || p.image_large_url || '',
    image_signature: p.image_signature || null,
    dominant_color: p.dominant_color || null,
    is_video: Boolean(p.is_video || p.isVideo),
    saves,
    repins,
    comments,
    age_days: ageDays,
    velocity: Math.round((saves / ageDays) * 100) / 100,
    annotations,
    tags: tagList,
  };
}

// ── Pin Qualification Rule Checker (OR Rules) ──
function qualifies(pin, settings) {
  const minSaves = Number(settings.pin_filter_min_saves || 0);
  const minRepins = Number(settings.pin_filter_min_repins || 0);
  const risingAgeDays = Number(settings.pin_filter_rising_age_days ?? 14);
  const risingSaves = Number(settings.pin_filter_rising_saves ?? 34);

  if (minSaves > 0 && pin.saves >= minSaves) return true;
  if (minRepins > 0 && pin.repins >= minRepins) return true;
  if (risingAgeDays > 0 && risingSaves > 0 && pin.age_days <= risingAgeDays && pin.saves >= risingSaves) return true;
  return false;
}

// ── Ingest API Push Helper ──
async function pushToIngest(workspaceId, username, pins, followerCount, accountMeta) {
  if (!pins.length) return { ok: true, pushed: 0 };
  const body = {
    run_id: crypto.randomUUID(),
    workspace_id: workspaceId,
    username,
    fetched_at: new Date().toISOString(),
    run_type: 'backfill',
    trigger: 'backfill',
    follower_count: typeof followerCount === 'number' ? followerCount : undefined,
    account_meta: accountMeta || { pins_count: pins.length, last_result: 'discovery' },
    pins,
  };

  const res = await fetch(`${PINORBIT_WORKER_URL.replace(/\/+$/, '')}/api/internal/pinarchive/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ingest-secret': PINARCHIVE_INGEST_SECRET,
    },
    body: JSON.stringify(body),
  });

  if (res.status >= 200 && res.status < 300) return { ok: true, pushed: pins.length };
  let error = '';
  try {
    const json = await res.json();
    error = json.error || '';
    if (res.status === 409 && error === 'ingest_disabled') {
      return { ok: false, code: 409, terminal: true, error: 'ingest_disabled (terminal)' };
    }
  } catch (e) {
    error = await res.text();
  }
  return { ok: false, code: res.status, error: error || `http ${res.status}` };
}

// ── GAS Sheet Write Helper ──
async function writeToGas(gasUrl, secret, payload, maxRetries = 1) {
  if (!gasUrl || gasUrl.trim() === '') {
    console.log('ℹ️ sheet_write skipped: GAS URL not configured');
    return { ok: true, skipped: true };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(gasUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': secret,
        },
        body: JSON.stringify({ ...payload, action: 'sheet_write', secret }),
        signal: AbortSignal.timeout(30000),
      });

      const data = await res.json().catch(() => ({}));
      if (data?.ok === false && data?.error === 'locked' && attempt < maxRetries) {
        console.warn('⚠️ [GAS Write] Lock conflict detected, retrying after 2s...');
        await sleep(2000);
        continue;
      }
      return data;
    } catch (err) {
      if (attempt < maxRetries) {
        console.warn(`⚠️ [GAS Write] Error on attempt ${attempt + 1}: ${err.message}, retrying after 2s...`);
        await sleep(2000);
        continue;
      }
      console.warn(`❌ [GAS Write] Failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
}

// ── Main Process ──
async function main() {
  checkEnv();
  await logEgressIp();

  console.log('\n🚀 PinArchive Discovery pipeline starting...\n');

  const vaultDb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const kek = await resolveKek(vaultDb);
  if (!kek) {
    console.error('❌ Vault KEK unavailable');
    process.exit(1);
  }

  // Load workspace settings from P4
  const settingsMap = new Map();
  try {
    const wsSettings = await supaQuery(
      'pa_workspace_settings',
      'select=workspace_id,ingest_enabled,paused_account_policy,pin_filter_min_saves,pin_filter_min_repins,pin_filter_rising_age_days,pin_filter_rising_saves,max_batch_pins,discovery_stop_pages,audit_sweep_enabled,daily_sheet_sync_enabled,github_schedule_enabled'
    );
    if (Array.isArray(wsSettings)) {
      for (const s of wsSettings) {
        settingsMap.set(s.workspace_id, s);
      }
    }
  } catch (e) {
    console.warn('Could not query pa_workspace_settings (using defaults):', e.message);
  }

  // Check Master Workspace Global Kill-Switch for scheduled pipeline runs
  const isGhScheduled = (process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || '').trim().toLowerCase() === 'schedule';
  if (isGhScheduled) {
    try {
      const p1Url = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || process.env.PINORBIT_SUPABASE_URL || '';
      const p1Key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
      if (p1Url && p1Key) {
        const p1Res = await fetch(`${p1Url}/rest/v1/workspaces?select=id,is_master&is_master=eq.true&limit=1`, {
          headers: { apikey: p1Key, Authorization: `Bearer ${p1Key}`, Accept: 'application/json' },
        });
        if (p1Res.ok) {
          const masterWorkspaces = await p1Res.json();
          if (Array.isArray(masterWorkspaces) && masterWorkspaces.length > 0) {
            const masterId = masterWorkspaces[0].id;
            const masterSetting = settingsMap.get(masterId);
            if (masterSetting && masterSetting.github_schedule_enabled === false) {
              console.log(`[GLOBAL SKIP] GitHub Actions 07:00 UTC schedule is globally disabled by Master Workspace (${masterId.slice(0, 8)}). Exiting immediately.`);
              return;
            }
          }
        }
      }
    } catch (err) {
      // Non-blocking fallback
    }
  }

  // Load accounts from P4
  let accounts = await supaQuery(
    'pa_accounts',
    'select=id,workspace_id,username,follower_count,status,ingest_enabled,interval_days,next_run_at,last_run_at,backfill_status,backfill_cursor,pins_count&order=username.asc'
  );
  if (!accounts.length) {
    console.log('No accounts found in database.');
    return;
  }

  // Apply filters
  if (DISCOVERY_USERNAME) {
    accounts = accounts.filter(a => a.username.toLowerCase() === DISCOVERY_USERNAME);
    console.log(`Requested single account @${DISCOVERY_USERNAME}: ${accounts.length} matched`);
  } else if (DISCOVERY_USERNAMES.length > 0) {
    const set = new Set(DISCOVERY_USERNAMES);
    accounts = accounts.filter(a => set.has(a.username.toLowerCase()));
    console.log(`Requested ${DISCOVERY_USERNAMES.length} account(s): ${accounts.length} matched`);
  }

  if (DISCOVERY_WORKSPACE_ID) {
    accounts = accounts.filter(a => a.workspace_id === DISCOVERY_WORKSPACE_ID);
    console.log(`Filtered by workspace ${DISCOVERY_WORKSPACE_ID}: ${accounts.length} account(s)`);
  }

  // Sharding across runner matrix
  const shardedAccounts = accounts.filter((_, idx) => idx % SHARD_COUNT === DISCOVERY_SHARD);
  console.log(`Shard ${DISCOVERY_SHARD + 1}/${SHARD_COUNT}: Processing ${shardedAccounts.length} of ${accounts.length} total accounts.\n`);

  if (!shardedAccounts.length) {
    console.log('No accounts assigned to this shard.');
    return;
  }

  const grandSummary = { accounts: 0, pages: 0, newPins: 0, qualifyingPins: 0, sheetPushed: 0, errors: [] };

  for (const acc of shardedAccounts) {
    const wsSetting = settingsMap.get(acc.workspace_id) || {};
    const wsIngestEnabled = wsSetting.ingest_enabled ?? true;
    const wsGhScheduleEnabled = wsSetting.github_schedule_enabled ?? true;
    const isGhScheduledEvent = (process.env.GITHUB_EVENT_NAME || '').trim().toLowerCase() === 'schedule';
    const pausedPolicy = wsSetting.paused_account_policy ?? 'reject';
    const discoveryStopPages = Number(wsSetting.discovery_stop_pages ?? 3);
    const maxBatchPins = Math.min(Number(wsSetting.max_batch_pins || CFG.MAX_BATCH_PINS), 500);
    const discoveryMaxPages = Math.min(
      Math.max(1, Number(process.env.DISCOVERY_MAX_PAGES || wsSetting.discovery_max_pages || CFG.MAX_PAGES_DEFAULT)),
      500
    );

    // Gating checks
    if (isGhScheduledEvent && !wsGhScheduleEnabled) {
      console.log(`[SKIP] Workspace ${acc.workspace_id.slice(0, 8)} GitHub Actions 07:00 UTC schedule is disabled (delegated to FastCron).`);
      continue;
    }
    if (!wsIngestEnabled) {
      console.log(`[SKIP] Workspace ${acc.workspace_id} ingest is disabled.`);
      continue;
    }
    if (acc.ingest_enabled === false) {
      console.log(`[SKIP] Account @${acc.username} ingest is disabled.`);
      continue;
    }
    if (['paused', 'cookie_expired', 'error'].includes(acc.status) && pausedPolicy === 'reject') {
      console.log(`[SKIP] Account @${acc.username} is inactive (status=${acc.status}, policy=reject).`);
      continue;
    }

    // Schedule eligibility check unless FORCE_RUN or AUDIT_SWEEP or backfill in progress
    if (FORCE_RUN) {
      console.log(`[FORCE] Account @${acc.username} forced (bypassing next_run_at check).`);
    } else if (!IS_AUDIT_SWEEP && acc.next_run_at && acc.backfill_status !== 'in_progress') {
      const nextRunMs = new Date(acc.next_run_at).getTime();
      if (Date.now() < nextRunMs) {
        console.log(`[SKIP] Account @${acc.username} not eligible yet (next_run_at: ${acc.next_run_at}).`);
        continue;
      }
    }

    console.log(`\n==================================================`);
    console.log(`🔍 Discovering Pins for @${acc.username} (Workspace: ${acc.workspace_id.slice(0, 8)}, maxPages: ${discoveryMaxPages})`);
    grandSummary.accounts++;

    // 1. Fetch vault cookie for this workspace
    const cookie = await getVaultCookie(vaultDb, acc.workspace_id, kek);
    if (!cookie) {
      console.warn(`⚠️ No active Pinterest cookie in vault for workspace ${acc.workspace_id}. Proceeding anonymously.`);
    } else {
      console.log(`🍪 Using vault cookie ${cookie.id.slice(0, 8)}`);
    }

    // 2. Load known pin_ids from pa_pins (NOT from Sheet)
    const knownPinIds = new Set();
    try {
      let offset = 0;
      const PAGE_CHUNK = 1000;
      while (true) {
        const rows = await supaQuery(
          'pa_pins',
          `select=pin_id&workspace_id=eq.${acc.workspace_id}&account_id=eq.${acc.id}&limit=${PAGE_CHUNK}&offset=${offset}`
        );
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const r of rows) {
          if (r.pin_id) knownPinIds.add(String(r.pin_id));
        }
        if (rows.length < PAGE_CHUNK) break;
        offset += rows.length;
      }
      console.log(`📋 Loaded ${knownPinIds.size} known pin(s) from database for @${acc.username}`);
    } catch (e) {
      console.warn(`⚠️ Error loading known pins for @${acc.username}:`, e.message);
    }

    // 3. Paginate UserActivityPinsResource
    let cursor = acc.backfill_status === 'in_progress' ? acc.backfill_cursor : null;
    let pageCount = 0;
    let consecutiveKnownPages = 0;
    let consecutiveErrors = 0;
    let rateLimitCooldownUntil = 0;
    let circuitBroken = false;
    let hasMore = true;

    // Watermark for early-stop: pins created after (last_run_at - 24h buffer).
    // If account has never run or has zero known pins in DB, watermark is 0 (full sweep).
    const watermarkMs = acc.last_run_at && knownPinIds.size > 0
      ? new Date(acc.last_run_at).getTime() - 24 * 60 * 60 * 1000
      : 0;

    const qualifyingForDb = [];
    const allPinsForSheet = [];

    while (hasMore && pageCount < discoveryMaxPages) {
      if (circuitBroken) break;

      if (Date.now() < rateLimitCooldownUntil) {
        const waitMs = Math.max(0, rateLimitCooldownUntil - Date.now());
        console.warn(`[RATE LIMIT] Pausing for ${Math.round(waitMs / 1000)}s cooldown before next page`);
        await sleep(waitMs);
      }

      await sleep(randomJitterMs());
      pageCount++;
      grandSummary.pages++;

      const url = buildDiscoveryUrl(acc.username, cursor);
      let pagePins = [];
      let nextCursor = null;

      try {
        const res = await pinterestFetch(
          url,
          acc.username,
          cookie?.plain || '',
          vaultDb,
          cookie?.id || null
        );

        if (!res.ok) {
          const status = res.status;
          if (status === 429) {
            consecutiveErrors++;
            rateLimitCooldownUntil = Date.now() + 60000;
            console.warn(`⚠️ [429 RATE LIMIT] Discovery page ${pageCount} hit 429 for @${acc.username}. 60s cooldown.`);
          } else if (status === 401 || status === 403) {
            consecutiveErrors++;
            console.warn(`⚠️ [AUTH ${status}] Cookie authentication failed on page ${pageCount} for @${acc.username}.`);
          } else {
            consecutiveErrors++;
          }

          if (consecutiveErrors >= CFG.CIRCUIT_BREAKER) {
            circuitBroken = true;
            grandSummary.errors.push(`circuit-breaker: @${acc.username}`);
            console.error(`[CIRCUIT BREAKER] Hit ${CFG.CIRCUIT_BREAKER} consecutive errors on @${acc.username}. Aborting.`);
            break;
          }
          console.warn(`⚠️ Discovery page ${pageCount} failed for @${acc.username} (HTTP ${status}). Retrying next iteration.`);
          continue;
        }

        consecutiveErrors = 0;
        const payload = await res.json();
        const rr = payload?.resource_response || {};
        pagePins = rr.data || [];
        nextCursor = rr.bookmark || null;
      } catch (err) {
        consecutiveErrors++;
        console.error(`❌ Discovery fetch error on page ${pageCount} for @${acc.username}:`, err.message);
        if (consecutiveErrors >= CFG.CIRCUIT_BREAKER) {
          circuitBroken = true;
          grandSummary.errors.push(`circuit-breaker: @${acc.username}`);
          break;
        }
        continue;
      }

      if (!Array.isArray(pagePins) || pagePins.length === 0) {
        console.log(`ℹ️ Page ${pageCount}: No pins returned. Stopping discovery pagination.`);
        hasMore = false;
        break;
      }

      // Check how many pins on this page are already known / after watermark
      let pageNewPinsCount = 0;
      const formattedPagePins = pagePins.map(mapDiscoveryPin);

      for (const p of formattedPagePins) {
        if (!p.pin_id) continue;
        allPinsForSheet.push(p);

        if (!knownPinIds.has(p.pin_id)) {
          const pinCreatedAtMs = p.created_at_pinterest ? new Date(p.created_at_pinterest).getTime() : 0;
          const isAfterWatermark = watermarkMs === 0 || pinCreatedAtMs >= watermarkMs;

          if (isAfterWatermark) {
            pageNewPinsCount++;
          }

          const doesQualify = qualifies(p, wsSetting);
          if (doesQualify) {
            p.archived_at = new Date().toISOString();
            qualifyingForDb.push(p);
            knownPinIds.add(p.pin_id);
            grandSummary.qualifyingPins++;
            grandSummary.newPins++;
          }
        }
      }

      console.log(`📄 Page ${pageCount}: ${pagePins.length} pins fetched (${pageNewPinsCount} new, ${pagePins.length - pageNewPinsCount} known).`);

      // Early-stop check: stop after K consecutive pages of all-known pins
      const inBackfill = acc.backfill_status === 'in_progress';
      if (pageNewPinsCount === 0 && knownPinIds.size > 0 && !IS_AUDIT_SWEEP && !inBackfill) {
        consecutiveKnownPages++;
        console.log(`⏳ Consecutive all-known pages: ${consecutiveKnownPages}/${discoveryStopPages}`);
        if (consecutiveKnownPages >= discoveryStopPages) {
          console.log(`🛑 Early-stop threshold reached (${discoveryStopPages} consecutive all-known pages). Terminating discovery.`);
          hasMore = false;
          break;
        }
      } else {
        consecutiveKnownPages = 0;
      }

      if (nextCursor && nextCursor !== '-end-' && nextCursor !== cursor) {
        cursor = nextCursor;
      } else {
        hasMore = false;
      }
    }

    const newPinsCount = qualifyingForDb.length;
    console.log(`\n📊 Discovery summary for @${acc.username}: ${pageCount} pages, ${newPinsCount} qualifying pins discovered for DB, ${allPinsForSheet.length} total pins for Sheet.`);

    // 4. Push qualifying pins to Ingest API in batches ≤ maxBatchPins
    let pushedToIngest = 0;
    if (qualifyingForDb.length > 0) {
      console.log(`📤 Pushing ${qualifyingForDb.length} qualifying pins to /api/internal/pinarchive/ingest...`);
      for (let i = 0; i < qualifyingForDb.length; i += maxBatchPins) {
        const batch = qualifyingForDb.slice(i, i + maxBatchPins);
        const res = await pushToIngest(
          acc.workspace_id,
          acc.username,
          batch,
          acc.follower_count,
          { pins_count: knownPinIds.size, last_result: `discovery +${newPinsCount}` }
        );
        if (res.ok) {
          pushedToIngest += res.pushed || batch.length;
        } else {
          console.error(`❌ Ingest batch push failed: ${res.error}`);
          grandSummary.errors.push(`ingest: ${res.error}`);
          if (res.terminal) break;
        }
      }
    }

    // 5. Push all pins to GAS writer (sheet_write mode=update)
    let sheetPushed = 0;
    if (allPinsForSheet.length > 0 && PINARCHIVE_GAS_URL) {
      console.log(`📑 Writing ${allPinsForSheet.length} pins to Google Sheet via GAS writer (mode=update)...`);
      for (let i = 0; i < allPinsForSheet.length; i += maxBatchPins) {
        const batch = allPinsForSheet.slice(i, i + maxBatchPins);
        const gasRes = await writeToGas(PINARCHIVE_GAS_URL, PINARCHIVE_INGEST_SECRET, {
          workspace_id: acc.workspace_id,
          username: acc.username,
          mode: 'update',
          rows: batch,
        });
        if (gasRes?.ok) {
          const writtenCount = gasRes.written ?? batch.length;
          sheetPushed += writtenCount;
          grandSummary.sheetPushed += writtenCount;
        }
      }
    }

    // 6. Update pa_accounts metadata & next_run_at
    const intervalDays = Number(acc.interval_days || 3);
    const nextRunAt = hasMore && cursor && !circuitBroken
      ? new Date().toISOString()
      : new Date(Date.now() + intervalDays * 86400000).toISOString();

    const lastResult = `pages=${pageCount} +${newPinsCount} qual=${newPinsCount} sheet=${sheetPushed}${circuitBroken ? ' (circuit-broken)' : ''}`;

    await supaPatch('pa_accounts', `workspace_id=eq.${acc.workspace_id}&id=eq.${acc.id}`, {
      next_run_at: nextRunAt,
      last_run_at: new Date().toISOString(),
      backfill_status: circuitBroken ? (acc.backfill_status || 'in_progress') : (hasMore && cursor ? 'in_progress' : 'done'),
      backfill_cursor: circuitBroken ? (acc.backfill_cursor || cursor) : (hasMore && cursor ? cursor : null),
      last_result: lastResult,
      pins_count: knownPinIds.size,
    });

    // Record run telemetry in pa_runs
    await supaInsert('pa_runs', {
      workspace_id: acc.workspace_id,
      account_id: acc.id,
      trigger: 'backfill',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      pages_fetched: pageCount,
      pins_added: newPinsCount,
      pins_updated: 0,
      pins_promoted: 0,
      status: circuitBroken ? 'failed' : 'completed',
      message: lastResult,
    });
  }

  console.log(`\n==================================================`);
  console.log(`🎉 Discovery Complete!`);
  console.log(`Accounts: ${grandSummary.accounts} | Pages: ${grandSummary.pages} | New Qualifying Pins: ${grandSummary.qualifyingPins} | Sheet Pushed: ${grandSummary.sheetPushed} | Errors: ${grandSummary.errors.length}`);

  if (grandSummary.errors.length > 0 && grandSummary.newPins === 0 && grandSummary.accounts > 0) {
    process.exit(1);
  }
}

export {
  mapDiscoveryPin,
  qualifies,
  buildDiscoveryUrl,
  getDiscoveryHeaders,
  getVaultCookie,
  decryptCookieValue,
  resolveKek,
  writeToGas,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error('💥 Fatal error in discovery pipeline:', err);
    process.exit(1);
  });
}
