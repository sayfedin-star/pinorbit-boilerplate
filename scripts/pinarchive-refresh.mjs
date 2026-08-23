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
    board_name: pin.board?.name || '',
    board_id: pin.board?.entityId || pin.board?.id || '',
    image_url: pin.images_orig?.url || pin.images?.orig?.url || '',
    dominant_color: pin.dominantColor || pin.dominant_color || '',
    image_signature: pin.imageSignature || pin.image_signature || '',
    node_id: pin.id || '',
    created_at_pinterest: pin.createdAt || pin.created_at || '',
    is_video: Boolean(pin.isVideo || pin.is_video),
    reactions: reactionsMap,

    // NEW enrichment
    annotations: mergedAnnotations,
    seo_category: pin?.pinJoin?.seoBreadcrumbs?.[0]?.name || pin?.pin_join?.seo_breadcrumbs?.[0]?.name || null,
    canonical_pin_id: pin?.pinJoin?.canonicalPin?.entityId || pin?.pin_join?.canonical_pin?.entity_id || null,
    seo_alt_text: pin.seoAltText || pin.seo_alt_text || null,
    share_count: Number(pin.shareCount || pin.share_count || 0),
    board_pin_count: typeof pin.board?.pinCount === 'number' ? pin.board.pinCount : (typeof pin.board?.pin_count === 'number' ? pin.board.pin_count : null),
    board_last_modified_at: pin.board?.boardOrderModifiedAt || pin.board?.last_modified_at || null,
    follower_count: Number(pin?.pinner?.followerCount || pin?.pinner?.follower_count || 0),
  };
}

function extractPinData(html, pinId) {
  const blocks = [];

  // 1. Relay completed request blocks
  for (const [, content] of html.matchAll(
    /window\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\("[^"]+",\s*([\s\S]*?)\}\s*\);/g
  )) {
    try {
      const parsed = JSON.parse(content + '}');
      const pinObj = parsed?.data?.v3GetPinQueryv2?.data;
      if (pinObj) {
        const pinB64 = `UGluOj${Buffer.from(pinId).toString('base64').replace(/=+$/, '')}`;
        if (String(pinObj.entityId) === pinId || String(pinObj.id) === pinId || pinObj.id === pinB64 || pinObj.pinJoin || pinObj.reactionCountsData) {
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
  const pwsMatch = html.match(/<script[^>]+id\s*=\s*"__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (pwsMatch) {
    try {
      const pws = JSON.parse(pwsMatch[1]);
      const pin = findPinInTree(pws, pinId);
      if (pin) blocks.push(pin);
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
    if (savesM && !merged.saves && !merged.aggregated_pin_data?.aggregated_stats?.saves) {
      merged.saves = parseInt(savesM[1]);
    }
    const commentsM = html.match(/"comment_count"\s*:\s*(\d+)/) || html.match(/"commentCount"\s*:\s*(\d+)/);
    if (commentsM && !merged.comments && !merged.commentCount && !merged.comment_count && !merged.aggregated_pin_data?.commentCount) {
      merged.commentCount = parseInt(commentsM[1]);
    }
    return formatPin(merged);
  }

  // 4. Regex fallback
  const savesM = html.match(/"saves"\s*:\s*(\d+)/);
  if (savesM) {
    const repinsM = html.match(/"repin_count"\s*:\s*(\d+)/);
    const commentsM = html.match(/"comment_count"\s*:\s*(\d+)/);
    const annM = html.match(/"visual_annotation"\s*:\s*(\[[^\]]*?\])/);
    let tags = [];
    if (annM) try { tags = JSON.parse(annM[1]); } catch (e) {}
    return formatPin({
      aggregated_pin_data: { aggregated_stats: { saves: parseInt(savesM[1]) } },
      repin_count: repinsM ? parseInt(repinsM[1]) : 0,
      comment_count: commentsM ? parseInt(commentsM[1]) : 0,
      visual_annotation: tags,
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
  try { error = (await res.json()).error || ''; } catch (e) { error = await res.text(); }
  return { ok: false, code: res.status, error: error || `http ${res.status}` };
}

async function main() {
  checkEnv();
  console.log('\nPinArchive Refresh starting...\n');
  const accounts = await supaQuery('pa_accounts', 'select=workspace_id,username,follower_count');
  if (!accounts.length) { console.log('No accounts found.'); return; }
  console.log(`Found ${accounts.length} account(s)\n`);
  const summary = { refreshed: 0, updated: 0, pushed: 0, errors: [] };

  for (const acc of accounts) {
    const pins = await supaQuery('pa_pins', `select=pin_id,saves,repins,comments,share_count,reactions,annotations,seo_category,canonical_pin_id,seo_alt_text,board_pin_count,board_last_modified_at,archived_at,title,description,link,domain,board_name,board_id,created_at_pinterest,image_url,dominant_color,image_signature,node_id,is_video,velocity&workspace_id=eq.${acc.workspace_id}&order=saves.desc&limit=${CFG.MAX_PINS}`);
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
        if (result.ok) summary.pushed += result.pushed;
        else summary.errors.push(`push: ${result.error}`);
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
  if (summary.errors.length > summary.refreshed) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
