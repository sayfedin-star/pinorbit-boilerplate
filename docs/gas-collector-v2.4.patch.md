# PinArchive Google Apps Script (GAS) Collector v2.4 Patch Document

This document contains the deployed, canonical Google Apps Script (GAS) Collector v2.4 source code for PinArchive, along with deployment steps, changelog, and acceptance criteria.

---

## 1. Changelog (v2.4)

- **H1a (Off-by-one fix in `addAccount_`)**: Fixed column count mismatch (14 columns) where `created_at` was shifted to column O due to an extra `0`. Now properly aligns timestamp to column N.
- **H1b (`account_meta` telemetry in `sendToPinOrbit_`)**: Added `account_meta: { pins_count: pinsSheet.getLastRow() - 1, last_result: 'success' }` to ingestion payload so PinArchive dashboard cards populate live pin counts.
- **H1c (Dynamic Pin Filter Configuration)**: In `tick()`, collector queries `/api/internal/pinarchive/config?workspace_id=...` with `x-ingest-secret` once per workspace execution. Updated `qualifies_(m, cfg)` to dynamically filter pins based on `pin_filter_min_saves`, `pin_filter_min_repins`, and `pin_filter_max_age_days` with fail-safe defaults.

---

## 2. Script Properties (Project Settings > Script Properties)

| Property Name | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `PINORBIT_URL` | **Yes** | Base URL of your PinOrbit instance | `https://pinorbit.yourdomain.com` |
| `PINARCHIVE_SECRET` | **Yes** | Shared secret matching `PINARCHIVE_INGEST_SECRET` | `pa_sec_live_...` |
| `PINTEREST_COOKIE` | *Optional* | Session cookie for Pinterest scraping | `_auth=1; _pinterest_sess=...` |

---

## 3. Deployment Steps

1. Open the Google Spreadsheet containing your **Control** and **Pins** sheets.
2. Open **Extensions > Apps Script**.
3. In **Project Settings (gear icon) > Script Properties**, verify `PINORBIT_URL`, `PINARCHIVE_SECRET`, and optionally `PINTEREST_COOKIE`.
4. Paste the complete `gas-collector-v2.4.gs` code below into your script editor (e.g. `Code.gs`).
5. Click **Save** (`Ctrl+S`).
6. Click **Deploy > Manage deployments > Edit > New version > Deploy**.
7. Ensure the Web App is configured with:
   - **Execute as**: *Me*
   - **Who has access**: *Anyone*
8. In **Triggers (clock icon)**, ensure a time-driven trigger runs `tick` periodically (e.g. every 1 hour).

---

## 4. Deployed Source Code (`gas-collector-v2.4.gs`)

