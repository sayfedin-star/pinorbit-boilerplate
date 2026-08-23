export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients, isKnownDefaultIngestSecret, isProductionEnv } from '../../../server/db/clients';
import { getSecretStatus, regenerate } from '../../../server/services/webhook-secrets';

export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = (locals as any).activeWorkspaceId as string | undefined;
  if (!user || !schedulingClient) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  let body: any = {};
  try { body = JSON.parse((await request.text()) || '{}'); } catch { body = {}; }
  const wsId = (typeof body.workspace_id === 'string' && body.workspace_id) || workspaceId;
  if (!wsId) return new Response(JSON.stringify({ error: 'workspace_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  try {
    await assertWorkspaceAccess(schedulingClient, wsId, user.id, 'admin');
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || 'Forbidden' }), { status: e.status || 403, headers: { 'Content-Type': 'application/json' } });
  }
  let st = await getSecretStatus(wsId, runtimeEnv);
  
  // Guarantee a per-workspace override exists before revealing so global fallback is never exposed
  if (!st.hasOverride && runtimeEnv?.INGEST_SECRETS_KV) {
    try {
      const generated = await regenerate('workspace', wsId, runtimeEnv);
      st = { secret: generated, source: 'workspace', hasOverride: true };
    } catch {}
  }

  if (isProductionEnv(runtimeEnv) && st.source === 'env' && isKnownDefaultIngestSecret(st.secret)) {
    return new Response(JSON.stringify({ error: 'Service unavailable: ingest secret not configured on server.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  const admin = dbClients.getSchedulingAdmin(runtimeEnv);
  try {
    await admin.from('audit_log').insert({
      table_name: 'ingest_secrets', record_id: wsId,
      action: 'SECRET_REVEAL', new_data: { source: st.source }, changed_by: user.id,
    });
  } catch {}
  return new Response(JSON.stringify({ success: true, secret: st.secret, source: st.source }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
