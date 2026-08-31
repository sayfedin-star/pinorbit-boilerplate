import type { APIRoute } from 'astro';
import { dbClients } from '../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { HttpError } from '../../../server/lib/http-error';

export const prerender = false;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user || !user.id) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized: authentication required.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ success: false, error: 'Malformed JSON payload.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { workspace_id, is_master = true } = body;

    if (!workspace_id || !UUID_REGEX.test(workspace_id)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid or missing workspace_id UUID.' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const schedulingAdmin = dbClients.getSchedulingAdmin();
    await assertWorkspaceAccess(schedulingAdmin, workspace_id, user.id, 'admin');

    if (is_master) {
      // 1. Reset all other workspaces
      await schedulingAdmin
        .from('workspaces')
        .update({ is_master: false })
        .neq('id', workspace_id);

      // 2. Set this workspace as master
      const { data, error } = await schedulingAdmin
        .from('workspaces')
        .update({ is_master: true, updated_at: new Date().toISOString() })
        .eq('id', workspace_id)
        .select('id, name, is_master')
        .single();

      if (error) {
        throw new HttpError(500, `Failed to update master workspace: ${error.message}`);
      }

      return new Response(JSON.stringify({ success: true, workspace: data, message: 'Workspace set as Master Workspace successfully.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      // Unset master
      const { data, error } = await schedulingAdmin
        .from('workspaces')
        .update({ is_master: false, updated_at: new Date().toISOString() })
        .eq('id', workspace_id)
        .select('id, name, is_master')
        .single();

      if (error) {
        throw new HttpError(500, `Failed to unset master workspace: ${error.message}`);
      }

      return new Response(JSON.stringify({ success: true, workspace: data, message: 'Master status removed.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    return new Response(JSON.stringify({ success: false, error: err.message || 'Internal server error' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};