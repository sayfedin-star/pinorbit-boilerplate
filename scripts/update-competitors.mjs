// Node 22. Proven Pinterest scraping headers + DB vault + job tracking + self-heal.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (existing).
// Vault: encrypted cookies in pinterest_cookies (KEK from competitor_kek table).
// Jobs: per-workspace tracking in competitor_ingestion_jobs.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const enc = new TextEncoder(); const dec = new TextDecoder();
const b64 = b => btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b))));
const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// ── AES-GCM (v1:iv:ct, SHA-256(kek)) — same format as token-crypto.ts ──
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
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(ivB64) }, await aesKey(kek, 'decrypt'), ub64(ctB64)));
  } catch { return null; }
}
async function resolveKek(db) {
  const { data } = await db.from('competitor_kek').select('kek').limit(1).maybeSingle();
  if (data?.kek) return data.kek;
  const hex = crypto.randomBytes(32).toString('hex');
  await db.from('competitor_kek').upsert({ id: true, kek: hex }, { onConflict: 'id', ignoreDuplicates: true });
  const { data: d2 } = await db.from('competitor_kek').select('kek').limit(1).maybeSingle();
  return d2?.kek || null;
}

// ── PROVEN headers (verbatim from working old script — Chrome 151) ──
function getHeaders(username, activeCookie) {
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,fr;q=0.7,ar;q=0.6,de;q=0.5',
    priority: 'u=1, i',
    'screen-dpr': '1.25',
    'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
    'sec-ch-ua-full-version-list': '"Not=A?Brand";v="99.0.0.0", "Google Chrome";v="151.0.7922.76", "Chromium";v="151.0.7922.76"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-platform-version': '"19.0.0"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-app-version': '9302641',
    'x-b3-flags': '0',
    'x-pinterest-appstate': 'background',
    'x-pinterest-pws-handler': `www/${username}.js`,
    'x-pinterest-source-url': `/${username}/`,
    'x-requested-with': 'XMLHttpRequest',
    Referer: `https://www.pinterest.com/${username}/`,
    cookie: activeCookie || '',
  };
}

// ── Cookie vault picker + one-time legacy import ──
async function getVaultCookie(db, wsId, kek) {
  const { data } = await db.from('pinterest_cookies').select('id, cookie_value')
    .eq('workspace_id', wsId).eq('is_active', true)
    .order('last_used_at', { ascending: true, nullsFirst: true }).limit(5);
  for (const c of data || []) {
    const plain = await decryptCookieValue(c.cookie_value, kek);
    if (plain) {
      await db.from('pinterest_cookies').update({ last_used_at: new Date().toISOString() }).eq('id', c.id);
      return { id: c.id, plain };
    }
  }
  // ONE-TIME legacy auto-import from env
  const legacy = process.env.PINTEREST_COOKIE;
  if (legacy && legacy.trim().length >= 20) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(kek, 'encrypt'), enc.encode(legacy.trim()));
    const enc = `v1:${b64(iv)}:${b64(ct)}`;
    await db.from('pinterest_cookies').insert({ workspace_id: wsId, cookie_value: enc, is_active: true });
    console.log(`🔐 Legacy PINTEREST_COOKIE auto-imported into vault for ws ${wsId}. You may delete that GitHub secret.`);
    return { id: 'legacy', plain: legacy.trim() };
  }
  return null;
}

// ── Self-heal: 401/403 on vault cookie → disable it and retry anonymously ──
async function pinterestFetch(url, username, cookiePlain, maxRetries = 3) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const res = await fetch(url, { method: 'GET', headers: getHeaders(username, cookiePlain), signal: AbortSignal.timeout(15000) });
      return res;
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000 + Math.random() * 500));
      attempt++;
    }
  }
}

// ── Resource URLs ──
const resourceUrl = (username, resource, options) =>
  `https://www.pinterest.com/resource/${resource}/get/?source_url=%2F${username}%2F&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}&_=${Date.now()}`;

