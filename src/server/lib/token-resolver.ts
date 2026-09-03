import { dbClients, getServerEnv } from '../db/clients';
import { decryptToken, encryptToken, resolveTokenKek } from './token-crypto';
import { getGlobalCronProvider } from '../services/cron-provider';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ProjectName = 'scheduling' | 'analytics' | 'competitors' | 'pinarchive';

export interface TokenResolveOptions {
  workspaceId?: string | null;
  tokenId?: string | null;
  channel?: string | null;
  provider?: 'fastcron' | 'cronjoborg' | string;
  encryptedToken?: string | null;
  schedule?: {
    workspace_id?: string | null;
    fastcron_token_id?: string | null;
    fastcron_token_encrypted?: string | null;
  } | null;
}

export interface ResolvedTokenResult {
  token: string;
  source: 'schedule_override' | 'workspace_registry' | 'channel' | 'env';
  tokenId?: string | null;
  name?: string;
  maskedToken?: string;
}

export interface WorkspaceTokenSummary {
  id: string | null;
  name: string;
  masked_token: string;
  is_default: boolean;
  source: 'workspace_registry' | 'env';
  token?: string;
  created_at?: string;
}

/**
 * Pure helper function to evaluate token candidates in priority order.
 * Returns the first valid candidate with length >= 16 (or non-empty if specified).
 */
export function evaluateTokenCandidates(candidates: Array<string | null | undefined>): string | null {
  for (const tok of candidates) {
    if (tok && typeof tok === 'string' && tok.trim().length >= 16) {
      return tok.trim();
    }
  }
  return null;
}

/**
 * Canonical token masker returning ••••XXXX (last 4 characters).
 */
export function maskToken(token?: string | null): string {
  if (!token || typeof token !== 'string') return '';
  const trimmed = token.trim();
  if (trimmed.length <= 4) return '••••' + trimmed;
  return '••••' + trimmed.slice(-4);
}

function getClientAndTable(
  project: ProjectName,
  runtimeEnv?: Record<string, any>
): { client: SupabaseClient; table: string } {
  const tableMap: Record<ProjectName, string> = {
    scheduling: 'fastcron_tokens',
    analytics: 'analytics_fastcron_tokens',
    competitors: 'competitor_fastcron_tokens',
    pinarchive: 'pinarchive_fastcron_tokens',
  };

  switch (project) {
    case 'scheduling':
      return {
        client: runtimeEnv?.schedulingClient || runtimeEnv?.supabaseClient || dbClients.getSchedulingAdmin(runtimeEnv),
        table: 'fastcron_tokens',
      };
    case 'analytics':
      return {
        client: runtimeEnv?.analyticsClient || dbClients.getAnalyticsAdmin(runtimeEnv),
        table: 'analytics_fastcron_tokens',
      };
    case 'competitors':
      return {
        client: runtimeEnv?.competitorsClient || dbClients.getCompetitorsAdmin(runtimeEnv),
        table: 'competitor_fastcron_tokens',
      };
    case 'pinarchive':
      return {
        client: runtimeEnv?.pinarchiveClient || dbClients.getPinArchive(runtimeEnv),
        table: 'pinarchive_fastcron_tokens',
      };
    default:
      throw new Error(`Unknown project name: ${project}`);
  }
}

/**
 * Resolves API Token for a specific workspace, schedule, or project.
 * Canonical Priority Hierarchy:
 * 1. Schedule-encrypted token (AES-GCM decrypted via TOKEN_KEK)
 * 2. Explicit tokenId row in that project's token table (AES-GCM decrypted via TOKEN_KEK)
 * 3. Workspace default token (is_default = true or first active token)
 * 4. Environment variable fallback (FASTCRON_API_TOKEN or CRONJOB_API_KEY)
 */
