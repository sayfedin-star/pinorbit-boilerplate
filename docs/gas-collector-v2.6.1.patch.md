# PinArchive Google Apps Script (GAS) Collector v2.6.1 Patch Document

This document contains the deployed, canonical Google Apps Script (GAS) Collector v2.6.1 source code for PinArchive, along with deployment steps, changelog, and acceptance criteria.

---

## 1. Changelog (v2.6.1)

- **[A2] `mapPin_`**: `annotations: []` — The GitHub refresh workflow is the sole DB annotation writer. GAS emits `annotations: []`.
- **[T1] `cellToStr_`**: Sheet `Date` cells are formatted via `fmtDate_` instead of `String()` to prevent Postgres timestamp parsing errors in sync pushes.
- **[S1] `refreshArchived`**: Zero-cookie fast sync directly from Sheet rows to Postgres database applying OR filtering rules.
- **Architecture Law**: GAS owns Google Sheets. The GitHub refresh workflow owns DB enrichment (by `pin_id`, no cookie). Independent pipelines.

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
4. Paste the complete `gas-collector-v2.6.1.gs` code below into your script editor (e.g. `Code.gs`).
5. Click **Save** (`Ctrl+S`).
6. Click **Deploy > Manage deployments > Edit > New version > Deploy**.
7. Ensure the Web App is configured with:
   - **Execute as**: *Me*
   - **Who has access**: *Anyone*

---

## 4. Deployed Source Code (`gas-collector-v2.6.1.gs`)

