# PinArchive Google Apps Script (GAS) Collector v2.3 Contract

> [!WARNING]
> **Source of truth = the deployed Apps Script file (PinArchive Collector v2.3 FINAL, Phase-1 Unit G).**
> Do NOT regenerate, rewrite, or paste any GAS code from git history. The prior rewrite in commit history is DEPRECATED.

---

## 1. Script Properties Contract

| Property Name | Required | Description |
| :--- | :--- | :--- |
| `PINORBIT_URL` | **Yes** | Base URL of your PinOrbit instance |
| `PINARCHIVE_SECRET` | **Yes** | Shared secret for authenticating with PinOrbit |
| `PINTEREST_COOKIE` | *Optional* | Session cookie for Pinterest scraping |

---

## 2. Action Contract Table

All webhook requests sent to GAS Web App endpoint follow the envelope shape `{ secret, action, payload: { ... } }` (unwrapped by G1):

| Action | Payload Shape | Description |
| :--- | :--- | :--- |
| `run` | `{ username?: string }` | Forced execution: scrapes single account immediately if `username` is provided; runs scheduled tick if omitted. |
| `add_account` | `{ username: string, workspace_id: string, interval_days: number, user_id?: string }` | Inserts or updates account row in Control sheet. |
| `ping` | `{}` | Health check / ping response. |
| `status` | `{}` | Returns collector operational status and metrics. |
| `pause` | `{ username: string, workspace_id: string }` | Pauses account scraping in Control sheet. |
| `resume` | `{ username: string, workspace_id: string }` | Resumes account scraping in Control sheet. |
| `set_interval` | `{ username: string, workspace_id: string, interval_days: number }` | Updates scrape interval in Control sheet. |

---

## 3. Deployment Steps

1. Open the Google Apps Script project attached to your spreadsheet.
2. In **Project Settings > Script Properties**, verify `PINORBIT_URL`, `PINARCHIVE_SECRET`, and optionally `PINTEREST_COOKIE`.
3. Click **Save**.
4. Click **Deploy > Manage deployments > Edit > New version > Deploy**.
5. Ensure Web App execution is set to *Me* with access *Anyone*.

---

## 4. Ingest Contract

- **Endpoint**: `POST {WORKER_URL}/api/internal/pinarchive/ingest`
- **Header**: `x-ingest-secret: <PINARCHIVE_SECRET>`
- **Terminal Status**: HTTP `409 ingest_disabled` is **TERMINAL** — GAS collector skips the batch immediately and must NOT retry.