export async function resolveToken(
  options: TokenResolveOptions,
  project: ProjectName = 'scheduling',
  runtimeEnv?: Record<string, any>
): Promise<ResolvedTokenResult> {
  const workspaceId = options.workspaceId || options.schedule?.workspace_id || null;
  const tokenId = options.tokenId || options.schedule?.fastcron_token_id || null;
  const encryptedToken = options.encryptedToken || options.schedule?.fastcron_token_encrypted || null;

  const provider = options.provider || (workspaceId ? await getGlobalCronProvider(workspaceId, runtimeEnv) : 'fastcron');
  const isCronJobOrg = provider === 'cronjoborg' || provider === 'cron-job.org';
  const env = getServerEnv(runtimeEnv);
  const envToken = isCronJobOrg
    ? (runtimeEnv?.CRONJOB_API_KEY || (typeof process !== 'undefined' ? process.env.CRONJOB_API_KEY || process.env.CRON_JOB_ORG_API_KEY : ''))
    : (runtimeEnv?.FASTCRON_API_TOKEN || env.FASTCRON_API_TOKEN || (typeof process !== 'undefined' ? process.env.FASTCRON_API_TOKEN : ''));
  const kek = await resolveTokenKek(runtimeEnv || {});

  // 1. Schedule-encrypted token (AES-GCM decrypted via TOKEN_KEK)
  if (encryptedToken && kek) {
    try {
      const dec = await decryptToken(encryptedToken, kek);
      if (dec && dec.trim().length >= 8) {
        return {
          token: dec.trim(),
          source: 'schedule_override',
          tokenId: null,
          name: 'Schedule Token Override',
          maskedToken: maskToken(dec.trim()),
        };
      }
    } catch (err) {
      console.warn('[TokenResolver] Failed to decrypt schedule-level token:', err);
    }
  }

  const { client, table } = getClientAndTable(project, runtimeEnv);

  // 2. Explicit tokenId row in project table
  if (tokenId && kek) {
    if (!workspaceId) {
      throw new Error('Tenant isolation violation: workspaceId is required when resolving by tokenId');
    }

    const tokenQuery = client
      .from(table)
      .select('id, name, token_encrypted, token_masked, is_default')
      .eq('id', tokenId)
      .eq('workspace_id', workspaceId);

    const { data: row } = await tokenQuery.maybeSingle();

    if (row?.token_encrypted) {
      const dec = await decryptToken(row.token_encrypted, kek);
      if (dec && dec.trim().length >= 8) {
        return {
          token: dec.trim(),
          source: 'workspace_registry',
          tokenId: row.id,
          name: row.name,
          maskedToken: row.token_masked || maskToken(dec.trim()),
        };
      }
    }
  }

  // 3. Workspace default token lookup
  if (workspaceId && kek) {
    const { data: defRow } = await client
      .from(table)
      .select('id, name, token_encrypted, token_masked, is_default')
      .eq('workspace_id', workspaceId)
      .eq('is_default', true)
      .maybeSingle();

    if (defRow) {
      let dec = defRow.token_encrypted && kek ? await decryptToken(defRow.token_encrypted, kek) : null;
      if (!dec && (defRow as any).token) dec = (defRow as any).token;
      if (!dec && envToken) dec = envToken;
      if (dec && dec.trim().length >= 8) {
        return {
          token: dec.trim(),
          source: 'workspace_registry',
          tokenId: defRow.id,
          name: defRow.name || 'Workspace Default',
          maskedToken: defRow.token_masked || maskToken(dec.trim()),
        };
      }
    }

    // 3b. Any first active token in project workspace registry
    try {
      let anyQuery: any = client
        .from(table)
        .select('id, name, token_encrypted, token_masked, is_default')
        .eq('workspace_id', workspaceId);

      if (typeof anyQuery?.order === 'function') {
        anyQuery = anyQuery.order('created_at', { ascending: true });
      }
      if (typeof anyQuery?.limit === 'function') {
        anyQuery = anyQuery.limit(1);
      }

      const { data: anyRows } = await anyQuery;

      if (anyRows && anyRows.length > 0 && anyRows[0].token_encrypted) {
        const dec = await decryptToken(anyRows[0].token_encrypted, kek);
        if (dec && dec.trim().length >= 8) {
          return {
            token: dec.trim(),
            source: 'workspace_registry',
            tokenId: anyRows[0].id,
            name: anyRows[0].name,
            maskedToken: anyRows[0].token_masked || maskToken(dec.trim()),
          };
        }
      }
    } catch (regErr: any) {
      console.warn('[TokenResolver] Non-fatal registry token lookup error:', regErr?.message || regErr);
    }
  }

  // 4. Environment variable fallback
  if (envToken && typeof envToken === 'string' && envToken.trim().length >= 8) {
    return {
      token: envToken.trim(),
      source: 'env',
      tokenId: null,
      name: isCronJobOrg ? 'Env cron-job.org Key' : 'Env FastCron Token',
      maskedToken: maskToken(envToken),
    };
  }

  throw new Error(`No ${provider} API token configured for workspace in ${project} project or server environment.`);
}

