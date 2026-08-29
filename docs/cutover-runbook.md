# PinArchive GH Brain / GAS Writer Migration — Cutover Runbook

This operational runbook defines the step-by-step procedure for executing the atomic switch from autonomous Google Apps Script (GAS) collectors to the GitHub Actions Brain + GAS Thin Writer architecture.

---

## 1. Overview & Architecture Transition

| Component | Legacy Architecture (v2.6.2) | Target Architecture (v2.7.0 GH Brain) |
| :--- | :--- | :--- |
| **Discovery & Crawling** | GAS cron (`tick`) with hardcoded cookie | GitHub Actions (`pinarchive-discovery.mjs`) + Vault Cookies + Egress IP Rotation |
| **Metrics Refresh** | GAS cron (`refreshArchived`) | GitHub Actions (`pinarchive-refresh.mjs`) |
| **Filtering & Promotion** | GAS client-side filtering | Supabase atomic RPC (`pa_promote_candidates`) via Server Promotion Service |
| **Sheet Persistence** | GAS writes locally during crawl | GitHub Actions pushes filtered rows via GAS `sheet_write` Webhook |
| **Database Sync** | GAS pushes pins to `/api/internal/pinarchive/ingest` | Direct DB Ingest API push from GH runner |

---

## 2. Go / No-Go Checklist (The 4 Production Verification Gates)

Before proceeding to full matrix automation, verify that each gate passes:

1. **Gate 1: Pinterest API Request Health (≥ 90% HTTP 200)**
   - Vault cookies decrypt cleanly with server KEK (`resolveKek`).
   - Requests to `UserActivityPinsResource` return 200 OK without CAPTCHA or blocking.
2. **Gate 2: Zero Circuit-Breaker / Self-Healing Trip**
   - Cookies in `competitor_vault_cookies` (or workspace cookies) authenticate successfully.
   - No runner exits on fatal authentication failures.
3. **Gate 3: Sheet Data Integrity & Deduplication**
   - Spot-check target Google Sheet tabs (`pins_<username>`).
   - Zero duplicate `pin_id` entries.
   - Header formatting, column schemas, and metric values intact.
4. **Gate 4: Database Candidate Ingestion & Promotion Integrity**
   - Unpromoted candidates stored with `archived_at IS NULL` when criteria not met.
   - Qualified pins promoted atomically (`archived_at` populated) on re-evaluation.

---

## 3. Atomic Switch Procedure

### Step 1: Set GAS Mode
1. Open the target Google Spreadsheet containing your **Control** and creator sheets.
2. Navigate to **Extensions > Apps Script**.
3. In **Project Settings (Gear Icon) > Script Properties**:
   - Ensure `PINARCHIVE_SECRET` matches your workspace ingest secret.
   - Set `legacy_mode` = `false` (GAS operates strictly as a passive thin writer for `sheet_write`; background ticks/scrapes become no-ops).
4. Save properties and deploy a new version of the Web App.

### Step 2: Enable GitHub Actions Pipeline
1. In repository **Settings > Secrets and variables > Actions**, verify required repository secrets:
   - `SUPABASE_URL` & `SUPABASE_SERVICE_ROLE_KEY`
   - `PINORBIT_WORKER_URL` & `PINARCHIVE_INGEST_SECRET`
   - `PINARCHIVE_GAS_URL`
2. In the GitHub Actions tab, ensure `.github/workflows/pinarchive-pipeline.yml` is enabled (scheduled daily at 07:00 UTC).

### Step 3: Verify First Run (Staged Pilot ≤ 3 Accounts)
1. Go to **Actions > PinArchive Pipeline (GH Brain) > Run workflow**.
2. Inputs:
   - `workspace_id`: `<your-workspace-uuid>`
   - `usernames`: `account1,account2,account3`
   - `mode`: `all`
3. Click **Run workflow**.
4. Inspect the workflow logs:
   - Shard runners start and stagger.
   - Discovery fetches pages, early-stop $K$ triggers on known pins.
   - Candidate pins pushed to PinArchive Ingest API.
   - Thin writer writes pins to GAS Sheet via `sheet_write`.
   - Stage 3 candidate promotion re-evaluates candidates.
5. Verify the 4 Go/No-Go gates above.

### Step 4: Full Matrix Production Run
1. Trigger **PinArchive Pipeline** with no `usernames` filter (or wait for the daily 07:00 UTC cron trigger).
2. Monitor all 4 runner shards for completion.
3. Verify live dashboard metrics and account counts in `/pinarchive`.

---

## 4. Rollback Procedure

If unexpected issues or upstream Pinterest blocking occurs:

1. **Re-activate GAS Autonomous Engine:**
   - In Google Apps Script **Project Settings > Script Properties**, set `legacy_mode` = `true`.
   - GAS v2.7 immediately resumes autonomous v2.6.2 scraping, local filtering, and DB syncing.
2. **Disable GitHub Schedule:**
   - In GitHub Actions, disable workflow `.github/workflows/pinarchive-pipeline.yml`.
3. **(Optional) Revert Tier 4 Code:**
   - Git revert the Tier 4 cutover commit (`git revert HEAD`).
   - Run `npm test` and redeploy PinOrbit.

---

## 5. Operations & Monitoring

- **Dashboard UI**: Monitor accounts and candidate promotion via `/pinarchive`.
- **Manual Discovery Run**: Click **▶ Run** on any selected accounts or use the dashboard UI.
- **Candidate Re-evaluation**: Click **🔄 Sync** or **Re-evaluate Now** in settings to re-score candidate pins against updated OR rules.
- **Audit Sweep**: Automated monthly full-sweep runs on the 1st of every month via `.github/workflows/pinarchive-audit-sweep.yml`.
