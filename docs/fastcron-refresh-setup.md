# FastCron PinArchive Refresh Setup Guide

This guide details how to configure isolated, per-workspace automated refreshes using FastCron and the PinOrbit Worker refresh relay endpoint.

---

## 1. Architecture Overview

```
[FastCron Scheduler]
        │
        │  POST /api/internal/pinarchive/refresh
        │  Header: x-ingest-secret: <workspace-secret>
        │  Body: { "workspace_id": "<uuid>" }
        ▼
[PinOrbit Worker Relay]
        │
        │  Dual-Auth Verified (ingest secret / session admin)
        │  Injects GH_REFRESH_TOKEN (kept server-side)
        │  POST https://api.github.com/.../dispatches
        ▼
[GitHub Actions Workflow: PinArchive Refresh]
        │
        │  Runs with REFRESH_WORKSPACE_ID
        │  Skips accounts outside target workspace
        │  Orders pins by last_updated_at.asc (G5 Rotation)
        ▼
[PinOrbit Ingest Endpoint] ──► [Database (Project 4)]
```

---

## 2. Worker Secret Setup (GH_REFRESH_TOKEN)

The GitHub Personal Access Token (PAT) is stored securely **only** in Cloudflare Worker secrets and never exposed to clients or FastCron.

1. Go to **GitHub** → **Settings** → **Developer Settings** → **Personal Access Tokens** → **Fine-grained tokens**.
2. Generate a new token:
   - **Repository access**: Only select repository `sayfedin-star/pinorbit-v2`.
   - **Permissions**: **Actions** → `Read and write`.
3. Set the token on Cloudflare Workers:
   ```bash
   wrangler secret put GH_REFRESH_TOKEN
   ```
   Paste your fine-grained token when prompted.

---

## 3. FastCron Job Configuration (Per-Workspace)

Create one dedicated FastCron job per workspace in the FastCron UI:

| Field | Configuration |
|---|---|
| **URL** | `https://<worker-domain>/api/internal/pinarchive/refresh` |
| **HTTP Method** | `POST` |
| **HTTP Headers** | `Content-Type: application/json`<br/>`x-ingest-secret: <workspace ingest secret>` |
| **Request Body** | `{"workspace_id": "<workspace-uuid>"}` |
| **Schedule** | Every 2 to 3 days (e.g. `0 3 */3 * *` or every 72 hours) |

> [!TIP]
> **Locating Workspace Ingest Secret**:
> Navigate to `/analytics/secrets` in the PinOrbit dashboard and click **Reveal** for the target workspace.

---

## 4. Full-Coverage Rotation Mechanics (`last_updated_at.asc`)

The refresh script queries pins ordered by `last_updated_at.asc` with a limit of 150 pins per account:
- In PostgreSQL, `NULLS FIRST` is the default for ascending order. Pins that have never been refreshed (or backfilled) are prioritized first.
- Every successful refresh updates `last_updated_at` to the current timestamp.
- Successive runs automatically cycle through older pins, guaranteeing 100% full-coverage rotation across all historical pins without repeatedly fetching the same top 150 pins.
- Rotation by `last_updated_at.asc` ensures full coverage over successive runs — one workspace with N accounts × 150 pins needs ceil(N*150 / 150) ≈ N runs to cover the backlog; subsequent runs rotate to oldest remaining pins.
- **Initial Backfill**: For accounts with large backlogs (> 150 pins), manually trigger 2–3 runs from the dashboard to rotate through the entire backlog.

---

## 5. Migration & Fallback Notes

- The default GitHub Actions scheduled cron (`0 3 */2 * *` in `.github/workflows/pinarchive-refresh.yml`) remains in place as an active backup.
- Once FastCron per-workspace jobs are verified across two successful cycles, the `schedule:` cron trigger in the workflow file can be safely deprecated while preserving `workflow_dispatch:`.

---

## 6. Single-Pin Probe & Filtered-Run Diagnostics

To diagnose a filtered run that shows errors=51/checked=0, copy one pin_id from `pa_pins` for that workspace and run the probe locally and in Actions — compare `Has __PWS_DATA__ / aggregated_stats` flags:
```bash
node scripts/test-pin-fetch.mjs <pin_id>
```

---

## 7. Account Attribution Verification & Integrity Diagnostics (SQL)

To verify pin attribution counts per account and ensure data integrity across multi-account workspaces:

```sql
-- A) VERIFY attribution counts for the affected workspace:
select a.username, count(p.id) as pins
from pa_accounts a
left join pa_pins p on p.account_id = a.id
where a.workspace_id = '46afe19d-f16f-4d75-9164-41614616da27'
group by a.username order by pins desc;
-- EXPECT: cindymay3977=21, denisevigliottarecipes=30, others=0.
-- If cindymay shows >21 → misattribution occurred → corrective path:
-- re-point pins using the per-account GAS sheets (pins_<username> tab
-- pin_id lists), since pa_pins stores no username column.
-- (No corruption is expected: both refresh runs failed extraction before
--  any push, so zero writes happened.)
```

