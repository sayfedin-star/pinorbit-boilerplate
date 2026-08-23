import { supabase, isSupabaseConfigured } from './supabase';
import { ACTIVE_WORKSPACE_COOKIE, DEFAULT_WORKSPACE_ID } from './workspaces';
import type { Workspace } from './types';

/**
 * Sets the active workspace ID cookie in the browser and updates local cookie storage.
 */
export function setActiveWorkspaceId(workspaceId: string): void {
  if (typeof document !== 'undefined') {
    document.cookie = `${ACTIVE_WORKSPACE_COOKIE}=${encodeURIComponent(
      workspaceId
    )}; path=/; max-age=31536000; SameSite=Lax`;
  }
}

/**
 * Creates a new workspace and assigns membership to the creator.
 * Sets the new workspace as active upon creation.
 */
export async function createWorkspace(payload: {
  name: string;
  slug?: string;
}): Promise<Workspace> {
  const cleanName = payload.name.trim();
  if (!cleanName) {
    throw new Error('Workspace name is required');
  }

  const generatedSlug =
    payload.slug?.trim() ||
    cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

  if (!isSupabaseConfigured || !supabase) {
    const mockCreated: Workspace = {
      id: `ws-${Date.now()}`,
      name: cleanName,
      slug: generatedSlug,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setActiveWorkspaceId(mockCreated.id);
    return mockCreated;
  }

  // 1. Insert Workspace
  const { data: createdWs, error: wsError } = await supabase
    .from('workspaces')
    .insert([
      {
        name: cleanName,
        slug: generatedSlug,
      },
    ])
    .select()
    .single();

  if (wsError || !createdWs) {
    throw new Error(wsError?.message || 'Failed to create workspace');
  }

  // 2. Insert Membership for Current User if authenticated
  const { data: userData } = await supabase.auth.getUser();
  if (userData?.user?.id) {
    const { error: memError } = await supabase.from('workspace_memberships').insert([
      {
        workspace_id: createdWs.id,
        user_id: userData.user.id,
        role: 'owner',
      },
    ]);
    if (memError) {
      console.error('Failed to create owner membership for workspace:', memError);
      // Attempt rollback to avoid orphaned workspace
      await supabase.from('workspaces').delete().eq('id', createdWs.id);
      throw new Error(`Failed to create owner membership: ${memError.message}`);
    }
  }

  // 3. Set newly created workspace active
  setActiveWorkspaceId(createdWs.id);

  return createdWs as Workspace;
}

/**
 * Renames an existing workspace.
 */
export async function renameWorkspace(
  id: string,
  newName: string
): Promise<Workspace> {
  const cleanName = newName.trim();
  if (!cleanName) {
    throw new Error('Workspace name cannot be empty');
  }

  if (!isSupabaseConfigured || !supabase) {
    return {
      id,
      name: cleanName,
      slug: cleanName.toLowerCase().replace(/\s+/g, '-'),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update({ name: cleanName, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error || !updated) {
    throw new Error(error?.message || 'Failed to rename workspace');
  }

  return updated as Workspace;
}

/**
 * Checks whether a workspace is completely empty (no accounts, competitors, boards, pins, or competitor_boards).
 * Returns true if empty, or throws a detailed Error if operational rows exist.
 */
export async function assertWorkspaceEmpty(workspaceId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) {
    return true;
  }

  const [accRes, compRes, boardRes, pinRes, compBoardRes] = await Promise.all([
    supabase.from('accounts').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    supabase.from('competitors').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    supabase.from('boards').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    supabase.from('pins').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
    supabase.from('competitor_boards').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
  ]);

  const accCount = accRes.count || 0;
  const compCount = compRes.count || 0;
  const boardCount = boardRes.count || 0;
  const pinCount = pinRes.count || 0;
  const compBoardCount = compBoardRes.count || 0;

  const total = accCount + compCount + boardCount + pinCount + compBoardCount;
  if (total > 0) {
    const details = [
      accCount ? `${accCount} accounts` : '',
      compCount ? `${compCount} competitors` : '',
      boardCount ? `${boardCount} boards` : '',
      pinCount ? `${pinCount} pins` : '',
      compBoardCount ? `${compBoardCount} competitor boards` : '',
    ]
      .filter(Boolean)
      .join(', ');

    throw new Error(`Workspace is not empty (${details}). Only empty workspaces can be deleted.`);
  }

  return true;
}

/**
 * Deletes a workspace after asserting it is not Default Workspace and is completely empty.
 */
export async function deleteWorkspace(id: string): Promise<boolean> {
  if (id === DEFAULT_WORKSPACE_ID) {
    throw new Error('Action blocked: The Default Workspace cannot be deleted.');
  }

  // Call server-side endpoint instead of client-side check
  const response = await fetch('/api/workspaces/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: id })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to delete workspace' }));
    throw new Error(error.error || 'Failed to delete workspace');
  }

  setActiveWorkspaceId(DEFAULT_WORKSPACE_ID);
  return true;
}
