import { dbClients } from '../db/clients';

export interface PromotionResult {
  promoted: number;
  checked: number;
  error?: string;
}

/**
 * Server-only service to evaluate candidate pins against workspace OR filter rules.
 * Invokes the atomic Project 4 RPC `pa_promote_candidates`.
 *
 * Fail-safe: NEVER throws; returns { promoted: 0, checked: 0, error: ... } on any failure.
 */
export async function promoteCandidates(
  workspaceId: string,
  runtimeEnv?: Record<string, any>
): Promise<PromotionResult> {
  if (!workspaceId || typeof workspaceId !== 'string') {
    return { promoted: 0, checked: 0, error: 'Invalid workspace identifier.' };
  }

  try {
    const pinArchive = dbClients.getPinArchive(runtimeEnv);
    const { data, error } = await pinArchive.rpc('pa_promote_candidates', {
      p_workspace_id: workspaceId.trim(),
    });

    if (error) {
      console.error(`[Promotion Service] RPC error for workspace ${workspaceId}:`, error.message);
      return { promoted: 0, checked: 0, error: error.message };
    }

    if (Array.isArray(data) && data.length > 0) {
      const row = data[0];
      return {
        promoted: Number(row.promoted || 0),
        checked: Number(row.checked || 0),
      };
    } else if (data && typeof data === 'object') {
      return {
        promoted: Number((data as any).promoted || 0),
        checked: Number((data as any).checked || 0),
      };
    }

    return { promoted: 0, checked: 0 };
  } catch (err: any) {
    console.error(`[Promotion Service] Unexpected exception for workspace ${workspaceId}:`, err?.message || err);
    return { promoted: 0, checked: 0, error: err?.message || 'Unknown promotion error' };
  }
}
