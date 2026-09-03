/**
 * PinArchive Staleness Check (Tier 5 Monitoring Safety Net)
 *
 * Verifies that all active daily workspaces (interval_days = 1, ingest_enabled = true)
 * have completed at least one discovery or refresh run within the last 26 hours.
 *
 * If a workspace is stale (> 26h), it emits prominent warning logs and appends
 * an alert to GitHub Actions Step Summary (if available), alerting operators.
 */

import fs from 'node:fs';

const PINARCHIVE_SUPABASE_URL = process.env.PINARCHIVE_SUPABASE_URL;
const PINARCHIVE_SUPABASE_KEY = process.env.PINARCHIVE_SUPABASE_KEY;

if (!PINARCHIVE_SUPABASE_URL || !PINARCHIVE_SUPABASE_KEY) {
  console.warn('⚠️ [STALENESS-CHECK] PINARCHIVE_SUPABASE_URL or PINARCHIVE_SUPABASE_KEY missing. Skipping check.');
  process.exit(0);
}

async function supaQuery(table, params = '') {
  const url = `${PINARCHIVE_SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const res = await fetch(url, {
    headers: {
      apikey: PINARCHIVE_SUPABASE_KEY,
      Authorization: `Bearer ${PINARCHIVE_SUPABASE_KEY}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Supabase ${table}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log('🔍 PinArchive Staleness Check running (threshold: 26 hours)...');

  // 1. Fetch active daily accounts from P4
  let accounts;
  try {
    accounts = await supaQuery(
      'pa_accounts',
      'select=id,workspace_id,username,status,ingest_enabled,interval_days,last_run_at&ingest_enabled=neq.false&status=eq.active'
    );
  } catch (err) {
    console.warn(`⚠️ Could not query pa_accounts: ${err.message}`);
    process.exit(0);
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    console.log('ℹ️ No active ingest-enabled accounts found in pa_accounts.');
    process.exit(0);
  }

  // Filter to workspaces with daily accounts (interval_days = 1)
  const dailyWorkspaces = new Map();
  for (const acc of accounts) {
    const interval = Number(acc.interval_days ?? 1);
    if (interval === 1) {
      if (!dailyWorkspaces.has(acc.workspace_id)) {
        dailyWorkspaces.set(acc.workspace_id, []);
      }
      dailyWorkspaces.get(acc.workspace_id).push(acc);
    }
  }

  if (dailyWorkspaces.size === 0) {
    console.log('ℹ️ No workspaces with interval_days=1 found.');
    process.exit(0);
  }

  const now = Date.now();
  const STALENESS_THRESHOLD_MS = 26 * 3600 * 1000; // 26 hours
  const staleList = [];
  const freshList = [];

  for (const [wsId, accList] of dailyWorkspaces.entries()) {
    // Find the latest last_run_at across this workspace's accounts
    let latestRunMs = 0;
    let latestRunAccount = null;

    for (const a of accList) {
      if (a.last_run_at) {
        const ms = new Date(a.last_run_at).getTime();
        if (ms > latestRunMs) {
          latestRunMs = ms;
          latestRunAccount = a.username;
        }
      }
    }

    const ageHours = latestRunMs > 0 ? ((now - latestRunMs) / 3600000).toFixed(1) : 'Never';
    const isStale = latestRunMs === 0 || now - latestRunMs > STALENESS_THRESHOLD_MS;

    if (isStale) {
      staleList.push({
        workspaceId: wsId,
        shortId: wsId.slice(0, 8),
        accountCount: accList.length,
        ageHours,
        lastAccount: latestRunAccount,
      });
      console.warn(`🚨 [STALE WORKSPACE ALERT] [ws:${wsId.slice(0, 8)}] Last synced ${ageHours}h ago (> 26h threshold) across ${accList.length} daily accounts!`);
    } else {
      freshList.push({
        workspaceId: wsId,
        shortId: wsId.slice(0, 8),
        accountCount: accList.length,
        ageHours,
      });
      console.log(`✅ [FRESH][ws:${wsId.slice(0, 8)}] Synced ${ageHours}h ago (${accList.length} accounts).`);
    }
  }

  // If running in GitHub Actions, write summary to GITHUB_STEP_SUMMARY
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      let md = `### 🛡️ PinArchive 26-Hour Staleness Monitor\n\n`;
      if (staleList.length > 0) {
        md += `> ⚠️ **Warning:** ${staleList.length} daily workspace(s) have not completed an ingestion run within the last 26 hours.\n\n`;
        md += `| Workspace | Daily Accounts | Last Sync Age | Status |\n`;
        md += `| :--- | :---: | :---: | :---: |\n`;
        for (const s of staleList) {
          md += `| \`${s.shortId}\` | ${s.accountCount} | **${s.ageHours}h ago** | 🚨 **STALE** |\n`;
        }
        for (const f of freshList) {
          md += `| \`${f.shortId}\` | ${f.accountCount} | ${f.ageHours}h ago | ✅ Fresh |\n`;
        }
      } else {
        md += `> ✅ **All ${freshList.length} daily workspace(s) are fresh** (all synced within the last 26 hours).\n`;
      }
      fs.appendFileSync(summaryPath, md, 'utf-8');
    } catch (e) {
      console.warn('Could not write to GITHUB_STEP_SUMMARY:', e.message);
    }
  }

  console.log(`\nStaleness check complete: ${staleList.length} stale, ${freshList.length} fresh.`);
  process.exit(0);
}

main().catch(err => {
  console.error('💥 Staleness check encountered an unexpected error:', err);
  process.exit(0); // non-destructive fallback
});
