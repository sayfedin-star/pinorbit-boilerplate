import { analyticsDb } from '../db/analytics';
import { dbClients } from '../db/clients';
import { edgeCache } from './edge-cache';
import type {
  PinnerIngestPayload,
  PinnerSortBy,
  PinnerRawMetrics,
  AccountAnalyticsDaily,
  AccountAnalyticsSummary,
  TopPinSnapshot,
  DailyWorkspaceMetric,
} from '../../lib/types';

// =============================================================================
// R4: Schema-Contract Allowlist Definitions (Immutable Project 3 DB Contracts)
// =============================================================================
export const COLUMN_ALLOWLISTS = {
  account_analytics_daily: new Set([
    'workspace_id',
    'connection_id',
    'window_start',
    'window_end',
    'metric_date',
    'data_status',
    'impressions',
    'engagements',
    'outbound_clicks',
    'pin_clicks',
    'saves',
    'video_10s_view',
    'video_mrc_view',
    'video_start',
    'quartile_95_percent_view',
    'engagement_rate',
    'outbound_click_rate',
    'pin_click_rate',
    'save_rate',
    'video_avg_watch_time',
    'video_v50_watch_time',
    'profile_visits',
    'closeups',
    'raw_metrics',
    'recorded_at',
  ]),
  account_analytics_summaries: new Set([
    'workspace_id',
    'connection_id',
    'window_start',
    'window_end',
    'summary_impressions',
    'summary_engagements',
    'summary_outbound_clicks',
    'summary_pin_clicks',
    'summary_saves',
    'summary_video_10s_view',
    'summary_video_mrc_view',
    'summary_video_start',
    'summary_quartile_95_percent_view',
    'summary_engagement_rate',
    'summary_outbound_click_rate',
    'summary_pin_click_rate',
    'summary_save_rate',
    'summary_profile_visits',
    'summary_closeups',
    'summary_video_avg_watch_time',
    'summary_video_v50_watch_time',
    'raw_summary',
    'recorded_at',
  ]),
  top_pins_snapshots: new Set([
    'workspace_id',
    'connection_id',
    'window_start',
    'window_end',
    'sort_by',
    'rank_position',
    'pin_id',
    'recorded_at',
    'impressions',
    'engagement',
    'outbound_clicks',
    'pin_clicks',
    'saves',
    'video_10s_view',
    'video_mrc_view',
    'video_start',
    'quartile_95_percent_view',
    'engagement_rate',
    'outbound_click_rate',
    'pin_click_rate',
    'save_rate',
    'video_avg_watch_time',
    'video_v50_watch_time',
    'data_status',
    'date_availability',
    'title',
    'destination_url',
    'image_url',
    'pin_metadata',
    'raw_metrics',
    'raw_pin',
    'raw_headers',
  ]),
};

/**
 * Filters a raw record exclusively to allowed contract column keys.
 */
