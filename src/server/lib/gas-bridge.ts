import { getServerEnv } from '../db/clients';
import { getEffectiveSecret } from '../services/webhook-secrets';

export interface GasCallResult {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

/**
 * Executes a call to the Google Apps Script (GAS) Web App bridge.
 *
 * Architecture Law: PinOrbit never communicates with Google Sheets directly.
 * All Google Sheets interactions are proxied through this GAS bridge.
 *
 * This function NEVER throws; any network failure or timeout returns `{ ok: false, error }`.
 */
export async function gasCall(
  runtimeEnv: Record<string, any> | undefined,
  workspaceId: string,
  action: string,
  payload: Record<string, any> = {}
): Promise<GasCallResult> {
  try {
    if (!workspaceId) {
      return { ok: false, error: 'workspace_id is required for gasCall.' };
    }

    const env = getServerEnv(runtimeEnv);
    const gasUrl = env.PINARCHIVE_GAS_URL;
    if (!gasUrl || gasUrl.trim().length === 0) {
      return { ok: false, error: 'PINARCHIVE_GAS_URL is not configured.' };
    }

    const eff = await getEffectiveSecret(workspaceId, runtimeEnv || {});
    const secret = eff.value || '';
    if (!secret || secret.trim().length === 0) {
      return { ok: false, error: 'Ingest secret is not configured for workspace.' };
    }

    const cmd_id = crypto.randomUUID();
    const bodyPayload = {
      v: 1,
      cmd_id,
      secret,
      action,
      workspace_id: workspaceId,
      payload,
    };

    const res = await fetch(gasUrl.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: `GAS responded with HTTP ${res.status}: ${text || res.statusText}`,
      };
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (typeof data === 'object' && data !== null) {
        const ok = typeof data.ok === 'boolean' ? data.ok : (data.success !== false && !data.error);
        return { ok, ...data };
      }
      return { ok: true, data };
    }

    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) {
        const ok = typeof parsed.ok === 'boolean' ? parsed.ok : (parsed.success !== false && !parsed.error);
        return { ok, ...parsed };
      }
      return { ok: true, data: parsed };
    } catch {
      return { ok: false, error: 'GAS returned non-JSON/HTML response: ' + text.slice(0, 300) };
    }
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || 'Unknown network error during gasCall.',
    };
  }
}
