import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface BootstrapOptions {
  email?: string;
  password?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  supabaseUrl?: string;
  supabaseSecretKey?: string;
  client?: SupabaseClient; // Optional injection for testing
}

export type BootstrapStatus = 'SUCCESS' | 'ALREADY_INITIALIZED' | 'CONFIG_ERROR' | 'FAILED';

export interface BootstrapResult {
  success: boolean;
  status: BootstrapStatus;
  message: string;
  userId?: string;
  workspaceId?: string;
  email?: string;
  timestamp: string;
}

/**
 * Server-only, idempotent administrative bootstrap service for PinOrbit.
 * Provisions the first admin user and default workspace if and only if
 * the Scheduling/Auth authority project is uninitialized.
 */
export async function bootstrapAdminUser(
  options?: BootstrapOptions,
  runtimeEnv?: Record<string, any>
): Promise<BootstrapResult> {
  const timestamp = new Date().toISOString();
  const envSource = {
    ...(typeof process !== 'undefined' ? process.env : {}),
    ...(runtimeEnv || {}),
  } as Record<string, string | undefined>;

  // 1. Resolve admin bootstrap credentials (options or environment)
  const email = options?.email || envSource.BOOTSTRAP_ADMIN_EMAIL;
  const password = options?.password || envSource.BOOTSTRAP_ADMIN_PASSWORD;

  if (!email || !password) {
    return {
      success: false,
      status: 'CONFIG_ERROR',
      message: 'Missing BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD in server environment.',
      timestamp,
    };
  }

  // 2. Resolve Project 1 service role credentials
  const supabaseUrl =
    options?.supabaseUrl ||
    envSource.SCHEDULING_SUPABASE_URL ||
    envSource.PUBLIC_SCHEDULING_SUPABASE_URL;
  const supabaseSecretKey =
    options?.supabaseSecretKey ||
    envSource.SCHEDULING_SUPABASE_SECRET_KEY;

  let adminClient: SupabaseClient;
  if (options?.client) {
    adminClient = options.client;
  } else {
    if (!supabaseUrl || !supabaseSecretKey) {
      return {
        success: false,
        status: 'CONFIG_ERROR',
        message: 'Missing SCHEDULING_SUPABASE_URL or SCHEDULING_SUPABASE_SECRET_KEY in server environment.',
        timestamp,
      };
    }

    adminClient = createClient(supabaseUrl, supabaseSecretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          'x-client-info': 'pinorbit-v2-admin-bootstrap',
        },
      },
    });
  }

  try {
    // 3. Check whether public.admin_users already contains rows
    const { count: adminCount, error: countErr } = await adminClient
      .from('admin_users')
      .select('*', { count: 'exact', head: true });

    if (countErr) {
      return {
        success: false,
        status: 'FAILED',
        message: `Failed to query public.admin_users: ${countErr.message}`,
        timestamp,
      };
    }

    if (typeof adminCount === 'number' && adminCount > 0) {
      return {
        success: false,
        status: 'ALREADY_INITIALIZED',
        message: 'System is already initialized with active admin users.',
        timestamp,
      };
    }

    // 4. Check if auth user already exists in auth.users
    let userId: string | undefined;

    const { data: listData, error: listErr } = await adminClient.auth.admin.listUsers({
      page: 1,
      perPage: 50,
    });

    if (listErr) {
      return {
        success: false,
        status: 'FAILED',
        message: `Failed to check auth.users: ${listErr.message}`,
        timestamp,
      };
    }

    const existingAuthUser = listData?.users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );

    if (existingAuthUser) {
      userId = existingAuthUser.id;
    } else {
      // Create the first auth user with email confirmed
      const { data: createData, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: {
          role: 'admin',
          bootstrapped: true,
          bootstrapped_at: timestamp,
        },
        user_metadata: {
          bootstrapped: true,
          bootstrapped_at: timestamp,
        },
      });

      if (createErr || !createData?.user) {
        return {
          success: false,
          status: 'FAILED',
          message: `Failed to create admin auth user: ${createErr?.message || 'Unknown error'}`,
          timestamp,
        };
      }

      userId = createData.user.id;
    }

    // 5. Insert user into public.admin_users
    const { error: adminUserErr } = await adminClient
      .from('admin_users')
      .upsert({ user_id: userId }, { onConflict: 'user_id' });

    if (adminUserErr) {
      return {
        success: false,
        status: 'FAILED',
        message: `Failed to insert record into public.admin_users: ${adminUserErr.message}`,
        userId,
        timestamp,
      };
    }

    // 6. Create default workspace if none exists for this user
    const workspaceName = options?.workspaceName || 'Default Workspace';
    const workspaceSlug = options?.workspaceSlug || 'default';

    // Check if a workspace with this slug exists
    let workspaceId: string | undefined;
    const { data: existingWs } = await adminClient
      .from('workspaces')
      .select('id')
      .eq('slug', workspaceSlug)
      .maybeSingle();

    if (existingWs) {
      workspaceId = existingWs.id;
    } else {
      const { data: newWs, error: wsErr } = await adminClient
        .from('workspaces')
        .insert({
          name: workspaceName,
          slug: workspaceSlug,
        })
        .select('id')
        .single();

      if (wsErr || !newWs) {
        return {
          success: false,
          status: 'FAILED',
          message: `Failed to provision default workspace: ${wsErr?.message || 'Unknown error'}`,
          userId,
          timestamp,
        };
      }
      workspaceId = newWs.id;
    }

    // 7. Create owner membership in public.workspace_memberships
    const { data: existingMembership } = await adminClient
      .from('workspace_memberships')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!existingMembership) {
      const { error: memberErr } = await adminClient
        .from('workspace_memberships')
        .insert({
          workspace_id: workspaceId,
          user_id: userId,
          role: 'owner',
        });

      if (memberErr) {
        return {
          success: false,
          status: 'FAILED',
          message: `Failed to link admin membership to default workspace: ${memberErr.message}`,
          userId,
          workspaceId,
          timestamp,
        };
      }
    }

    // 8. Append audit log entry in public.audit_log
    try {
      await adminClient.from('audit_log').insert({
        table_name: 'admin_users',
        record_id: userId,
        action: 'admin_bootstrap',
        new_data: {
          email,
          role: 'admin',
          workspace_id: workspaceId,
          bootstrapped_at: timestamp,
        },
        changed_by: userId,
      });
    } catch (auditErr) {
      console.warn('Non-fatal audit log failure during admin bootstrap:', auditErr);
    }

    return {
      success: true,
      status: 'SUCCESS',
      message: 'First admin and default workspace successfully bootstrapped.',
      userId,
      workspaceId,
      email,
      timestamp,
    };
  } catch (err: any) {
    return {
      success: false,
      status: 'FAILED',
      message: `Unexpected error during admin bootstrap: ${err.message || String(err)}`,
      timestamp,
    };
  }
}
