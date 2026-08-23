# Google Apps Script (GAS) Collector v2.3 Patch

This document contains the complete, paste-ready Google Apps Script (GAS) collector code for PinArchive (`gas-collector-v2.3.gs`).

## Deployment Instructions

1. Open your Google Apps Script project attached to your PinArchive Control & Data Sheets.
2. Replace the contents of your script file (or `Code.gs`) with the complete script below.
3. Verify Script Properties in **Project Settings > Script Properties**:
   - `PINORBIT_WORKER_URL`: Base URL of your PinOrbit worker (e.g. `https://pinorbit.yourdomain.com`).
   - `PINARCHIVE_INGEST_SECRET`: Shared webhook secret for authenticating with PinOrbit.
4. Click **Deploy > Manage deployments > Edit > New version > Deploy**.

---

## Complete Script (`gas-collector-v2.3.gs`)

```javascript
/**
 * PinArchive Google Apps Script Collector v2.3
 *
 * Handles Pinterest scraping, Control Sheet synchronization, and webhook dispatching.
 * Incorporates fixes G1 through G6:
 * - G1: Robust payload unwrapping for nested bridge payloads { action, payload: { ... } }
 * - G2: Safe null-checking for backfill_pins arrays
 * - G3: Resilient HTTP fetching with exponential backoff on 429/5xx
 * - G4: Optional user_id in add_account sheet bridge action
 * - G5: Real-time dispatch_now action handler for on-demand account ingestion
 * - G6: 409 ingest_disabled terminal skip handling without retries
 */

// ─── CONFIGURATION & PROPERTIES ──────────────────────────────────────────────
function getScriptConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    WORKER_URL: props.getProperty('PINORBIT_WORKER_URL') || '',
    INGEST_SECRET: props.getProperty('PINARCHIVE_INGEST_SECRET') || '',
    CONTROL_SHEET_NAME: 'Control',
    DATA_SHEET_NAME: 'Pins',
  };
}

// ─── G3: EXPONENTIAL BACKOFF FETCH HELPER ────────────────────────────────────
function fetchWithRetry(url, options, maxRetries) {
  const retries = typeof maxRetries === 'number' ? maxRetries : 3;
  const opts = Object.assign({ muteHttpExceptions: true }, options || {});

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = UrlFetchApp.fetch(url, opts);
      const code = res.getResponseCode();

      // Return on success or non-retryable client errors (except 429)
      if (code >= 200 && code < 400) {
        return res;
      }

      if (code !== 429 && code < 500) {
        // 4xx client errors (400, 401, 403, 404, 409) return immediately
        return res;
      }

      if (attempt < retries) {
        const sleepMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        console.warn('Fetch HTTP ' + code + ' for ' + url + '. Retrying in ' + sleepMs + 'ms (attempt ' + (attempt + 1) + '/' + retries + ')...');
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

// ─── G6: PUSH TO PINORBIT WITH TERMINAL 409 HANDLING ──────────────────────────
function pushToPinOrbit(workspaceId, username, pins, accountMeta) {
  const config = getScriptConfig();
  if (!config.WORKER_URL || !config.INGEST_SECRET) {
    console.error('Missing PINORBIT_WORKER_URL or PINARCHIVE_INGEST_SECRET in Script Properties.');
    return { success: false, error: 'missing_worker_config' };
  }

  // G2: Ensure pins is safe array
  const safePins = Array.isArray(pins) ? pins : [];

  const payload = {
    run_id: Utilities.getUuid(),
    workspace_id: workspaceId,
    username: username,
    fetched_at: new Date().toISOString(),
    trigger: accountMeta?.trigger || 'cron',
    account_meta: Object.assign(
      {
        pins_count: safePins.length,
        last_result: 'success',
      },
      accountMeta || {}
    ),
    pins: safePins,
  };

  const endpoint = config.WORKER_URL.replace(/\/+$/, '') + '/api/internal/pinarchive/ingest';
  const response = fetchWithRetry(
    endpoint,
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-ingest-secret': config.INGEST_SECRET,
      },
      payload: JSON.stringify(payload),
    },
    2
  );

  const statusCode = response.getResponseCode();
  const text = response.getContentText();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch (e) {}

  // G6: 409 is terminal — do not retry
  if (statusCode === 409) {
    console.warn('[TERMINAL 409] PinOrbit ingestion disabled for workspace ' + workspaceId + ': ' + (json.error || text));
    return { success: false, skipped: true, error: 'ingest_disabled', terminal: true };
  }

  if (statusCode >= 200 && statusCode < 300) {
    console.info('Successfully pushed ' + safePins.length + ' pins for @' + username + ' to PinOrbit.');
    return { success: true, accepted: json.accepted || safePins.length, truncated: json.truncated };
  }

  console.error('Failed to push to PinOrbit: HTTP ' + statusCode + ' - ' + text);
  return { success: false, statusCode: statusCode, error: json.error || text };
}

// ─── CONTROL SHEET HELPERS ───────────────────────────────────────────────────
function getControlSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const config = getScriptConfig();
  let sheet = ss.getSheetByName(config.CONTROL_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(config.CONTROL_SHEET_NAME);
    sheet.appendRow(['workspace_id', 'username', 'interval_days', 'status', 'last_run_at', 'user_id', 'created_at']);
  }
  return sheet;
}

// ─── G4: ADD ACCOUNT BRIDGE ACTION ───────────────────────────────────────────
function handleAddAccount(p) {
  const workspaceId = String(p.workspace_id || '').trim();
  const username = String(p.username || '').trim().replace(/^@/, '');
  const intervalDays = Number(p.interval_days) || 3;
  // G4: user_id is optional and never throws if missing/empty
  const userId = p.user_id ? String(p.user_id).trim() : '';

  if (!workspaceId || !username) {
    return { success: false, error: 'workspace_id and username are required.' };
  }

  const sheet = getControlSheet();
  const data = sheet.getDataRange().getValues();
  let existingRow = -1;

  for (let r = 1; r < data.length; r++) {
    const rowWs = String(data[r][0] || '').trim();
    const rowUser = String(data[r][1] || '').trim();
    if (rowWs === workspaceId && rowUser.toLowerCase() === username.toLowerCase()) {
      existingRow = r + 1; // 1-indexed sheet row
      break;
    }
  }

  const now = new Date().toISOString();
  if (existingRow > 0) {
    // Update existing row
    sheet.getRange(existingRow, 3).setValue(intervalDays);
    sheet.getRange(existingRow, 4).setValue('active');
    if (userId) sheet.getRange(existingRow, 6).setValue(userId);
    return { success: true, action: 'add_account', status: 'updated', username: username };
  } else {
    // Append new row
    sheet.appendRow([workspaceId, username, intervalDays, 'active', '', userId, now]);
    return { success: true, action: 'add_account', status: 'created', username: username };
  }
}

// ─── G5: DISPATCH NOW ACTION HANDLER ─────────────────────────────────────────
function handleDispatchNow(p) {
  const workspaceId = String(p.workspace_id || '').trim();
  const username = String(p.username || '').trim().replace(/^@/, '');

  if (!workspaceId || !username) {
    return { success: false, error: 'workspace_id and username are required for dispatch_now.' };
  }

  console.info('Triggering immediate scrape dispatch for @' + username + ' (workspace ' + workspaceId + ')...');

  // Scrape the target Pinterest creator profile
  const scrapeResult = scrapePinterestUser(username);
  if (!scrapeResult.ok) {
    return {
      success: false,
      action: 'dispatch_now',
      username: username,
      error: scrapeResult.error || 'Scraping failed for user @' + username,
    };
  }

  // Push harvested pins to PinOrbit
  const pushRes = pushToPinOrbit(workspaceId, username, scrapeResult.pins, {
    trigger: 'manual',
    follower_count: scrapeResult.followerCount,
    pins_count: scrapeResult.pins.length,
  });

  // Update Control sheet last_run_at
  try {
    const sheet = getControlSheet();
    const data = sheet.getDataRange().getValues();
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][0]).trim() === workspaceId && String(data[r][1]).trim().toLowerCase() === username.toLowerCase()) {
        sheet.getRange(r + 1, 5).setValue(new Date().toISOString());
        break;
      }
    }
  } catch (e) {}

  return {
    success: true,
    action: 'dispatch_now',
    username: username,
    pins_scraped: scrapeResult.pins.length,
    push_result: pushRes,
  };
}

// ─── PINTEREST SCRAPER LOGIC ─────────────────────────────────────────────────
function scrapePinterestUser(username) {
  const cleanUser = encodeURIComponent(username.replace(/^@/, ''));
  const url = 'https://www.pinterest.com/' + cleanUser + '/';

  try {
    const response = fetchWithRetry(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      2
    );

    if (response.getResponseCode() !== 200) {
      return { ok: false, error: 'Pinterest profile HTTP ' + response.getResponseCode() };
    }

    const html = response.getContentText();
    const pins = [];
    let followerCount = 0;

    // Extract Initial Redux state or JSON payload
    const match = html.match(/id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match && match[1]) {
      try {
        const json = JSON.parse(match[1]);
        const initialPins = json?.props?.initialReduxState?.pins || {};
        for (const pid of Object.keys(initialPins)) {
          const pin = initialPins[pid];
          if (pin && (pin.id || pin.pin_id)) {
            pins.push(normalizePin(pin));
          }
        }
        followerCount = json?.props?.initialReduxState?.users?.[cleanUser]?.follower_count || 0;
      } catch (e) {}
    }

    return { ok: true, pins: pins, followerCount: followerCount };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function normalizePin(raw) {
  const stats = raw.aggregated_pin_data?.aggregated_stats || raw.aggregatedStats || {};
  return {
    pin_id: String(raw.id || raw.pin_id),
    title: raw.title || raw.grid_title || '',
    description: raw.description || raw.grid_description || '',
    link: raw.link || '',
    domain: raw.domain || '',
    saves: Number(stats.saves || raw.saves || 0),
    repins: Number(raw.repin_count || stats.repins || 0),
    comments: Number(raw.comment_count || 0),
    image_url: raw.images?.orig?.url || raw.image_large_url || '',
    created_at_pinterest: raw.created_at || null,
  };
}

// ─── G1: WEBHOOK DISPATCHER (doPost) ─────────────────────────────────────────
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Empty POST body' })).setMimeType(
        ContentService.MimeType.JSON
      );
    }

    const b = JSON.parse(e.postData.contents);

    // G1: Safely unwrap flat or nested payload envelope
    const p = Object.assign({}, b, b.payload || {});
    const action = String(b.action || p.action || '').trim();

    // Verify Shared Ingest Secret
    const config = getScriptConfig();
    const providedSecret = String(b.secret || p.secret || '').trim();
    if (config.INGEST_SECRET && providedSecret !== config.INGEST_SECRET) {
      return ContentService.createTextOutput(
        JSON.stringify({ success: false, error: 'Unauthorized: invalid secret' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    let result = { success: false, error: 'Unknown action: ' + action };

    if (action === 'add_account') {
      result = handleAddAccount(p);
    } else if (action === 'dispatch_now') {
      // G5: Real-time scrape dispatch
      result = handleDispatchNow(p);
    } else if (action === 'backfill_pins') {
      // G2: Ensure safe array handling
      const pins = Array.isArray(p.pins) ? p.pins : [];
      result = pushToPinOrbit(p.workspace_id, p.username, pins, { trigger: 'backfill' });
    } else if (action === 'ping' || action === 'status') {
      result = { success: true, pong: true, timestamp: new Date().toISOString() };
    }

    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('doPost fatal exception:', err);
    return ContentService.createTextOutput(
      JSON.stringify({ success: false, error: err.message || 'Internal exception in doPost' })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'active', service: 'PinArchive Collector v2.3' })
  ).setMimeType(ContentService.MimeType.JSON);
}
```
