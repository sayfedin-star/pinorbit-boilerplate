# PinArchive Google Apps Script (GAS) Collector v2.3

This document contains the deployed, canonical Google Apps Script (GAS) Collector v2.3 source code for PinArchive, along with deployment steps and acceptance checks.

---

## 1. Script Properties (Project Settings > Script Properties)

| Property Name | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `PINORBIT_URL` | **Yes** | Base URL of your PinOrbit instance | `https://pinorbit.yourdomain.com` |
| `PINARCHIVE_SECRET` | **Yes** | Shared secret matching `PINARCHIVE_INGEST_SECRET` | `pa_sec_live_...` |
| `PINTEREST_COOKIE` | *Optional* | Session cookie for Pinterest scraping | `_auth=1; _pinterest_sess=...` |

---

## 2. Deployment Steps

1. Open the Google Spreadsheet containing your **Control** and **Pins** sheets.
2. Open **Extensions > Apps Script**.
3. In **Project Settings (gear icon) > Script Properties**, verify `PINORBIT_URL`, `PINARCHIVE_SECRET`, and optionally `PINTEREST_COOKIE`.
4. Paste the complete `gas-collector-v2.3.gs` code below into your script editor (e.g. `Code.gs`).
5. Click **Save** (`Ctrl+S`).
6. Click **Deploy > Manage deployments > Edit > New version > Deploy**.
7. Ensure the Web App is configured with:
   - **Execute as**: *Me*
   - **Who has access**: *Anyone*
8. In **Triggers (clock icon)**, ensure a time-driven trigger runs `tick` periodically (e.g. every 1 hour).

---

## 3. Deployed Source Code (`gas-collector-v2.3.gs`)

