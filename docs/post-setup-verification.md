# Post-Setup Verification Guide

After provisioning your Supabase projects and configuring your environment variables, complete the following verification steps to validate system health and security integrity.

---

## 1. Migrations Applied Verification

Confirm that all SQL migrations are successfully applied to their respective databases:

### Project 1: Scheduling & Auth Authority
Verify the presence of core tenant and scheduling tables:
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('workspaces', 'workspace_memberships', 'admin_users', 'accounts', 'account_webhooks', 'boards', 'pins', 'pin_delivery_logs', 'logs', 'audit_log');
```

### Project 2: Competitors
Verify competitor intelligence tables:
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('competitors', 'competitor_boards', 'competitor_snapshots', 'competitor_daily_snapshots', 'competitor_ingestion_jobs');
```

### Project 3: Analytics
Verify time-series and reporting tables:
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('import_sessions', 'pin_metrics_history', 'top_pins_snapshots', 'board_analytics_rollups', 'daily_workspace_analytics');
```

---

## 2. Row-Level Security (RLS) Verification

Ensure RLS is actively enforced across all tables in Project 1:

```sql
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relnamespace = 'public'::regnamespace 
  AND relkind = 'r'
ORDER BY relname;
```
*Expected result: `rls_enabled` is `true` for all public tables.*

---

## 3. Build & Test Verification

Run the automated typecheck and unit testing suite locally:

```bash
# 1. Astro type diagnostic
npm run check

# 2. Vitest unit tests
npm test

# 3. Production build compilation
npm run build
```

*Expected result: 0 errors in `astro check`, 100% passing tests in Vitest, and clean `dist/` compilation.*

---

## 4. Client Bundle Audit

Audit the compiled output in `dist/` to verify that zero secret keys or private server tokens were bundled into client JavaScript assets:

```bash
# Linux/macOS
grep -rn "SECRET_KEY" dist/_astro/ || echo "Audit passed: No secret keys found."
grep -rn "service_role" dist/_astro/ || echo "Audit passed: No service_role strings found."

# Windows (PowerShell)
Select-String -Path "dist/_astro/*.js" -Pattern "SECRET_KEY", "service_role", "sb_secret_"
```

*Expected result: Zero matching secret occurrences in browser bundles.*

---

## 5. Auth Flow & Workspace Isolation Verification

1. **Sign Up & Sign In**: Navigate to `/login` and create a new tenant account. Confirm PKCE cookie exchange completes and routes to `/dashboard`.
2. **Workspace Creation**: Create a second workspace from the workspace switcher.
3. **Tenant Isolation**:
   - Create an account or pin in Workspace A.
   - Switch active workspace to Workspace B.
   - Confirm records from Workspace A are completely inaccessible and invisible in Workspace B.
4. **Server Boundaries**: Verify that competitor and analytics views only populate data associated with the active session workspace.
