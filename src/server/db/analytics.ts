import { dbClients } from './clients';
import { edgeCache } from '../services/edge-cache';
import type {
  AccountAnalyticsDaily,
  AccountAnalyticsSummary,
  TopPinSnapshot,
  DailyWorkspaceMetric,
  PinnerSortBy,
  WorkspaceAnalyticsSettings,
  AnalyticsConnection,
  AnalyticsIngestionRun,
  PinLeaderboardItem,
  PinLeaderboardOptions,
  PinLeaderboardResult,
  PinTrendPoint,
  PurgePreviewCounts,
  PurgeResultCounts,
  PurgeTarget,
} from '../../lib/types';

export interface MetricSummary {
  workspace_id: string;
  total_pins_posted: number;
  total_impressions: number;
  total_saves: number;
  total_clicks: number;
  engagement_rate: number;
}

export interface BoardAnalyticsRollup {
  board_id: string;
  board_name: string;
  total_pins: number;
  impressions_7d: number;
  impressions_30d: number;
  saves_30d: number;
  clicks_30d: number;
}

/**
 * Server-Only Project 3 (Analytics Data Warehouse & Standalone Control Plane) Data Layer.
 * Directives (V17 Final Standalone Edition):
 * 1. Must never be imported from browser code.
 * 2. Every analytics query/write uses ONLY Project 3 analyticsClient. Zero Project 1/2 calls.
 * 3. Operational ingestion history is tracked in public.analytics_ingestion_runs.
 */