```javascript
/**
 * PinArchive Google Apps Script (GAS) Collector v2.3
 *
 * Full PinArchive Collector with fixes G1–G6:
 * - G1: Robust payload unwrapping for bridge requests (action, payload)
 * - G2: Safe null checking on pins array
 * - G3: Exponential backoff HTTP fetching with retry on 429/5xx
 * - G4: Optional user_id in Control sheet row
 * - G5: 'run' action for forced single-account scraping
 * - G6: Terminal 409 handling for ingest_disabled
 */

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
function getScriptConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    PINORBIT_URL: (props.getProperty('PINORBIT_URL') || '').replace(/\/+$/, ''),
    PINARCHIVE_SECRET: props.getProperty('PINARCHIVE_SECRET') || props.getProperty('PINARCHIVE_INGEST_SECRET') || '',
    PINTEREST_COOKIE: props.getProperty('PINTEREST_COOKIE') || '',
    CONTROL_SHEET: 'Control',
    PINS_SHEET: 'Pins',
  };
}

// ─── G3: RESILIENT HTTP FETCHING WITH RETRY & BACKOFF ────────────────────────
function fetchWithRetry(url, options, maxRetries) {
  const retries = typeof maxRetries === 'number' ? maxRetries : 3;
  const opts = Object.assign({ muteHttpExceptions: true }, options || {});

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = UrlFetchApp.fetch(url, opts);
      const code = res.getResponseCode();

      if (code >= 200 && code < 400) return res;
      if (code !== 429 && code < 500) return res; // Non-retryable client errors

      if (attempt < retries) {
        const sleepMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        console.warn('HTTP ' + code + ' for ' + url + '. Retrying in ' + sleepMs + 'ms (attempt ' + (attempt + 1) + '/' + retries + ')...');
        Utilities.sleep(sleepMs);
      } else {
        return res;
      }
    } catch (err) {
      if (attempt < retries) {
        const sleepMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        console.warn('Network error: ' + err.message + '. Retrying in ' + sleepMs + 'ms...');
        Utilities.sleep(sleepMs);
      } else {
        throw err;
      }
    }
  }
}

// ─── G6: PUSH BATCH TO PINORBIT WITH TERMINAL 409 HANDLING ───────────────────
function pushBatchToPinOrbit(workspaceId, username, pins, meta) {
  const cfg = getScriptConfig();
  if (!cfg.PINORBIT_URL || !cfg.PINARCHIVE_SECRET) {
    console.error('Missing PINORBIT_URL or PINARCHIVE_SECRET');
    return { ok: false, error: 'missing_config' };
  }

  // G2: Safe array guarantee
  const safePins = Array.isArray(pins) ? pins : [];

  const body = {
    run_id: Utilities.getUuid(),
    workspace_id: workspaceId,
    username: username,
    fetched_at: new Date().toISOString(),
    trigger: meta?.trigger || 'cron',
    account_meta: Object.assign({ last_result: 'success' }, meta?.account_meta || {}),
    pins: safePins,
  };

  try {
    const res = fetchWithRetry(cfg.PINORBIT_URL + '/api/internal/pinarchive/ingest', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-ingest-secret': cfg.PINARCHIVE_SECRET,
      },
      payload: JSON.stringify(body),
    });

    const code = res.getResponseCode();
    const text = res.getContentText();

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

// ─── SHEET HELPERS ────────────────────────────────────────────────────────────
function getSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getControlSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(getScriptConfig().CONTROL_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(getScriptConfig().CONTROL_SHEET);
    sheet.appendRow(['Username', 'Workspace ID', 'Interval (Days)', 'Last Scraped At', 'Status', 'Next Run At', 'User ID']);
  }
  return sheet;
}

function getPinsSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(getScriptConfig().PINS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(getScriptConfig().PINS_SHEET);
    sheet.appendRow(['Pin ID', 'Username', 'Title', 'Description', 'Link', 'Saves', 'Repins', 'Comments', 'Created At', 'Archived At']);
  }
  return sheet;
}

// ─── G4: ADD / UPDATE ACCOUNT IN CONTROL SHEET ────────────────────────────────
function addAccount(payload) {
  const username = String(payload.username || '').trim().replace(/^@/, '').toLowerCase();
  const workspaceId = String(payload.workspace_id || '').trim();
  const intervalDays = parseInt(payload.interval_days, 10) || 3;
  const userId = String(payload.user_id || '').trim();

  if (!username || !workspaceId) {
    return { ok: false, error: 'username and workspace_id are required' };
  }

  const sheet = getControlSheet();
  const data = sheet.getDataRange().getValues();

  for (let r = 1; r < data.length; r++) {
    const rowUser = String(data[r][0] || '').trim().toLowerCase();
    const rowWs = String(data[r][1] || '').trim();

    if (rowUser === username && rowWs === workspaceId) {
      // Existing row: preserve status and last_scraped_at
      sheet.getRange(r + 1, 3).setValue(intervalDays);
      if (userId) sheet.getRange(r + 1, 7).setValue(userId);
      return { ok: true, action: 'updated', username: username, row: r + 1 };
    }
  }

  // New row
  const now = new Date();
  sheet.appendRow([
    username,
    workspaceId,
    intervalDays,
    '',               // Last Scraped At
    'active',         // Status
    now.toISOString(),// Next Run At (immediate)
    userId,           // User ID
  ]);

  return { ok: true, action: 'inserted', username: username, row: sheet.getLastRow() };
}

// ─── PINTEREST SCRAPER ────────────────────────────────────────────────────────
function scrapeUserPins(username) {
  const cfg = getScriptConfig();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };

  if (cfg.PINTEREST_COOKIE) {
    headers['Cookie'] = cfg.PINTEREST_COOKIE;
  }

  const url = 'https://www.pinterest.com/' + encodeURIComponent(username) + '/pins/';
  const res = fetchWithRetry(url, { headers: headers }, 3);

  if (res.getResponseCode() !== 200) {
    console.warn('Failed to fetch Pinterest page for @' + username + ': HTTP ' + res.getResponseCode());
    return [];
  }

  const html = res.getContentText();
  const pins = [];

  // Extract from __PWS_DATA__ or JSON blocks
  const match = html.match(/id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      const reduxState = data?.props?.initialReduxState;
      const rawPins = reduxState?.pins || {};

      for (const id in rawPins) {
        const p = rawPins[id];
        if (p && p.id) {
          pins.push({
            pin_id: String(p.id),
            title: p.title || p.grid_title || '',
            description: p.description || '',
            link: p.link || '',
            domain: p.domain || '',
            saves: parseInt(p.aggregated_pin_data?.aggregated_stats?.saves || p.saves || 0, 10),
            repins: parseInt(p.repin_count || 0, 10),
            comments: parseInt(p.comment_count || 0, 10),
            created_at_pinterest: p.created_at || null,
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

// ─── G5: SCRAPE AND INGEST A SINGLE ACCOUNT ──────────────────────────────────
function processAccount(usernameFilter) {
  const sheet = getControlSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { count: 0 };

  const now = new Date();
  let processed = 0;

  for (let r = 1; r < data.length; r++) {
    const rowUser = String(data[r][0] || '').trim();
    const workspaceId = String(data[r][1] || '').trim();
    const intervalDays = parseInt(data[r][2], 10) || 3;
    const status = String(data[r][4] || '').trim().toLowerCase();
    const nextRunStr = String(data[r][5] || '').trim();

    if (!rowUser || !workspaceId) continue;
    if (usernameFilter && rowUser.toLowerCase() !== usernameFilter.toLowerCase()) continue;
    if (!usernameFilter && status === 'paused') continue;

    // Check if due when running full tick
    if (!usernameFilter && nextRunStr) {
      const nextRun = new Date(nextRunStr);
      if (!isNaN(nextRun.getTime()) && nextRun > now) continue;
    }

    console.log('Processing @' + rowUser + ' for workspace ' + workspaceId + '...');
    const pins = scrapeUserPins(rowUser);

    if (pins.length > 0) {
      const pushRes = pushBatchToPinOrbit(workspaceId, rowUser, pins, { trigger: usernameFilter ? 'run' : 'cron' });
      if (pushRes.ok) {
        console.log('Successfully pushed ' + pins.length + ' pins for @' + rowUser);
      } else {
        console.warn('Push failed for @' + rowUser + ': ' + (pushRes.error || pushRes.code));
      }
    }

    // Update Control sheet timestamps
    const nextDate = new Date(now.getTime() + intervalDays * 86400000);
    sheet.getRange(r + 1, 4).setValue(now.toISOString());      // Last Scraped At
    sheet.getRange(r + 1, 6).setValue(nextDate.toISOString()); // Next Run At
    processed++;
  }

  return { count: processed };
}

// ─── TICK ROUTINE (SCHEDULED OR MANUAL) ───────────────────────────────────────
function tick() {
  return processAccount(null);
}

// ─── G1 & G5: WEBHOOK DISPATCH HANDLER (doPost) ──────────────────────────────
function doPost(e) {
  const cfg = getScriptConfig();

  try {
    // G1: Envelope unwrapping
    let rawBody = {};
    if (e && e.postData && e.postData.contents) {
      rawBody = JSON.parse(e.postData.contents);
    }

    // Secret verification
    if (cfg.PINARCHIVE_SECRET) {
      const reqSecret = rawBody.secret || '';
      if (reqSecret !== cfg.PINARCHIVE_SECRET) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized: invalid secret' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    const action = rawBody.action || 'tick';
    const payload = rawBody.payload || rawBody;

    // Route actions
    if (action === 'add_account') {
      const result = addAccount(payload);
      return ContentService.createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // G5: Forced single-account execution or full tick
    if (action === 'run') {
      const username = payload.username || null;
      const result = processAccount(username);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, action: 'run', processed: result.count }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'tick') {
      const result = tick();
      return ContentService.createTextOutput(JSON.stringify({ ok: true, action: 'tick', processed: result.count }))
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

---

## 4. Acceptance Checks

1. **Ping / Add Account**: Sending POST `action: 'add_account'` with `username`, `workspace_id`, and `interval_days` inserts or updates the Control sheet row.
2. **On-Demand Scrape**: Sending POST `action: 'run'` with `username` scrapes and dispatches the specified account immediately.
3. **Ingest Gating Resilience**: If PinOrbit responds with `409 ingest_disabled`, collector skips gracefully without retrying.
