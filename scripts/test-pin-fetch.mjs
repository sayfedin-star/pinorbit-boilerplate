#!/usr/bin/env node
/**
 * Probe: fetches a single pin from Pinterest public HTML and extracts metrics.
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
  if (String(obj.id) === pinId && (obj.aggregated_pin_data || obj.repin_count !== undefined)) return obj;
  if (obj[pinId] && typeof obj[pinId] === 'object' && obj[pinId].aggregated_pin_data) return obj[pinId];
  for (const key of Object.keys(obj)) {
    const found = findPinInTree(obj[key], pinId, depth + 1);
    if (found) return found;
  }
  return null;
}

function formatPinFromObject(pin) {
  const st = pin?.aggregated_pin_data?.aggregated_stats || {};
  const annotations = pin?.pin_join?.visual_annotation || pin?.visual_annotation || [];
  return {
    saves: Number(st.saves || 0),
    repins: Number(pin.repin_count || 0),
    comments: Number(pin.comment_count || 0),
    tags: Array.isArray(annotations) ? annotations : [],
    title: pin.title || pin.grid_title || '',
    description: pin.description || pin.grid_description || '',
    link: pin.link || '',
    domain: pin.domain || '',
    board_name: pin.board?.name || '',
    image_url: pin.images?.orig?.url || '',
  };
}

function extractPinData(html, pinId) {
  const pwsMatch = html.match(/<script[^>]+id\s*=\s*"__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (pwsMatch) {
    try {
      const pws = JSON.parse(pwsMatch[1]);
      const pin = findPinInTree(pws, pinId);
      if (pin) return { method: '__PWS_DATA__', ...formatPinFromObject(pin) };
    } catch (e) { console.log('  PWS parse error:', e.message); }
  }

  const jsonBlobs = [...html.matchAll(/<script[^>]*type\s*=\s*"application\/json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, content] of jsonBlobs) {
    if (!content.includes(pinId)) continue;
    try {
      const data = JSON.parse(content);
      const pin = findPinInTree(data, pinId);
      if (pin) return { method: 'json-blob', ...formatPinFromObject(pin) };
    } catch (e) { /* continue */ }
  }

  const savesM = html.match(/"saves"\s*:\s*(\d+)/);
  if (savesM) {
    const repinsM   = html.match(/"repin_count"\s*:\s*(\d+)/);
    const commentsM = html.match(/"comment_count"\s*:\s*(\d+)/);
    const annM      = html.match(/"visual_annotation"\s*:\s*(\[[^\]]*?\])/);
    let tags = [];
    if (annM) try { tags = JSON.parse(annM[1]); } catch (e) {}
    return {
      method: 'regex',
      saves: parseInt(savesM[1]),
      repins: repinsM ? parseInt(repinsM[1]) : 0,
      comments: commentsM ? parseInt(commentsM[1]) : 0,
      tags,
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
  console.log(`Tags (${data.tags.length}): ${data.tags.slice(0, 5).join(', ')}${data.tags.length > 5 ? '...' : ''}`);
  if (data.title) console.log(`Title: ${data.title.substring(0, 60)}`);
} else {
  console.log('Could not extract pin data from HTML.');
  console.log('Saving HTML to debug-pin.html for inspection...');
  const { writeFileSync } = await import('fs');
  writeFileSync('debug-pin.html', html);
  process.exit(1);
}
