export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../../server/auth/workspace-guard';
import { analyticsDb } from '../../../../../server/db/analytics';
import { errorStatus } from '../../../../../server/lib/http-error';

export const GET: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const connectionId = params.id;

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: authentication required.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!workspaceId || !connectionId) {
    return new Response(
      JSON.stringify({ success: false, error: 'workspace and connection ID required.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);

    const url = new URL(request.url);
    const fromDate = url.searchParams.get('from_date') || undefined;
    const toDate = url.searchParams.get('to_date') || undefined;
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '25', 10)));
    const ALLOWED_SORT_FIELDS = new Set(['metric_date', 'impressions', 'engagements', 'pin_clicks', 'outbound_clicks', 'saves', 'video_views', 'total_comments']);
    const rawSort = url.searchParams.get('sort') || 'metric_date';
    const sortField = ALLOWED_SORT_FIELDS.has(rawSort) ? rawSort : 'metric_date';
    const isDesc = (url.searchParams.get('dir') || 'desc').toLowerCase() === 'desc';
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();

    const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
    if ((fromDate && !DATE_REGEX.test(fromDate)) || (toDate && !DATE_REGEX.test(toDate))) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid date format. Expected YYYY-MM-DD.' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const MAX_SPAN_DAYS = 365;
    const today = new Date().toISOString().split('T')[0];
    let from = fromDate, to = toDate;
    if (!from || !to) { const d = new Date(Date.now() - 30*86400000); from = from || d.toISOString().split('T')[0]; to = to || today; }
    if (from > to) {
      return new Response(JSON.stringify({ success: false, error: 'from_date cannot be after to_date.' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if ((+new Date(to) - +new Date(from))/86400000 > MAX_SPAN_DAYS) {
      return new Response(JSON.stringify({ success: false, error: 'Date range span cannot exceed 365 days.' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await analyticsDb.getConnectionDailyMetrics(
      workspaceId,
      connectionId,
      from,
      to,
      {
        query,
        sortField,
        sortDir: isDesc ? 'desc' : 'asc',
        page,
        pageSize,
      }
    );

    return new Response(JSON.stringify({ 
      success: true, 
      data: {
        rows: result.rows,
        total: result.total,
        totals: result.totals,
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message || 'Failed to retrieve connection daily metrics.',
      }),
      {
        status: errorStatus(err),
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
