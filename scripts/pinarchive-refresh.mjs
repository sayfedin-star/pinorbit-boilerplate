#!/usr/bin/env node
/**
 * PinArchive Refresh: fetches updated metrics & relay enrichment for archived pins and pushes deltas.
 * Env Vars: PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, PINORBIT_WORKER_URL, PINARCHIVE_INGEST_SECRET
 */

const CFG = { SLEEP_MS: 1800, BATCH_SIZE: 25, CIRCUIT_BREAKER: 3, MAX_PINS: 150 };

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
  const st = pin?.aggregated_pin_data?.aggregated_stats || pin?.aggregatedStats || {};
  const ann = pin?.pin_join?.visual_annotation || pin?.visual_annotation || pin?.pinJoin?.visualAnnotation || pin?.visualAnnotation || [];

  // --- NEW: merged annotations with idea_id/url ---
  const visual = Array.isArray(ann) ? ann : [];
  const withLinks = pin?.pin_join?.annotationsWithLinksArray || pin?.pinJoin?.annotationsWithLinksArray || pin?.annotationsWithLinksArray || [];
  const mergedAnnotations = [];
  const seen = new Set();
  for (const item of withLinks) {
    if (item?.name && !seen.has(item.name)) {
      mergedAnnotations.push({
        name: item.name,
        idea_id: String(item.url || '').match(/\/ideas\/[^/]+\/(\d+)/)?.[1] || null,
        url: item.url || null,
      });
      seen.add(item.name);
    }
  }
  for (const name of visual) {
    if (typeof name === 'string' && !seen.has(name)) {
      mergedAnnotations.push({ name });
      seen.add(name);
    }
  }

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

  return {
    // existing
    saves: Number(st.saves || pin.saves || 0),
    repins: Number(pin.repinCount || pin.repin_count || pin.repins || 0),
    comments: Number(pin?.aggregated_pin_data?.commentCount || pin?.commentCount || pin?.comment_count || pin.comments || 0),
    title: pin.title || pin.gridTitle || pin.grid_title || '',
    description: pin.description || pin.gridDescription || pin.grid_description || '',
    link: pin.link || '',
    domain: pin.domain || '',
    board_name: pin.board?.name || pin.pinner?.username || '',
    board_id: pin.board?.id || null,
    created_at_pinterest: pin.created_at || null,
    image_url: pin.images?.orig?.url || pin.image_large_url || '',
    dominant_color: pin.dominant_color || null,
    image_signature: pin.image_signature || null,
    node_id: pin.node_id || null,
    is_video: Boolean(pin.is_video),

    // NEW enriched fields
    reactions: reactionsMap,
    annotations: mergedAnnotations,
    seo_category: pin?.seo_category || pin?.category || null,
    canonical_pin_id: pin?.canonical_pin_id ? String(pin.canonical_pin_id) : (pin?.pin_join?.canonical_pin?.id ? String(pin.pin_join.canonical_pin.id) : null),
    seo_alt_text: pin?.seo_alt_text || pin?.alt_text || null,
    share_count: Number(pin?.share_count || pin?.pin_join?.share_count || 0),
    board_pin_count: typeof pin?.board?.pin_count === 'number' ? pin.board.pin_count : null,
    board_last_modified_at: pin?.board?.last_modified_at || pin?.board?.board_order_updated_at || null,
    follower_count: typeof pin?.pinner?.follower_count === 'number' ? pin.pinner.follower_count : (typeof pin?.origin_pinner?.follower_count === 'number' ? pin.origin_pinner.follower_count : null),
  };
}