/**
 * Lists all tokens for a given workspace in a specific project's isolated table.
 */
export async function listWorkspaceTokens(
  workspaceId: string,
  project: ProjectName,
  runtimeEnv?: Record<string, any>,
  includePlain: boolean = false
): Promise<WorkspaceTokenSummary[]> {
  const tokenList: WorkspaceTokenSummary[] = [];
  const tokenStrings = new Set<string>();

  try {
    const { client, table } = getClientAndTable(project, runtimeEnv);
    const kek = await resolveTokenKek(runtimeEnv || {});

    let query: any = client
      .from(table)
      .select('id, name, token_encrypted, token_masked, is_default, created_at')
      .eq('workspace_id', workspaceId);

    if (typeof query?.order === 'function') {
      query = query.order('is_default', { ascending: false });
      if (typeof query?.order === 'function') {
        query = query.order('created_at', { ascending: false });
      }
    }

    const { data: rows, error } = await query;

    if (!error && Array.isArray(rows)) {
      for (const row of rows) {
        let plain: string | null = null;
        if (row.token_encrypted && kek) {
          plain = await decryptToken(row.token_encrypted, kek);
        }

        if (plain && plain.trim().length > 0) {
          tokenStrings.add(plain.trim());
          tokenList.push({
            id: row.id,
            name: row.name || 'Workspace Token',
            masked_token: row.token_masked || ('••••' + plain.trim().slice(-4)),
            is_default: Boolean(row.is_default),
            source: 'workspace_registry',
            token: includePlain ? plain.trim() : undefined,
            created_at: row.created_at,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[TokenResolver] Error listing tokens for ${project}:`, err);
  }

  // Add env fallback to list if configured and not already duplicated
  const envToken = runtimeEnv?.FASTCRON_API_TOKEN || (typeof process !== 'undefined' ? process.env.FASTCRON_API_TOKEN : '');
  if (envToken && envToken.trim().length >= 8 && !tokenStrings.has(envToken.trim())) {
    tokenList.push({
      id: null,
      name: 'Server Default (Env)',
      masked_token: '••••' + envToken.trim().slice(-4),
      is_default: tokenList.length === 0,
      source: 'env',
      token: includePlain ? envToken.trim() : undefined,
    });
  }

  return tokenList;
}

/**
 * Saves or updates a token in the project's isolated table.
 */
export async function saveWorkspaceToken(
  workspaceId: string,
  project: ProjectName,
  data: { name: string; token: string; is_default?: boolean },
  runtimeEnv?: Record<string, any>
): Promise<{ success: boolean; id?: string; error?: string }> {
  const { name, token, is_default = false } = data;
  if (!token || token.trim().length < 8) {
    return { success: false, error: 'Token must be at least 8 characters' };
  }

  try {
    const kek = await resolveTokenKek(runtimeEnv || {});
    if (!kek) {
      return { success: false, error: 'Encryption KEK is not configured on server' };
    }

    const encrypted = await encryptToken(token.trim(), kek);
    const masked = '••••' + token.trim().slice(-4);
    const { client, table } = getClientAndTable(project, runtimeEnv);

    if (is_default) {
      await client.from(table).update({ is_default: false }).eq('workspace_id', workspaceId);
    }

    const { data: inserted, error } = await client
      .from(table)
      .insert({
        workspace_id: workspaceId,
        name: name.trim() || 'API Token',
        token_encrypted: encrypted,
        token_masked: masked,
        is_default: Boolean(is_default),
      })
      .select('id')
      .single();

    if (error || !inserted) {
      if (error?.code === '23505') {
        return { success: false, error: 'A default token already exists for this workspace. Please unset the current default token or refresh and retry.' };
      }
      return { success: false, error: error?.message || 'Failed to save token' };
    }

    return { success: true, id: inserted.id };
  } catch (err: any) {
    return { success: false, error: err.message || 'Token encryption failed' };
  }
}

/**
 * Deletes a token from the project's isolated table.
 */
export async function deleteWorkspaceToken(
  workspaceId: string,
  tokenId: string,
  project: ProjectName,
  runtimeEnv?: Record<string, any>
): Promise<{ success: boolean; error?: string }> {
  try {
    const { client, table } = getClientAndTable(project, runtimeEnv);
    const { error } = await client
      .from(table)
      .delete()
      .eq('id', tokenId)
      .eq('workspace_id', workspaceId);

    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