```javascript
/**
 * PinArchive Google Apps Script (GAS) Collector v2.4
 *
 * Changelog:
 * - v2.4 (H1a): Fixed addAccount_ column alignment off-by-one (14 columns)
 * - v2.4 (H1b): Populated account_meta: { pins_count, last_result: 'success' }
 * - v2.4 (H1c): Fetches /api/internal/pinarchive/config and dynamically applies pin filters in qualifies_(m, cfg)
 * - v2.3 (G1–G6): Webhook envelope unwrapping, resilient retry backoff, terminal 409 handling
 */

// ─── CONFIGURATION & DEFAULTS ─────────────────────────────────────────────────
var CONFIG = {
  CONTROL_SHEET: 'Control',
  PINS_SHEET: 'Pins',
  DEFAULT_INTERVAL_DAYS: 3,
  THRESHOLD_SAVES: 0,
  THRESHOLD_REPINS: 0,
  MAX_RETRIES: 3,
};

function prop_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

function getScriptConfig() {
  return {
    PINORBIT_URL: prop_('PINORBIT_URL').replace(/\/+$/, ''),
    PINARCHIVE_SECRET: prop_('PINARCHIVE_SECRET') || prop_('PINARCHIVE_INGEST_SECRET'),
    PINTEREST_COOKIE: prop_('PINTEREST_COOKIE'),
    CONTROL_SHEET: CONFIG.CONTROL_SHEET,
    PINS_SHEET: CONFIG.PINS_SHEET,
  };
}

// ─── G3: RESILIENT HTTP FETCHING WITH RETRY & BACKOFF ────────────────────────
function fetchWithRetry(url, options, maxRetries) {
  var retries = typeof maxRetries === 'number' ? maxRetries : CONFIG.MAX_RETRIES;
  var opts = Object.assign({ muteHttpExceptions: true }, options || {});

  for (var attempt = 0; attempt <= retries; attempt++) {
    try {
      var res = UrlFetchApp.fetch(url, opts);
      var code = res.getResponseCode();

      if (code >= 200 && code < 400) return res;
      if (code !== 429 && code < 500) return res; // Non-retryable client errors

      if (attempt < retries) {
        var sleepMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        console.warn('HTTP ' + code + ' for ' + url + '. Retrying in ' + sleepMs + 'ms (attempt ' + (attempt + 1) + '/' + retries + ')...');
        Utilities.sleep(sleepMs);
      } else {
        return res;
      }
    } catch (err) {
      if (attempt < retries) {
        var sleepMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        console.warn('Network error: ' + err.message + '. Retrying in ' + sleepMs + 'ms...');
        Utilities.sleep(sleepMs);
      } else {
        throw err;
      }
    }
  }
}

// ─── H1c: FETCH WORKSPACE CONFIGURATION (FAIL-SAFE) ───────────────────────────
function fetchWorkspaceConfig_(wsId) {
  if (!wsId) return null;
  var baseUrl = prop_('PINORBIT_URL').replace(/\/+$/, '');
  var secret = prop_('PINARCHIVE_SECRET');
  if (!baseUrl || !secret) return null;

  try {
    var url = baseUrl + '/api/internal/pinarchive/config?workspace_id=' + encodeURIComponent(wsId);
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'x-ingest-secret': secret },
      muteHttpExceptions: true,
    });

    if (res.getResponseCode() === 200) {
      var json = JSON.parse(res.getContentText());
      if (json && json.success) return json;
    }
  } catch (e) {
    console.warn('Failed to fetch workspace config for ' + wsId + ': ' + e.message);
  }
  return null;
}

// ─── H1c: QUALIFIES PIN FILTER EVALUATION ─────────────────────────────────────
function qualifies_(m, cfg) {
  var minS = (cfg && typeof cfg.pin_filter_min_saves === 'number') ? cfg.pin_filter_min_saves : CONFIG.THRESHOLD_SAVES;
  var minR = (cfg && typeof cfg.pin_filter_min_repins === 'number') ? cfg.pin_filter_min_repins : CONFIG.THRESHOLD_REPINS;
  var maxA = (cfg && typeof cfg.pin_filter_max_age_days === 'number') ? cfg.pin_filter_max_age_days : 0;

  if (minS > 0 && (m.saves || 0) < minS) return false;
  if (minR > 0 && (m.repins || 0) < minR) return false;
  if (maxA > 0 && (m.age_days || 0) > maxA) return false;
  return true;
}

// ─── SHEET HELPERS ────────────────────────────────────────────────────────────
function getSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getControlSheet() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(getScriptConfig().CONTROL_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(getScriptConfig().CONTROL_SHEET);
    sheet.appendRow([
      'Username', 'Workspace ID', 'Interval (Days)', 'Last Scraped At',
      'Status', 'Next Run At', 'User ID', 'Col8', 'Col9', 'Col10',
      'Col11', 'Col12', 'Pins Count', 'Created At'
    ]);
  }
  return sheet;
}

function getPinsSheet() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(getScriptConfig().PINS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(getScriptConfig().PINS_SHEET);
    sheet.appendRow([
      'Pin ID', 'Username', 'Title', 'Description', 'Link',
      'Saves', 'Repins', 'Comments', 'Created At', 'Archived At'
    ]);
  }
  return sheet;
}

// ─── H1a & G4: ADD / UPDATE ACCOUNT IN CONTROL SHEET ──────────────────────────
function addAccount_(payload) {
  var username = String(payload.username || '').trim().replace(/^@/, '').toLowerCase();
  var workspaceId = String(payload.workspace_id || '').trim();
  var intervalDays = parseInt(payload.interval_days, 10) || CONFIG.DEFAULT_INTERVAL_DAYS;
  var userId = String(payload.user_id || '').trim();

  if (!username || !workspaceId) {
    return { ok: false, error: 'username and workspace_id are required' };
  }

  var sheet = getControlSheet();
  var data = sheet.getDataRange().getValues();

  for (var r = 1; r < data.length; r++) {
    var rowUser = String(data[r][0] || '').trim().toLowerCase();
    var rowWs = String(data[r][1] || '').trim();

    if (rowUser === username && rowWs === workspaceId) {
      // Existing row: update interval and user_id while preserving timestamps and status
      sheet.getRange(r + 1, 3).setValue(intervalDays);
      if (userId) sheet.getRange(r + 1, 7).setValue(userId);
      return { ok: true, action: 'updated', username: username, row: r + 1 };
    }
  }

  // H1a: Insert exactly 14 column values (Created At in Col N)
  sheet.appendRow([
    username,
    workspaceId,
    intervalDays,
    '',               // Last Scraped At
    'active',         // Status
    new Date().toISOString(), // Next Run At (immediate)
    userId,           // User ID
    '', '', '', '', '', // Cols 8-12
    0,                // Pins Count (Col 13 / M)
    new Date().toISOString() // Created At (Col 14 / N)
  ]);

  return { ok: true, action: 'inserted', username: username, row: sheet.getLastRow() };
}

// ─── H1b & G6: SEND TO PINORBIT INGESTION API ─────────────────────────────────
function sendToPinOrbit_(workspaceId, username, pins, meta) {
  var cfg = getScriptConfig();
  if (!cfg.PINORBIT_URL || !cfg.PINARCHIVE_SECRET) {
    console.error('Missing PINORBIT_URL or PINARCHIVE_SECRET');
    return { ok: false, error: 'missing_config' };
  }

  var safePins = Array.isArray(pins) ? pins : [];
  var pinsSheet = getPinsSheet();
  var totalPinsCount = Math.max(0, pinsSheet.getLastRow() - 1);

  // H1b: Send account_meta with pins_count and last_result
  var body = {
    run_id: Utilities.getUuid(),
    workspace_id: workspaceId,
    username: username,
    fetched_at: new Date().toISOString(),
    trigger: meta?.trigger || 'cron',
    account_meta: Object.assign({
      pins_count: totalPinsCount,
      last_result: 'success'
    }, meta?.account_meta || {}),
    pins: safePins,
  };

  try {
    var res = fetchWithRetry(cfg.PINORBIT_URL + '/api/internal/pinarchive/ingest', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-ingest-secret': cfg.PINARCHIVE_SECRET,
      },
      payload: JSON.stringify(body),
    });

    var code = res.getResponseCode();
    var text = res.getContentText();

    if (code >= 200 && code < 300) {
      return { ok: true, code: code, response: text };
    }

    // G6: Terminal 409 ingest_disabled check
    if (code === 409 && text.indexOf('ingest_disabled') !== -1) {
      console.warn('[TERMINAL 409] Ingestion disabled for workspace ' + workspaceId);
      return { ok: false, code: 409, terminal: true, error: 'ingest_disabled' };
    }

    return { ok: false, code: code, error: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── PINTEREST SCRAPER ────────────────────────────────────────────────────────
function scrapeUserPins(username) {
  var cfg = getScriptConfig();
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };

  if (cfg.PINTEREST_COOKIE) {
    headers['Cookie'] = cfg.PINTEREST_COOKIE;
  }

  var url = 'https://www.pinterest.com/' + encodeURIComponent(username) + '/pins/';
  var res = fetchWithRetry(url, { headers: headers }, CONFIG.MAX_RETRIES);

  if (res.getResponseCode() !== 200) {
    console.warn('Failed to fetch Pinterest page for @' + username + ': HTTP ' + res.getResponseCode());
    return [];
  }

  var html = res.getContentText();
  var pins = [];

  var match = html.match(/id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (match) {
    try {
      var data = JSON.parse(match[1]);
      var reduxState = data?.props?.initialReduxState;
      var rawPins = reduxState?.pins || {};
      var nowMs = Date.now();

      for (var id in rawPins) {
        var p = rawPins[id];
        if (p && p.id) {
          var createdAtStr = p.created_at || null;
          var ageDays = 0;
          if (createdAtStr) {
            var createdMs = new Date(createdAtStr).getTime();
            if (!isNaN(createdMs)) {
              ageDays = Math.max(0, Math.floor((nowMs - createdMs) / 86400000));
            }
          }

          pins.push({
            pin_id: String(p.id),
            title: p.title || p.grid_title || '',
            description: p.description || '',
            link: p.link || '',
            domain: p.domain || '',
            saves: parseInt(p.aggregated_pin_data?.aggregated_stats?.saves || p.saves || 0, 10),
            repins: parseInt(p.repin_count || 0, 10),
            comments: parseInt(p.comment_count || 0, 10),
            created_at_pinterest: createdAtStr,
            age_days: ageDays,
            image_url: p.images?.orig?.url || p.image_large_url || '',
            board_name: p.board?.name || '',
          });
        }
      }
    } catch (e) {
      console.warn('Could not parse __PWS_DATA__ for @' + username + ': ' + e.message);
    }
  }

  return pins;
}

// ─── PROCESS ACCOUNT (WITH H1c DYNAMIC FILTERING) ─────────────────────────────
function processAccount_(usernameFilter, wsConfigMap) {
  var sheet = getControlSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { count: 0 };

  var now = new Date();
  var processed = 0;

  for (var r = 1; r < data.length; r++) {
    var rowUser = String(data[r][0] || '').trim();
    var workspaceId = String(data[r][1] || '').trim();
    var intervalDays = parseInt(data[r][2], 10) || CONFIG.DEFAULT_INTERVAL_DAYS;
    var status = String(data[r][4] || '').trim().toLowerCase();
    var nextRunStr = String(data[r][5] || '').trim();

    if (!rowUser || !workspaceId) continue;
    if (usernameFilter && rowUser.toLowerCase() !== usernameFilter.toLowerCase()) continue;
    if (!usernameFilter && status === 'paused') continue;

    // Check schedule if running periodic tick
    if (!usernameFilter && nextRunStr) {
      var nextRun = new Date(nextRunStr);
      if (!isNaN(nextRun.getTime()) && nextRun > now) continue;
    }

    // Resolve workspace filter config
    var cfg = (wsConfigMap && wsConfigMap[workspaceId]) ? wsConfigMap[workspaceId] : fetchWorkspaceConfig_(workspaceId);

    console.log('Processing @' + rowUser + ' for workspace ' + workspaceId + '...');
    var rawPins = scrapeUserPins(rowUser);

    // Apply H1c dynamic qualifying filter
    var qualifiedPins = [];
    for (var i = 0; i < rawPins.length; i++) {
      if (qualifies_(rawPins[i], cfg)) {
        qualifiedPins.push(rawPins[i]);
      }
    }

    if (qualifiedPins.length > 0) {
      var pushRes = sendToPinOrbit_(workspaceId, rowUser, qualifiedPins, { trigger: usernameFilter ? 'run' : 'cron' });
      if (pushRes.ok) {
        console.log('Successfully pushed ' + qualifiedPins.length + ' pins for @' + rowUser);
      } else {
        console.warn('Push failed for @' + rowUser + ': ' + (pushRes.error || pushRes.code));
      }
    }

    // Update Control sheet timestamps
    var nextDate = new Date(now.getTime() + intervalDays * 86400000);
    sheet.getRange(r + 1, 4).setValue(now.toISOString());      // Last Scraped At
    sheet.getRange(r + 1, 6).setValue(nextDate.toISOString()); // Next Run At
    processed++;
  }

  return { count: processed };
}

// ─── TICK ROUTINE (H1c FETCH CONFIG ONCE PER WORKSPACE) ──────────────────────
function tick() {
  var sheet = getControlSheet();
  var data = sheet.getDataRange().getValues();
  var wsConfigMap = {};

  // Fetch config once per distinct workspace
  for (var r = 1; r < data.length; r++) {
    var wsId = String(data[r][1] || '').trim();
    if (wsId && !wsConfigMap[wsId]) {
      wsConfigMap[wsId] = fetchWorkspaceConfig_(wsId);
    }
  }

  return processAccount_(null, wsConfigMap);
}

// ─── WEBHOOK DISPATCH HANDLER (doPost) ────────────────────────────────────────
function doPost(e) {
  var cfg = getScriptConfig();

  try {
    // G1: Envelope unwrapping
    var rawBody = {};
    if (e && e.postData && e.postData.contents) {
      rawBody = JSON.parse(e.postData.contents);
    }

    // Secret verification
    if (cfg.PINARCHIVE_SECRET) {
      var reqSecret = rawBody.secret || '';
      if (reqSecret !== cfg.PINARCHIVE_SECRET) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized: invalid secret' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    var action = rawBody.action || 'tick';
    var payload = rawBody.payload || rawBody;

    if (action === 'add_account') {
      var addResult = addAccount_(payload);
      return ContentService.createTextOutput(JSON.stringify(addResult))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'run') {
      var username = payload.username || null;
      var runResult = processAccount_(username, null);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, action: 'run', processed: runResult.count }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'tick') {
      var tickResult = tick();
      return ContentService.createTextOutput(JSON.stringify({ ok: true, action: 'tick', processed: tickResult.count }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unknown action: ' + action }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```
