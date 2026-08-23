import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/http-error';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceMembership { id: string; workspace_id: string; user_id: string; role: 'owner' | 'admin' | 'member'; created_at: string; }
export interface WorkspaceContext { workspaceId: string; role: string; isOwner: boolean; isAdmin: boolean; }
export type RequiredRole = 'member' | 'admin' | 'owner';

export async function assertWorkspaceAccess(
  schedulingClient: SupabaseClient,
  workspaceId: string,
  userId: string,
  requiredRole: RequiredRole = 'member'
): Promise<WorkspaceContext> {
  if (!workspaceId || !userId) {
    throw new HttpError(401, 'Unauthorized: missing workspace or user identifier.');
  }

  // UUID format validation
  if (!UUID_REGEX.test(workspaceId) || !UUID_REGEX.test(userId)) {
    throw new HttpError(400, 'Invalid workspace or user identifier format.');
  }

  // 1. Check explicit workspace membership first
  const { data, error } = await schedulingClient.from('workspace_memberships')
    .select('id, workspace_id, user_id, role, created_at').eq('workspace_id', workspaceId).eq('user_id', userId).single();

  if (data && !error) {
    const role = data.role as 'owner' | 'admin' | 'member';
    const roleOk = requiredRole === 'member' ? true : requiredRole === 'admin' ? (role === 'admin' || role === 'owner') : role === 'owner';
    if (!roleOk) throw new HttpError(403, 'Forbidden: insufficient workspace role.');
    return { workspaceId: data.workspace_id, role, isOwner: role === 'owner', isAdmin: role === 'admin' || role === 'owner' };
  }

  // 2. Fallback: check if user is a platform admin (public.admin_users) -> global owner access
  try {
    const adminQuery = schedulingClient.from('admin_users').select('user_id').eq('user_id', userId);
    const { data: adminData } = typeof (adminQuery as any)?.maybeSingle === 'function'
      ? await (adminQuery as any).maybeSingle()
      : typeof (adminQuery as any)?.single === 'function'
      ? await (adminQuery as any).single()
      : { data: null };

    if (adminData) {
      return {
        workspaceId,
        role: 'owner',
        isOwner: true,
        isAdmin: true,
      };
    }
  } catch {
    // Non-admin or unmocked table in test environment
  }

  throw new HttpError(403, 'Forbidden: Access Denied.');
}

export async function getUserWorkspaces(schedulingClient: SupabaseClient, userId: string) {
  if (!userId || !UUID_REGEX.test(userId)) {
    throw new HttpError(400, 'Invalid user ID format.');
  }

  const { data, error } = await schedulingClient.from('workspace_memberships').select('workspace_id, role, workspaces(id, name, slug)').eq('user_id', userId);
  const memberWorkspaces = (!error && data)
    ? data.filter((item: any) => item.workspaces).map((item: any) => ({ id: item.workspaces.id, name: item.workspaces.name, slug: item.workspaces.slug, role: item.role }))
    : [];

  if (memberWorkspaces.length > 0) {
    return memberWorkspaces;
  }

  // Fallback for platform admins if not explicitly listed in memberships
  try {
    const adminQuery = schedulingClient.from('admin_users').select('user_id').eq('user_id', userId);
    const { data: adminData } = typeof (adminQuery as any)?.maybeSingle === 'function'
      ? await (adminQuery as any).maybeSingle()
      : typeof (adminQuery as any)?.single === 'function'
      ? await (adminQuery as any).single()
      : { data: null };

    if (adminData) {
      const { data: allWorkspaces } = await schedulingClient
        .from('workspaces')
        .select('id, name, slug')
        .order('created_at', { ascending: true });

      if (allWorkspaces && allWorkspaces.length > 0) {
        return allWorkspaces.map((w: any) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          role: 'owner',
        }));
      }
    }
  } catch {
    // Non-admin or unmocked table
  }

  return memberWorkspaces;
}
