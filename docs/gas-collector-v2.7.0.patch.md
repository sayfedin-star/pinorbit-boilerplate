# PinArchive Google Apps Script (GAS) Collector v2.7.0 Patch Document

This document contains the deployed, canonical Google Apps Script (GAS) Collector v2.7.0 source code for PinArchive, transitioning GAS from an active crawler into a passive thin Google Sheet writer for GitHub Actions.

---

## ⚡ Cutover Instructions & Architecture Modes

> **Operational Runbook**: See [docs/cutover-runbook.md](file:///C:/Users/D.Mouad/.gemini/antigravity/worktrees/PinOrbit/migrate_pinorbit_brain_gas/docs/cutover-runbook.md) for the complete atomic switch and rollback procedures.

In v2.7.0, the `legacy_mode` Script Property controls the system role:
- **`legacy_mode = false` (GH Brain Active / Thin Writer)**: GAS acts purely as a passive receiver for the `sheet_write` webhook from GitHub Actions. Autonomous scraping (`tick`), metric refreshing (`refreshArchived`), and direct Sheet scraping are bypassed (no-ops). Zero egress calls to Pinterest.
- **`legacy_mode = true` (Legacy Autonomous Fallback)**: GAS owns the entire collection cycle (v2.6.2 behavior) using `PINTEREST_COOKIE` and direct HTTP polling. Use this mode for instant rollback if needed.

---

## 1. Changelog (v2.7.0)

- **[W1] `sheet_write` Action**: Added `doPost` action `sheet_write` supporting atomic chunked writes (`mode: 'append' | 'update'`) up to 500 rows per request with dedicated `LockService` synchronization.
- **[W2] Change-Detection & Counters**: In `sheet_write` update mode, rows with identical saves/repins/comments are skipped from re-writing; returns `{ok:true, written: updatedCount+toAppend.length, appended: toAppend.length, updated: updatedCount}`.
- **[L1] `legacy_mode` Switch**: Controlled via Script Property `legacy_mode`. When `false` (default for GH Brain architecture), background timers (`tick`, `refreshArchived`, Pinterest scraping, Control-sheet writes) become immediate no-ops.
- **[Z1] Zero External Egress**: When `legacy_mode` is `false`, zero `UrlFetchApp.fetch` network requests occur. GAS operates purely as a passive Sheet writer.
- **[B1] Rollback Ready**: Setting `legacy_mode` to `true` in Script Properties restores full autonomous v2.6.2 scraping and sync behavior without requiring code edits.

---

## 2. Script Properties (Project Settings > Script Properties)

| Property Name | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `PINARCHIVE_SECRET` | **Yes** | Shared secret matching `PINARCHIVE_INGEST_SECRET` | `pa_sec_live_...` |
| `legacy_mode` | *Optional* | `false` (thin writer) or `true` (autonomous legacy runner) | `false` |
| `PINORBIT_URL` | *Legacy only* | Base URL of PinOrbit instance (used when `legacy_mode=true`) | `https://pinorbit.yourdomain.com` |
| `PINTEREST_COOKIE` | *Legacy only* | Session cookie for Pinterest scraping (used when `legacy_mode=true`) | `_auth=1; ...` |

---

## 3. Deployment Steps

1. Open the Google Spreadsheet containing your **Control** and **pins_** sheets.
2. Open **Extensions > Apps Script**.
3. In **Project Settings (gear icon) > Script Properties**, verify `PINARCHIVE_SECRET` and set `legacy_mode` to `false` (or `true` during rollback).
4. Paste the complete `gas-collector-v2.7.0.gs` code below into your script editor (`Code.gs`).
5. Click **Save** (`Ctrl+S`).
6. Click **Deploy > Manage deployments > Edit > New version > Deploy**.
7. Ensure the Web App is configured with:
   - **Execute as**: *Me*
   - **Who has access**: *Anyone*

---

## 4. Deployed Source Code (`gas-collector-v2.7.0.gs`)

```javascript
/***************************************************************
 * 📌 PinArchive Collector v2.7.0 — THIN WRITER & GH BRAIN
 *
 * Changelog vs v2.6.2:
 *  [W1] doPost 'sheet_write': passive batch writer for GH Actions.
 *  [L1] legacy_mode property: when false, zero daily autonomous runs,
 *       zero Pinterest calls, zero UrlFetch outside legacy blocks.
 *  [B1] Rollback: setting legacy_mode='true' restores full v2.6.2 engine.
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

const CONTROL_HEADERS = [
  'username','user_id','workspace_id','sheet_name','interval_days',
  'next_run_at','status','backfill_status','backfill_cursor','last_run_at',
  'last_result','pins_count','archived_count','created_at'
];

const PIN_HEADERS = [
  'pin_id','title','description','link','domain','board_name',
  'created_at','image_url','image_signature','dominant_color','saves','repins',
  'comments','velocity','first_seen_at','last_updated_at','archived_at','tags'
];

const C_ = {}; CONTROL_HEADERS.forEach((h, i) => C_[h] = i + 1);
const P_ = {}; PIN_HEADERS.forEach((h, i) => P_[h] = i + 1);

/* ================= أدوات مساعدة ================= */
const prop_ = k => PropertiesService.getScriptProperties().getProperty(k) || '';
const out_  = o => ContentService.createTextOutput(JSON.stringify(o))
                     .setMimeType(ContentService.MimeType.JSON);

function isLegacyMode_() {
  const v = prop_('legacy_mode');
  return v === 'true';
}

function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
}

const cellToStr_ = (v) => (v instanceof Date ? fmtDate_(v) : String(v ?? ''));

function timingSafeEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
  const row1 = w0 > 0 ? sh.getRange(1, 1, 1, w0).getValues()[0] : [];
  const map = {};
  row1.forEach((h, i) => { if (h) map[String(h)] = i + 1; });
  let next = w0 + 1;
  headers.forEach(h => {
    if (!map[h]) { sh.getRange(1, next).setValue(h); map[h] = next; next++; }
  });
  return { map, width: Math.max(w0, next - 1) };
}

function buildRow_(obj, map, width) {
  const row = new Array(width).fill('');
  PIN_HEADERS.forEach(h => {
    let val = obj[h];
    if (h === 'created_at' && val === undefined) val = obj.created_at_pinterest;
    if (h === 'tags' && val === undefined && Array.isArray(obj.annotations)) {
      val = obj.annotations.map(a => (typeof a === 'string' ? a : a.name || '')).filter(Boolean).join(', ');
    }
    row[(map[h] || 1) - 1] = (val !== undefined && val !== null ? val : '');
  });
  return row;
}

const getF_ = (row, map, h) => row[(map[h] || 1) - 1];

/* ================= نقاط الدخول ================= */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('PinArchive')
    .addItem('مزامنة الفلتر الآن (Sheets ← DB)', 'refreshArchived')
    .addItem('تشغيل المستحق الآن', 'runDueAccounts')
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
  const base = {
    ok: true,
    service: 'pinarchive-collector',
    version: '2.7.0',
    legacy_mode: isLegacyMode_(),
    time: new Date().toISOString()
  };
  if (authed) base.accounts = readAccounts_().map(a => a.summary);
  return out_(base);
}

function doPost(e) {
  let b = {};
  try { b = JSON.parse(e.postData.contents || '{}'); } catch (err) { return out_({ok: false, error: 'bad json'}); }
  
  const providedSecret = b.secret || (b.payload && b.payload.secret) || '';
  if (!timingSafeEqual_(providedSecret, prop_('PINARCHIVE_SECRET'))) {
    return out_({ok: false, error: 'unauthorized'});
  }

  const p = Object.assign({}, b, b.payload || {});

  // ── Action: sheet_write (Thin Writer for GitHub Actions) ──
  if (p.action === 'sheet_write') {
    return handleSheetWrite_(p);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ctl = ensureControl_(ss);

  switch (p.action) {
    case 'ping':
      return out_({ok: true, version: '2.7.0', legacy_mode: isLegacyMode_()});
    case 'status':
      return out_({ok: true, accounts: readAccounts_().map(a => a.summary)});
    case 'update_cookie':
      PropertiesService.getScriptProperties().setProperty('PINTEREST_COOKIE', String(p.cookie || ''));
      return out_({ok: true});
    case 'set_interval':
      if (!isLegacyMode_()) return out_({ok: true, note: 'ignored in non-legacy mode'});
      return out_(setInterval_(ctl, p));
    case 'pause':
      if (!isLegacyMode_()) return out_({ok: true, note: 'ignored in non-legacy mode'});
      return out_(setStatus_(ctl, p.username, 'paused'));
    case 'resume':
      if (!isLegacyMode_()) return out_({ok: true, note: 'ignored in non-legacy mode'});
      return out_(setStatus_(ctl, p.username, 'active'));
    case 'add_account':
      if (!isLegacyMode_()) return out_({ok: true, note: 'ignored in non-legacy mode'});
      return out_(addAccount_(ctl, p));
    case 'run':
      if (!isLegacyMode_()) return out_({ok: true, note: 'ignored in non-legacy mode'});
      tick(p.username || null, !!p.username || p.force === true);
      return out_({ok: true});
    default:
      return out_({ok: false, error: 'unknown action'});
  }
}

/* ================= معالج كتابة الشيت المباشر (sheet_write) ================= */
function handleSheetWrite_(p) {
  const username = String(p.username || '').trim();
  if (!username) return out_({ok: false, error: 'username required'});

  const rawRows = Array.isArray(p.rows) ? p.rows : [];
  if (rawRows.length === 0) return out_({ok: true, written: 0});

  const mode = p.mode === 'update' ? 'update' : 'append';
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return out_({ok: false, error: 'locked'});

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = 'pins_' + username;
    const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    const schema = ensureSchema_(sh, PIN_HEADERS);
    const map = schema.map, width = schema.width;

    const lastRow = sh.getLastRow();
    const nowHuman = fmtDate_(new Date());

    if (mode === 'append') {
      const rowsToAdd = rawRows.map(r => {
        if (!r.first_seen_at) r.first_seen_at = nowHuman;
        if (!r.last_updated_at) r.last_updated_at = nowHuman;
        return buildRow_(r, map, width);
      });
      sh.getRange(lastRow + 1, 1, rowsToAdd.length, width).setValues(rowsToAdd);
      return out_({ok: true, written: rowsToAdd.length});
    }

    // mode === 'update'
    const existingRows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, width).getValues() : [];
    const index = {};
    existingRows.forEach((row, i) => {
      const id = String(getF_(row, map, 'pin_id') || '').trim();
      if (id) index[id] = i;
    });

    let updatedCount = 0;
    const toAppend = [];

    for (let j = 0; j < rawRows.length; j++) {
      const r = rawRows[j];
      const pinId = String(r.pin_id || '').trim();
      if (!pinId) continue;
      const idx = index[pinId];
      if (idx !== undefined) {
        const existRow = existingRows[idx];
        const oldSaves = Number(getF_(existRow, map, 'saves') || 0);
        const oldRepins = Number(getF_(existRow, map, 'repins') || 0);
        const oldComments = Number(getF_(existRow, map, 'comments') || 0);
        const newSaves = Number(r.saves || 0);
        const newRepins = Number(r.repins || 0);
        const newComments = Number(r.comments || 0);

        if (oldSaves === newSaves && oldRepins === newRepins && oldComments === newComments) {
          // No metrics changed, skip writing
          continue;
        }

        r.first_seen_at = getF_(existRow, map, 'first_seen_at') || nowHuman;
        r.last_updated_at = nowHuman;
        sh.getRange(idx + 2, 1, 1, width).setValues([buildRow_(r, map, width)]);
        updatedCount++;
      } else {
        r.first_seen_at = nowHuman;
        r.last_updated_at = nowHuman;
        toAppend.push(buildRow_(r, map, width));
      }
    }

    if (toAppend.length > 0) {
      sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, width).setValues(toAppend);
    }

    return out_({
      ok: true,
      written: updatedCount + toAppend.length,
      appended: toAppend.length,
      updated: updatedCount,
    });
  } catch (err) {
    return out_({ok: false, error: err.message});
  } finally {
    lock.releaseLock();
  }
}

/* ================= Legacy Runner (Active ONLY when legacy_mode === true) ================= */
function runDueAccounts() {
  if (!isLegacyMode_()) { Logger.log('Legacy runs disabled in thin writer mode.'); return; }
  tick(null, false);
}

function tick(onlyUsername, force) {
  if (!isLegacyMode_()) return;
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
      catch (err) { updateControl_(ctl, item.row, {last_result: 'error: ' + err.message}); }
      if (Date.now() - now > CONFIG.TIME_BUDGET_MS) break;
    }
  } finally { lock.releaseLock(); }
}

function processAccount_(ss, ctl, r, acc, cfg) {
  if (!isLegacyMode_()) return;
  const started = Date.now();
  const nowHuman = fmtDate_(new Date());
  const stats = { pages: 0, added: 0, updated: 0, sent: 0, skippedIngest: 0 };

  const sh = ss.getSheetByName(acc.sheet_name) || ss.insertSheet(acc.sheet_name);
  const schema = ensureSchema_(sh, PIN_HEADERS);
  const map = schema.map, width = schema.width;

  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  const index = {};
  rows.forEach((row, i) => { const id = String(getF_(row, map, 'pin_id')); if (id) index[id] = i; });

  let cursor = acc.backfill_cursor || null;
  let cookieOk = true, hasMore = true;
  const sendList = [];

  while (hasMore && (Date.now() - started) < CONFIG.TIME_BUDGET_MS) {
    const page = fetchPage_(acc, cursor);
    if (!page.ok) { cookieOk = false; break; }
    stats.pages++;

    page.pins.forEach(p => {
      const m = mapPin_(p);
      if (!m.pin_id) return;
      m.workspace_id = acc.workspace_id;
      const i = index[m.pin_id];
      if (i !== undefined) {
        m.first_seen_at = getF_(rows[i], map, 'first_seen_at') || nowHuman;
        m.archived_at   = getF_(rows[i], map, 'archived_at') || '';
        sh.getRange(i + 2, 1, 1, width).setValues([buildRow_(m, map, width)]);
        stats.updated++;
      } else {
        m.first_seen_at = nowHuman; m.archived_at = '';
        sh.appendRow(buildRow_(m, map, width));
        index[m.pin_id] = (last + (++stats.added)) - 2;
      }
      if (!m.archived_at && qualifies_(m, cfg)) sendList.push(m);
    });

    cursor = page.bookmark || null;
    if (!cursor || cursor === '-end-') { hasMore = false; cursor = null; }
    else Utilities.sleep(CONFIG.SLEEP_MS);
  }

  if (sendList.length) {
    const send = sendToPinOrbit_(acc, sendList, { pins_count: sh.getLastRow() - 1, last_result: 'success' });
    if (send.ok && send.skipped === 'ingest_disabled') {
      stats.skippedIngest = sendList.length;
    } else if (send.ok) {
      stats.sent = sendList.length;
      sendList.forEach(m => {
        const i = index[m.pin_id];
        if (i !== undefined) {
          const rowNum = i + 2;
          const colNum = map['archived_at'] || P_.archived_at;
          sh.getRange(rowNum, colNum).setValue(nowHuman);
        }
      });
    } else {
      stats.sendError = send.error;
    }
  }

  updateControl_(ctl, r, {
    status: cookieOk ? 'active' : 'cookie_expired',
    backfill_status: cookieOk ? (cursor ? 'in_progress' : 'done') : (acc.backfill_status || 'pending'),
    backfill_cursor: cursor || '',
    last_run_at: new Date().toISOString(),
    last_result: cookieOk
      ? ('pages=' + stats.pages + ' +' + stats.added + ' ~' + stats.updated + ' sent=' + stats.sent)
      : 'cookie expired / http error',
    pins_count: sh.getLastRow() - 1,
    archived_count: (Number(ctl.getRange(r + 1, C_.archived_count).getValue()) || 0) + stats.sent,
    next_run_at: (cookieOk && !cursor)
      ? new Date(Date.now() + acc.interval_days * 86400000).toISOString()
      : (acc.next_run_at || new Date().toISOString())
  });
}

function fetchPage_(acc, cursor) {
  if (!isLegacyMode_()) return {ok: false, code: 0};
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
    + '&data=' + encodeURIComponent(JSON.stringify({options, context: {}}))
    + '&_=' + Date.now();
  const res = UrlFetchApp.fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/javascript, */*, q=0.01',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      'X-App-Version': 'fe3675a',
      'X-Pinterest-AppState': 'active',
      'X-Pinterest-Platform-Bid': extractCookie_(cookie, '_b'),
      'X-Pinterest-PWS-Handler': 'www/[username]/_created.js',
      'X-Pinterest-Source-Url': src,
      'Referer': 'https://www.pinterest.com' + src,
      'Cookie': cookie
    },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) return {ok: false, code};
  const rr = (JSON.parse(res.getContentText()) || {}).resource_response || {};
  return {ok: true, pins: rr.data || [], bookmark: rr.bookmark || null};
}

function mapPin_(p) {
  const st = (p.aggregated_pin_data && p.aggregated_pin_data.aggregated_stats) || {};
  const saves = Number(st.saves || 0), repins = Number(p.repin_count || 0), comments = Number(p.comment_count || 0);
  const created = p.created_at ? new Date(p.created_at) : new Date();
  const age = Math.max(1, (Date.now() - created.getTime()) / 86400000) || 1;
  return {
    pin_id: String(p.id || ''), title: p.title || p.grid_title || '',
    description: p.description || p.grid_description || '', link: p.link || '',
    domain: p.domain || '', board_name: (p.board && p.board.name) || '',
    created_at: fmtDate_(created),
    image_url: (p.images && p.images.orig && p.images.orig.url) || '',
    image_signature: p.image_signature || '', dominant_color: p.dominant_color || '',
    saves, repins, comments,
    age_days: age,
    velocity: Math.round((saves / age) * 100) / 100,
    annotations: []
  };
}

function qualifies_(m, cfg) {
  if (!isLegacyMode_()) return false;
  const minS = (cfg && typeof cfg.pin_filter_min_saves === 'number') ? cfg.pin_filter_min_saves : CONFIG.THRESHOLD_SAVES;
  const minR = (cfg && typeof cfg.pin_filter_min_repins === 'number') ? cfg.pin_filter_min_repins : CONFIG.THRESHOLD_REPINS;
  const risA = (cfg && typeof cfg.pin_filter_rising_age_days === 'number') ? cfg.pin_filter_rising_age_days : CONFIG.RISING_AGE_DAYS;
  const risS = (cfg && typeof cfg.pin_filter_rising_saves === 'number') ? cfg.pin_filter_rising_saves : CONFIG.RISING_SAVES;

  if (minS > 0 && m.saves >= minS) return true;
  if (minR > 0 && m.repins >= minR) return true;
  if (risA > 0 && risS > 0 && (m.age_days || 0) <= risA && m.saves >= risS) return true;
  return false;
}

function sendToPinOrbit_(acc, pins, accountMeta) {
  if (!isLegacyMode_()) return {ok: true, note: 'disabled outside legacy mode'};
  const base = prop_('PINORBIT_URL'), secret = prop_('PINARCHIVE_SECRET');
  if (!base || !secret) return {ok: false, error: 'missing PINORBIT_URL / PINARCHIVE_SECRET'};
  if (!acc.workspace_id) return {ok: false, error: 'missing workspace_id'};
  const res = UrlFetchApp.fetch(base.replace(/\/+$/, '') + CONFIG.INGEST_PATH, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-ingest-secret': secret },
    payload: JSON.stringify({
      run_id: Utilities.getUuid(), workspace_id: acc.workspace_id,
      username: acc.username, fetched_at: new Date().toISOString(),
      account_meta: accountMeta || { pins_count: pins.length, last_result: 'success' },
      pins: pins
    })
  });
  const code = res.getResponseCode();
  let error = '';
  if (!(code >= 200 && code < 300)) {
    try { error = (JSON.parse(res.getContentText()) || {}).error || ''; } catch (e) {}
    error = error || ('http ' + code);
  }
  if (code === 409 && error === 'ingest_disabled') return {ok: true, skipped: 'ingest_disabled'};
  return {ok: code >= 200 && code < 300, code, error};
}

function fetchWorkspaceConfig_(wsId) {
  if (!isLegacyMode_()) return null;
  if (!wsId) return null;
  const base = prop_('PINORBIT_URL'), secret = prop_('PINARCHIVE_SECRET');
  if (!base || !secret) return null;
  try {
    const url = base.replace(/\/+$/, '') + '/api/internal/pinarchive/config?workspace_id=' + encodeURIComponent(wsId);
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

function refreshArchived() {
  if (!isLegacyMode_()) { Logger.log('Filter sync disabled in thin writer mode.'); return; }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ctl = ensureControl_(ss);
    const accounts = readAccounts_();
    const cfgCache = {};
    for (const item of accounts) {
      if (item.acc.status !== 'active') continue;
      const sh = ss.getSheetByName(item.acc.sheet_name);
      if (!sh) continue;
      let cfg = cfgCache[item.acc.workspace_id];
      if (cfg === undefined) {
        cfg = fetchWorkspaceConfig_(item.acc.workspace_id);
        cfgCache[item.acc.workspace_id] = cfg;
      }
      const schema = ensureSchema_(sh, PIN_HEADERS);
      const map = schema.map, width = schema.width;
      const last = sh.getLastRow();
      if (last < 2) continue;
      const rows = sh.getRange(2, 1, last - 1, width).getValues();
      const batch = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const pinId = String(getF_(row, map, 'pin_id') || '').trim();
        if (!pinId) continue;
        const saves = Number(getF_(row, map, 'saves')) || 0;
        const repins = Number(getF_(row, map, 'repins')) || 0;
        const createdStr = cellToStr_(getF_(row, map, 'created_at'));
        const createdMs = createdStr ? new Date(createdStr).getTime() : NaN;
        const ageDays = isNaN(createdMs) ? 99999 : Math.max(0, (Date.now() - createdMs) / 86400000);
        const m = { pin_id: pinId, saves, repins, age_days: ageDays };
        if (qualifies_(m, cfg)) {
          batch.push({
            pin_id: pinId,
            title: String(getF_(row, map, 'title') || ''),
            saves, repins,
            comments: Number(getF_(row, map, 'comments')) || 0,
            archived_at: cellToStr_(getF_(row, map, 'archived_at')) || new Date().toISOString()
          });
        }
      }
      if (batch.length) {
        sendToPinOrbit_(item.acc, batch, { pins_count: last - 1, last_result: 'sync' });
      }
    }
  } finally { lock.releaseLock(); }
}

/* ================= Control Operations ================= */
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
  for (let r = 1; r < v.length; r++) {
    const row = v[r];
    const username = String(row[C_.username - 1] || '').trim();
    if (!username) continue;
    list.push({
      row: r,
      acc: {
        username,
        user_id: String(row[C_.user_id - 1] || ''),
        workspace_id: String(row[C_.workspace_id - 1] || '').trim(),
        sheet_name: String(row[C_.sheet_name - 1] || ('pins_' + username)),
        interval_days: Number(row[C_.interval_days - 1]) || 3,
        next_run_at: row[C_.next_run_at - 1] || '',
        status: String(row[C_.status - 1] || 'active'),
        backfill_status: String(row[C_.backfill_status - 1] || 'pending'),
        backfill_cursor: String(row[C_.backfill_cursor - 1] || '')
      },
      summary: {
        username, status: String(row[C_.status - 1] || 'active'),
        backfill: String(row[C_.backfill_status - 1] || 'pending'),
        last_run_at: row[C_.last_run_at - 1] || '', last_result: row[C_.last_result - 1] || '',
        pins_count: row[C_.pins_count - 1] || 0, archived_count: row[C_.archived_count - 1] || 0
      }
    });
  }
  return list;
}

function updateControl_(ctl, r, patch) {
  if (!isLegacyMode_()) return; // Frozen in non-legacy mode
  for (const k in patch) if (C_[k]) ctl.getRange(r + 1, C_[k]).setValue(patch[k]);
}

function addAccount_(ctl, b) {
  const username = String(b.username || '').trim();
  if (!username) return {ok: false, error: 'username required'};
  const v = ctl.getDataRange().getValues();
  for (let r = 1; r < v.length; r++) if (String(v[r][C_.username - 1] || '').trim() === username)
    return {ok: false, error: 'exists'};
  ctl.appendRow([username, String(b.user_id || ''), String(b.workspace_id || '').trim(),
    'pins_' + username, Number(b.interval_days) || 3, '', 'active', 'pending', '', '', '', '', 0,
    new Date().toISOString()]);
  return {ok: true};
}

function setStatus_(ctl, username, status) {
  const v = ctl.getDataRange().getValues();
  for (let r = 1; r < v.length; r++) if (String(v[r][C_.username - 1] || '').trim() === username) {
    updateControl_(ctl, r, {status});
    return {ok: true};
  }
  return {ok: false, error: 'not found'};
}

function setInterval_(ctl, b) {
  const v = ctl.getDataRange().getValues();
  for (let r = 1; r < v.length; r++) if (String(v[r][C_.username - 1] || '').trim() === String(b.username || '').trim()) {
    updateControl_(ctl, r, {interval_days: Number(b.days) || 3});
    return {ok: true};
  }
  return {ok: false, error: 'not found'};
}
```
