#!/usr/bin/env node
/**
 * PinArchive Refresh: fetches updated metrics for archived pins and pushes deltas.
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
  if (String(obj.id) === pinId && (obj.aggregated_pin_data || obj.repin_count !== undefined)) return obj;
  if (obj[pinId] && typeof obj[pinId] === 'object' && obj[pinId].aggregated_pin_data) return obj[pinId];
  for (const key of Object.keys(obj)) {
    const found = findPinInTree(obj[key], pinId, depth + 1);
    if (found) return found;
  }
  return null;
}

function formatPin(pin) {
  const st = pin?.aggregated_pin_data?.aggregated_stats || {};
  const ann = pin?.pin_join?.visual_annotation || pin?.visual_annotation || [];
  return {
    saves: Number(st.saves || 0), repins: Number(pin.repin_count || 0), comments: Number(pin.comment_count || 0),
    tags: Array.isArray(ann) ? ann : [], title: pin.title || '', description: pin.description || '',
    link: pin.link || '', domain: pin.domain || '', board_name: pin.board?.name || '', image_url: pin.images?.orig?.url || '',
  };
}

function extractPinData(html, pinId) {
  const pwsMatch = html.match(/<script[^>]+id\s*=\s*"__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (pwsMatch) { try { const pin = findPinInTree(JSON.parse(pwsMatch[1]), pinId); if (pin) return formatPin(pin); } catch (e) {} }
  for (const [, content] of html.matchAll(/<script[^>]*type\s*=\s*"application\/json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!content.includes(pinId)) continue;
    try { const pin = findPinInTree(JSON.parse(content), pinId); if (pin) return formatPin(pin); } catch (e) {}
  }
  const savesM = html.match(/"saves"\s*:\s*(\d+)/);
  if (savesM) {
    const repinsM = html.match(/"repin_count"\s*:\s*(\d+)/);
    const commentsM = html.match(/"comment_count"\s*:\s*(\d+)/);
    const annM = html.match(/"visual_annotation"\s*:\s*(\[[^\]]*?\])/);
    let tags = []; if (annM) try { tags = JSON.parse(annM[1]); } catch (e) {}
    return { saves: parseInt(savesM[1]), repins: repinsM ? parseInt(repinsM[1]) : 0, comments: commentsM ? parseInt(commentsM[1]) : 0, tags };
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

async function pushBatch(workspaceId, username, pins) {
  if (!pins.length) return { ok: true, pushed: 0 };
  const body = { run_id: crypto.randomUUID(), workspace_id: workspaceId, username, fetched_at: new Date().toISOString(), run_type: 'refresh', pins };
  const res = await fetch(`${PINORBIT_WORKER_URL.replace(/\/+$/, '')}/api/internal/pinarchive/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ingest-secret': PINARCHIVE_INGEST_SECRET }, body: JSON.stringify(body),
  });
  if (res.status >= 200 && res.status < 300) return { ok: true, pushed: pins.length };
  let error = ''; try { error = (await res.json()).error || ''; } catch (e) { error = await res.text(); }
  return { ok: false, code: res.status, error: error || `http ${res.status}` };
}

async function main() {
  checkEnv();
  console.log('\nPinArchive Refresh starting...\n');
  const accounts = await supaQuery('pa_accounts', 'select=workspace_id,username');
  if (!accounts.length) { console.log('No accounts found.'); return; }
  console.log(`Found ${accounts.length} account(s)\n`);
  const summary = { refreshed: 0, updated: 0, pushed: 0, errors: [] };

  for (const acc of accounts) {
    const pins = await supaQuery('pa_pins', `select=pin_id,saves,repins,comments,title,description,link,domain,board_name,created_at,image_url,tags&workspace_id=eq.${acc.workspace_id}&order=saves.desc&limit=${CFG.MAX_PINS}`);
    if (!pins.length) continue;
    console.log(`${acc.username}: ${pins.length} pins to refresh`);
    let consecutive403 = 0;
    const changedBatch = [];

    for (let i = 0; i < pins.length; i++) {
      const p = pins[i]; const pinId = String(p.pin_id);
      if (consecutive403 >= CFG.CIRCUIT_BREAKER) { summary.errors.push(`circuit-breaker: ${acc.username}`); break; }
      const fresh = await fetchPinFromPinterest(pinId);
      if (!fresh.ok) {
        if (fresh.code === 403 || fresh.code === 429) consecutive403++; else consecutive403 = 0;
        summary.errors.push(`${pinId}: ${fresh.error || 'http ' + fresh.code}`);
        await sleep(CFG.SLEEP_MS); continue;
      }
      consecutive403 = 0; summary.refreshed++;
      const oldSaves = Number(p.saves) || 0, oldRepins = Number(p.repins) || 0, oldComments = Number(p.comments) || 0;
      if (fresh.saves !== oldSaves || fresh.repins !== oldRepins || fresh.comments !== oldComments) {
        const ageDays = Math.max(1, (Date.now() - new Date(p.created_at || Date.now()).getTime()) / 86400000);
        changedBatch.push({
          pin_id: pinId, title: fresh.title || p.title || '', description: fresh.description || p.description || '',
          link: fresh.link || p.link || '', domain: fresh.domain || p.domain || '', board_name: fresh.board_name || p.board_name || '',
          created_at: p.created_at || '', image_url: fresh.image_url || p.image_url || '',
          saves: fresh.saves, repins: fresh.repins, comments: fresh.comments,
          velocity: Math.round((fresh.saves / ageDays) * 100) / 100,
          tags: (fresh.tags.length ? fresh.tags : (p.tags || '')).toString(), refreshed_at: new Date().toISOString(),
        });
        summary.updated++;
      }
      if (changedBatch.length >= CFG.BATCH_SIZE) {
        const result = await pushBatch(acc.workspace_id, acc.username, changedBatch.splice(0, changedBatch.length));
        if (result.ok) summary.pushed += result.pushed; else summary.errors.push(`push: ${result.error}`);
        await sleep(2000);
      }
      await sleep(CFG.SLEEP_MS);
    }
    if (changedBatch.length) {
      const result = await pushBatch(acc.workspace_id, acc.username, changedBatch);
      if (result.ok) summary.pushed += result.pushed; else summary.errors.push(`push: ${result.error}`);
    }
  }
  console.log(`\nSummary: checked=${summary.refreshed}, changed=${summary.updated}, pushed=${summary.pushed}, errors=${summary.errors.length}`);
  if (summary.errors.length > summary.refreshed) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
