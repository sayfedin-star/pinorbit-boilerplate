# PinOrbit — Multi-Project Supabase SaaS Starter

[![Astro](https://img.shields.io/badge/Astro-4.x-FF5D01?logo=astro&logoColor=white)](https://astro.build)
[![Supabase](https://img.shields.io/badge/Supabase-Multi--Project-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)
[![Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020?logo=cloudflare&logoColor=white)](https://pages.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vitest](https://img.shields.io/badge/Vitest-Unit%20Tests-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

A modern, production-hardened multi-project Supabase SaaS starter built with Astro SSR, TailwindCSS, and strict multi-tenant isolation. Engineered for scale, speed, and strict security across isolated operational databases.

---

## ⚡ Key Highlights

- **3-Project Database Topology:** Isolates user authentication and scheduling authority from private competitor intelligence and analytical rollups.
- **Server-Side Access Boundaries:** Projects 2 & 3 have zero client-side exposure. Access is brokered strictly server-side by Astro SSR using verified session credentials.
- **Multi-Tenant Workspace Isolation:** Every tenant entity is scoped by `workspace_id` and guarded by Postgres Row-Level Security (RLS) policies.
- **Resilient Background Execution:** Built-in pacing engine, rate-limit fail-safes, exponential backoff, and delivery audit logs.
- **Production-Ready Starter:** Includes SSR middleware, cookie session handling, responsive Astro UI primitives, and 100% passing test suites.

---

## 📐 Architecture Summary

```
                      ┌─────────────────────────────────────────┐
                      │          Astro SSR Application          │
                      │     (Cloudflare Pages / Edge Runtime)   │
                      └────────────────────┬────────────────────┘
                                           │
             ┌─────────────────────────────┼─────────────────────────────┐
             │ 1. Session & Workspace Gate │ 2. Server-Only Query        │ 3. Server-Only Query
             ▼                             ▼                             ▼
┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
│   Project 1: Scheduling  │ │  Project 2: Competitors  │ │   Project 3: Analytics   │
│  (Auth & Tenant Authority)│ │    (Server-Only Data)    │ │    (Server-Only Data)    │
├──────────────────────────┤ ├──────────────────────────┤ ├──────────────────────────┤
│ • auth.users             │ │ • competitors            │ │ • import_sessions        │
│ • workspaces             │ │ • competitor_boards      │ │ • pin_metrics_history    │
│ • workspace_memberships  │ │ • competitor_snapshots   │ │ • top_pins_snapshots     │
│ • accounts & webhooks    │ │ • daily_snapshots        │ │ • board_analytics_rollups│
│ • boards & pins queue    │ │ • ingestion_jobs         │ │ • daily_workspace_metrics│
│ • pin_delivery_logs      │ └──────────────────────────┘ └──────────────────────────┘
│ • audit_log & system logs│
└──────────────────────────┘
```

For full architectural details and data flow diagrams, see [docs/architecture.md](docs/architecture.md).

---

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js**: `v20.x` or `v22.x`
- **npm** or **pnpm**
- Three active Supabase projects (or local Supabase instances)

### 2. Clone & Install

```bash
git clone https://github.com/sayfedin-star/pinorbit-boilerplate.git my-saas
cd my-saas
npm install
```

### 3. Environment Configuration

Copy the example environment file and populate your project credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Project 1: Scheduling & Auth Authority (browser-safe publishable key + server secret key)
SCHEDULING_SUPABASE_URL=https://your-project-1.supabase.co
SCHEDULING_SUPABASE_PUBLISHABLE_KEY=your_project_1_publishable_key
SCHEDULING_SUPABASE_SECRET_KEY=your_project_1_secret_key

# Project 2: Competitors (server-only)
COMPETITORS_SUPABASE_URL=https://your-project-2.supabase.co
COMPETITORS_SUPABASE_SECRET_KEY=your_project_2_secret_key

# Project 3: Analytics (server-only)
ANALYTICS_SUPABASE_URL=https://your-project-3.supabase.co
ANALYTICS_SUPABASE_SECRET_KEY=your_project_3_secret_key
```

### 4. Apply Database Migrations

Apply the migration scripts to each corresponding Supabase instance:

```bash
# Project 1: Scheduling & Auth Authority
supabase db push --project-ref <PROJECT_1_REF> --schema-path supabase/scheduling/migrations

# Project 2: Competitors
supabase db push --project-ref <PROJECT_2_REF> --schema-path supabase/competitors/migrations

# Project 3: Analytics
supabase db push --project-ref <PROJECT_3_REF> --schema-path supabase/analytics/migrations
```

### 5. Run Local Development

```bash
npm run dev
```

Open [http://localhost:4321](http://localhost:4321) in your browser.

---

## 🧪 Testing & Verification

```bash
# Typecheck & Astro diagnostic validation
npm run check

# Run Vitest test suites
npm test

# Build production bundle
npm run build
```

---

## 📚 Starter Documentation

- [Architecture Guide](docs/architecture.md) — 3-project topology, tenant isolation, and client singleton factory.
- [Security Model](docs/security.md) — Key hygiene, secret protection, and Postgres RLS standards.
- [Post-Setup Verification](docs/post-setup-verification.md) — Step-by-step checklist to confirm full platform health.
- [Deployment Guide](docs/deployment.md) — Deploy to Cloudflare Pages with Astro SSR.
- [Customization Guide](docs/customization.md) — Rebrand and adapt the starter for your custom product.

---

## 📄 License

MIT License — free to use for personal and commercial SaaS projects.
