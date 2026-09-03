# Architecture Specification

## Overview

This boilerplate implements a high-scale, multi-project Supabase architecture fronted by an Astro SSR application running on Cloudflare Pages.

By decoupling concerns across three isolated database instances, the system achieves strict blast-radius isolation, distinct security perimeters, and independent scaling capabilities.

```
                         ┌────────────────────────────────────────────────────────┐
                         │                   Astro SSR Application                │
                         │            (Cloudflare Pages / Edge Runtime)          │
                         └──────────────────────┬─────────────────────────────────┘
                                                │
                ┌───────────────────────────────┼───────────────────────────────┐
                │ 1. Verify Session & Workspace │ 2. Server-Only Query         │ 3. Server-Only Query
                ▼                               ▼                               ▼
 ┌──────────────────────────────┐ ┌──────────────────────────────┐ ┌──────────────────────────────┐
 │     Project 1: Scheduling    │ │    Project 2: Competitors    │ │     Project 3: Analytics     │
 │   (Auth / Tenant Authority)  │ │      (Server-Only DB)        │ │      (Server-Only DB)        │
 ├──────────────────────────────┤ ├──────────────────────────────┤ ├──────────────────────────────┤
 │ • auth.users                 │ │ • competitors                │ │ • import_sessions            │
 │ • workspaces                 │ │ • competitor_boards          │ │ • pin_metrics_history        │
 │ • workspace_memberships      │ │ • competitor_snapshots       │ │ • top_pins_snapshots         │
 │ • admin_users                │ │ • competitor_daily_snapshots │ │ • board_analytics_rollups   │
 │ • accounts                   │ │ • competitor_ingestion_jobs  │ │ • daily_workspace_analytics │
 │ • account_webhooks           │ └──────────────────────────────┘ └──────────────────────────────┘
 │ • account_posting_windows    │
 │ • boards (scheduler registry)│
 │ • pins (operational queue)   │
 │ • pin_delivery_logs          │
 │ • audit_log & logs           │
 └──────────────────────────────┘
```

---

## 3-Project Responsibilities

### Project 1: Scheduling & Auth Authority (Public + Server Key)
Project 1 serves as the single source of truth for identity, authentication, and core tenant organization.
- **Authentication**: Native Supabase Auth (`auth.users`), PKCE session exchange, and JWT issuance.
- **Tenant Management**: Multi-tenant workspaces (`workspaces`), memberships (`workspace_memberships`), and platform administrators (`admin_users`).
- **Core Operations**: Operational accounts, webhooks, posting windows, scheduling queues (`pins`), and real-time pin delivery logs.
- **Client Security**: Issues a browser-safe publishable key for client auth session bootstrapping and utilizes a server secret key for elevated administrative actions.

### Project 2: Competitors (Server-Only Database)
Project 2 is a completely private database dedicated to competitor intelligence, market research, and external scraping rollups.
- **Isolation**: Has zero public/browser exposure. No publishable keys are generated or distributed.
- **Data Domain**: Competitor profiles, competitor board registries, daily time-series performance snapshots, and automated ingestion job logs.
- **Access Model**: All queries originate exclusively from Astro SSR server endpoints (`src/server/db/clients.ts`) after tenant authorization is confirmed via Project 1.

### Project 3: Analytics (Server-Only Database)
Project 3 is a dedicated analytical warehouse optimized for high-volume time-series metrics, telemetry, and reporting rollups.
- **Isolation**: Completely backend-only. Has zero client-side direct access.
- **Data Domain**: Bulk CSV/Sheets import sessions (`import_sessions`), granular URL click/save time-series (`pin_metrics_history`), URL performance rollups, board-level aggregations, and daily workspace analytics.
- **Performance**: Isolates heavy analytical aggregations from the transactional scheduling database in Project 1.

---

## Multi-Tenant Isolation Standard (`workspace_id`)

Tenant isolation is strictly maintained across all three databases:

1. **Partitioning Column**: Every table storing tenant-owned records includes a mandatory `workspace_id UUID NOT NULL` column referencing `public.workspaces(id)` with `ON DELETE CASCADE`.
2. **Postgres Row-Level Security (RLS)**:
   - Enabled on all tables in Project 1.
   - Enforced through declarative policies checking `is_workspace_member(workspace_id)`.
3. **Server-Side Access Gatekeeping**:
   - For Project 2 and Project 3, Astro SSR middleware verifies the authenticated user's workspace membership against Project 1.
   - All server queries constructed for Project 2 and Project 3 strictly enforce `WHERE workspace_id = ?` parameterization using the verified session workspace.

---

## Client Access Layer (`src/server/db/clients.ts`)

All database interactions are channeled through a centralized, hardened factory:

- `dbClients.getSchedulingSSR(context)`: Returns an Astro SSR cookie-authenticated Supabase client for Project 1.
- `dbClients.getSchedulingAdmin()`: Returns a server-only administrative client for Project 1 (background dispatch, audit logging).
- `dbClients.getCompetitors()`: Returns a server-only client for Project 2 with persistent connection pooling.
- `dbClients.getAnalytics()`: Returns a server-only client for Project 3 with persistent connection pooling.

Direct instantiation of Supabase clients in client-side Astro islands is prohibited, preventing secret leakage and enforcing backend security boundaries.