export const analyticsDb = {
  // ============================================================================
  // Project 3 Operational Ingestion Run Tracking (V17 Final)
  // ============================================================================

  /**
   * Records the start of an ingestion run in Project 3 (status: processing).
   */
  async createIngestionRun(
    run: {
      workspace_id: string;
      connection_id: string;
      channel: 'account_analytics' | 'top_pins';
      job_type: 'daily_sync' | 'manual_sync' | 'backfill' | 'ping';
      status?: 'processing' | 'completed' | 'failed';
      request_context?: Record<string, any> | null;
      rows_processed?: number;
      error_details?: Record<string, any> | null;
    }
  ): Promise<AnalyticsIngestionRun> {
    if (!run.workspace_id || !run.connection_id) {
      throw new Error('Tenant Boundary Violation: workspace_id and connection_id are required.');
    }

    const analyticsClient = dbClients.getAnalytics();

    // R5.2 Stale Sweeper: update prior processing runs older than 30 minutes to failed
    try {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      await analyticsClient
        .from('analytics_ingestion_runs')
        .update({
          status: 'failed',
          error_details: { error: 'stale_processing_timeout' },
          completed_at: new Date().toISOString(),
        })
        .eq('connection_id', run.connection_id)
        .eq('channel', run.channel)
        .eq('status', 'processing')
        .lt('started_at', thirtyMinutesAgo);
    } catch (sweepErr) {
      console.warn('[AnalyticsDb] Stale sweeper failed non-fatally:', sweepErr);
    }

    const { data, error } = await analyticsClient
      .from('analytics_ingestion_runs')
      .insert({
        workspace_id: run.workspace_id,
        connection_id: run.connection_id,
        channel: run.channel,
        job_type: run.job_type,
        status: run.status || 'processing',
        request_context: run.request_context || null,
        rows_processed: run.rows_processed || 0,
        error_details: run.error_details || null,
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return data as AnalyticsIngestionRun;
  },

  /**
   * Marks an ingestion run as completed in Project 3.
   */
  async completeIngestionRun(
    runId: string,
    rowsProcessed: number
  ): Promise<void> {
    if (!runId) return;
    const analyticsClient = dbClients.getAnalytics();
    const { error } = await analyticsClient
      .from('analytics_ingestion_runs')
      .update({
        status: 'completed',
        rows_processed: rowsProcessed,
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);

    if (error) {
      console.warn('[AnalyticsDb] Failed to complete ingestion run:', runId, error);
    }
  },

  /**
   * Marks an ingestion run as failed in Project 3 with error details.
   */
  async failIngestionRun(
    runId: string,
    errorDetails: Record<string, any>
  ): Promise<void> {
    if (!runId) return;
    const analyticsClient = dbClients.getAnalytics();
    const { error } = await analyticsClient
      .from('analytics_ingestion_runs')
      .update({
        status: 'failed',
        error_details: errorDetails,
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);

    if (error) {
      console.warn('[AnalyticsDb] Failed to fail ingestion run:', runId, error);
    }
  },

  /**
   * Lists recent ingestion runs for a connection within a workspace.
   */
  async listIngestionRuns(
    workspaceId: string,
    connectionId?: string,
    limit = 10
  ): Promise<AnalyticsIngestionRun[]> {
    if (!workspaceId) {
      throw new Error('Tenant Boundary Violation: workspaceId is required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    let query = analyticsClient
      .from('analytics_ingestion_runs')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('started_at', { ascending: false })
      .limit(limit);

    if (connectionId) {
      query = query.eq('connection_id', connectionId);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('[AnalyticsDb] Failed to query ingestion runs:', error);
      return [];
    }

    return (data as AnalyticsIngestionRun[]) || [];
  },

  /**
   * Returns the latest failed run for (connection_id, channel) within a workspace.
   */
  async getLatestFailedRun(
    workspaceId: string,
    connectionId: string,
    channel: 'account_analytics' | 'top_pins'
  ): Promise<AnalyticsIngestionRun | null> {
    if (!workspaceId || !connectionId) return null;
    const analyticsClient = dbClients.getAnalytics();
    const { data, error } = await analyticsClient
      .from('analytics_ingestion_runs')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .eq('channel', channel)
      .eq('status', 'failed')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return data as AnalyticsIngestionRun;
  },

  /**
   * Checks whether the last N consecutive runs for (connection_id, channel) are failed.
   */
  async checkConsecutiveFailures(
    connectionId: string,
    channel: 'account_analytics' | 'top_pins',
    requiredCount = 2
  ): Promise<boolean> {
    if (!connectionId) return false;

    const analyticsClient = dbClients.getAnalytics();
    const { data, error } = await analyticsClient
      .from('analytics_ingestion_runs')
      .select('status')
      .eq('connection_id', connectionId)
      .eq('channel', channel)
      .order('started_at', { ascending: false })
      .limit(requiredCount);

    if (error || !data || data.length < requiredCount) {
      return false;
    }

    return data.every((r) => r.status === 'failed');
  },

  /**
   * Computes operational health metrics for a connection.
   */
  async getConnectionHealth(
    connectionId: string
  ): Promise<{
    total_runs: number;
    consecutive_failures: number;
    last_success_at: string | null;
    revoked: boolean;
  }> {
    if (!connectionId) return { total_runs: 0, consecutive_failures: 0, last_success_at: null, revoked: false };

    const analyticsClient = dbClients.getAnalytics();
    
    // Total runs
    const { count, error: countErr } = await analyticsClient
      .from('analytics_ingestion_runs')
      .select('id', { count: 'exact', head: true })
      .eq('connection_id', connectionId);

    // Recent runs to compute consecutive failures & last success
    const { data: runs, error: runErr } = await analyticsClient
      .from('analytics_ingestion_runs')
      .select('status, started_at')
      .eq('connection_id', connectionId)
      .order('started_at', { ascending: false })
      .limit(50);

    let consecutive_failures = 0;
    let last_success_at: string | null = null;
    let revoked = false;

    if (runs && runs.length > 0) {
      for (const run of runs) {
        if (run.status === 'completed') {
          last_success_at = run.started_at;
          break;
        } else if (run.status === 'failed') {
          consecutive_failures++;
        }
      }
      
      // If the 3 most recent are failed, consider it revoked
      if (consecutive_failures >= 3) {
        revoked = true;
      }
    }

    return {
      total_runs: count || 0,
      consecutive_failures,
      last_success_at,
      revoked,
    };
  },

  // ============================================================================
  // Project 3 Ingestion Upserts (Strict Zero-Sum & Clean Upserts)
  // ============================================================================

  /**
   * Upserts daily account metrics (Project 3 account_analytics_daily).
   */
  async upsertAccountDailyMetrics(
    workspaceId: string,
    connectionId: string,
    rows: AccountAnalyticsDaily[]
  ): Promise<number> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }
    if (!rows || rows.length === 0) return 0;

    const analyticsClient = dbClients.getAnalytics();
    const payload = rows.map((r) => ({
      ...r,
      workspace_id: workspaceId,
      connection_id: connectionId,
      recorded_at: new Date().toISOString(),
    }));

    const { error } = await analyticsClient
      .from('account_analytics_daily')
      .upsert(payload, {
        onConflict: 'workspace_id,connection_id,metric_date',
        ignoreDuplicates: false,
      });

    if (error) throw error;
    return rows.length;
  },

  /**
   * Upserts precomputed account summary (Project 3 account_analytics_summaries).
   */
  async upsertAccountSummary(
    workspaceId: string,
    connectionId: string,
    summary: AccountAnalyticsSummary
  ): Promise<void> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const payload = {
      ...summary,
      workspace_id: workspaceId,
      connection_id: connectionId,
      recorded_at: new Date().toISOString(),
    };

    const { error } = await analyticsClient
      .from('account_analytics_summaries')
      .upsert(payload, {
        onConflict: 'workspace_id,connection_id,window_start,window_end',
        ignoreDuplicates: false,
      });

    if (error) throw error;
  },

  /**
   * Upserts ranked top pin snapshots (Project 3 top_pins_snapshots).
   */
  async upsertTopPinsSnapshots(
    workspaceId: string,
    connectionId: string,
    pins: TopPinSnapshot[]
  ): Promise<number> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }
    if (!pins || pins.length === 0) return 0;

    const analyticsClient = dbClients.getAnalytics();
    const payload = pins.map((p) => ({
      ...p,
      workspace_id: workspaceId,
      connection_id: connectionId,
      recorded_at: new Date().toISOString(),
    }));

    const { error } = await analyticsClient
      .from('top_pins_snapshots')
      .upsert(payload, {
        onConflict: 'workspace_id,connection_id,pin_id,window_start,window_end,sort_by',
        ignoreDuplicates: false,
      });

    if (error) throw error;
    return pins.length;
  },

  /**
   * Upserts derived workspace rollups (Project 3 daily_workspace_metrics).
   */
  async upsertDailyWorkspaceMetrics(
    workspaceId: string,
    metrics: DailyWorkspaceMetric[]
  ): Promise<number> {
    if (!workspaceId) {
      throw new Error('Tenant Boundary Violation: workspaceId is required.');
    }
    if (!metrics || metrics.length === 0) return 0;

    const analyticsClient = dbClients.getAnalytics();
    const payload = metrics.map((m) => ({
      ...m,
      workspace_id: workspaceId,
      recorded_at: new Date().toISOString(),
    }));

    const { error } = await analyticsClient
      .from('daily_workspace_metrics')
      .upsert(payload, {
        onConflict: 'workspace_id,metric_date',
        ignoreDuplicates: false,
      });

    if (error) throw error;
    return metrics.length;
  },

  /**
   * Upserts URL performance metrics (Project 3 url_performance_history).
   */
  async upsertUrlPerformance(
    workspaceId: string,
    urls: Array<{
      destination_url: string;
      period_date: string;
      total_impressions: number;
      total_clicks: number;
      total_pins_active: number;
    }>
  ): Promise<number> {
    if (!workspaceId) {
      throw new Error('Tenant Boundary Violation: workspaceId is required.');
    }
    if (!urls || urls.length === 0) return 0;

    const analyticsClient = dbClients.getAnalytics();
    const payload = urls.map((u) => ({
      ...u,
      workspace_id: workspaceId,
      created_at: new Date().toISOString(),
    }));

    const { error } = await analyticsClient
      .from('url_performance_history')
      .upsert(payload, {
        onConflict: 'workspace_id,destination_url,period_date',
        ignoreDuplicates: false,
      });

    if (error) throw error;
    return urls.length;
  },

  // ============================================================================
  // Project 3 Query Operations
  // ============================================================================

  /**
   * Retrieves daily time-series metrics from Project 3.
   */
  async getDailyTimeSeries(
    workspaceId: string,
    connectionId: string,
    windowDays: number
  ): Promise<AccountAnalyticsDaily[]> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - windowDays);
    const startDateStr = startDate.toISOString().split('T')[0];

    const analyticsClient = dbClients.getAnalytics();
    const { data, error } = await analyticsClient
      .from('account_analytics_daily')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .gte('metric_date', startDateStr)
      .order('metric_date', { ascending: true });

    if (error) throw error;
    return (data as AccountAnalyticsDaily[]) || [];
  },

  /**
   * Retrieves ranked top pins for an account from Project 3.
   * R19 F3: Two-step window-pinned reader returning ONLY the newest window snapshot to prevent duplication.
   */
  async getRankedTopPins(
    workspaceId: string,
    connectionId: string,
    sortBy: PinnerSortBy,
    limit = 50
  ): Promise<TopPinSnapshot[]> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();

    // Step 1 (Latest window):
    const { data: latestWindow, error: windowError } = await analyticsClient
      .from('top_pins_snapshots')
      .select('window_start, window_end')
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .eq('sort_by', sortBy)
      .order('window_end', { ascending: false })
      .limit(1);

    if (windowError) throw windowError;
    if (!latestWindow || latestWindow.length === 0) {
      return [];
    }

    const { window_start: w0, window_end: w1 } = latestWindow[0];

    // Step 2: return rows for THAT exact window
    const { data, error } = await analyticsClient
      .from('top_pins_snapshots')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .eq('sort_by', sortBy)
      .eq('window_start', w0)
      .eq('window_end', w1)
      .order('rank_position', { ascending: true })
      .limit(limit);

    if (error) throw error;
    return (data as TopPinSnapshot[]) || [];
  },

  /**
   * Retrieves aggregated pin leaderboard scoped strictly to a single sort_by mode (V26.1 + V36).
   * Computes per-item pooled rates, supports additive filtering, server sorting, and pagination.
   */
  async getPinLeaderboard(
    workspaceId: string,
    connectionId: string,
    sortBy: PinnerSortBy,
    days = 30,
    limit = 25,
    search?: string | null,
    options: PinLeaderboardOptions = {}
  ): Promise<PinLeaderboardResult> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const cleanSearch = search && search.trim().length > 0 ? (search || '').trim().replace(/[\\%_(),.]/g, '\\$&') : null;
    
    // Fetch candidate aggregated records (up to 1000 for client filtering & pagination)
    const { data, error } = await analyticsClient.rpc('get_pin_leaderboard', {
      p_connection_id: connectionId,
      p_sort_by: sortBy,
      p_days: days,
      p_limit: 1000,
      p_search: cleanSearch,
    });

    let allItems: PinLeaderboardItem[] = [];

    if (error) {
      console.warn('[AnalyticsDb] get_pin_leaderboard RPC error, falling back to SQL aggregation query:', error.message);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      let query = analyticsClient
        .from('top_pins_snapshots')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('connection_id', connectionId)
        .eq('sort_by', sortBy)
        .gte('window_end', cutoff)
        .limit(500)
        .order('window_end', { ascending: false });

      if (cleanSearch) {
        query = query.or(`pin_id.ilike.%${cleanSearch}%,title.ilike.%${cleanSearch}%`);
      }

      const { data: rawRows, error: rawError } = await query;
      if (!rawError && rawRows) {
        const pinMap = new Map<string, any>();
        for (const row of rawRows) {
          const existing = pinMap.get(row.pin_id);
          if (!existing) {
            pinMap.set(row.pin_id, {
              pin_id: row.pin_id,
              title: row.title || null,
              image_url: row.image_url || null,
              destination_url: row.destination_url || null,
              appearances: 1,
              best_rank: row.rank_position,
              total_impressions: Number(row.impressions || 0),
              total_engagements: Number(row.engagement || 0),
              total_saves: Number(row.saves || 0),
              total_outbound_clicks: Number(row.outbound_clicks || 0),
              total_pin_clicks: Number(row.pin_clicks || 0),
              last_seen: row.window_end,
              prev_rank: null,
            });
          } else {
            existing.appearances++;
            if (row.rank_position < existing.best_rank) existing.best_rank = row.rank_position;
            existing.total_impressions += Number(row.impressions || 0);
            existing.total_engagements += Number(row.engagement || 0);
            existing.total_saves += Number(row.saves || 0);
            existing.total_outbound_clicks += Number(row.outbound_clicks || 0);
            existing.total_pin_clicks += Number(row.pin_clicks || 0);
            if (new Date(row.window_end) > new Date(existing.last_seen)) existing.last_seen = row.window_end;
            if (!existing.title && row.title) existing.title = row.title;
          }
        }

        allItems = Array.from(pinMap.values()).map(item => {
          const total_impressions = Number(item.total_impressions || 0);
          const total_engagements = Number(item.total_engagements || 0);
          const total_outbound_clicks = Number(item.total_outbound_clicks || 0);
          const total_pin_clicks = Number(item.total_pin_clicks || 0);
          const total_saves = Number(item.total_saves || 0);

          return {
            ...item,
            last_seen: item.last_seen ? new Date(item.last_seen).toISOString().split('T')[0] : '',
            trend: 'NEW',
            engagement_rate: total_impressions > 0 ? total_engagements / total_impressions : 0,
            outbound_click_rate: total_impressions > 0 ? total_outbound_clicks / total_impressions : 0,
            pin_click_rate: total_impressions > 0 ? total_pin_clicks / total_impressions : 0,
            save_rate: total_impressions > 0 ? total_saves / total_impressions : 0,
          };
        });
      }
    } else if (data && Array.isArray(data)) {
      allItems = data.map((row: any) => {
        let trend = 'NEW';
        if (row.prev_rank !== null && row.prev_rank !== undefined && row.best_rank !== null) {
          const diff = Number(row.prev_rank) - Number(row.best_rank);
          if (diff > 0) trend = `▲${diff}`;
          else if (diff < 0) trend = `▼${Math.abs(diff)}`;
          else trend = '▬';
        }

        const total_impressions = Number(row.total_impressions || 0);
        const total_engagements = Number(row.total_engagements || 0);
        const total_outbound_clicks = Number(row.total_outbound_clicks || 0);
        const total_pin_clicks = Number(row.total_pin_clicks || 0);
        const total_saves = Number(row.total_saves || 0);

        return {
          pin_id: row.pin_id,
          title: row.title || null,
          image_url: row.image_url || null,
          destination_url: row.destination_url || null,
          appearances: Number(row.appearances || 0),
          best_rank: Number(row.best_rank || 0),
          total_impressions,
          total_engagements,
          total_saves,
          total_outbound_clicks,
          total_pin_clicks,
          last_seen: row.last_seen ? new Date(row.last_seen).toISOString().split('T')[0] : '',
          prev_rank: row.prev_rank !== null && row.prev_rank !== undefined ? Number(row.prev_rank) : null,
          trend,
          engagement_rate: total_impressions > 0 ? total_engagements / total_impressions : 0,
          outbound_click_rate: total_impressions > 0 ? total_outbound_clicks / total_impressions : 0,
          pin_click_rate: total_impressions > 0 ? total_pin_clicks / total_impressions : 0,
          save_rate: total_impressions > 0 ? total_saves / total_impressions : 0,
        };
      });
    }

    // Apply additive filters
    let filtered = allItems;

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(item =>
        item.pin_id.toLowerCase().includes(q) || (item.title && item.title.toLowerCase().includes(q))
      );
    }

    if (options.min_impressions !== undefined && options.min_impressions >= 0) {
      filtered = filtered.filter(item => item.total_impressions >= options.min_impressions!);
    }

    if (options.min_appearances !== undefined && options.min_appearances >= 1) {
      filtered = filtered.filter(item => item.appearances >= options.min_appearances!);
    }

    if (options.trend && options.trend !== 'ALL') {
      const t = options.trend.toUpperCase();
      if (t === 'NEW') {
        filtered = filtered.filter(item => item.trend === 'NEW');
      } else if (t === 'RISING') {
        filtered = filtered.filter(item => item.trend.startsWith('▲'));
      } else if (t === 'FALLING') {
        filtered = filtered.filter(item => item.trend.startsWith('▼'));
      }
    }

    if (options.has_link !== undefined && options.has_link !== null) {
      if (options.has_link === true) {
        filtered = filtered.filter(item => Boolean(item.destination_url && item.destination_url.trim().length > 0));
      } else {
        filtered = filtered.filter(item => !item.destination_url || item.destination_url.trim().length === 0);
      }
    }

    // Sort items
    const sortField = options.sort || 'total_impressions';
    const isAsc = options.sort_dir === 'asc' || (sortField === 'best_rank' && options.sort_dir !== 'desc');

    filtered.sort((a, b) => {
      let diff = 0;
      switch (sortField) {
        case 'appearances':
          diff = a.appearances - b.appearances;
          break;
        case 'best_rank':
          diff = a.best_rank - b.best_rank;
          break;
        case 'total_saves':
          diff = a.total_saves - b.total_saves;
          break;
        case 'total_engagements':
          diff = a.total_engagements - b.total_engagements;
          break;
        case 'total_outbound_clicks':
          diff = a.total_outbound_clicks - b.total_outbound_clicks;
          break;
        case 'total_pin_clicks':
          diff = a.total_pin_clicks - b.total_pin_clicks;
          break;
        case 'last_seen':
          diff = new Date(a.last_seen || 0).getTime() - new Date(b.last_seen || 0).getTime();
          break;
        case 'total_impressions':
        default:
          diff = a.total_impressions - b.total_impressions;
          break;
      }
      return isAsc ? diff : -diff;
    });

    const total_unique = filtered.length;
    const page = Math.max(1, options.page || 1);
    const pageSize = options.page_size || limit || 25;
    const pagedItems = filtered.slice((page - 1) * pageSize, page * pageSize);

    return {
      items: pagedItems,
      total_unique,
      page,
      page_size: pageSize,
    };
  },

  /**
   * Retrieves chronological trend timeline points for a single pin (V26.1).
   */
  async getPinTrends(
    workspaceId: string,
    connectionId: string,
    pinId: string,
    sortBy: PinnerSortBy,
    days = 90
  ): Promise<PinTrendPoint[]> {
    if (!workspaceId || !connectionId || !pinId) {
      throw new Error('Tenant Boundary Violation: workspaceId, connectionId, and pinId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const { data, error } = await analyticsClient
      .from('top_pins_snapshots')
      .select('window_end, rank_position, impressions, engagement, saves, outbound_clicks, pin_clicks, engagement_rate, outbound_click_rate, pin_click_rate, save_rate, title, image_url, destination_url')
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .eq('pin_id', pinId)
      .eq('sort_by', sortBy)
      .gte('window_end', cutoff)
      .order('window_end', { ascending: true });

    if (error || !data) {
      return [];
    }

    return data.map((r: any) => ({
      window_end: r.window_end ? new Date(r.window_end).toISOString().split('T')[0] : '',
      rank_position: Number(r.rank_position || 0),
      impressions: Number(r.impressions || 0),
      engagements: Number(r.engagement || 0),
      saves: Number(r.saves || 0),
      outbound_clicks: Number(r.outbound_clicks || 0),
      pin_clicks: Number(r.pin_clicks || 0),
      engagement_rate: Number(r.engagement_rate || 0),
      outbound_click_rate: Number(r.outbound_click_rate || 0),
      pin_click_rate: Number(r.pin_click_rate || 0),
      save_rate: Number(r.save_rate || 0),
      title: r.title || null,
      image_url: r.image_url || null,
      destination_url: r.destination_url || null,
    }));
  },

  /**
   * Aggregates overview KPI metrics from Project 3 account_analytics_daily.
   * R11.1: Sum over account_analytics_daily for the window WHERE data_status = 'READY'.
   * R11.2: Prefer account_analytics_summaries rates, fallback to pooled totals.
   * R11.3: daily_workspace_metrics remains workspace-level only.
   */
  async getAccountOverviewMetrics(
    workspaceId: string,
    connectionId: string,
    windowDays: number
  ): Promise<{
    impressions: number;
    engagements: number;
    pinClicks: number;
    outboundClicks: number;
    saves: number;
    engagementRate: number;
    pinClickRate: number;
    outboundClickRate: number;
    saveRate: number;
    lastIngestedAt: string | null;
  }> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - windowDays);
    const startDateStr = startDate.toISOString().split('T')[0];

    const analyticsClient = dbClients.getAnalytics();
    const { data: dailyRows, error: dailyError } = await analyticsClient
      .from('account_analytics_daily')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .eq('data_status', 'READY')
      .gte('metric_date', startDateStr)
      .order('metric_date', { ascending: true });

    if (dailyError) throw dailyError;

    let impressions = 0;
    let engagements = 0;
    let pinClicks = 0;
    let outboundClicks = 0;
    let saves = 0;
    let lastIngestedAt: string | null = null;

    for (const row of dailyRows || []) {
      impressions += Number(row.impressions || 0);
      engagements += Number(row.engagements || 0);
      pinClicks += Number(row.pin_clicks || 0);
      outboundClicks += Number(row.outbound_clicks || 0);
      saves += Number(row.saves || 0);
      const rowTimestamp = row.recorded_at || row.created_at;
      if (rowTimestamp && (!lastIngestedAt || rowTimestamp > lastIngestedAt)) {
        lastIngestedAt = rowTimestamp;
      }
    }

    // R11.2: Prefer account_analytics_summaries rates for the same window
    let summaryEngagementRate: number | null = null;
    let summaryPinClickRate: number | null = null;
    let summaryOutboundClickRate: number | null = null;
    let summarySaveRate: number | null = null;

    try {
      const { data: summaryRows } = await analyticsClient
        .from('account_analytics_summaries')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('connection_id', connectionId)
        .order('window_end', { ascending: false })
        .limit(1);

      if (summaryRows && summaryRows.length > 0) {
        const s = summaryRows[0];
        if (s.summary_engagement_rate != null) summaryEngagementRate = Number(s.summary_engagement_rate);
        if (s.summary_pin_click_rate != null) summaryPinClickRate = Number(s.summary_pin_click_rate);
        if (s.summary_outbound_click_rate != null) summaryOutboundClickRate = Number(s.summary_outbound_click_rate);
        if (s.summary_save_rate != null) summarySaveRate = Number(s.summary_save_rate);
      }
    } catch (sErr) {
      console.warn('[AnalyticsDb] Error looking up summary rates:', sErr);
    }

    const engagementRate = summaryEngagementRate != null
      ? summaryEngagementRate
      : (impressions > 0 ? engagements / impressions : 0.0);

    const pinClickRate = summaryPinClickRate != null
      ? summaryPinClickRate
      : (impressions > 0 ? pinClicks / impressions : 0.0);

    const outboundClickRate = summaryOutboundClickRate != null
      ? summaryOutboundClickRate
      : (impressions > 0 ? outboundClicks / impressions : 0.0);

    const saveRate = summarySaveRate != null
      ? summarySaveRate
      : (impressions > 0 ? saves / impressions : 0.0);

    return {
      impressions,
      engagements,
      pinClicks,
      outboundClicks,
      saves,
      engagementRate: Math.min(1.0, engagementRate),
      pinClickRate: Math.min(1.0, pinClickRate),
      outboundClickRate: Math.min(1.0, outboundClickRate),
      saveRate: Math.min(1.0, saveRate),
      lastIngestedAt,
    };
  },

  /**
   * Retrieves all connections for a workspace with single-query batch aggregated stats (no N+1).
   */
  async getWorkspaceConnectionsWithStats(
    workspaceId: string,
    windowDays = 30
  ): Promise<Array<AnalyticsConnection & {
    stats: {
      impressions: number;
      engagements: number;
      pin_clicks: number;
      outbound_clicks: number;
      saves: number;
    };
  }>> {
    if (!workspaceId) {
      throw new Error('Tenant Boundary Violation: workspaceId is required.');
    }

    const connections = await this.listWorkspaceConnections(workspaceId);
    if (connections.length === 0) return [];

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - windowDays);
    const startDateStr = startDate.toISOString().split('T')[0];

    const analyticsClient = dbClients.getAnalytics();
    // Bounded fetch to prevent unbounded memory growth; TODO: Replace with RPC get_connection_rollup_stats
    const { data: dailyRows, error } = await analyticsClient
      .from('account_analytics_daily')
      .select('connection_id, impressions, engagements, pin_clicks, outbound_clicks, saves')
      .eq('workspace_id', workspaceId)
      .eq('data_status', 'READY')
      .gte('metric_date', startDateStr)
      .limit(10000);

    if (error) {
      console.warn('[AnalyticsDb] Failed to query daily rows for connection stats:', error);
    }

    const statsMap = new Map<string, {
      impressions: number;
      engagements: number;
      pin_clicks: number;
      outbound_clicks: number;
      saves: number;
    }>();

    for (const row of dailyRows || []) {
      const connId = row.connection_id;
      const current = statsMap.get(connId) || {
        impressions: 0,
        engagements: 0,
        pin_clicks: 0,
        outbound_clicks: 0,
        saves: 0,
      };
      current.impressions += Number(row.impressions || 0);
      current.engagements += Number(row.engagements || 0);
      current.pin_clicks += Number(row.pin_clicks || 0);
      current.outbound_clicks += Number(row.outbound_clicks || 0);
      current.saves += Number(row.saves || 0);
      statsMap.set(connId, current);
    }

    return connections.map((conn) => ({
      ...conn,
      stats: statsMap.get(conn.id) || {
        impressions: 0,
        engagements: 0,
        pin_clicks: 0,
        outbound_clicks: 0,
        saves: 0,
      },
    }));
  },

  /**
   * Retrieves connection daily metrics and pooled totals for a date range.
   */
  async getConnectionDailyMetrics(
    workspaceId: string,
    connectionId: string,
    fromDate?: string,
    toDate?: string,
    options?: {
      query?: string;
      sortField?: string;
      sortDir?: 'asc' | 'desc';
      page?: number;
      pageSize?: number;
    }
  ): Promise<{
    rows: AccountAnalyticsDaily[];
    total: number;
    totals: {
      impressions: number;
      engagements: number;
      outbound_clicks: number;
      pin_clicks: number;
      saves: number;
      engagement_rate: number;
      outbound_click_rate: number;
      pin_click_rate: number;
      save_rate: number;
    };
  }> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();

    // 1. Calculate totals across the date range (for READY status)
    let totalsQuery = analyticsClient
      .from('account_analytics_daily')
      .select('impressions, engagements, outbound_clicks, pin_clicks, saves')
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .eq('data_status', 'READY');

    if (fromDate) totalsQuery = totalsQuery.gte('metric_date', fromDate);
    if (toDate) totalsQuery = totalsQuery.lte('metric_date', toDate);

    const { data: totalsData } = await totalsQuery;
    const totalsRows = totalsData || [];

    let impressions = 0;
    let engagements = 0;
    let outbound_clicks = 0;
    let pin_clicks = 0;
    let saves = 0;

    for (const row of totalsRows) {
      impressions += Number(row.impressions || 0);
      engagements += Number(row.engagements || 0);
      outbound_clicks += Number(row.outbound_clicks || 0);
      pin_clicks += Number(row.pin_clicks || 0);
      saves += Number(row.saves || 0);
    }

    const engagement_rate = impressions > 0 ? engagements / impressions : 0.0;
    const outbound_click_rate = impressions > 0 ? outbound_clicks / impressions : 0.0;
    const pin_click_rate = impressions > 0 ? pin_clicks / impressions : 0.0;
    const save_rate = impressions > 0 ? saves / impressions : 0.0;

    // 2. Query filtered, sorted, paginated rows
    let query = analyticsClient
      .from('account_analytics_daily')
      .select('*', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId);

    if (fromDate) query = query.gte('metric_date', fromDate);
    if (toDate) query = query.lte('metric_date', toDate);

    if (options?.query) {
      const sanitized = options.query.trim().replace(/[\\%_]/g, '\\$&');
      query = query.ilike('metric_date', `%${sanitized}%`);
    }

    const sortCol = options?.sortField || 'metric_date';
    const isAsc = options?.sortDir === 'asc';
    query = query.order(sortCol, { ascending: isAsc });

    if (options?.page && options?.pageSize) {
      const from = (options.page - 1) * options.pageSize;
      const to = from + options.pageSize - 1;
      query = query.range(from, to);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const rows = (data as AccountAnalyticsDaily[]) || [];
    const total = count ?? rows.length;

    return {
      rows,
      total,
      totals: {
        impressions,
        engagements,
        outbound_clicks,
        pin_clicks,
        saves,
        engagement_rate,
        outbound_click_rate,
        pin_click_rate,
        save_rate,
      },
    };
  },

  /**
   * Deletes a daily metric record and recomputes the daily_workspace_metrics rollup for that date.
   */
  async deleteDailyMetricAndRecompute(
    workspaceId: string,
    connectionId: string,
    metricDate: string
  ): Promise<void> {
    if (!workspaceId || !connectionId || !metricDate) {
      throw new Error('Validation Error: workspaceId, connectionId, and metricDate are required.');
    }

    const analyticsClient = dbClients.getAnalytics();

    // 1. Delete the specific daily row
    const { error: delError } = await analyticsClient
      .from('account_analytics_daily')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .eq('metric_date', metricDate);

    if (delError) throw delError;

    // 2. Query remaining READY rows for the workspace on that date to recompute rollup
    const { data: remainingRows, error: remError } = await analyticsClient
      .from('account_analytics_daily')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('metric_date', metricDate)
      .eq('data_status', 'READY');

    if (remError) throw remError;

    if (!remainingRows || remainingRows.length === 0) {
      // No remaining rows for that date -> remove or zero out rollup
      await analyticsClient
        .from('daily_workspace_metrics')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('metric_date', metricDate);
    } else {
      let total_impressions = 0;
      let total_engagements = 0;
      let total_saves = 0;
      let total_outbound_clicks = 0;
      let total_pin_clicks = 0;

      for (const r of remainingRows) {
        total_impressions += Number(r.impressions || 0);
        total_engagements += Number(r.engagements || 0);
        total_saves += Number(r.saves || 0);
        total_outbound_clicks += Number(r.outbound_clicks || 0);
        total_pin_clicks += Number(r.pin_clicks || 0);
      }

      await analyticsClient
        .from('daily_workspace_metrics')
        .upsert(
          {
            workspace_id: workspaceId,
            metric_date: metricDate,
            total_impressions,
            total_engagements,
            total_saves,
            total_outbound_clicks,
            total_pin_clicks,
            total_profile_visits: 0,
            recorded_at: new Date().toISOString(),
          },
          { onConflict: 'workspace_id,metric_date' }
        );
    }

    // 3. Invalidate connection cache
    await edgeCache.invalidateConnection(workspaceId, connectionId);
  },

  /**
   * Retrieves ranked top pins with date range filtering.
   * R19 F3: Two-step window-pinned reader returning ONLY the newest window snapshot matching range.
   */
  /**
   * Retrieves paginated Top Pins snapshots for a given window (R-04 Layer B).
   */
  async getTopPinsPaginated(
    workspaceId: string,
    connectionId: string,
    sortBy: PinnerSortBy,
    fromDate?: string,
    toDate?: string,
    limit = 50,
    page = 1,
    pageSize = 25,
    q?: string
  ): Promise<{ rows: TopPinSnapshot[]; total: number; window: { start: string; end: string } | null }> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();

    // Step 1 (Latest window within optional range):
    let windowQuery = analyticsClient
      .from('top_pins_snapshots')
      .select('window_start, window_end')
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .eq('sort_by', sortBy);

    if (fromDate) windowQuery = windowQuery.gte('window_start', fromDate);
    if (toDate) windowQuery = windowQuery.lte('window_end', toDate);

    const { data: latestWindow, error: windowError } = await windowQuery
      .order('window_end', { ascending: false })
      .order('window_start', { ascending: false })
      .limit(1);

    if (windowError) throw windowError;
    if (!latestWindow || latestWindow.length === 0) {
      return {
        rows: [],
        total: 0,
        window: null,
      };
    }

    const { window_start: w0, window_end: w1 } = latestWindow[0];

    const selectCols =
      'pin_id,title,image_url,destination_url,rank_position,window_start,window_end,impressions,engagement,outbound_clicks,pin_clicks,saves,engagement_rate,outbound_click_rate,pin_click_rate,save_rate,data_status';

    const ps = pageSize || limit;
    const start = (page - 1) * ps;
    const end = start + ps - 1;

    let query = analyticsClient
      .from('top_pins_snapshots')
      .select(selectCols, { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .eq('connection_id', connectionId)
      .eq('sort_by', sortBy)
      .eq('window_start', w0)
      .eq('window_end', w1);

    if (q && q.trim()) {
      const term = (q || '').trim().replace(/[\\%_(),.]/g, '\\$&');
      query = query.or(`pin_id.ilike.%${term}%,title.ilike.%${term}%`);
    }

    const { data, error, count } = await query
      .order('rank_position', { ascending: true })
      .order('recorded_at', { ascending: false })
      .range(start, end);

    if (error) throw error;

    const rows = (data as TopPinSnapshot[]) || [];
    const total = count ?? rows.length;

    return {
      rows: rows || [],
      total,
      window: { start: w0, end: w1 },
    };
  },

  /**
   * Computes high-level aggregated summary across an entire workspace for a given date range.
   */
  async getMetricSummary(
    workspaceId: string,
    startDate?: string,
    endDate?: string
  ): Promise<MetricSummary> {
    if (!workspaceId) {
      throw new Error('Tenant Boundary Violation: workspaceId is required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    let query = analyticsClient
      .from('daily_workspace_metrics')
      .select('total_impressions, total_engagements, total_saves, total_pin_clicks')
      .eq('workspace_id', workspaceId);

    if (startDate) query = query.gte('metric_date', startDate);
    if (endDate) query = query.lte('metric_date', endDate);

    const { data, error } = await query;
    if (error) throw error;

    let total_impressions = 0;
    let total_engagements = 0;
    let total_saves = 0;
    let total_clicks = 0;

    if (data && data.length > 0) {
      for (const row of data) {
        total_impressions += Number(row.total_impressions || 0);
        total_engagements += Number(row.total_engagements || 0);
        total_saves += Number(row.total_saves || 0);
        total_clicks += Number(row.total_pin_clicks || 0);
      }
    }

    const engagement_rate =
      total_impressions > 0 ? (total_engagements / total_impressions) : 0.0;

    return {
      workspace_id: workspaceId,
      total_pins_posted: 0,
      total_impressions,
      total_saves,
      total_clicks,
      engagement_rate: Math.min(1.0, engagement_rate),
    };
  },

  // ============================================================================
  // Project 3 Dedicated Analytics Control Plane (V17 Final Standalone)
  // ============================================================================

  /**
   * Retrieves workspace analytics settings from Project 3.
   */
  async getWorkspaceAnalyticsSettings(
    workspaceId: string
  ): Promise<WorkspaceAnalyticsSettings | null> {
    if (!workspaceId) {
      throw new Error('Tenant Boundary Violation: workspaceId is required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const { data, error } = await analyticsClient
      .from('workspace_analytics_settings')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (error) throw error;
    return data as WorkspaceAnalyticsSettings | null;
  },

  /**
   * Upserts workspace analytics settings into Project 3.
   */
  async upsertWorkspaceAnalyticsSettings(
    workspaceId: string,
    settings: Partial<WorkspaceAnalyticsSettings>
  ): Promise<WorkspaceAnalyticsSettings> {
    if (!workspaceId) {
      throw new Error('Tenant Boundary Violation: workspaceId is required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const payload = {
      ...settings,
      workspace_id: workspaceId,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await analyticsClient
      .from('workspace_analytics_settings')
      .upsert(payload, { onConflict: 'workspace_id' })
      .select()
      .single();

    if (error) throw error;
    return data as WorkspaceAnalyticsSettings;
  },

  /**
   * Lists non-deleted analytics connections of a workspace from Project 3.
   */
  async listWorkspaceConnections(workspaceId: string): Promise<AnalyticsConnection[]> {
    if (!workspaceId) {
      throw new Error('Tenant Boundary Violation: workspaceId is required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const { data, error } = await analyticsClient
      .from('analytics_connections')
      .select('*')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as AnalyticsConnection[]) || [];
  },

  /**
   * Gets a specific analytics connection in a workspace.
   */
  async getWorkspaceConnection(
    workspaceId: string,
    connectionId: string
  ): Promise<AnalyticsConnection | null> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const { data, error } = await analyticsClient
      .from('analytics_connections')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', connectionId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw error;
    return data as AnalyticsConnection | null;
  },

  /**
   * Creates a new analytics connection in Project 3.
   */
  async createWorkspaceConnection(
    workspaceId: string,
    displayName: string,
    analyticsEnabled = true
  ): Promise<AnalyticsConnection> {
    if (!workspaceId || !displayName) {
      throw new Error('Validation Error: workspaceId and displayName are required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const { data, error } = await analyticsClient
      .from('analytics_connections')
      .insert({
        workspace_id: workspaceId,
        display_name: displayName.trim(),
        analytics_enabled: analyticsEnabled,
        analytics_sync_time: '04:00',
        analytics_cron_expression: '0 4 * * *',
        analytics_schedule_status: 'pending',
        top_pins_sync_time: '04:30',
        top_pins_cron_expression: '30 4 * * *',
        top_pins_schedule_status: 'pending',
        top_pins_num_of_pins: 50,
        top_pins_sort_modes: ['IMPRESSION', 'OUTBOUND_CLICK', 'SAVE', 'ENGAGEMENT', 'PIN_CLICK'],
        fastcron_notify: true,
        fastcron_timeout: 30,
        fastcron_instances: 1,
      })
      .select()
      .single();

    if (error) throw error;
    return data as AnalyticsConnection;
  },

  /**
   * Updates an existing analytics connection in Project 3.
   * If analytics_enabled is set to true, automatically clears revoked_at.
   */
  async updateWorkspaceConnection(
    workspaceId: string,
    connectionId: string,
    updates: Partial<AnalyticsConnection>
  ): Promise<AnalyticsConnection> {
    if (!workspaceId || !connectionId) {
      throw new Error('Validation Error: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const updatePayload: Record<string, any> = {
      ...updates,
      updated_at: new Date().toISOString(),
    };

    if (updates.display_name !== undefined) {
      updatePayload.display_name = updates.display_name.trim();
    }

    if (updates.analytics_enabled === true && updates.revoked_at === undefined) {
      updatePayload.revoked_at = null;
    }

    const { data, error } = await analyticsClient
      .from('analytics_connections')
      .update(updatePayload)
      .eq('id', connectionId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .select()
      .single();

    if (error) throw error;
    return data as AnalyticsConnection;
  },

  /**
   * Soft-deletes an analytics connection in Project 3.
   */
  async softDeleteWorkspaceConnection(
    workspaceId: string,
    connectionId: string
  ): Promise<AnalyticsConnection> {
    if (!workspaceId || !connectionId) {
      throw new Error('Validation Error: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const { data, error } = await analyticsClient
      .from('analytics_connections')
      .update({
        analytics_enabled: false,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', connectionId)
      .eq('workspace_id', workspaceId)
      .select()
      .single();

    if (error) throw error;
    return data as AnalyticsConnection;
  },

  /**
   * Updates the last_analytics_sync_at timestamp for a connection in Project 3.
   */
  async updateConnectionLastSync(connectionId: string, workspaceId?: string): Promise<void> {
    if (!connectionId) return;
    const analyticsClient = dbClients.getAnalytics();
    let query = analyticsClient
      .from('analytics_connections')
      .update({
        last_analytics_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', connectionId);

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    await query;
  },

  /**
   * Preview data purge record counts and affected rollup dates.
   * Scoped across the 5 analytics data layers:
   * - D1: account_analytics_daily (daily metrics per connection)
   * - D2: account_analytics_summaries (period summaries per connection)
   * - D3: daily_workspace_metrics (workspace rollups recalculated across remaining connections)
   * - D4: top_pins_snapshots (ranked top pins snapshots)
   * - D5: url_performance_history (destination URL performance history)
   */
  async previewPurge(
    workspaceId: string,
    connectionId: string,
    fromDate: string,
    toDate: string,
    targets: PurgeTarget[]
  ): Promise<PurgePreviewCounts> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const p_daily = targets.includes('daily');
    const p_top_pins = targets.includes('top_pins');

    const fromTs = `${fromDate}T00:00:00.000Z`;
    const toDateObj = new Date(`${toDate}T00:00:00.000Z`);
    const toExclDate = new Date(toDateObj.getTime() + 86400000).toISOString().split('T')[0];
    const toExclTs = `${toExclDate}T00:00:00.000Z`;

    let daily_count = 0;
    let summaries_count = 0;
    let top_pins_count = 0;
    let url_perf_count = 0;
    let affected_rollup_dates: string[] = [];

    if (p_daily) {
      const [dailyRes, sumRes, rollRes] = await Promise.all([
        analyticsClient
          .from('account_analytics_daily')
          .select('*', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('connection_id', connectionId)
          .gte('metric_date', fromDate)
          .lte('metric_date', toDate),
        analyticsClient
          .from('account_analytics_summaries')
          .select('*', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('connection_id', connectionId)
          .gte('window_end', fromTs)
          .lt('window_start', toExclTs),
        analyticsClient
          .from('daily_workspace_metrics')
          .select('metric_date')
          .eq('workspace_id', workspaceId)
          .gte('metric_date', fromDate)
          .lte('metric_date', toDate),
      ]);

      daily_count = dailyRes.count ?? 0;
      summaries_count = sumRes.count ?? 0;
      affected_rollup_dates = (rollRes.data || []).map((r: any) => r.metric_date);
    }

    if (p_top_pins) {
      const [pinsRes, urlRes] = await Promise.all([
        analyticsClient
          .from('top_pins_snapshots')
          .select('*', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .eq('connection_id', connectionId)
          .gte('window_end', fromTs)
          .lt('window_start', toExclTs),
        analyticsClient
          .from('url_performance_history')
          .select('*', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId)
          .gte('period_date', fromDate)
          .lte('period_date', toDate),
      ]);

      top_pins_count = pinsRes.count ?? 0;
      url_perf_count = urlRes.count ?? 0;
    }

    const total_records = daily_count + summaries_count + top_pins_count + url_perf_count;

    return {
      daily_count,
      summaries_count,
      top_pins_count,
      url_perf_count,
      affected_rollup_dates,
      total_records,
    };
  },

  /**
   * Executes atomic data purge via PostgreSQL RPC and returns audit log details.
   */
  async purgeAnalyticsData(
    workspaceId: string,
    connectionId: string,
    fromDate: string,
    toDate: string,
    targets: PurgeTarget[],
    performedBy: string
  ): Promise<{ purge_log_id: string; counts: PurgeResultCounts }> {
    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspaceId and connectionId are required.');
    }

    const analyticsClient = dbClients.getAnalytics();
    const { data, error } = await analyticsClient.rpc('purge_analytics_data', {
      p_workspace: workspaceId,
      p_connection: connectionId,
      p_from: fromDate,
      p_to: toDate,
      p_daily: targets.includes('daily'),
      p_top_pins: targets.includes('top_pins'),
      p_performed_by: performedBy,
    });

    if (error) throw error;

    return {
      purge_log_id: data.purge_log_id,
      counts: data.counts,
    };
  },
};

