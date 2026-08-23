#!/usr/bin/env node
/**
 * Probe: fetches a single pin from Pinterest public HTML and extracts enriched metrics.
 * Usage: node scripts/test-pin-fetch.mjs [pin_id]
 */

const PIN_ID = process.argv[2] || '1079245498222414527';

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
    return { method: 'relay-merged', ...formatPin(merged) };
  }

  // 4. Regex fallback
  const savesM = html.match(/"saves"\s*:\s*(\d+)/);
  if (savesM) {
    const repinsM = html.match(/"repin_count"\s*:\s*(\d+)/);
    const commentsM = html.match(/"comment_count"\s*:\s*(\d+)/);
    const annM = html.match(/"visual_annotation"\s*:\s*(\[[^\]]*?\])/);
    let tags = [];
    if (annM) try { tags = JSON.parse(annM[1]); } catch (e) {}
    return {
      method: 'regex',
      ...formatPin({
        aggregated_pin_data: { aggregated_stats: { saves: parseInt(savesM[1]) } },
        repin_count: repinsM ? parseInt(repinsM[1]) : 0,
        comment_count: commentsM ? parseInt(commentsM[1]) : 0,
        visual_annotation: tags,
      }),
    };
  }

  return null;
}

console.log(`\nFetching pin ${PIN_ID} ...\n`);
const res = await fetch(`https://www.pinterest.com/pin/${PIN_ID}/`, { headers: HEADERS });
console.log(`HTTP ${res.status} ${res.statusText}`);

if (res.status !== 200) {
  console.log('Pinterest returned non-200. Body preview:');
  const text = await res.text();
  console.log(text.substring(0, 500));
  process.exit(1);
}

const html = await res.text();
console.log(`HTML size: ${(html.length / 1024).toFixed(0)} KB`);
console.log(`Has __PWS_DATA__: ${html.includes('__PWS_DATA__')}`);
console.log(`Has pin_id: ${html.includes(PIN_ID)}`);
console.log(`Has aggregated_stats: ${html.includes('aggregated_stats')}`);
console.log(`Has visual_annotation: ${html.includes('visual_annotation')}\n`);

const data = extractPinData(html, PIN_ID);

if (data) {
  console.log('Extraction succeeded!');
  console.log(`Method: ${data.method}`);
  console.log(`Saves: ${data.saves}`);
  console.log(`Repins: ${data.repins}`);
  console.log(`Comments: ${data.comments}`);
  const annNames = (data.annotations || []).map(a => a.name || a);
  console.log(`Annotations (${annNames.length}): ${annNames.slice(0, 5).join(', ')}${annNames.length > 5 ? '...' : ''}`);
  if (data.seo_category) console.log(`SEO Category: ${data.seo_category}`);
  if (data.canonical_pin_id) console.log(`Canonical pin: ${data.canonical_pin_id}`);
  if (data.share_count !== undefined) console.log(`Share count: ${data.share_count}`);
  if (data.follower_count !== undefined) console.log(`Follower count: ${data.follower_count}`);
  if (data.title) console.log(`Title: ${data.title.substring(0, 60)}`);
} else {
  console.log('Could not extract pin data from HTML.');
  console.log('Saving HTML to debug-pin.html for inspection...');
  const { writeFileSync } = await import('fs');
  writeFileSync('debug-pin.html', html);
  process.exit(1);
}
