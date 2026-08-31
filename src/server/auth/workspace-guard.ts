import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/http-error';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceMembership { id: string; workspace_id: string; user_id: string; role: 'owner' | 'admin' | 'member'; created_at: string; }
export interface WorkspaceContext { workspaceId: string; role: string; isOwner: boolean; isAdmin: boolean; isMaster?: boolean; }
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

  const { data, error } = await schedulingClient
    .from('workspace_memberships')
    .select('id, workspace_id, user_id, role, created_at, workspaces(id, is_master)')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    throw new HttpError(403, 'Forbidden: Access Denied.');
  }

  const role = data.role as 'owner' | 'admin' | 'member';
  const roleOk = requiredRole === 'member' ? true : requiredRole === 'admin' ? (role === 'admin' || role === 'owner') : role === 'owner';
  if (!roleOk) throw new HttpError(403, 'Forbidden: insufficient workspace role.');
  const isMaster = Boolean((data as any).workspaces?.is_master);
  return { workspaceId: data.workspace_id, role, isOwner: role === 'owner', isAdmin: role === 'admin' || role === 'owner', isMaster };
}

export async function getUserWorkspaces(schedulingClient: SupabaseClient, userId: string) {
  if (!userId || !UUID_REGEX.test(userId)) {
    throw new HttpError(400, 'Invalid user ID format.');
  }
  const { data, error } = await schedulingClient.from('workspace_memberships').select('workspace_id, role, workspaces(id, name, slug, is_master)').eq('user_id', userId);
  if (error || !data) {
    const fallback = await schedulingClient.from('workspace_memberships').select('workspace_id, role, workspaces(id, name, slug)').eq('user_id', userId);
    if (fallback.data) {
      return fallback.data.filter((item: any) => item.workspaces).map((item: any) => ({ id: item.workspaces.id, name: item.workspaces.name, slug: item.workspaces.slug, role: item.role, is_master: false }));
    }
    return [];
  }
  return data.filter((item: any) => item.workspaces).map((item: any) => ({ id: item.workspaces.id, name: item.workspaces.name, slug: item.workspaces.slug, role: item.role, is_master: Boolean(item.workspaces.is_master) }));
}
