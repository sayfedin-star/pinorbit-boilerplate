# PinArchive Google Apps Script (GAS) Collector v2.4 Patch Document

This document contains the deployed, canonical Google Apps Script (GAS) Collector v2.4 source code for PinArchive, along with deployment steps, changelog, and acceptance criteria.

---

## 1. Changelog (v2.4)

- **[H1a] `addAccount_`**: fixed off-by-one (15 values into 14 columns) → `created_at` now lands in column N (was 0, ISO spilled to O).
- **[H1b] `sendToPinOrbit_`**: now sends `account_meta { pins_count, last_result }` → dashboard account cards show live PINS TOTAL.
- **[H1c] `tick()`**: fetches `/api/internal/pinarchive/config` per workspace (`x-ingest-secret`, fail-safe) and `qualifies_(m, cfg)` applies `pin_filter_min_saves` / `pin_filter_min_repins` / `pin_filter_max_age_days` (AND semantics, 0 = off). Config fetch failure → exact v2.3 fallback thresholds.
- **Byte-identical parity**: Everything else is byte-identical to deployed v2.3.

---

## 2. Script Properties (Project Settings > Script Properties)

| Property Name | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `PINORBIT_URL` | **Yes** | Base URL of your PinOrbit instance | `https://pinorbit.yourdomain.com` |
| `PINARCHIVE_SECRET` | **Yes** | Shared secret matching `PINARCHIVE_INGEST_SECRET` | `pa_sec_live_...` |
| `PINTEREST_COOKIE` | *Optional* | Session cookie for Pinterest scraping | `_auth=1; _pinterest_sess=...` |

---

## 3. Deployment Steps

1. Open the Google Spreadsheet containing your **Control** and **pins_** sheets.
2. Open **Extensions > Apps Script**.
3. In **Project Settings (gear icon) > Script Properties**, verify `PINORBIT_URL`, `PINARCHIVE_SECRET`, and optionally `PINTEREST_COOKIE`.
4. Paste the complete `gas-collector-v2.4.gs` code below into your script editor (e.g. `Code.gs`).
5. Click **Save** (`Ctrl+S`).
6. Click **Deploy > Manage deployments > Edit > New version > Deploy**.
7. Ensure the Web App is configured with:
   - **Execute as**: *Me*
   - **Who has access**: *Anyone*
8. In **Triggers (clock icon)**, ensure a time-driven trigger runs `tick` periodically (e.g. every 1 hour) or `refreshArchived` periodically.

---

## 4. Deployed Source Code (`gas-collector-v2.4.gs`)