export function filterRecordByAllowlist<T extends Record<string, any>>(
  record: T,
  allowlist: Set<string>
): Partial<T> {
  const result: any = {};
  for (const [key, value] of Object.entries(record)) {
    if (allowlist.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

const MAX_TRACKER_SIZE = 1000;
// In-memory tracker for consecutive ingestion failures by workspace
const failureStreakTracker = new Map<string, { count: number; lastFailedAt: string }>();

export interface ETLProcessingResult {
  success: boolean;
  persisted: boolean;
  workspaceId: string;
  connectionId: string;
  runId?: string;
  dailyRowsIngested: number;
  summarySaved: boolean;
  topPinsIngested: number;
  workspaceRollupsUpdated: number;
  revoked: boolean;
  snitchAlerted: boolean;
  error?: string | null;
  details?: any;
}

/**
 * Helper to execute and log batch upserts cleanly (R-09).
 */
async function upsertBatch<T>(label: string, rows: T[], fn: (r: T[]) => Promise<number>): Promise<number> {
  if (!rows.length) return 0;
  const count = await fn(rows);
  console.info(`[PinnerETL] ${label}: upserted ${count} rows`);
  return count;
}

/**
 * Normalizes Pinterest metrics ensuring proper BIGINT counts and NUMERIC(8,6) rates.
 * Forward-compatibility: unknown metric keys are preserved ONLY in raw_metrics JSONB.
 */
function normalizeMetrics(raw: PinnerRawMetrics = {}) {
  const sanitizeNumber = (v: unknown): number => {
    if (v === undefined || v === null) return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    let s = String(v).trim().toLowerCase();
    let multiplier = 1;
    if (s.endsWith('k')) { multiplier = 1000; s = s.slice(0, -1); }
    else if (s.endsWith('m')) { multiplier = 1000000; s = s.slice(0, -1); }
    else if (s.endsWith('b')) { multiplier = 1000000000; s = s.slice(0, -1); }
    s = s.replace(/[^0-9.-]/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n * multiplier : 0;
  };

  const parseCount = (v: unknown): number => {
    const n = sanitizeNumber(v);
    const result = n < 0 ? 0 : Math.floor(n);
    return Number.isFinite(result) ? result : 0;
  };

  const parseRate = (v: unknown): number => {
    const n = sanitizeNumber(v);
    const result = parseFloat(n.toFixed(6));
    return Number.isFinite(result) ? result : 0;
  };

  const parseTiming = (v: unknown): number => {
    const n = sanitizeNumber(v);
    const result = n < 0 ? 0.0 : parseFloat(n.toFixed(2));
    return Number.isFinite(result) ? result : 0;
  };

  const impressions = parseCount(raw.IMPRESSION);
  const engagements = parseCount(raw.ENGAGEMENT);
  const saves = parseCount(raw.SAVE);
  const pinClicks = parseCount(raw.PIN_CLICK);
  const outboundClicks = parseCount(raw.OUTBOUND_CLICK);

  // Derived or provided rates
  const engagementRate =
    raw.ENGAGEMENT_RATE !== undefined
      ? parseRate(raw.ENGAGEMENT_RATE)
      : impressions > 0
      ? parseRate(engagements / impressions)
      : 0.0;

  const outboundClickRate =
    raw.OUTBOUND_CLICK_RATE !== undefined
      ? parseRate(raw.OUTBOUND_CLICK_RATE)
      : impressions > 0
      ? parseRate(outboundClicks / impressions)
      : 0.0;

  const pinClickRate =
    raw.PIN_CLICK_RATE !== undefined
      ? parseRate(raw.PIN_CLICK_RATE)
      : impressions > 0
      ? parseRate(pinClicks / impressions)
      : 0.0;

  const saveRate =
    raw.SAVE_RATE !== undefined
      ? parseRate(raw.SAVE_RATE)
      : impressions > 0
      ? parseRate(saves / impressions)
      : 0.0;

  return {
    impressions,
    engagements,
    engagement_rate: engagementRate,
    outbound_clicks: outboundClicks,
    outbound_click_rate: outboundClickRate,
    pin_clicks: pinClicks,
    pin_click_rate: pinClickRate,
    saves,
    save_rate: saveRate,
    video_10s_view: parseCount(raw.VIDEO_10S_VIEW),
    video_mrc_view: parseCount(raw.VIDEO_MRC_VIEW),
    video_start: parseCount(raw.VIDEO_START),
    quartile_95_percent_view: parseCount(raw.QUARTILE_95_PERCENT_VIEW),
    video_avg_watch_time: parseTiming(raw.VIDEO_AVG_WATCH_TIME),
    video_v50_watch_time: parseTiming(raw.VIDEO_V50_WATCH_TIME),
    profile_visits: parseCount(raw.PROFILE_VISITS || raw.PROFILE_VISIT),
    closeups: parseCount(raw.CLOSEUPS || raw.CLOSEUP),
  };
}

export const pinnerETL = {
  /**
   * Resets failure tracker for a workspace (useful for tests).
   */
  resetFailureStreak(workspaceId: string) {
    failureStreakTracker.delete(workspaceId);
  },

  /**
   * Triggers Dead Man's Snitch webhook on consecutive failures.
   */
  async triggerDeadManSnitch(
    workspaceId: string,
    connectionId: string,
    streakCount: number,
    lastError?: any,
    runtimeEnv?: Record<string, any>
  ): Promise<boolean> {
    const env = dbClients.getConfig(runtimeEnv);
    const snitchUrl = env.SNITCH_WEBHOOK_URL;
    if (!snitchUrl) {
      console.warn('[DeadManSnitch] No SNITCH_WEBHOOK_URL configured.');
      return false;
    }

    try {
      const res = await fetch(snitchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'pinner_ingestion_failure_streak',
          workspace_id: workspaceId,
          connection_id: connectionId,
          consecutive_failures: streakCount,
          error_details: lastError || null,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      });

      return res.ok;
    } catch (e) {
      console.warn('[DeadManSnitch] Webhook dispatch error:', e);
      return false;
    }
  },

  /**
   * Handles 401 Unauthorized revocation strictly in Project 3.
   */
  async handleAccountRevocation(
    workspaceId: string,
    connectionId: string,
    _errorDetails?: any,
    runtimeEnv?: Record<string, any>
  ): Promise<void> {
    try {
      const analyticsClient = dbClients.getAnalytics(runtimeEnv);
      await analyticsClient
        .from('analytics_connections')
        .update({
          analytics_enabled: false,
          revoked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', connectionId)
        .eq('workspace_id', workspaceId);
    } catch (e) {
      console.error('[PinnerETL] Account revocation handler error in Project 3:', e);
    }
  },

  /**
   * Main Ingestion Processor.
   * R5: Guaranteed run completion lifecycle inside try/catch/finally.
   */
  async processIngestionPayload(
    payload: PinnerIngestPayload,
    runtimeKvNamespace?: any,
    runtimeEnv?: Record<string, any>
  ): Promise<ETLProcessingResult> {
    const nowIso = new Date().toISOString();
    const {
      workspace_id: workspaceId,
      connection_id: connectionId,
      request_context: requestContext,
      error_details: errorDetails,
      raw_headers: rawHeaders,
      channel: explicitChannel,
    } = payload;

    if (!workspaceId || !connectionId) {
      throw new Error('Tenant Boundary Violation: workspace_id and connection_id are required in payload.');
    }

    // 0. Verify Connection Exists in Project 3
    const analyticsClient = dbClients.getAnalytics(runtimeEnv);
    const { data: connectionData, error: connError } = await analyticsClient
      .from('analytics_connections')
      .select('id, workspace_id, analytics_enabled')
      .eq('id', connectionId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();

    if (connError || !connectionData) {
      return {
        success: false,
        persisted: false,
        workspaceId,
        connectionId,
        dailyRowsIngested: 0,
        summarySaved: false,
        topPinsIngested: 0,
        workspaceRollupsUpdated: 0,
        revoked: false,
        snitchAlerted: false,
        error: `Connection "${connectionId}" is not registered in Project 3 analytics_connections or is deleted.`,
      };
    }

    if (connectionData.workspace_id !== workspaceId) {
      return {
        success: false,
        persisted: false,
        workspaceId,
        connectionId,
        dailyRowsIngested: 0,
        summarySaved: false,
        topPinsIngested: 0,
        workspaceRollupsUpdated: 0,
        revoked: false,
        snitchAlerted: false,
        error: 'tenant_mismatch',
      };
    }

    // Determine ingestion channel and job type
    const channel: 'account_analytics' | 'top_pins' =
      explicitChannel === 'top_pins' || (!payload.account_analytics && payload.top_pins_analytics)
        ? 'top_pins'
        : 'account_analytics';

    const jobType: 'daily_sync' | 'manual_sync' | 'backfill' | 'ping' =
      (requestContext?.job_type as any) || 'daily_sync';

    // 1. Record Ingestion Run in Project 3
    const runRecord = await analyticsDb.createIngestionRun({
      workspace_id: workspaceId,
      connection_id: connectionId,
      channel,
      job_type: jobType,
      status: 'processing',
      request_context: requestContext ? { ...requestContext, raw_headers: rawHeaders } : null,
      rows_processed: 0,
    });

    try {
      // =========================================================================
      // Case 1: Ingestion Failed at Source (Make.com reported success: false)
      // =========================================================================
      if (!payload.success) {
        const httpStatus = errorDetails?.http_status;
        const isRevoked = httpStatus === 401;

        if (isRevoked) {
          await this.handleAccountRevocation(workspaceId, connectionId, errorDetails, runtimeEnv);
        }

        const streak = failureStreakTracker.get(workspaceId) || { count: 0, lastFailedAt: nowIso };
        streak.count += 1;
        streak.lastFailedAt = nowIso;
        if (failureStreakTracker.size >= MAX_TRACKER_SIZE && !failureStreakTracker.has(workspaceId)) {
          const oldestKey = failureStreakTracker.keys().next().value;
          if (oldestKey) failureStreakTracker.delete(oldestKey);
        }
        failureStreakTracker.set(workspaceId, streak);

        const currentStreak = streak.count;
        let snitchFired = false;
        if (currentStreak >= 2) {
          snitchFired = await this.triggerDeadManSnitch(workspaceId, connectionId, currentStreak, errorDetails, runtimeEnv);
        }

        await analyticsDb.failIngestionRun(runRecord.id, {
          ...(errorDetails || { message: 'Make.com reported sync failure' }),
          consecutive_failures: currentStreak,
          snitch_alerted: snitchFired,
          revoked: isRevoked,
        });

        return {
          success: false,
          persisted: false,
          workspaceId,
          connectionId,
          runId: runRecord.id,
          dailyRowsIngested: 0,
          summarySaved: false,
          topPinsIngested: 0,
          workspaceRollupsUpdated: 0,
          revoked: isRevoked,
          snitchAlerted: snitchFired,
          error: errorDetails?.error_message || 'Make.com ingestion failed',
          details: { streak: currentStreak, rawHeaders },
        };
      }

      // =========================================================================
      // Case 2: Ingestion Succeeded — Parse & Transform Data
      // =========================================================================
      const hasAccountAnalytics = Boolean(payload.account_analytics);
      const hasTopPinsAnalytics = Boolean(payload.top_pins_analytics);

      if (!hasAccountAnalytics && !hasTopPinsAnalytics) {
        await analyticsDb.failIngestionRun(runRecord.id, {
          message: 'At least one analytics channel payload must be present when success=true',
        });

        return {
          success: false,
          persisted: false,
          workspaceId,
          connectionId,
          runId: runRecord.id,
          dailyRowsIngested: 0,
          summarySaved: false,
          topPinsIngested: 0,
          workspaceRollupsUpdated: 0,
          revoked: false,
          snitchAlerted: false,
          error: 'Validation Error: At least one analytics channel (account_analytics or top_pins_analytics) must be provided when success=true.',
        };
      }

      // Reset failure streak on success
      failureStreakTracker.delete(workspaceId);

      const dailyRows: AccountAnalyticsDaily[] = [];
      let summaryRow: AccountAnalyticsSummary | null = null;
      const topPinRows: TopPinSnapshot[] = [];
      const destinationUrlsToTrack: Array<{
        destination_url: string;
        period_date: string;
        total_impressions: number;
        total_clicks: number;
        total_pins_active: number;
      }> = [];

      // -------------------------------------------------------------------------
      // Parse Pipeline A: Account Daily Time Series & Summaries (Allowlist filtered)
      // -------------------------------------------------------------------------
      if (payload.account_analytics) {
        const { all } = payload.account_analytics;

        // Parse daily metrics array
        if (all?.daily_metrics && Array.isArray(all.daily_metrics)) {
          for (const item of all.daily_metrics) {
            if (!item.data_status || item.data_status === 'READY') {
              const metrics = normalizeMetrics(item.metrics);
              const unvalidatedDaily = {
                workspace_id: workspaceId,
                connection_id: connectionId,
                metric_date: item.date,
                window_start: item.window_start || item.date,
                window_end: item.window_end || item.date,
                data_status: (typeof item.data_status === 'string' && ['READY','PROCESSING'].includes(item.data_status.toUpperCase())) ? item.data_status.toUpperCase() : 'READY',
                ...metrics,
                raw_metrics: item.metrics || null,
                recorded_at: nowIso,
              };

              const filteredDaily = filterRecordByAllowlist(
                unvalidatedDaily,
                COLUMN_ALLOWLISTS.account_analytics_daily
              ) as AccountAnalyticsDaily;

              dailyRows.push(filteredDaily);
            }
          }
        }

        // Parse summary metrics
        if (all?.summary_metrics) {
          const metrics = normalizeMetrics(all.summary_metrics);
          const windowStart = requestContext?.start_date || (dailyRows[0]?.metric_date ?? nowIso.split('T')[0]);
          const windowEnd = requestContext?.end_date || (dailyRows[dailyRows.length - 1]?.metric_date ?? nowIso.split('T')[0]);

          const unvalidatedSummary = {
            workspace_id: workspaceId,
            connection_id: connectionId,
            window_start: windowStart,
            window_end: windowEnd,
            summary_impressions: metrics.impressions,
            summary_engagements: metrics.engagements,
            summary_outbound_clicks: metrics.outbound_clicks,
            summary_pin_clicks: metrics.pin_clicks,
            summary_saves: metrics.saves,
            summary_video_10s_view: metrics.video_10s_view,
            summary_video_mrc_view: metrics.video_mrc_view,
            summary_video_start: metrics.video_start,
            summary_quartile_95_percent_view: metrics.quartile_95_percent_view,
            summary_engagement_rate: metrics.engagement_rate,
            summary_outbound_click_rate: metrics.outbound_click_rate,
            summary_pin_click_rate: metrics.pin_click_rate,
            summary_save_rate: metrics.save_rate,
            summary_profile_visits: metrics.profile_visits,
            summary_closeups: metrics.closeups,
            summary_video_avg_watch_time: metrics.video_avg_watch_time,
            summary_video_v50_watch_time: metrics.video_v50_watch_time,
            raw_summary: all.summary_metrics || null,
            recorded_at: nowIso,
          };

          summaryRow = filterRecordByAllowlist(
            unvalidatedSummary,
            COLUMN_ALLOWLISTS.account_analytics_summaries
          ) as AccountAnalyticsSummary;
        }
      }

      // -------------------------------------------------------------------------
      // Parse Pipeline B: Ranked Top Pins Snapshots (Allowlist filtered)
      // -------------------------------------------------------------------------
      const today = nowIso.split('T')[0];
      const todayMs = Date.now();
      const calcOffsetDate = (daysAgo: number) =>
        new Date(todayMs - daysAgo * 86400000).toISOString().split('T')[0];

      const endOffset =
        typeof payload.top_pins_analytics?.end_offset_days === 'number'
          ? payload.top_pins_analytics.end_offset_days
          : typeof requestContext?.end_offset_days === 'number'
          ? requestContext.end_offset_days
          : 2;

      const startOffset =
        typeof payload.top_pins_analytics?.start_offset_days === 'number'
          ? payload.top_pins_analytics.start_offset_days
          : typeof requestContext?.start_offset_days === 'number'
          ? requestContext.start_offset_days
          : 7;

      // Exact R13.3 window fallback order:
      // windowEnd = request_context.end_date OR (today - end_offset) OR today
      // windowStart = request_context.start_date OR (today - start_offset) OR windowEnd
      let windowEnd =
        requestContext?.end_date?.trim() || calcOffsetDate(endOffset) || today;
      let windowStart =
        requestContext?.start_date?.trim() || calcOffsetDate(startOffset) || windowEnd;

      // Enforce windowStart <= windowEnd
      if (windowStart > windowEnd) {
        console.warn('[PinnerETL] Inverted time window detected, swapping start/end', {
          originalStart: windowStart,
          originalEnd: windowEnd,
        });
        const temp = windowStart;
        windowStart = windowEnd;
        windowEnd = temp;
      }

      const normalizedPinsBySort: Record<string, any[]> = {};
      const topPinsEnvelope = payload.top_pins_analytics || (payload.pins ? payload : null);
      const envelopeDateAvailability =
        payload.top_pins_analytics?.date_availability || payload.date_availability || null;

      if (topPinsEnvelope) {
        if (topPinsEnvelope.pins_by_sort_mode && typeof topPinsEnvelope.pins_by_sort_mode === 'object') {
          // Shape A: Legacy structure { pins_by_sort_mode: { SORT: [pins] } }
          for (const [sKey, pList] of Object.entries(topPinsEnvelope.pins_by_sort_mode)) {
            if (Array.isArray(pList)) {
              normalizedPinsBySort[sKey.toUpperCase()] = pList;
            }
          }
        } else if (Array.isArray(topPinsEnvelope.pins)) {
          // Shape B: Make.com raw Pinterest response with sort_by & pins[]
          const rawSort = String(topPinsEnvelope.sort_by || requestContext?.sort_by || 'IMPRESSION').toUpperCase();
          normalizedPinsBySort[rawSort] = topPinsEnvelope.pins;
        } else if (Array.isArray(topPinsEnvelope)) {
          // Shape C: Array of pins directly
          const rawSort = String(requestContext?.sort_by || 'IMPRESSION').toUpperCase();
          normalizedPinsBySort[rawSort] = topPinsEnvelope;
        }
      }

      for (const [sortByRaw, pinsArray] of Object.entries(normalizedPinsBySort)) {
        const sortBy = sortByRaw.toUpperCase() as PinnerSortBy;
        if (!Array.isArray(pinsArray)) continue;

        pinsArray.forEach((pin, index) => {
          const metrics = normalizeMetrics(pin.metrics || pin);
          const dateAvailability = pin.date_availability || envelopeDateAvailability || null;

          const unvalidatedTopPin = {
            workspace_id: workspaceId,
            connection_id: connectionId,
            pin_id: pin.pin_id || pin.id,
            window_start: windowStart,
            window_end: windowEnd,
            title: pin.title || pin.pin_title || null,
            image_url: pin.image_url || pin.media?.images?.['600x']?.url || pin.media?.images?.originals?.url || null,
            destination_url: pin.destination_url || pin.link || null,
            sort_by: sortBy,
            rank_position: index + 1,
            impressions: metrics.impressions,
            engagement: metrics.engagements,
            outbound_clicks: metrics.outbound_clicks,
            pin_clicks: metrics.pin_clicks,
            saves: metrics.saves,
            video_10s_view: metrics.video_10s_view,
            video_mrc_view: metrics.video_mrc_view,
            video_start: metrics.video_start,
            quartile_95_percent_view: metrics.quartile_95_percent_view,
            engagement_rate: metrics.engagement_rate,
            outbound_click_rate: metrics.outbound_click_rate,
            pin_click_rate: metrics.pin_click_rate,
            save_rate: metrics.save_rate,
            video_avg_watch_time: metrics.video_avg_watch_time,
            video_v50_watch_time: metrics.video_v50_watch_time,
            data_status: (typeof pin.data_status === 'string' && ['READY','PROCESSING'].includes(pin.data_status.toUpperCase())) ? pin.data_status.toUpperCase() : 'READY',
            date_availability: dateAvailability,
            pin_metadata: pin.pin_metadata || null,
            raw_metrics: pin.metrics || null,
            raw_pin: pin.raw_pin || pin,
            raw_headers: payload.raw_headers || null,
            recorded_at: nowIso,
          };

          const filteredTopPin = filterRecordByAllowlist(
            unvalidatedTopPin,
            COLUMN_ALLOWLISTS.top_pins_snapshots
          ) as TopPinSnapshot;

          topPinRows.push(filteredTopPin);

          const destUrl = pin.destination_url || pin.link;
          if (destUrl) {
            destinationUrlsToTrack.push({
              destination_url: destUrl,
              period_date: windowEnd.split('T')[0],
              total_impressions: metrics.impressions,
              total_clicks: metrics.outbound_clicks + metrics.pin_clicks,
              total_pins_active: 1,
            });
          }
        });
      }

      // -------------------------------------------------------------------------
      // Derive Workspace Rollups (daily_workspace_metrics)
      // -------------------------------------------------------------------------
      const workspaceDailyMap = new Map<string, any>();

      for (const daily of dailyRows) {
        const dateKey = daily.metric_date;
        const existing = workspaceDailyMap.get(dateKey) || {
          workspace_id: workspaceId,
          metric_date: dateKey,
          total_impressions: 0,
          total_engagements: 0,
          total_saves: 0,
          total_outbound_clicks: 0,
          total_pin_clicks: 0,
          total_profile_visits: 0,
          top_pin_impressions: 0,
          top_pin_outbound_clicks: 0,
          top_pin_saves: 0,
          active_top_pins_count: 0,
          recorded_at: nowIso,
        };

        existing.total_impressions = (existing.total_impressions || 0) + (daily.impressions || 0);
        existing.total_engagements = (existing.total_engagements || 0) + (daily.engagements || 0);
        existing.total_saves = (existing.total_saves || 0) + (daily.saves || 0);
        existing.total_outbound_clicks = (existing.total_outbound_clicks || 0) + (daily.outbound_clicks || 0);
        existing.total_pin_clicks = (existing.total_pin_clicks || 0) + (daily.pin_clicks || 0);

        workspaceDailyMap.set(dateKey, existing);
      }

      // Add top pins aggregates if present
      if (topPinRows.length > 0) {
        const latestDate = windowEnd.split('T')[0];
        const latestWorkspaceMetric = workspaceDailyMap.get(latestDate) || {
          workspace_id: workspaceId,
          metric_date: latestDate,
          total_impressions: 0,
          total_engagements: 0,
          total_saves: 0,
          total_outbound_clicks: 0,
          total_pin_clicks: 0,
          total_profile_visits: 0,
          top_pin_impressions: 0,
          top_pin_outbound_clicks: 0,
          top_pin_saves: 0,
          active_top_pins_count: 0,
          recorded_at: nowIso,
        };

        const impressionTopPins = topPinRows.filter((p) => p.sort_by === 'IMPRESSION');
        latestWorkspaceMetric.active_top_pins_count = impressionTopPins.length;
        latestWorkspaceMetric.top_pin_impressions = impressionTopPins.reduce(
          (acc, p) => acc + (p.impressions || 0),
          0
        );
        latestWorkspaceMetric.top_pin_outbound_clicks = impressionTopPins.reduce(
          (acc, p) => acc + (p.outbound_clicks || 0),
          0
        );
        latestWorkspaceMetric.top_pin_saves = impressionTopPins.reduce(
          (acc, p) => acc + (p.saves || 0),
          0
        );

        workspaceDailyMap.set(latestDate, latestWorkspaceMetric);
      }

      const workspaceRollupRows = Array.from(workspaceDailyMap.values());

      // =========================================================================
      // Persistence Layer (Project 3 Upserts)
      // =========================================================================
      const dailyUpsertCount = await upsertBatch('daily', dailyRows, (r) =>
        analyticsDb.upsertAccountDailyMetrics(workspaceId, connectionId, r)
      );

      if (summaryRow) {
        await analyticsDb.upsertAccountSummary(workspaceId, connectionId, summaryRow);
      }

      const topPinsUpsertCount = await upsertBatch('top_pins', topPinRows, (r) =>
        analyticsDb.upsertTopPinsSnapshots(workspaceId, connectionId, r)
      );

      if (topPinsUpsertCount > 0) {
        // Offload raw JSONB after 7 days to reclaim space
        const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
        const analyticsClient = dbClients.getAnalytics(runtimeEnv);
        await analyticsClient
          .from('top_pins_snapshots')
          .update({
            raw_pin: null,
            raw_headers: null,
            raw_metrics: null,
          })
          .eq('workspace_id', workspaceId)
          .lt('window_end', sevenDaysAgo)
          .then(() => {});
      }

      const rollupsUpsertCount = await upsertBatch('workspace_rollups', workspaceRollupRows, (r) =>
        analyticsDb.upsertDailyWorkspaceMetrics(workspaceId, r)
      );

      if (destinationUrlsToTrack.length > 0) {
        await analyticsDb.upsertUrlPerformance(workspaceId, destinationUrlsToTrack);
      }

      // =========================================================================
      // Operational Ingestion Run Completion in Project 3 (R5.1)
      // =========================================================================
      const totalRowsCount = dailyRows.length + topPinRows.length + (summaryRow ? 1 : 0);
      await analyticsDb.completeIngestionRun(runRecord.id, totalRowsCount);

      // =========================================================================
      // Edge Cache Invalidation & Post-Persistence Warmup
      // =========================================================================
      await edgeCache.invalidateConnection(workspaceId, connectionId, runtimeKvNamespace);
      await analyticsDb.updateConnectionLastSync(connectionId, workspaceId);

      return {
        success: true,
        persisted: true,
        workspaceId,
        connectionId,
        runId: runRecord.id,
        dailyRowsIngested: dailyUpsertCount,
        summarySaved: Boolean(summaryRow),
        topPinsIngested: topPinsUpsertCount,
        workspaceRollupsUpdated: rollupsUpsertCount,
        revoked: false,
        snitchAlerted: false,
      };
    } catch (err: any) {
      // R5.1: Guaranteed run failure update on throw so no runs remain 'processing'
      console.error('[PinnerETL] Fatal error during ingestion pipeline execution:', err);
      try {
        await analyticsDb.failIngestionRun(runRecord.id, {
          message: err.message || 'Internal ETL pipeline error',
          error_code: 'ETL_EXCEPTION',
        });
      } catch (failErr) {
        console.error('[PinnerETL] Failed to record failed run status:', failErr);
      }
      throw err;
    }
  },
};