function extractPinData(html, pinId) {
  // Pattern 1: __PWS_DATA__
  const pwsMatch = html.match(/id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (pwsMatch) {
    try {
      const pws = JSON.parse(pwsMatch[1]);
      const pinObj = pws?.props?.initialReduxState?.pins?.[pinId]
        || pws?.props?.relayContext?.relayData?.[pinId]
        || pws?.props?.relayContext?.rootFeed
        || findPinInTree(pws, pinId);
      if (pinObj) {
        const direct = pinObj.aggregated_pin_data || pinObj.saves !== undefined ? pinObj : findPinInTree(pinObj, pinId);
        if (direct) return formatPin(direct);
      }
    } catch (e) {}
  }

  // Pattern 2: relay-preloaded-queries
  const relayMatch = html.match(/id="relay-preloaded-queries"[^>]*>([\s\S]*?)<\/script>/);
  if (relayMatch) {
    try {
      const queries = JSON.parse(relayMatch[1]);
      for (const key of Object.keys(queries)) {
        const found = findPinInTree(queries[key], pinId);
        if (found) return formatPin(found);
      }
    } catch (e) {}
  }

  // Pattern 3: initial-data-feed
  const feedMatch = html.match(/id="initial-data-feed"[^>]*>([\s\S]*?)<\/script>/);
  if (feedMatch) {
    try {
      const feed = JSON.parse(feedMatch[1]);
      const found = findPinInTree(feed, pinId);
      if (found) return formatPin(found);
    } catch (e) {}
  }

  // Pattern 4: window.__INITIAL_DATA__
  const initMatch = html.match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (initMatch) {
    try {
      const init = JSON.parse(initMatch[1]);
      const found = findPinInTree(init, pinId);
      if (found) return formatPin(found);
    } catch (e) {}
  }

  // Pattern 5: Generic application/json script tags with deep search
  const scriptRegex = /<script\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const found = findPinInTree(parsed, pinId);
      if (found) return formatPin(found);
    } catch (e) {}
  }

  // Pattern 6: JSON-LD fallback (rich metadata but basic metrics)
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
          domain: '',
          board_name: '',
          board_id: null,
          created_at_pinterest: ld.datePublished || null,
          image_url: Array.isArray(ld.image) ? ld.image[0] : (typeof ld.image === 'string' ? ld.image : (ld.image?.url || '')),
          dominant_color: null,
          image_signature: null,
          node_id: null,
          is_video: ld['@type'] === 'VideoObject',
          reactions: { total: 0 },
          annotations: [],
          seo_category: ld.articleSection || null,
          canonical_pin_id: null,
          seo_alt_text: null,
          share_count: 0,
          board_pin_count: null,
          board_last_modified_at: null,
          follower_count: null,
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
  const res = await fetch(`https://www.pinterest.com/pin/${pinId}/`, { headers: HEADERS, redirect: 'follow' });
  if (res.status !== 200) return { ok: false, code: res.status };
  const html = await res.text();
  const data = extractPinData(html, pinId);
  if (!data) return { ok: false, code: 200, error: 'extraction-failed' };
  return { ok: true, ...data };
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
    const wsSettings = await supaQuery('pa_workspace_settings', 'select=workspace_id,ingest_enabled,paused_account_policy');
    if (Array.isArray(wsSettings)) {
      for (const s of wsSettings) {
        settingsMap.set(s.workspace_id, s);
      }
    }
  } catch (e) {
    console.warn('Could not query pa_workspace_settings (using defaults):', e.message);
  }

  const accounts = await supaQuery('pa_accounts', 'select=workspace_id,username,follower_count,status,ingest_enabled');
  if (!accounts.length) { console.log('No accounts found.'); return; }
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

    const pins = await supaQuery('pa_pins', `select=pin_id,saves,repins,comments,share_count,reactions,annotations,seo_category,canonical_pin_id,seo_alt_text,board_pin_count,board_last_modified_at,archived_at,title,description,link,domain,board_name,board_id,created_at_pinterest,image_url,dominant_color,image_signature,node_id,is_video,velocity&workspace_id=eq.${acc.workspace_id}&order=last_updated_at.asc&limit=${CFG.MAX_PINS}`);
    if (!pins.length) continue;
    console.log(`${acc.username}: ${pins.length} pins to refresh`);
    let consecutive403 = 0;
    const changedBatch = [];
    let accountFollowerCount = typeof acc.follower_count === 'number' && acc.follower_count > 0 ? acc.follower_count : null;

    for (let i = 0; i < pins.length; i++) {
      const p = pins[i];
      const pinId = String(p.pin_id);
      if (consecutive403 >= CFG.CIRCUIT_BREAKER) {
        summary.errors.push(`circuit-breaker: ${acc.username}`);
        break;
      }
      const fresh = await fetchPinFromPinterest(pinId);
      if (!fresh.ok) {
        if (fresh.code === 403 || fresh.code === 429) consecutive403++;
        else consecutive403 = 0;
        console.warn(`[FAIL] ${pinId}: ${fresh.error || 'http ' + fresh.code} (code=${fresh.code})`);
        summary.errors.push(`${pinId}: ${fresh.error || 'http ' + fresh.code}`);
        await sleep(CFG.SLEEP_MS);
        continue;
      }
      consecutive403 = 0;
      summary.refreshed++;

      if (typeof fresh.follower_count === 'number' && fresh.follower_count > 0 && accountFollowerCount === null) {
        accountFollowerCount = fresh.follower_count;
      }

      const oldSaves = Number(p.saves) || 0;
      const oldRepins = Number(p.repins) || 0;
      const oldComments = Number(p.comments) || 0;
      const oldShares = Number(p.share_count) || 0;

      if (
        fresh.saves !== oldSaves ||
        fresh.repins !== oldRepins ||
        fresh.comments !== oldComments ||
        fresh.share_count !== oldShares ||
        fresh.annotations?.length > 0
      ) {
        const ageDays = Math.max(1, (Date.now() - new Date(p.created_at_pinterest || Date.now()).getTime()) / 86400000);
        changedBatch.push({
          pin_id: pinId,
          title: fresh.title || p.title || '',
          description: fresh.description || p.description || '',
          link: fresh.link || p.link || '',
          domain: fresh.domain || p.domain || '',
          board_name: fresh.board_name || p.board_name || '',
          board_id: fresh.board_id || null,
          created_at_pinterest: p.created_at_pinterest || '',
          image_url: fresh.image_url || p.image_url || '',
          dominant_color: fresh.dominant_color || null,
          image_signature: fresh.image_signature || null,
          node_id: fresh.node_id || null,
          is_video: fresh.is_video || false,
          saves: fresh.saves,
          repins: fresh.repins,
          comments: fresh.comments,
          velocity: Math.round((fresh.saves / ageDays) * 100) / 100,
          reactions: fresh.reactions || {},
          annotations: fresh.annotations || [],
          seo_category: fresh.seo_category || null,
          canonical_pin_id: fresh.canonical_pin_id || null,
          seo_alt_text: fresh.seo_alt_text || null,
          share_count: fresh.share_count || 0,
          board_pin_count: fresh.board_pin_count ?? null,
          board_last_modified_at: fresh.board_last_modified_at || null,
          archived_at: new Date().toISOString(),
          tags: (fresh.annotations?.length ? fresh.annotations.map(a => a.name) : []).join(', '),
          refreshed_at: new Date().toISOString(),
        });
        summary.updated++;
      }

      if (changedBatch.length >= CFG.BATCH_SIZE) {
        const result = await pushBatch(acc.workspace_id, acc.username, changedBatch.splice(0, changedBatch.length), accountFollowerCount, pins.length);
        if (result.ok) {
          summary.pushed += result.pushed;
        } else {
          summary.errors.push(`push: ${result.error}`);
          if (result.terminal) break;
        }
        await sleep(2000);
      }
      await sleep(CFG.SLEEP_MS);
    }

    if (changedBatch.length) {
      const result = await pushBatch(acc.workspace_id, acc.username, changedBatch, accountFollowerCount, pins.length);
      if (result.ok) summary.pushed += result.pushed;
      else summary.errors.push(`push: ${result.error}`);
    }
  }

  console.log(`\nSummary: checked=${summary.refreshed}, changed=${summary.updated}, pushed=${summary.pushed}, errors=${summary.errors.length}`);
  const isFiltered = Boolean(REFRESH_WORKSPACE_ID || REFRESH_USERNAME);
  if (isFiltered) {
    // Filtered run: success if anything was pushed/updated, regardless of per-pin extraction misses
    if (summary.pushed > 0 || summary.updated > 0) process.exit(0);
    // No change but also no systemic failure (e.g. capped rotation) → still 0
    if (summary.errors.length === 0) process.exit(0);
    // All pins in the filtered scope failed → keep red signal
  }
  if (summary.errors.length > summary.refreshed) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
