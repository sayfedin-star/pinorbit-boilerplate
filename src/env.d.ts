/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

import type { SupabaseClient, User } from '@supabase/supabase-js';

declare global {
  namespace App {
    interface Locals {
      supabase: SupabaseClient;
      user: User | null;
      isAuthenticated: boolean;
      activeWorkspaceId?: string;
      runtime?: {
        env?: Record<string, any>;
        [key: string]: any;
      };
      runtimeEnv?: Record<string, any>;
    }
  }
}

interface ImportMetaEnv {
  readonly SCHEDULING_SUPABASE_URL: string;
  readonly SCHEDULING_SUPABASE_PUBLISHABLE_KEY: string;
  readonly SCHEDULING_SUPABASE_SECRET_KEY: string;
  readonly COMPETITORS_SUPABASE_URL: string;
  readonly COMPETITORS_SUPABASE_SECRET_KEY: string;
  readonly ANALYTICS_SUPABASE_URL: string;
  readonly ANALYTICS_SUPABASE_SECRET_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
