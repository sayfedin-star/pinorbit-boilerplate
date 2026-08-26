/**
 * PinArchive Refresh: fetches updated metrics & relay enrichment for archived pins and pushes deltas.
 * Env Vars: PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, PINORBIT_WORKER_URL, PINARCHIVE_INGEST_SECRET
 */

import { fileURLToPath } from 'url';
import path from 'path';

const CFG = {
  SLEEP_MS_MIN: 2500,
  SLEEP_MS_MAX: 4000,
  BATCH_SIZE: 12,
  PUSH_SLEEP_MS: 3000,
  CIRCUIT_BREAKER: 3,
  CONCURRENCY: 3,
  MAX_PINS: parseInt(process.env.REFRESH_MAX_PINS || '0', 10) || 0,
};

const SHARD_COUNT = Math.max(1, parseInt(process.env.SHARD_COUNT || '1', 10) || 1);
const REFRESH_SHARD = Math.max(0, parseInt(process.env.REFRESH_SHARD || '0', 10) || 0);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'upgrade-insecure-requests': '1',
  'Cache-Control': 'no-cache',
};

const { PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, PINORBIT_WORKER_URL, PINARCHIVE_INGEST_SECRET } = process.env;

const REFRESH_WORKSPACE_ID = (process.env.REFRESH_WORKSPACE_ID || '').trim();
const REFRESH_USERNAME = (process.env.REFRESH_USERNAME || '').trim().toLowerCase();
const REFRESH_USERNAMES = (process.env.REFRESH_USERNAMES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function checkEnv() {
  const missing = [];
  if (!PINARCHIVE_SUPABASE_URL) missing.push('PINARCHIVE_SUPABASE_URL');
  if (!PINARCHIVE_SUPABASE_KEY) missing.push('PINARCHIVE_SUPABASE_KEY');
  if (!PINORBIT_WORKER_URL) missing.push('PINORBIT_WORKER_URL');
  if (!PINARCHIVE_INGEST_SECRET) missing.push('PINARCHIVE_INGEST_SECRET');
  if (missing.length) { console.error(`Missing env vars: ${missing.join(', ')}`); process.exit(1); }
}

async function supaQuery(table, params = '') {
  const url = `${PINARCHIVE_SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const res = await fetch(url, {
    headers: { 'apikey': PINARCHIVE_SUPABASE_KEY, 'Authorization': `Bearer ${PINARCHIVE_SUPABASE_KEY}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: HTTP ${res.status}`);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function randomJitterMs(min = CFG.SLEEP_MS_MIN, max = CFG.SLEEP_MS_MAX) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.count--;
    if (this.queue.length > 0) {
      this.count++;
      const next = this.queue.shift();
      next();
    }
  }
}

function findPinInTree(obj, pinId, depth = 0) {
  if (depth > 20 || !obj || typeof obj !== 'object') return null;
  if (String(obj.id) === pinId && (obj.aggregated_pin_data || obj.aggregatedStats || obj.repin_count !== undefined || obj.repinCount !== undefined)) return obj;
  if (String(obj.entityId) === pinId) return obj;
  if (obj[pinId] && typeof obj[pinId] === 'object') return obj[pinId];
  for (const key of Object.keys(obj)) {
    const found = findPinInTree(obj[key], pinId, depth + 1);
    if (found) return found;
  }
  return null;
}

function formatPin(pin) {
  const st = pin?.aggregated_pin_data?.aggregated_stats
    || pin?.aggregatedPinData?.aggregatedStats
    || pin?.aggregatedStats || {};

  // --- annotations: annotationsWithLinksArray (rich) + visualAnnotation fallback ---
  const withLinks = pin?.pin_join?.annotationsWithLinksArray
    || pin?.pinJoin?.annotationsWithLinksArray
    || pin?.annotationsWithLinksArray || [];
  const visual = pin?.pin_join?.visual_annotation
    || pin?.visual_annotation
    || pin?.pinJoin?.visualAnnotation
    || pin?.visualAnnotation || [];
  const annotationsMap = new Map();
  for (const item of (Array.isArray(withLinks) ? withLinks : [])) {
    if (item?.name && !annotationsMap.has(item.name)) {
      annotationsMap.set(item.name, {
        name: item.name,
        idea_id: String(item.url || '').match(/\/ideas\/[^/]+\/(\d+)/)?.[1] || null,
        url: item.url || null,
      });
    }
  }
  for (const name of (Array.isArray(visual) ? visual : [])) {
    if (typeof name === 'string' && name.trim() && !annotationsMap.has(name)) {
      annotationsMap.set(name, { name, idea_id: null, url: null });
    }
  }
  const annotations = Array.from(annotationsMap.values());

  // --- NEW: reactions ---
  const reactionsPayload = pin?.reactionCountsData || pin?.reactions || [];
  const reactionsMap = {};
  if (Array.isArray(reactionsPayload)) {
    for (const r of reactionsPayload) {
      if (r?.reactionType !== undefined) {
        reactionsMap[`type_${r.reactionType}`] = r.reactionCount;
      }
    }
  }
  reactionsMap.total = Number(pin?.totalReactionCount || pin?.reactions_total || 0);

  // --- canonical_pin_id: pinJoin.canonicalPin.entityId ?? pin_join.canonical_pin?.id ?? (seoCanonicalUrl match /(\d+)\/?$/ -> id) ---
  const canonicalPinId = pin?.pinJoin?.canonicalPin?.entityId
    ?? pin?.pin_join?.canonical_pin?.id
    ?? (pin?.canonical_pin_id ? String(pin.canonical_pin_id) : null)
    ?? (typeof pin.seoCanonicalUrl === 'string' ? pin.seoCanonicalUrl.match(/(\d+)\/?$/)?.[1] : null)
    ?? (typeof pin.seo_canonical_url === 'string' ? pin.seo_canonical_url.match(/(\d+)\/?$/)?.[1] : null)
    ?? null;

  return {
    // existing
    saves: Number(st.saves || pin.saves || 0),
    repins: Number(pin.repinCount || pin.repin_count || pin.repins || 0),
    comments: Number(pin?.aggregated_pin_data?.commentCount || pin?.aggregatedPinData?.commentCount || pin?.commentCount || pin?.comment_count || pin.comments || 0),
    title: pin.title || pin.gridTitle || pin.grid_title || '',
    description: pin.description || pin.gridDescription || pin.grid_description || '',
    link: pin.link || '',
    utm_link: pin.utmLink ?? pin.utm_link ?? null,
    domain: pin.domain || '',
    board_name: pin.board?.name || pin.pinner?.username || '',
    board_id: pin.board?.entityId ?? pin.board?.id ?? null,
    image_url: pin.images_orig?.url || pin.images?.orig?.url || pin.image_large_url || '',
    dominant_color: pin.dominantColor || pin.dominant_color || null,
    image_signature: pin.imageSignature || pin.image_signature || null,
    node_id: pin.id || pin.node_id || null,
    created_at_pinterest: pin.createdAt || pin.created_at || null,
    is_video: Boolean(pin.isVideo || pin.is_video),
    reactions: reactionsMap,

    // NEW enriched fields
    annotations: annotations,
    seo_category: pin?.pinJoin?.seoBreadcrumbs?.[0]?.name || pin?.pin_join?.seo_breadcrumbs?.[0]?.name || pin?.seo_category || pin?.category || null,
    canonical_pin_id: canonicalPinId,
    seo_alt_text: pin.seoAltText || pin.seo_alt_text || pin?.alt_text || null,
    share_count: Number(pin.shareCount ?? pin.share_count ?? pin?.pin_join?.share_count ?? 0),
    board_pin_count: typeof pin.board?.pinCount === 'number' ? pin.board.pinCount : (typeof pin.board?.pin_count === 'number' ? pin.board.pin_count : (typeof pin?.board?.pin_count === 'number' ? pin.board.pin_count : null)),
    board_last_modified_at: pin.board?.boardOrderModifiedAt || pin.board?.last_modified_at || pin?.board?.board_order_updated_at || null,
    follower_count: typeof pin?.pinner?.followerCount === 'number' ? pin.pinner.followerCount : (typeof pin?.pinner?.follower_count === 'number' ? pin.pinner.follower_count : (typeof pin?.origin_pinner?.follower_count === 'number' ? pin.origin_pinner.follower_count : null)),
  };
}

function extractPinData(html, pinId) {
  const blocks = [];

  // 1. Relay completed request blocks (first pattern)
  for (const [, content] of html.matchAll(
    /window\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\("[^"]+",\s*([\s\S]*?)\}\s*\);/g
  )) {
    try {
      const parsed = JSON.parse(content + '}');
      const pinObj = parsed?.data?.v3GetPinQueryv2?.data;
      if (pinObj) {
        const pinB64 = `UGluOj${Buffer.from(pinId).toString('base64').replace(/=+$/, '')}`;
        if (String(pinObj.entityId) === pinId || String(pinObj.id) === pinId
            || pinObj.id === pinB64 || pinObj.pinJoin || pinObj.reactionCountsData) {
          blocks.push(pinObj);
        }
      }
    } catch (e) {}
  }

  // 2. Application json scripts
  const jsonBlobs = [...html.matchAll(/<script[^>]*type\s*=\s*"application\/json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, content] of jsonBlobs) {
    if (!content.includes(pinId)) continue;
    try {
      const data = JSON.parse(content);
      const pin = findPinInTree(data, pinId);
      if (pin) blocks.push(pin);
    } catch (e) {}
  }

  // 3. __PWS_DATA__
  const pwsMatch = html.match(/<script[^>]+id\s*=\s*"__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/i) || html.match(/id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (pwsMatch) {
    try {
      const pws = JSON.parse(pwsMatch[1]);
      const pin = pws?.props?.initialReduxState?.pins?.[pinId]
        || pws?.props?.relayContext?.relayData?.[pinId]
        || pws?.props?.relayContext?.rootFeed
        || findPinInTree(pws, pinId);
      if (pin) {
        const direct = pin.aggregated_pin_data || pin.saves !== undefined ? pin : findPinInTree(pin, pinId);
        if (direct) blocks.push(direct);
      }
    } catch (e) {}
  }

  // 4. relay-preloaded-queries
  const relayMatch = html.match(/id="relay-preloaded-queries"[^>]*>([\s\S]*?)<\/script>/);
  if (relayMatch) {
    try {
      const queries = JSON.parse(relayMatch[1]);
      for (const key of Object.keys(queries)) {
        const found = findPinInTree(queries[key], pinId);
        if (found) blocks.push(found);
      }
    } catch (e) {}
  }

  // 5. initial-data-feed
  const feedMatch = html.match(/id="initial-data-feed"[^>]*>([\s\S]*?)<\/script>/);
  if (feedMatch) {
    try {
      const feed = JSON.parse(feedMatch[1]);
      const found = findPinInTree(feed, pinId);
      if (found) blocks.push(found);
    } catch (e) {}
  }

  // 6. window.__INITIAL_DATA__
  const initMatch = html.match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (initMatch) {
    try {
      const init = JSON.parse(initMatch[1]);
      const found = findPinInTree(init, pinId);
      if (found) blocks.push(found);
    } catch (e) {}
  }

  if (blocks.length > 0) {
    const merged = {};
    for (const b of blocks) {
      for (const [k, v] of Object.entries(b)) {
        if (v !== null && v !== undefined) {
          if (typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object' && !Array.isArray(merged[k])) {
            merged[k] = { ...merged[k], ...v };
          } else {
            merged[k] = v;
          }
        }
      }
    }
    const savesM = html.match(/"saves"\s*:\s*(\d+)/);
    if (savesM && !merged.saves && !merged.aggregated_pin_data?.aggregated_stats?.saves && !merged.aggregatedStats?.saves) {
      merged.saves = parseInt(savesM[1]);
    }
    const commentsM = html.match(/"comment_count"\s*:\s*(\d+)/) || html.match(/"commentCount"\s*:\s*(\d+)/);
    if (commentsM && !merged.comments && !merged.commentCount && !merged.comment_count && !merged.aggregated_pin_data?.commentCount) {
      merged.commentCount = parseInt(commentsM[1]);
    }
    return formatPin(merged);
  }

  // Fallback: JSON-LD fallback (rich metadata but basic metrics)
  const jsonLdMatch = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld && (ld['@type'] === 'SocialMediaPosting' || ld['@type'] === 'ImageObject' || ld.interactionStatistic)) {
        let saves = 0;
        let comments = 0;
        const stats = Array.isArray(ld.interactionStatistic) ? ld.interactionStatistic : (ld.interactionStatistic ? [ld.interactionStatistic] : []);
        for (const s of stats) {
          if (s.interactionType && s.interactionType.includes('LikeAction')) saves = Number(s.userInteractionCount || 0);
          if (s.interactionType && s.interactionType.includes('CommentAction')) comments = Number(s.userInteractionCount || 0);
        }
        return {
          saves,
          repins: saves,
          comments,
          title: ld.headline || ld.name || '',
          description: ld.articleBody || ld.description || '',
          link: ld.url || '',
          utm_link: null,
          domain: '',
          board_name: '',
          board_id: null,
          created_at_pinterest: ld.datePublished || null,
          image_url: Array.isArray(ld.image) ? ld.image[0] : (typeof ld.image === 'string' ? ld.image : (ld.image?.url || '')),
          dominant_color: null,
          image_signature: null,
          node_id: null,
          is_video: ld['@type'] === 'VideoObject',
          reactions: undefined,
          annotations: undefined,
          seo_category: ld.articleSection || null,
          canonical_pin_id: null,
          seo_alt_text: null,
          share_count: undefined,
          board_pin_count: null,
          board_last_modified_at: null,
          follower_count: null,
          _source: 'jsonld',
        };
      }
    } catch (e) {}
  }

  // Fallback: meta tags regex
  const saveMeta = html.match(/name="pinterest:saves"\s+content="(\d+)"/i) || html.match(/property="pinterest:saves"\s+content="(\d+)"/i);
  const repinMeta = html.match(/name="pinterest:repins"\s+content="(\d+)"/i) || html.match(/property="pinterest:repins"\s+content="(\d+)"/i);
  const titleMeta = html.match(/property="og:title"\s+content="([^"]*)"/i);
  const descMeta = html.match(/property="og:description"\s+content="([^"]*)"/i);
  const imgMeta = html.match(/property="og:image"\s+content="([^"]*)"/i);

  if (saveMeta || repinMeta || titleMeta) {
    return formatPin({
      saves: saveMeta ? parseInt(saveMeta[1], 10) : 0,
      repins: repinMeta ? parseInt(repinMeta[1], 10) : 0,
      title: titleMeta ? titleMeta[1] : '',
      description: descMeta ? descMeta[1] : '',
      image_large_url: imgMeta ? imgMeta[1] : '',
    });
  }

  return null;
}

async function fetchPinFromPinterest(pinId) {
  try {
    const res = await fetch(`https://www.pinterest.com/pin/${pinId}/`, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (res.status !== 200) return { ok: false, code: res.status };
    const html = await res.text();
    const data = extractPinData(html, pinId);
    if (!data) {
      return {
        ok: false,
        code: 200,
        error: 'extraction-failed',
        diag: {
          htmlLen: html.length,
          relay: html.includes('__PWS_RELAY_REGISTER_COMPLETED_REQUEST__'),
          pws: html.includes('__PWS_DATA__'),
          hasPinId: html.includes(pinId),
        },
      };
    }
    return { ok: true, ...data };
  } catch (err) {
    return {
      ok: false,
      code: 0,
      error: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'fetch-timeout-15s' : (err?.message || 'fetch-failed'),
    };
  }
}