```javascript
/***************************************************************
 * 📌 PinArchive Collector v2.6.1 — FINAL
 * Changelog vs v2.6:
 *  [T1] cellToStr_ helper: sheet Date cells (auto-converted by Sheets)
 *       are formatted via fmtDate_ instead of String() — fixes
 *       "invalid input syntax for type timestamp" in the sync push.
 *  [A2] mapPin_: annotations: [] (workflow is sole DB writer).
 *  Carried: v2.6 (S1 Sheet→DB sync, S2 dead code removed),
 *  v2.5 (OR qualifies_, 3 rules from /config), H1a/H1b/H1c, G1–G6.
 * Architecture law: GAS owns Google Sheets. The GitHub refresh workflow
 * owns DB enrichment (by pin_id, no cookie). Independent pipelines.
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

/* [T1] خلية Sheets قد تكون Date object — نُنسقها بصيغة يقبلها Postgres */
const cellToStr_ = (v) => (v instanceof Date ? fmtDate_(v) : String(v ?? ''));

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
    .addItem('مزامنة الفلتر الآن (Sheets ← DB)', 'refreshArchived')
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
  const base = { ok:true, service:'pinarchive-collector', version:'2.6.1', time:new Date().toISOString() };
  if (authed) base.accounts = readAccounts_().map(a => a.summary);
  return out_(base);
}

function doPost(e) {
  let b = {};
  try { b = JSON.parse(e.postData.contents || '{}'); } catch (err) { return out_({ok:false,error:'bad json'}); }
  if (!timingSafeEqual_(b.secret, prop_('PINARCHIVE_SECRET'))) return out_({ok:false,error:'unauthorized'});

  /* [G1] فك مغلف gas-bridge */
  const p = Object.assign({}, b, b.payload || {});

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ctl = ensureControl_(ss);

  switch (p.action) {
    case 'ping':  return out_({ok:true, version:'2.6.1'});
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
  /* [H1a] 14 قيمة بالضبط */
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

/* ================= [H1c] قراءة قواعد الفلترة من PinOrbit (fail-safe) ================= */
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
  return null;
}

/* ================= التشغيل الرئيسي (Backfill) ================= */
function tick(onlyUsername, force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ctl = ensureControl_(ss);
    const list = readAccounts_();
    const now = Date.now();
    const cfgCache = {};
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

  if (sendList.length) {
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
    annotations: [],   /* workflow is the sole DB annotation writer */
    seo_category: (p.pin_join && p.pin_join.seo_breadcrumbs
                    && p.pin_join.seo_breadcrumbs[0] && p.pin_join.seo_breadcrumbs[0].name) || null
  };
}

/* ================= [OR] القواعد الثلاث مع fallback v2.3 ================= */
function qualifies_(m, cfg) {
  var minS = (cfg && typeof cfg.pin_filter_min_saves === 'number')
    ? cfg.pin_filter_min_saves : CONFIG.THRESHOLD_SAVES;
  var minR = (cfg && typeof cfg.pin_filter_min_repins === 'number')
    ? cfg.pin_filter_min_repins : CONFIG.THRESHOLD_REPINS;
  var risA = (cfg && typeof cfg.pin_filter_rising_age_days === 'number')
    ? cfg.pin_filter_rising_age_days : CONFIG.RISING_AGE_DAYS;
  var risS = (cfg && typeof cfg.pin_filter_rising_saves === 'number')
    ? cfg.pin_filter_rising_saves : CONFIG.RISING_SAVES;

  if (minS > 0 && m.saves >= minS) return true;
  if (minR > 0 && m.repins >= minR) return true;
  if (risA > 0 && risS > 0 && (m.age_days||0) <= risA && m.saves >= risS) return true;
  return false;
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
 * 🔄 [S1] مزامنة Sheet ← DB حسب الفلتر — v2.6.1
 * بلا أي طلب Pinterest — بلا كوكي — ثوانٍ.
 * ============================================================ */

const SYNC_CONFIG = {
  BATCH_SIZE: 25,
  SLEEP_BETWEEN_BATCHES_MS: 2000
};

function pushSyncBatch_(acc, pins) {
  if (!pins.length) return { ok: true, pushed: 0 };
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
      trigger: 'refresh',
      account_meta: { pins_count: pins.length, last_result: 'sync' },
      pins: pins
    })
  });

  const code = res.getResponseCode();
  let error = '';
  if (!(code >= 200 && code < 300)) {
    try { error = (JSON.parse(res.getContentText()) || {}).error || ''; } catch (e) {}
    error = error || ('http ' + code);
  }
  if (code === 409 && error === 'ingest_disabled') return { ok: true, skipped: 'ingest_disabled' };
  return { ok: code >= 200 && code < 300, code, error };
}

/* ---------- [S1] المزامنة المفلترة: Sheet → DB ---------- */
function refreshArchived() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('Another sync is running'); return; }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const accounts = readAccounts_();
    const cfgCache = {};
    const summary = { accountsProcessed: 0, matched: 0, pushed: 0,
                      skippedUnchanged: 0, batchesSkipped: 0, errors: [] };

    for (const item of accounts) {
      if (item.acc.status !== 'active') continue;
      const sh = ss.getSheetByName(item.acc.sheet_name);
      if (!sh) continue;

      let cfg = cfgCache[item.acc.workspace_id];
      if (cfg === undefined) {
        cfg = fetchWorkspaceConfig_(item.acc.workspace_id);
        cfgCache[item.acc.workspace_id] = cfg;
      }
      const minS = (cfg && typeof cfg.pin_filter_min_saves === 'number')
        ? cfg.pin_filter_min_saves : CONFIG.THRESHOLD_SAVES;
      const minR = (cfg && typeof cfg.pin_filter_min_repins === 'number')
        ? cfg.pin_filter_min_repins : CONFIG.THRESHOLD_REPINS;
      const risA = (cfg && typeof cfg.pin_filter_rising_age_days === 'number')
        ? cfg.pin_filter_rising_age_days : CONFIG.RISING_AGE_DAYS;
      const risS = (cfg && typeof cfg.pin_filter_rising_saves === 'number')
        ? cfg.pin_filter_rising_saves : CONFIG.RISING_SAVES;

      const schema = ensureSchema_(sh, PIN_HEADERS);
      const map = schema.map, width = schema.width;
      const last = sh.getLastRow();
      if (last < 2) continue;
      summary.accountsProcessed++;

      const rows = sh.getRange(2, 1, last - 1, width).getValues();
      const nowMs = Date.now();
      const batch = [];
      const batchRows = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const pinId = String(getF_(row, map, 'pin_id') || '').trim();
        if (!pinId) continue;

        const saves  = Number(getF_(row, map, 'saves'))  || 0;
        const repins = Number(getF_(row, map, 'repins')) || 0;
        const createdStr = cellToStr_(getF_(row, map, 'created_at'));
        const createdMs = createdStr ? new Date(createdStr).getTime() : NaN;
        const ageDays = isNaN(createdMs) ? 99999
          : Math.max(0, (nowMs - createdMs) / 86400000);

        /* [S1] القواعد الثلاث — OR (0 = معطلة) */
        const rule1 = minS > 0 && saves >= minS;
        const rule2 = minR > 0 && repins >= minR;
        const rule3 = risA > 0 && risS > 0 && ageDays <= risA && saves >= risS;
        if (!(rule1 || rule2 || rule3)) continue;

        /* Dedup: archived_at >= last_updated_at → أحدث نسخة مدفوعة */
        const archV = getF_(row, map, 'archived_at');
        const updV  = getF_(row, map, 'last_updated_at');
        const archMs = archV instanceof Date ? archV.getTime()
          : (archV ? (Date.parse(String(archV)) || 0) : 0);
        const updMs  = updV instanceof Date ? updV.getTime()
          : (updV ? (Date.parse(String(updV)) || 0) : 0);
        if (archMs && updMs && archMs >= updMs) {
          summary.skippedUnchanged++; continue;
        }

        batch.push({
          pin_id: pinId,
          workspace_id: item.acc.workspace_id,
          username: item.acc.username,
          title: cellToStr_(getF_(row, map, 'title')),
          description: cellToStr_(getF_(row, map, 'description')),
          link: cellToStr_(getF_(row, map, 'link')),
          domain: cellToStr_(getF_(row, map, 'domain')),
          board_name: cellToStr_(getF_(row, map, 'board_name')),
          board_id: getF_(row, map, 'board_id') || null,
          created_at: createdStr,
          created_at_pinterest: createdStr,
          image_url: cellToStr_(getF_(row, map, 'image_url')),
          image_signature: cellToStr_(getF_(row, map, 'image_signature')),
          dominant_color: cellToStr_(getF_(row, map, 'dominant_color')),
          saves: saves,
          repins: repins,
          comments: Number(getF_(row, map, 'comments')) || 0,
          velocity: Number(getF_(row, map, 'velocity')) || 0,
          tags: cellToStr_(getF_(row, map, 'tags'))
        });
        batchRows.push(i + 2);
        summary.matched++;
      }

      if (batch.length === 0) continue;

      for (let b = 0; b < batch.length; b += SYNC_CONFIG.BATCH_SIZE) {
        const slice = batch.slice(b, b + SYNC_CONFIG.BATCH_SIZE);
        const sliceRows = batchRows.slice(b, b + SYNC_CONFIG.BATCH_SIZE);
        const pr = pushSyncBatch_(item.acc, slice);
        if (pr.ok && pr.skipped === 'ingest_disabled') {
          summary.batchesSkipped++;
        } else if (pr.ok) {
          summary.pushed += slice.length;
          const nowHuman = fmtDate_(new Date());
          sliceRows.forEach(sheetRow => {
            sh.getRange(sheetRow, map.archived_at).setValue(nowHuman);
          });
        } else {
          summary.errors.push('push: ' + (pr.error || ('http ' + pr.code)));
        }
        Utilities.sleep(SYNC_CONFIG.SLEEP_BETWEEN_BATCHES_MS);
      }
    }

    Logger.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    lock.releaseLock();
  }
}
```