// ── Main: per-workspace processing ──
async function processWorkspace(db, wsId, kek, options = {}) {
  const now = new Date().toISOString();
  const cookie = await getVaultCookie(db, wsId, kek);
  if (!cookie) {
    return { ok: false, error: 'No Pinterest cookie available in vault for this workspace' };
  }
  console.log(`🍪 [${wsId.slice(0, 8)}] using vault cookie ${cookie.id.slice(0, 8)}`);

  let query = db.from('competitors').select('id, username').eq('workspace_id', wsId);
  
  if (!options.forceRun) {
    query = query.eq('is_active', true);
  }

  const { data: allComps, error } = await query;
  if (error || !allComps) return { ok: false, error: error?.message || 'fetch failed' };

  let comps = allComps;

  // Filter by competitor_ids if provided (scope = 'selected')
  if (options.competitorIds && options.competitorIds.length > 0) {
    const idSet = new Set(options.competitorIds);
    comps = comps.filter(c => idSet.has(c.id));
  } else if (options.targetUsername && options.targetUsername.trim()) {
    const targetU = options.targetUsername.trim().toLowerCase();
    comps = comps.filter(c => c.username.toLowerCase() === targetU);
  }

  if (comps.length === 0) return { ok: true, processed: 0, errors: [] };

  const errors = [];
  let processed = 0;

  for (const comp of comps) {
    const username = comp.username.trim();
    console.log(`\n--------------------------------------------------`);
    console.log(`🔍 Processing Competitor (${processed + 1}/${comps.length}): @${username}`);

    try {
      // ── STEP 1: Profile (with self-heal on 401/403) ──
      let activeCookie = cookie.plain;
      let userUrl = resourceUrl(username, 'UserResource', { username, field_set_key: 'profile' });
      let userRes = await pinterestFetch(userUrl, username, activeCookie);
      if ((userRes.status === 401 || userRes.status === 403) && cookie.id !== 'legacy') {
        console.warn(`🚫 Cookie disabled for @${username} (HTTP ${userRes.status}) — retrying anonymously.`);
        await db.from('pinterest_cookies').update({ is_active: false }).eq('id', cookie.id);
        activeCookie = '';
        userRes = await pinterestFetch(userUrl, username, activeCookie);
      }
      if (!userRes.ok) {
        console.warn(`⚠️ UserResource HTTP ${userRes.status} for @${username}. Skipping profile update.`);
      } else {
        const userPayload = await userRes.json();
        const userData = userPayload?.resource_response?.data;
        if (userData) {
          const profileViews = userData.profile_views ?? userData.monthly_views ?? userData.profile_reach ?? 0;
          const profileReach = userData.profile_reach ?? userData.profile_views ?? userData.monthly_views ?? 0;
          const followers = userData.follower_count || 0;
          const pins = userData.pin_count || 0;
          const fullName = userData.full_name || username;
          const websiteUrl = userData.website_url || (userData.domain_url ? `https://${userData.domain_url}` : null);
          const domainVerified = !!userData.domain_verified;
          const lastPinAt = userData.last_pin_save_time ? new Date(userData.last_pin_save_time).toISOString() : null;

          if (!options.dryRun) {
            await db.from('competitors').update({
              full_name: fullName, profile_reach: profileReach, profile_views: profileViews,
              follower_count: followers, pin_count: pins, website_url: websiteUrl,
              domain_verified: domainVerified, last_pin_at: lastPinAt, last_checked_at: now,
            }).eq('id', comp.id);
            await db.from('competitor_snapshots').insert({ competitor_id: comp.id, profile_reach: profileReach, profile_views: profileViews, follower_count: followers, pin_count: pins, recorded_at: now });
            await db.from('competitor_daily_snapshots').upsert({ competitor_id: comp.id, snapshot_date: now.slice(0, 10), profile_reach: profileReach, profile_views: profileViews, follower_count: followers, pin_count: pins }, { onConflict: 'competitor_id,snapshot_date' });
          }
          console.log(`✅ Profile Updated -> Reach: ${profileReach.toLocaleString()}, Views: ${profileViews.toLocaleString()}, Followers: ${followers.toLocaleString()}, Pins: ${pins.toLocaleString()}`);
        } else {
          console.warn(`⚠️ Invalid UserResource data structure for @${username}.`);
        }
      }

      // ── STEP 2: Boards (bookmark pagination, up to 20 pages) ──
      let allBoards = []; let bookmark = null; let hasMore = true; let pageCount = 0;
      const maxPages = 20;
      while (hasMore && pageCount < maxPages) {
        pageCount++;
        const optionsPayload = {
          username, field_set_key: 'profile_grid_item', privacy_filter: 'all',
          sort: 'last_pinned_to', filter_stories: false, page_size: 50,
          group_by: 'visibility', include_archived: true, filter_all_pins: false,
          add_fields: 'board.{meal_plan}',
        };
        if (bookmark) optionsPayload.bookmarks = [bookmark];
        const boardsUrl = resourceUrl(username, 'BoardsResource', optionsPayload);
        try {
          let boardsRes = await pinterestFetch(boardsUrl, username, activeCookie);
          if (!boardsRes.ok) {
            console.warn(`⚠️ BoardsResource HTTP ${boardsRes.status} on page ${pageCount} for @${username}. Stopping pagination.`);
            break;
          }
          const boardsPayload = await boardsRes.json();
          const responseData = boardsPayload?.resource_response;
          const boardsList = responseData?.data || [];
          allBoards.push(...boardsList.filter(b => b.type === 'board' || !b.type));
          const nextBookmark = responseData?.bookmark;
          if (nextBookmark && nextBookmark !== '-end-' && boardsList.length > 0) bookmark = nextBookmark;
          else hasMore = false;
        } catch (err) {
          console.error(`❌ Error fetching boards page ${pageCount} for @${username}:`, err.message);
          break;
        }
      }
      if (allBoards.length > 0 && !options.dryRun) {
        const boardsToUpsert = allBoards.map(b => {
          const boardUrl = b.url ? (b.url.startsWith('http') ? b.url : `https://www.pinterest.com${b.url}`) : `https://www.pinterest.com/${username}/`;
          const realCreatedAt = b.created_at ? new Date(b.created_at).toISOString() : now;
          const realLastPinnedAt = (b.board_order_modified_at || b.last_pinned_by_owner_at || b.last_pinned_at) ? new Date(b.board_order_modified_at || b.last_pinned_by_owner_at || b.last_pinned_at).toISOString() : now;
          return {
            competitor_id: comp.id, board_id: String(b.id || b.node_id),
            name: b.name || 'Untitled Board', description: b.description || '',
            pin_count: b.pin_count || 0, follower_count: b.follower_count || 0,
            url: boardUrl, board_created_at: realCreatedAt, last_pinned_at: realLastPinnedAt,
          };
        });
        const { error: boardError } = await db.from('competitor_boards').upsert(boardsToUpsert, { onConflict: 'competitor_id, board_id' });
        if (boardError) console.warn(`⚠️ Boards Upsert Warning for @${username}:`, boardError.message);
        else console.log(`📋 Ingested ALL ${boardsToUpsert.length} Board(s) across ${pageCount} page(s) with REAL creation dates for @${username}.`);
      } else if (!allBoards.length) {
        console.log(`ℹ️ No public boards found for @${username}.`);
      }

      processed++;

      // Real-time telemetry update to competitor_ingestion_jobs table for live UI polling
      if (options.jobId) {
        await db.from('competitor_ingestion_jobs').update({
          items_processed: processed,
          error_message: errors.length ? errors.join(' | ').slice(0, 2000) : null,
        }).eq('id', options.jobId);
      }
    } catch (err) {
      console.error(`❌ Error processing @${username}:`, err.message);
      errors.push(`@${username}: ${err.message}`);
    }
  }

  return { ok: true, processed, errors };
}

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) { console.error('❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const kek = await resolveKek(db);
  if (!kek) { console.error('❌ KEK unavailable'); process.exit(1); }

  const DRY_RUN = process.env.DRY_RUN === 'true';
  if (DRY_RUN) console.log('⚠️ DRY_RUN mode — no writes will be performed.');

  // Parse Scope & Inputs
  const targetScope = process.env.TARGET_SCOPE || 'All Active';
  const targetUsername = process.env.TARGET_USERNAME || '';
  const rawCompIds = process.env.COMPETITOR_IDS || '';
  const competitorIds = rawCompIds ? rawCompIds.split(',').map(s => s.trim()).filter(Boolean) : [];
  const forceRun = Boolean(process.env.FORCE_RUN === 'true');
  const targetWsId = process.env.WORKSPACE_ID || null;
  const inputJobId = process.env.JOB_ID || null;

  let workspaces = [];
  if (targetWsId) {
    workspaces = [targetWsId];
  } else {
    const { data: wsRows } = await db.from('competitors').select('workspace_id').eq('is_active', true);
    workspaces = [...new Set((wsRows || []).map(r => r.workspace_id))];
  }

  console.log(`🚀 Execution Scope: ${targetScope} | Workspaces: ${workspaces.length} | Competitors Filter: ${competitorIds.length ? competitorIds.length : 'All'} | DRY_RUN=${DRY_RUN} | FORCE=${forceRun}`);

  // Check Master Workspace Global Kill-Switch for scheduled pipeline runs
  const isGhScheduled = (process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || '').trim().toLowerCase() === 'schedule';
  if (isGhScheduled) {
    try {
      const p1Url = process.env.SCHEDULING_SUPABASE_URL || process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || '';
      const p1Key = process.env.SCHEDULING_SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      if (p1Url && p1Key) {
        const p1Res = await fetch(`${p1Url}/rest/v1/workspaces?select=id,is_master&is_master=eq.true&limit=1`, {
          headers: { apikey: p1Key, Authorization: `Bearer ${p1Key}`, Accept: 'application/json' },
        });
        if (p1Res.ok) {
          const masterWorkspaces = await p1Res.json();
          if (Array.isArray(masterWorkspaces) && masterWorkspaces.length > 0) {
            const masterId = masterWorkspaces[0].id;
            const { data: masterPipe } = await db.from('competitor_pipeline_settings').select('github_schedule_enabled').eq('workspace_id', masterId).maybeSingle();
            if (masterPipe && masterPipe.github_schedule_enabled === false) {
              console.log(`[GLOBAL SKIP] GitHub Actions 02:00 UTC schedule is globally disabled by Master Workspace (${masterId.slice(0, 8)}). Exiting immediately.`);
              return;
            }
          }
        }
      }
    } catch (err) {
      // Non-blocking fallback
    }
  }

  let anyFatal = false;
  let grandProcessed = 0;

  for (const wsId of workspaces) {
    // Check per-workspace pipeline settings
    const { data: wsPipe } = await db.from('competitor_pipeline_settings').select('is_enabled, github_schedule_enabled, dry_run').eq('workspace_id', wsId).maybeSingle();
    const isGhScheduled = (process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || '').trim().toLowerCase() === 'schedule';

    if (isGhScheduled && wsPipe && wsPipe.github_schedule_enabled === false) {
      console.log(`[SKIP] Workspace ${wsId.slice(0, 8)} GitHub Actions 02:00 UTC schedule is disabled (delegated to FastCron).`);
      continue;
    }

    if (wsPipe && wsPipe.is_enabled === false && !forceRun) {
      console.log(`[SKIP] Workspace ${wsId.slice(0, 8)} pipeline is disabled.`);
      continue;
    }

    let jobId = (inputJobId && (targetWsId === wsId || workspaces.length === 1)) ? inputJobId : null;

    if (!jobId) {
      const runTrigger = process.env.RUN_TRIGGER || (process.env.EVENT_NAME === 'schedule' ? 'cron' : 'manual');
      const { data: job } = await db.from('competitor_ingestion_jobs').insert({
        workspace_id: wsId,
        competitor_id: competitorIds.length === 1 ? competitorIds[0] : null,
        status: 'running',
        trigger: runTrigger,
        items_processed: 0,
        started_at: new Date().toISOString(),
      }).select('id').single();
      if (job) jobId = job.id;
    } else {
      await db.from('competitor_ingestion_jobs').update({
        status: 'running',
        started_at: new Date().toISOString(),
      }).eq('id', jobId);
    }

    const r = await processWorkspace(db, wsId, kek, {
      targetUsername,
      competitorIds,
      jobId,
      forceRun,
      dryRun: DRY_RUN,
    });

    if (jobId) {
      await db.from('competitor_ingestion_jobs').update({
        status: !r.ok || (r.processed === 0 && !DRY_RUN && competitorIds.length > 0) ? 'failed' : 'completed',
        items_processed: DRY_RUN ? 0 : r.processed,
        error_message: r.ok ? (r.errors.length ? r.errors.join(' | ').slice(0, 2000) : null) : r.error,
        completed_at: new Date().toISOString(),
      }).eq('id', jobId);
    }

    if (!r.ok) {
      anyFatal = true;
      console.error(`❌ ws ${wsId}: ${r.error}`);
    }
    grandProcessed += r.processed || 0;
  }

  console.log(`\n🎉 Competitor sync complete! (${grandProcessed} profile(s) across ${workspaces.length} workspace(s))`);
  process.exit(anyFatal && grandProcessed === 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('💥 Fatal:', e);
  const inputJobId = process.env.JOB_ID || null;
  if (inputJobId) {
    try {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (SUPABASE_URL && SERVICE_KEY) {
        const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        await db.from('competitor_ingestion_jobs').update({
          status: 'failed',
          error_message: `Workflow crash: ${e.message || String(e)}`,
          completed_at: new Date().toISOString(),
        }).eq('id', inputJobId);
      }
    } catch (fatalDbErr) {
      console.error('❌ Failed to update job status on fatal error:', fatalDbErr?.message || fatalDbErr);
    }
  }
  process.exit(1);
});