async function pushBatch(workspaceId, username, pins, followerCount, totalPins) {
  if (!pins.length) return { ok: true, pushed: 0 };
  const body = {
    run_id: crypto.randomUUID(),
    workspace_id: workspaceId,
    username,
    fetched_at: new Date().toISOString(),
    run_type: 'refresh',
    trigger: 'refresh',
    follower_count: typeof followerCount === 'number' ? followerCount : undefined,
    account_meta: {
      pins_count: Number.isFinite(totalPins) ? totalPins : undefined,
      last_result: 'refresh',
    },
    pins,
  };
  const res = await fetch(`${PINORBIT_WORKER_URL.replace(/\/+$/, '')}/api/internal/pinarchive/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-secret': PINARCHIVE_INGEST_SECRET },
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

async function main() {
  checkEnv();
  console.log('\nPinArchive Refresh starting...\n');

  // Load workspace settings to map gating controls
  const settingsMap = new Map();
  try {
    const wsSettings = await supaQuery('pa_workspace_settings', 'select=workspace_id,ingest_enabled,paused_account_policy,refresh_max_pins');
    if (Array.isArray(wsSettings)) {
      for (const s of wsSettings) {
        settingsMap.set(s.workspace_id, s);
      }
    }
  } catch (e) {
    console.warn('Could not query pa_workspace_settings (using defaults):', e.message);
  }

  let accounts = await supaQuery('pa_accounts', 'select=id,workspace_id,username,follower_count,status,ingest_enabled');
  if (!accounts.length) { console.log('No accounts found.'); return; }

  if (REFRESH_USERNAME) {
    accounts = accounts.filter(a => a.username.toLowerCase() === REFRESH_USERNAME);
    console.log(`Requested single account @${REFRESH_USERNAME}: ${accounts.length} matched in this workspace/shard scope`);
  } else if (REFRESH_USERNAMES.length > 0) {
    const set = new Set(REFRESH_USERNAMES);
    accounts = accounts.filter(a => set.has(a.username.toLowerCase()));
    console.log(`Requested ${REFRESH_USERNAMES.length} account(s): ${accounts.length} matched in this workspace/shard scope`);
  }

  if (!accounts.length) { console.log('No matching accounts found.'); return; }
  console.log(`Found ${accounts.length} account(s)\n`);
  const summary = { refreshed: 0, updated: 0, pushed: 0, errors: [] };

  for (const acc of accounts) {
    const wsSetting = settingsMap.get(acc.workspace_id);
    const wsIngestEnabled = wsSetting ? wsSetting.ingest_enabled : true;
    const pausedPolicy = wsSetting ? wsSetting.paused_account_policy : 'reject';

    // Check workspace-level ingest gate
    if (wsIngestEnabled === false) {
      console.log(`[SKIP] Workspace ${acc.workspace_id} ingest is disabled.`);
      continue;
    }

    // Check account-level ingest gate
    if (acc.ingest_enabled === false) {
      console.log(`[SKIP] Account @${acc.username} ingest is disabled (ingest_enabled=false).`);
      continue;
    }

    // Check paused policy gate
    if (acc.status === 'paused' && pausedPolicy === 'reject') {
      console.log(`[SKIP] Account @${acc.username} is paused (policy=reject).`);
      continue;
    }

    if (REFRESH_WORKSPACE_ID && acc.workspace_id !== REFRESH_WORKSPACE_ID) {
      console.log(`[SKIP] ${acc.username}: outside requested workspace.`); continue;
    }
    if (REFRESH_USERNAME && acc.username.toLowerCase() !== REFRESH_USERNAME) {
      console.log(`[SKIP] ${acc.username}: outside requested account.`); continue;
    }

    // X2: Precedence: env REFRESH_MAX_PINS if set -> else DB setting -> else 0 (unlimited with pagination)
    const envMaxPinsRaw = process.env.REFRESH_MAX_PINS !== undefined && process.env.REFRESH_MAX_PINS.trim() !== ''
      ? parseInt(process.env.REFRESH_MAX_PINS, 10)
      : null;
    const settingsRefreshMaxPins = typeof wsSetting?.refresh_max_pins === 'number' ? wsSetting.refresh_max_pins : null;
    const configuredCap = envMaxPinsRaw !== null && !isNaN(envMaxPinsRaw)
      ? envMaxPinsRaw
      : (settingsRefreshMaxPins !== null && !isNaN(settingsRefreshMaxPins) ? settingsRefreshMaxPins : 0);

    const cap = configuredCap > 0 ? configuredCap : Number.MAX_SAFE_INTEGER;
    const effectiveCap = Math.min(cap, 10000);

    // True pagination loop (1000 per page)
    const allPins = [];
    let offset = 0;
    const PAGE = 1000;
    while (allPins.length < effectiveCap) {
      const fetchLimit = Math.min(PAGE, effectiveCap - allPins.length);
      const chunk = await supaQuery(
        'pa_pins',
        `select=pin_id,saves,repins,comments,share_count,reactions,annotations,seo_category,canonical_pin_id,seo_alt_text,board_pin_count,board_last_modified_at,archived_at,title,description,link,utm_link,domain,board_name,board_id,created_at_pinterest,image_url,dominant_color,image_signature,node_id,is_video,velocity&workspace_id=eq.${acc.workspace_id}&account_id=eq.${acc.id}&order=last_updated_at.asc&limit=${fetchLimit}&offset=${offset}`
      );
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      allPins.push(...chunk);
      if (chunk.length < fetchLimit) break;
      offset += chunk.length;
    }

    const pins = allPins.filter((_, idx) => idx % SHARD_COUNT === REFRESH_SHARD);

    if (!pins.length) continue;
    console.log(`${acc.username}: ${pins.length} pins to refresh (shard ${REFRESH_SHARD + 1}/${SHARD_COUNT} of ${allPins.length} total)`);

    let consecutiveErrors = 0;
    let rateLimitCooldownUntil = 0;
    let circuitBroken = false;
    const changedPins = [];
    let accountFollowerCount = typeof acc.follower_count === 'number' && acc.follower_count > 0 ? acc.follower_count : null;

    const sem = new Semaphore(CFG.CONCURRENCY);

    // Two-Phase: Phase 1 (Concurrent Fetch & Extract with Promise.allSettled)
    await Promise.allSettled(
      pins.map(async (p) => {
        await sem.acquire();
        try {
          if (circuitBroken) return;

          // Rate-limit cooldown check
          if (Date.now() < rateLimitCooldownUntil) {
            const waitMs = Math.max(0, rateLimitCooldownUntil - Date.now());
            console.warn(`[RATE LIMIT] Pausing for ${Math.round(waitMs / 1000)}s cooldown before pin ${p.pin_id}`);
            await sleep(waitMs);
          }

          if (circuitBroken) return;

          // Apply jitter delay before request
          await sleep(randomJitterMs());

          const pinId = String(p.pin_id);
          const fresh = await fetchPinFromPinterest(pinId);

          if (!fresh.ok) {
            if (fresh.code === 429) {
              consecutiveErrors++;
              rateLimitCooldownUntil = Date.now() + 60000;
              console.warn(`[429 RATE LIMIT] Pin ${pinId} received 429. Setting 60s cooldown.`);
            } else if (fresh.code === 403) {
              consecutiveErrors++;
            } else {
              consecutiveErrors = 0;
            }

            if (consecutiveErrors >= CFG.CIRCUIT_BREAKER) {
              circuitBroken = true;
              summary.errors.push(`circuit-breaker: ${acc.username}`);
              console.error(`[CIRCUIT BREAKER] Hit ${CFG.CIRCUIT_BREAKER} consecutive errors on ${acc.username}. Aborting remaining pin fetches for this account.`);
              return;
            }

            if (fresh.code === 200 && fresh.diag) {
              console.warn(`[DIAG] ${pinId}: html=${Math.round(fresh.diag.htmlLen / 1024)}KB relay=${fresh.diag.relay} pws=${fresh.diag.pws} hasPinId=${fresh.diag.hasPinId}`);
            }
            console.warn(`[FAIL] ${pinId}: ${fresh.error || 'http ' + fresh.code} (code=${fresh.code})`);
            summary.errors.push(`${pinId}: ${fresh.error || 'http ' + fresh.code}`);
            return;
          }

          consecutiveErrors = 0;
          summary.refreshed++;

          if (typeof fresh.follower_count === 'number' && fresh.follower_count > 0 && accountFollowerCount === null) {
            accountFollowerCount = fresh.follower_count;
          }

          const oldSaves = Number(p.saves) || 0;
          const oldRepins = Number(p.repins) || 0;

          const existingAnnotationNames = new Set((Array.isArray(p.annotations) ? p.annotations : [])
            .map(a => (typeof a === 'string' ? a.trim() : String(a?.name || '').trim()))
            .filter(Boolean));
          const newAnnotations = (Array.isArray(fresh.annotations) ? fresh.annotations : [])
            .filter(a => a?.name && !existingAnnotationNames.has(a.name));

          // X3: ageDays NaN protection
          const createdAt = p.created_at_pinterest || fresh.created_at_pinterest;
          const ms = createdAt ? Date.now() - new Date(createdAt).getTime() : NaN;
          const ageDays = !Number.isFinite(ms) || ms <= 0 ? 1 : Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));

          if (
            fresh.saves !== oldSaves ||
            fresh.repins !== oldRepins ||
            newAnnotations.length > 0
          ) {
            const changedItem = {
              pin_id: pinId,
              saves: fresh.saves,
              repins: fresh.repins,
              comments: fresh.comments,
              velocity: Math.round((fresh.saves / ageDays) * 100) / 100,
              archived_at: new Date().toISOString(),
              refreshed_at: new Date().toISOString(),
            };
            if (fresh.reactions && Object.keys(fresh.reactions).length > 0) {
              changedItem.reactions = fresh.reactions;
            }
            if (newAnnotations.length > 0) {
              changedItem.annotations = newAnnotations;
            }
            if (typeof fresh.share_count === 'number' && fresh.share_count > 0) {
              changedItem.share_count = fresh.share_count;
            }
            changedPins.push(changedItem);
            summary.updated++;
          }
        } finally {
          sem.release();
        }
      })
    );

    // Two-Phase: Phase 2 (Sequential Batch Push)
    if (changedPins.length > 0) {
      console.log(`[PUSH] Pushing ${changedPins.length} changed pins for @${acc.username} in batches of ${CFG.BATCH_SIZE}...`);
      for (let i = 0; i < changedPins.length; i += CFG.BATCH_SIZE) {
        const batch = changedPins.slice(i, i + CFG.BATCH_SIZE);
        const result = await pushBatch(acc.workspace_id, acc.username, batch, accountFollowerCount, allPins.length);
        if (result.ok) {
          summary.pushed += result.pushed;
        } else {
          summary.errors.push(`push: ${result.error}`);
          if (result.terminal) break;
        }
        if (i + CFG.BATCH_SIZE < changedPins.length) {
          await sleep(CFG.PUSH_SLEEP_MS);
        }
      }
    }
  }

  console.log(`\nSummary: checked=${summary.refreshed}, changed=${summary.updated}, pushed=${summary.pushed}, errors=${summary.errors.length}`);
  const isFiltered = Boolean(REFRESH_WORKSPACE_ID || REFRESH_USERNAME || REFRESH_USERNAMES.length > 0);
  if (isFiltered) {
    // Filtered run: success if anything was pushed/updated, regardless of per-pin extraction misses
    if (summary.pushed > 0 || summary.updated > 0) process.exit(0);
    // No change but also no systemic failure (e.g. capped rotation) → still 0
    if (summary.errors.length === 0) process.exit(0);
    // All pins in the filtered scope failed → keep red signal
  }
  if (summary.errors.length > summary.refreshed) process.exit(1);
}

export { extractPinData, formatPin, findPinInTree, fetchPinFromPinterest, pushBatch, Semaphore };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