```javascript
/***************************************************************
 * 📌 PinArchive Collector v2.4 — FINAL (Phase-1.1 Unit H1)
 * Changelog vs v2.3:
 *  [H1a] addAccount_: fixed off-by-one (15 values into 14 columns)
 *        → created_at now lands in column N (was 0, ISO spilled to O).
 *  [H1b] sendToPinOrbit_ now sends account_meta { pins_count, last_result }
 *        → dashboard account cards show live PINS TOTAL.
 *  [H1c] tick() fetches /api/internal/pinarchive/config per workspace
 *        (x-ingest-secret, fail-safe) and qualifies_(m, cfg) applies
 *        pin_filter_min_saves / min_repins / max_age_days (AND semantics,
 *        0 = off). Config fetch failure → exact v2.3 fallback thresholds.
 *  Everything else is byte-identical to deployed v2.3.
 ***************************************************************/

const CONFIG = {
  CONTROL_SHEET: 'Control',
  PAGE_SIZE: 50,
  SLEEP_MS: 1500,
  TIME_BUDGET_MS: 4.5 * 60 * 1000,
  THRESHOLD_SAVES: 100,
  THRESHOLD_REPINS: 100,
  RISING_AGE_DAYS: 14,
  RISING_SAVES: 34,
  INGEST_PATH: '/api/internal/pinarchive/ingest'
};

const CONTROL_HEADERS = ['username','user_id','workspace_id','sheet_name','interval_days',
  'next_run_at','status','backfill_status','backfill_cursor','last_run_at',
  'last_result','pins_count','archived_count','created_at'];

const PIN_HEADERS = ['pin_id','title','description','link','domain','board_name',
  'created_at','image_url','image_signature','dominant_color','saves','repins',
  'comments','velocity','first_seen_at','last_updated_at','archived_at','tags'];

const C_ = {}; CONTROL_HEADERS.forEach((h,i)=> C_[h]=i+1);
const P_ = {}; PIN_HEADERS.forEach((h,i)=> P_[h]=i+1);

/* ================= أدوات مساعدة ================= */
const prop_ = k => PropertiesService.getScriptProperties().getProperty(k) || '';
const out_  = o => ContentService.createTextOutput(JSON.stringify(o))
                     .setMimeType(ContentService.MimeType.JSON);

function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
}

function timingSafeEqual_(a, b) {
  a = String(a||''); b = String(b||'');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i=0;i<a.length;i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function extractCookie_(cookie, name) {
  const q = cookie.match(new RegExp('(?:^|;\\s*)' + name + '="([^"]*)"'));
  if (q) return q[1];
  const p = cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return p ? p[1] : '';
}

function ensureSchema_(sh, headers) {
  const w0 = sh.getLastColumn();
  const row1 = w0 > 0 ? sh.getRange(1,1,1,w0).getValues()[0] : [];
  const map = {};
  row1.forEach((h,i)=>{ if (h) map[String(h)] = i+1; });
  let next = w0 + 1;
  headers.forEach(h => {
    if (!map[h]) { sh.getRange(1, next).setValue(h); map[h] = next; next++; }
  });
  return { map, width: Math.max(w0, next-1) };
}

function buildRow_(obj, map, width) {
  const row = new Array(width).fill('');
  PIN_HEADERS.forEach(h => { row[(map[h]||1)-1] = (obj[h] !== undefined ? obj[h] : ''); });
  return row;
}
const getF_ = (row, map, h) => row[(map[h]||1)-1];

/* ✅ حذف الأعمدة غير المرغوبة من كل أوراق pins_ (شغّله مرة واحدة من القائمة) */
function removeUnwantedColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const unwanted = ['is_video','is_product','price','currency','site_name'];
  ss.getSheets().forEach(sh => {
    if (sh.getName().indexOf('pins_') !== 0) return;
    const w = sh.getLastColumn();
    const row1 = sh.getRange(1,1,1,w).getValues()[0];
    for (let c = w; c >= 1; c--) {
      if (unwanted.indexOf(String(row1[c-1])) !== -1) sh.deleteColumn(c);
    }
  });
}

/* ================= نقاط الدخول ================= */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('PinArchive')
    .addItem('تشغيل المستحق الآن', 'runDueAccounts')
    .addItem('حذف الأعمدة غير المرغوبة', 'removeUnwantedColumns')
    .addItem('إعداد Control', 'setup').addToUi();
}
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CONFIG.CONTROL_SHEET) || ss.insertSheet(CONFIG.CONTROL_SHEET);
  ensureSchema_(sh, CONTROL_HEADERS);
  sh.setFrozenRows(1);
}

function doGet(e) {
  const secret = prop_('PINARCHIVE_SECRET');
  const authed = e && e.parameter && timingSafeEqual_(e.parameter.secret, secret);
  const base = { ok:true, service:'pinarchive-collector', version:'2.4', time:new Date().toISOString() };
  if (authed) base.accounts = readAccounts_().map(a => a.summary);
  return out_(base);
}

function doPost(e) {
  let b = {};
  try { b = JSON.parse(e.postData.contents || '{}'); } catch (err) { return out_({ok:false,error:'bad json'}); }
  if (!timingSafeEqual_(b.secret, prop_('PINARCHIVE_SECRET'))) return out_({ok:false,error:'unauthorized'});

  /* [G1] فك مغلف gas-bridge: {v,cmd_id,secret,action,workspace_id,payload:{...}} */
  const p = Object.assign({}, b, b.payload || {});

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ctl = ensureControl_(ss);

  switch (p.action) {
    case 'ping':  return out_({ok:true, version:'2.4'});
    case 'status':return out_({ok:true, accounts: readAccounts_().map(a=>a.summary)});
    case 'update_cookie':
      PropertiesService.getScriptProperties().setProperty('PINTEREST_COOKIE', String(p.cookie||''));
      return out_({ok:true});
    case 'set_interval': return out_(setInterval_(ctl, p));
    case 'pause':        return out_(setStatus_(ctl, p.username, 'paused'));
    case 'resume':       return out_(setStatus_(ctl, p.username, 'active'));
    case 'add_account':  return out_(addAccount_(ctl, p));
    case 'run':          tick(p.username || null, !!p.username || p.force === true);
                         return out_({ok:true});
    default: return out_({ok:false, error:'unknown action'});
  }
}

/* ================= التشغيل ================= */
function runDueAccounts() { tick(null, false); }
function runSingleAccount(username) { tick(username, true); }
function testOne() { runSingleAccount('roseisabelle555'); }

/* ================= Control ================= */
function ensureControl_(ss) {
  const sh = ss.getSheetByName(CONFIG.CONTROL_SHEET) || ss.insertSheet(CONFIG.CONTROL_SHEET);
  ensureSchema_(sh, CONTROL_HEADERS);
  sh.setFrozenRows(1);
  return sh;
}

function readAccounts_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ctl = ensureControl_(ss);
  const v = ctl.getDataRange().getValues();
  const list = [];
  for (let r=1; r<v.length; r++) {
    const row = v[r];
    const username = String(row[C_.username-1]||'').trim();
    if (!username) continue;
    list.push({
      row: r,
      acc: {
        username,
        user_id: String(row[C_.user_id-1]||''),
        workspace_id: String(row[C_.workspace_id-1]||'').trim(),
        sheet_name: String(row[C_.sheet_name-1]||('pins_'+username)),
        interval_days: Number(row[C_.interval_days-1]) || 3,
        next_run_at: row[C_.next_run_at-1] || '',
        status: String(row[C_.status-1]||'active'),
        backfill_status: String(row[C_.backfill_status-1]||'pending'),
        backfill_cursor: String(row[C_.backfill_cursor-1]||'')
      },
      summary: {
        username, status: String(row[C_.status-1]||'active'),
        backfill: String(row[C_.backfill_status-1]||'pending'),
        last_run_at: row[C_.last_run_at-1]||'', last_result: row[C_.last_result-1]||'',
        pins_count: row[C_.pins_count-1]||0, archived_count: row[C_.archived_count-1]||0
      }
    });
  }
  return list;
}

function updateControl_(ctl, r, patch) {
  for (const k in patch) if (C_[k]) ctl.getRange(r+1, C_[k]).setValue(patch[k]);
}

function addAccount_(ctl, b) {
  const username = String(b.username||'').trim();
  if (!username) return {ok:false,error:'username required'};
  const v = ctl.getDataRange().getValues();
  for (let r=1;r<v.length;r++) if (String(v[r][C_.username-1]||'').trim()===username)
    return {ok:false,error:'exists'};
  /* [H1a] 14 قيمة بالضبط — كان هناك صفر زائد يدفع created_at إلى العمود O */
  ctl.appendRow([username, String(b.user_id||''), String(b.workspace_id||'').trim(),
    'pins_'+username, Number(b.interval_days)||3, '', 'active','pending','','','','',0,
    new Date().toISOString()]);
  return {ok:true};
}

function setStatus_(ctl, username, status) {
  const v = ctl.getDataRange().getValues();
  for (let r=1;r<v.length;r++) if (String(v[r][C_.username-1]||'').trim()===username) {
    updateControl_(ctl, r, {status});
    return {ok:true};
  }
  return {ok:false,error:'not found'};
}
function setInterval_(ctl, b) {
  const v = ctl.getDataRange().getValues();
  for (let r=1;r<v.length;r++) if (String(v[r][C_.username-1]||'').trim()===String(b.username||'').trim()) {
    updateControl_(ctl, r, {interval_days: Number(b.days)||3});
    return {ok:true};
  }
  return {ok:false,error:'not found'};
}

/* ================= [H1c] قراءة إعدادات الفلترة من PinOrbit (fail-safe) ================= */
function fetchWorkspaceConfig_(wsId) {
  if (!wsId) return null;
  const base = prop_('PINORBIT_URL'), secret = prop_('PINARCHIVE_SECRET');
  if (!base || !secret) return null;
  try {
    const url = base.replace(/\/+$/,'') + '/api/internal/pinarchive/config?workspace_id='
      + encodeURIComponent(wsId);
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'x-ingest-secret': secret },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    const json = JSON.parse(res.getContentText());
    if (json && json.success) return json;
  } catch (e) { console.warn('config fetch failed for ' + wsId + ': ' + e.message); }
  return null; /* fail-safe → qualifies_ يسقط للعتبات الافتراضية v2.3 */
}

/* ================= التشغيل الرئيسي ================= */
function tick(onlyUsername, force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ctl = ensureControl_(ss);
    const list = readAccounts_();
    const now = Date.now();
    const cfgCache = {}; /* [H1c] إعداد واحد لكل workspace لكل تنفيذ */
    for (const item of list) {
      if (onlyUsername && item.acc.username !== onlyUsername) continue;
      if (item.acc.status !== 'active') continue;
      const due = item.acc.backfill_status === 'in_progress' ||
                  !item.acc.next_run_at || new Date(item.acc.next_run_at).getTime() <= now;
      if (!force && !due) continue;
      let cfg = cfgCache[item.acc.workspace_id];
      if (cfg === undefined) {
        cfg = fetchWorkspaceConfig_(item.acc.workspace_id);
        cfgCache[item.acc.workspace_id] = cfg;
      }
      try { processAccount_(ss, ctl, item.row, item.acc, cfg); }
      catch (err) { updateControl_(ctl, item.row, {last_result:'error: '+err.message}); }
      if (Date.now() - now > CONFIG.TIME_BUDGET_MS) break;
    }
  } finally { lock.releaseLock(); }
}

function processAccount_(ss, ctl, r, acc, cfg) {
  const started = Date.now();
  const nowHuman = fmtDate_(new Date());
  const stats = { pages:0, added:0, updated:0, sent:0, skippedIngest:0 };

  const sh = ss.getSheetByName(acc.sheet_name) || ss.insertSheet(acc.sheet_name);
  const schema = ensureSchema_(sh, PIN_HEADERS);
  const map = schema.map, width = schema.width;

  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2,1,last-1,width).getValues() : [];
  const index = {};
  rows.forEach((row,i)=>{ const id=String(getF_(row,map,'pin_id')); if (id) index[id]=i; });

  let cursor = acc.backfill_cursor || null;
  let cookieOk = true, hasMore = true;
  const sendList = [];

  while (hasMore && (Date.now()-started) < CONFIG.TIME_BUDGET_MS) {
    const page = fetchPage_(acc, cursor);
    if (!page.ok) { cookieOk = false; break; }
    stats.pages++;

    page.pins.forEach(p => {
      const m = mapPin_(p);
      if (!m.pin_id) return;
      m.workspace_id = acc.workspace_id;
      const i = index[m.pin_id];
      if (i !== undefined) {
        m.first_seen_at = getF_(rows[i],map,'first_seen_at') || nowHuman;
        m.archived_at   = getF_(rows[i],map,'archived_at') || '';
        sh.getRange(i+2,1,1,width).setValues([buildRow_(m,map,width)]);
        stats.updated++;
      } else {
        m.first_seen_at = nowHuman; m.archived_at = '';
        sh.appendRow(buildRow_(m,map,width));
        index[m.pin_id] = (last + (++stats.added)) - 2;
      }
      if (!m.archived_at && qualifies_(m, cfg)) sendList.push(m);
    });

    cursor = page.bookmark || null;
    if (!cursor || cursor === '-end-') { hasMore = false; cursor = null; }
    else Utilities.sleep(CONFIG.SLEEP_MS);
  }

  /* دفع المؤهلين إلى PinOrbit */
  if (sendList.length) {
    /* [H1b] account_meta → بطاقات الحسابات تعرض PINS TOTAL حية */
    const send = sendToPinOrbit_(acc, sendList, { pins_count: sh.getLastRow()-1, last_result: 'success' });
    if (send.ok && send.skipped === 'ingest_disabled') {
      stats.skippedIngest = sendList.length;
    } else if (send.ok) {
      stats.sent = sendList.length;
      sendList.forEach(m => {
        const i = index[m.pin_id];
        if (i !== undefined) sh.getRange(i+2, map.archived_at).setValue(nowHuman);
      });
    } else {
      stats.sendError = send.error || ('http '+send.code);
    }
  }

  updateControl_(ctl, r, {
    status: cookieOk ? 'active' : 'cookie_expired',
    backfill_status: cookieOk ? (cursor ? 'in_progress' : 'done') : (acc.backfill_status||'pending'),
    backfill_cursor: cursor || '',
    last_run_at: new Date().toISOString(),
    last_result: cookieOk
      ? ('pages='+stats.pages+' +'+stats.added+' ~'+stats.updated+' sent='+stats.sent +
         (stats.skippedIngest ? ' skipped(ingest_disabled)='+stats.skippedIngest : '') +
         (stats.sendError ? ' | send: '+stats.sendError : ''))
      : 'cookie expired / http error',
    pins_count: sh.getLastRow()-1,
    archived_count: (Number(ctl.getRange(r+1, C_.archived_count).getValue())||0) + stats.sent,
    next_run_at: (cookieOk && !cursor)
      ? new Date(Date.now() + acc.interval_days*86400000).toISOString()
      : (acc.next_run_at || new Date().toISOString())
  });
}

/* ================= الجلب من Pinterest ================= */
function fetchPage_(acc, cursor) {
  const cookie = prop_('PINTEREST_COOKIE');
  const src = '/' + acc.username + '/_created/';
  const options = {
    exclude_add_pin_rep: true, field_set_key: 'profile_created_grid_item',
    is_own_profile_pins: false, user_id: acc.user_id || '', username: acc.username,
    data: { page_size: CONFIG.PAGE_SIZE }, noCache: true
  };
  if (cursor) options.bookmarks = [cursor];
  const url = 'https://www.pinterest.com/resource/UserActivityPinsResource/get/'
    + '?source_url=' + encodeURIComponent(src)
    + '&data=' + encodeURIComponent(JSON.stringify({options, context:{}}))
    + '&_=' + Date.now();
  const res = UrlFetchApp.fetch(url, {
    headers: {
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      'Accept':'application/json, text/javascript, */*, q=0.01',
      'Accept-Language':'en-US,en;q=0.9,ar;q=0.8',
      'X-Requested-With':'XMLHttpRequest',
      'X-App-Version':'fe3675a',
      'X-Pinterest-AppState':'active',
      'X-Pinterest-Platform-Bid': extractCookie_(cookie,'_b'),
      'X-Pinterest-PWS-Handler':'www/[username]/_created.js',
      'X-Pinterest-Source-Url': src,
      'Referer':'https://www.pinterest.com'+src,
      'Cookie': cookie
    },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) return {ok:false, code};
  const rr = (JSON.parse(res.getContentText())||{}).resource_response || {};
  return {ok:true, pins: rr.data||[], bookmark: rr.bookmark||null};
}

/* ================= تعيين الحقول ================= */
function mapPin_(p) {
  const st = (p.aggregated_pin_data && p.aggregated_pin_data.aggregated_stats) || {};
  const saves = Number(st.saves||0), repins = Number(p.repin_count||0), comments = Number(p.comment_count||0);
  const created = p.created_at ? new Date(p.created_at) : new Date();
  const age = Math.max(1, (Date.now()-created.getTime())/86400000) || 1;
  const tags = (p.pin_join && p.pin_join.visual_annotation) || p.visual_annotation || [];
  const tagList = Array.isArray(tags) ? tags : [];
  return {
    pin_id: String(p.id||''), title: p.title||p.grid_title||'',
    description: p.description||p.grid_description||'', link: p.link||'',
    domain: p.domain||'', board_name: (p.board&&p.board.name)||'',
    created_at: fmtDate_(created),
    image_url: (p.images&&p.images.orig&&p.images.orig.url)||'',
    image_signature: p.image_signature||'', dominant_color: p.dominant_color||'',
    saves, repins, comments,
    age_days: age,
    velocity: Math.round((saves/age)*100)/100,
    tags: tagList.join(' | '),
    annotations: tagList.map(t => ({ name: t })),
    seo_category: (p.pin_join && p.pin_join.seo_breadcrumbs
                    && p.pin_join.seo_breadcrumbs[0] && p.pin_join.seo_breadcrumbs[0].name) || null
  };
}

/* ================= [H1c] عتبات مؤهلة ديناميكية مع سلوك v2.3 كاحتياط ================= */
function qualifies_(m, cfg) {
  if (cfg && (cfg.pin_filter_min_saves > 0 || cfg.pin_filter_min_repins > 0
              || cfg.pin_filter_max_age_days > 0)) {
    if (cfg.pin_filter_min_saves > 0 && m.saves < cfg.pin_filter_min_saves) return false;
    if (cfg.pin_filter_min_repins > 0 && m.repins < cfg.pin_filter_min_repins) return false;
    if (cfg.pin_filter_max_age_days > 0 && (m.age_days||0) > cfg.pin_filter_max_age_days) return false;
    return true;
  }
  /* fallback: سلوك v2.3 الحرفي عند غياب/فشل الإعدادات */
  if (m.saves >= CONFIG.THRESHOLD_SAVES || m.repins >= CONFIG.THRESHOLD_REPINS) return true;
  return (m.age_days || 0) <= CONFIG.RISING_AGE_DAYS && m.saves >= CONFIG.RISING_SAVES;
}

/* ================= الدفع إلى PinOrbit ================= */
function sendToPinOrbit_(acc, pins, accountMeta) {
  const base = prop_('PINORBIT_URL'), secret = prop_('PINARCHIVE_SECRET');
  if (!base || !secret) return {ok:false, error:'missing PINORBIT_URL / PINARCHIVE_SECRET'};
  if (!acc.workspace_id) return {ok:false, error:'missing workspace_id'};
  const res = UrlFetchApp.fetch(base.replace(/\/+$/,'') + CONFIG.INGEST_PATH, {
    method:'post', contentType:'application/json', muteHttpExceptions:true,
    headers:{ 'x-ingest-secret': secret },
    payload: JSON.stringify({
      run_id: Utilities.getUuid(), workspace_id: acc.workspace_id,
      username: acc.username, fetched_at: new Date().toISOString(),
      /* [H1b] account_meta → بطاقات الحسابات */
      account_meta: accountMeta || { pins_count: pins.length, last_result: 'success' },
      pins: pins
    })
  });
  const code = res.getResponseCode();
  let error = '';
  if (!(code>=200 && code<300)) {
    try { error = (JSON.parse(res.getContentText())||{}).error || ''; } catch (e) {}
    error = error || ('http ' + code);
  }
  if (code === 409 && error === 'ingest_disabled') return {ok:true, skipped:'ingest_disabled'};
  return {ok: code>=200 && code<300, code, error};
}

/* ============================================================
 * 🔁 حلقة الإنعاش (Refresh Loop) — v3 + [G2][G4][G5][G6]
 * ============================================================ */

const REFRESH_CONFIG = {
  BATCH_SIZE: 25,
  SLEEP_BETWEEN_PINS_MS: 1200,
  SLEEP_BETWEEN_BATCHES_MS: 2000,
  MAX_PINS_PER_RUN: 120,
  CIRCUIT_BREAKER_THRESHOLD: 3,
};

/* ---------- [G2] التعريف الوحيد لجلب إحصائيات pin ---------- */
function fetchPinStats_(pinId) {
  const cookie = prop_('PINTEREST_COOKIE');
  if (!cookie) return { ok:false, code:0, error:'missing cookie' };

  const src = '/pin/' + pinId + '/';
  const options = { id: pinId, field_set_key: 'detailed' };
  const url = 'https://www.pinterest.com/resource/PinResource/get/'
    + '?source_url=' + encodeURIComponent(src)
    + '&data=' + encodeURIComponent(JSON.stringify({ options: options, context: {} }))
    + '&_=' + Date.now();

  const res = UrlFetchApp.fetch(url, {
    headers: {
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      'Accept':'application/json, text/javascript, */*, q=0.01',
      'Accept-Language':'en-US,en;q=0.9,ar;q=0.8',
      'X-Requested-With':'XMLHttpRequest',
      'X-App-Version':'fe3675a',
      'X-Pinterest-AppState':'active',
      'X-Pinterest-Platform-Bid': extractCookie_(cookie,'_b'),
      'X-Pinterest-Source-Url': src,
      'Referer':'https://www.pinterest.com' + src,
      'Cookie': cookie
    },
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code !== 200) return { ok:false, code:code };
  try {
    const body = JSON.parse(res.getContentText());
    const pin = (body.resource_response && body.resource_response.data) || {};
    const st  = (pin.aggregated_pin_data && pin.aggregated_pin_data.aggregated_stats) || {};
    return {
      ok: true,
      saves:    Number(st.saves || 0),
      repins:   Number(pin.repin_count || 0),
      comments: Number(pin.comment_count || 0)
    };
  } catch (e) {
    return { ok:false, code:code, error:'parse: ' + e.message };
  }
}

/* ---------- دفع دفعة من pins المنعشة إلى PinOrbit ---------- */
function pushRefreshBatch_(acc, pins) {
  if (!pins.length) return { ok: true };
  const base = prop_('PINORBIT_URL'), secret = prop_('PINARCHIVE_SECRET');
  if (!base || !secret || !acc.workspace_id) return { ok: false, error: 'missing config' };

  const res = UrlFetchApp.fetch(base.replace(/\/+$/, '') + CONFIG.INGEST_PATH, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-ingest-secret': secret },
    payload: JSON.stringify({
      run_id: Utilities.getUuid(),
      workspace_id: acc.workspace_id,
      username: acc.username,
      fetched_at: new Date().toISOString(),
      trigger: 'refresh',   /* [G4] */
      pins: pins
    })
  });

  const code = res.getResponseCode();
  let error = '';
  if (!(code >= 200 && code < 300)) {
    try { error = (JSON.parse(res.getContentText()) || {}).error || ''; } catch (e) {}
    error = error || ('http ' + code);
  }
  /* [G6] */
  if (code === 409 && error === 'ingest_disabled') return { ok: true, skipped: 'ingest_disabled' };
  return { ok: code >= 200 && code < 300, code, error };
}

/* ---------- الدالة الرئيسية للحلقة ---------- */
function refreshArchived() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('Another refresh is running'); return; }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const accounts = readAccounts_();
    const summary = { accountsProcessed: 0, pinsRefreshed: 0, pinsUpdated: 0,
                      batchesPushed: 0, batchesSkipped: 0, errors: [] };

    for (const acc of accounts) {
      if (acc.acc.status !== 'active') continue;
      const sh = ss.getSheetByName(acc.acc.sheet_name);
      if (!sh) continue;

      const schema = ensureSchema_(sh, PIN_HEADERS);
      const map = schema.map, width = schema.width;
      const last = sh.getLastRow();
      if (last < 2) continue;

      const rows = sh.getRange(2, 1, last - 1, width).getValues();
      const toRefresh = [];

      rows.forEach((row, i) => {
        const pinId = String(getF_(row, map, 'pin_id') || '');
        const archivedAt = getF_(row, map, 'archived_at');
        if (pinId && archivedAt) {
          toRefresh.push({ sheetRow: i + 2, pin_id: pinId, row: row });
        }
      });

      if (toRefresh.length === 0) continue;
      summary.accountsProcessed++;

      /* [G5] التدوير: الأقدم تحديثاً أولاً */
      toRefresh.sort((a, b) => {
        const ta = new Date(String(getF_(a.row, map, 'last_updated_at') || '')).getTime() || 0;
        const tb = new Date(String(getF_(b.row, map, 'last_updated_at') || '')).getTime() || 0;
        return ta - tb;
      });

      const limited = toRefresh.slice(0, REFRESH_CONFIG.MAX_PINS_PER_RUN);
      const refreshedBatch = [];
      let consecutive403 = 0;

      for (const item of limited) {
        if (consecutive403 >= REFRESH_CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
          summary.errors.push('circuit-breaker: 3x HTTP 401/403 — تحقق من الكوكي');
          break;
        }

        try {
          const fresh = fetchPinStats_(item.pin_id);
          if (!fresh.ok) {
            if (fresh.code === 401 || fresh.code === 403) {
              consecutive403++;
              summary.errors.push(item.pin_id + ': http ' + fresh.code + ' (attempt ' + consecutive403 + ')');
              if (consecutive403 >= REFRESH_CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
                summary.errors.push('circuit-breaker: 3x HTTP ' + fresh.code + ' — تحقق من الكوكي');
                break;
              }
              continue;
            }
            summary.errors.push(item.pin_id + ': http ' + fresh.code + (fresh.error ? ' / ' + fresh.error : ''));
            continue;
          }

          consecutive403 = 0;

          const oldSaves    = Number(getF_(item.row, map, 'saves'))    || 0;
          const oldRepins   = Number(getF_(item.row, map, 'repins'))   || 0;
          const oldComments = Number(getF_(item.row, map, 'comments')) || 0;

          const newSaves    = Number(fresh.saves)    || 0;
          const newRepins   = Number(fresh.repins)   || 0;
          const newComments = Number(fresh.comments) || 0;

          if (newSaves !== oldSaves || newRepins !== oldRepins || newComments !== oldComments) {
            const created = getF_(item.row, map, 'created_at')
              ? new Date(getF_(item.row, map, 'created_at'))
              : new Date();
            const age = Math.max(1, (Date.now() - created.getTime()) / 86400000) || 1;

            const newRow = item.row.slice();
            newRow[(map['saves']    || 1) - 1] = newSaves;
            newRow[(map['repins']   || 1) - 1] = newRepins;
            newRow[(map['comments'] || 1) - 1] = newComments;
            newRow[(map['velocity'] || 1) - 1] = Math.round((newSaves / age) * 100) / 100;
            newRow[(map['last_updated_at'] || 1) - 1] = fmtDate_(new Date());

            sh.getRange(item.sheetRow, 1, 1, width).setValues([newRow]);
            summary.pinsUpdated++;

            refreshedBatch.push({
              pin_id: item.pin_id,
              workspace_id: acc.acc.workspace_id,
              username: acc.acc.username,
              title: getF_(item.row, map, 'title') || '',
              description: getF_(item.row, map, 'description') || '',
              link: getF_(item.row, map, 'link') || '',
              domain: getF_(item.row, map, 'domain') || '',
              board_name: getF_(item.row, map, 'board_name') || '',
              created_at: getF_(item.row, map, 'created_at') || '',
              image_url: getF_(item.row, map, 'image_url') || '',
              image_signature: getF_(item.row, map, 'image_signature') || '',
              dominant_color: getF_(item.row, map, 'dominant_color') || '',
              saves: newSaves,
              repins: newRepins,
              comments: newComments,
              velocity: Math.round((newSaves / age) * 100) / 100,
              tags: getF_(item.row, map, 'tags') || '',
              refreshed_at: new Date().toISOString()
            });
          }

          summary.pinsRefreshed++;
        } catch (e) {
          summary.errors.push(item.pin_id + ': ' + e.message);
        }

        Utilities.sleep(REFRESH_CONFIG.SLEEP_BETWEEN_PINS_MS);

        if (refreshedBatch.length >= REFRESH_CONFIG.BATCH_SIZE) {
          const pr = pushRefreshBatch_(acc.acc, refreshedBatch.splice(0, refreshedBatch.length));
          if (pr.ok && pr.skipped === 'ingest_disabled') summary.batchesSkipped++;
          else if (pr.ok) summary.batchesPushed++;
          else summary.errors.push('push: ' + (pr.error || ('http ' + pr.code)));
          Utilities.sleep(REFRESH_CONFIG.SLEEP_BETWEEN_BATCHES_MS);
        }
      }

      if (refreshedBatch.length > 0) {
        const pr = pushRefreshBatch_(acc.acc, refreshedBatch);
        if (pr.ok && pr.skipped === 'ingest_disabled') summary.batchesSkipped++;
        else if (pr.ok) summary.batchesPushed++;
        else summary.errors.push('push: ' + (pr.error || ('http ' + pr.code)));
      }
    }

    Logger.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    lock.releaseLock();
  }
}
```
