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
- **Initial Backfill**: For accounts with large backlogs (> 150 pins), manually trigger 2–3 runs from the dashboard to rotate through the entire backlog.

---

## 5. Migration & Fallback Notes

- The default GitHub Actions scheduled cron (`0 3 */2 * *` in `.github/workflows/pinarchive-refresh.yml`) remains in place as an active backup.
- Once FastCron per-workspace jobs are verified across two successful cycles, the `schedule:` cron trigger in the workflow file can be safely deprecated while preserving `workflow_dispatch:`.
