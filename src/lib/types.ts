export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface Workspace {
  id: string;
  name: string;
  slug?: string | null;
  created_at: string;
  updated_at: string;
  cron_provider?: 'fastcron' | 'cronjoborg' | string;
  cron_provider_api_key_encrypted?: string | null;
  is_master?: boolean;
}

export interface WorkspaceMembership {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
}

export interface WorkspaceOption {
  id: string;
  name: string;
  slug?: string | null;
  is_default?: boolean;
  is_master?: boolean;
}

export interface AccountWebhook {
  id: string;
  account_id: string;
  label: string;
  webhook_url: string;
  monthly_capacity: number;
  monthly_usage: number;
  remaining_capacity: number;
  executions_used?: number;
  priority: number;
  is_active: boolean;
  is_primary: boolean;
  last_used_at: string | null;
  last_failed_at: string | null;
  last_failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: string;
  workspace_id?: string;
  account_name: string;
  webhook_url?: string;
  max_pins_per_day: number;
  is_active: boolean;
  pinning_started_at?: string | null;
  posting_window_start?: string | null;
  posting_window_end?: string | null;
  posting_interval_minutes?: number | null;
  random_delay_minutes?: number | null;
  timezone?: string;
  created_at: string;
  boards_count?: number;
  webhooks_count?: number;
  active_webhooks_count?: number;
  primary_webhook_label?: string;
  last_published_at?: string | null;
  auto_create_missing_boards?: boolean;
  board_creation_webhook_id?: string | null;
  board_webhook_id?: string | null;
  active_days?: string[] | string;
}

export interface AccountPinStats {
  total: number;
  pending: number;
  posted: number;
  failed: number;
  retrying: number;
  remainingToday: number;
}

export interface AccountWebhookSummary {
  totalWebhooks: number;
  activeWebhooks: number;
  primaryWebhookLabel: string;
  totalRemainingCapacity: number;
}

export interface Board {
  id: string;
  workspace_id?: string;
  account_id: string;
  board_name: string;
  board_id: string;
  created_at: string;
  account_name?: string;
  pinterest_board_id?: string | null;
  created_via?: 'manual' | 'webhook_auto_create' | string;
  created_via_webhook_id?: string | null;
  pin_count?: number | null;
  follower_count?: number | null;
  board_created_at?: string | null;
  board_pins_modified_at?: string | null;
  last_synced_at?: string | null;
}

export interface Pin {
  id: string;
  workspace_id?: string;
  account_id: string;
  title: string;
  description: string | null;
  image_url: string;
  board_name: string | null;
  link: string | null;
  status: 'pending' | 'processing' | 'posted' | 'failed';
  source: string;
  posted_at: string | null;
  scheduled_for?: string | null;
  processing_started_at?: string | null;
  created_at: string;
  account_name?: string;
  retry_count?: number;
  max_retries?: number;
  next_retry_at?: string | null;
  last_failure_reason?: string | null;
  last_attempt_at?: string | null;
  failure_type?: 'transient' | 'permanent' | 'rate_limited' | null;
}

export interface Log {
  id: string;
  workspace_id?: string;
  pin_id: string | null;
  account_id: string | null;
  webhook_id?: string | null;
  status: 'success' | 'error';
  message: string | null;
  webhook_used: string | null;
  created_at: string;
  account_name?: string;
  pin_title?: string;
  webhook_label?: string;
}

export interface PinDeliveryLog {
  id: string;
  pin_id: string;
  attempt_no: number;
  event_type: 'queued' | 'dispatched' | 'published' | 'rate_limited' | 'provider_error' | 'failed' | string;
  provider?: string | null;
  http_status?: number | null;
  error_code?: number | null;
  error_message?: string | null;
  response_excerpt?: string | null;
  metadata?: Record<string, any>;
  created_at: string;
  pin_title?: string;
  account_name?: string;
}

export interface AuditLog {
  id: string;
  table_name: string;
  record_id: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | string;
  old_data: Record<string, any> | null;
  new_data: Record<string, any> | null;
  changed_by: string | null;
  changed_at: string;
}

export interface ImportSession {
  id: string;
  workspace_id?: string;
  account_id: string;
  source_type: 'csv_upload' | 'google_sheets' | string;
  source_label?: string | null;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  imported_rows: number;
  created_by?: string | null;
  created_at: string;
}

export interface DashboardKPIs {
  totalAccounts: number;
  activeAccounts: number;
  pendingPins: number;
  postedPins: number;
  failedPins: number;
  totalLogs: number;
  totalWebhooks: number;
  activeWebhooks: number;
  exhaustedWebhooks: number;
}

export interface Competitor {
  id: string;
  workspace_id?: string;
  user_id?: string;
  username: string;
  full_name?: string | null;
  niche?: string | null;
  profile_reach: number;
  profile_views: number;
  follower_count: number;
  pin_count: number;
  avatar_url?: string | null;
  notes?: string | null;
  last_checked_at?: string | null;
  website_url?: string | null;
  domain_verified?: boolean;
  last_pin_at?: string | null;
  account_type?: 'own' | 'competitor' | string;
  tags?: string[];
  created_at: string;
  boards_count?: number;
  strategy_age_days?: number;
  oldest_board_date?: string | null;
}

export interface CompetitorSnapshot {
  id: string;
  competitor_id: string;
  profile_reach: number;
  profile_views: number;
  follower_count: number;
  pin_count: number;
  recorded_at: string;
}

export interface CompetitorDailySnapshot {
  id: string;
  competitor_id: string;
  snapshot_date: string;
  profile_reach: number;
  profile_views: number;
  follower_count: number;
  pin_count: number;
  created_at: string;
}

export interface CompetitorBoard {
  id: string;
  workspace_id?: string;
  competitor_id: string;
  board_id: string;
  name: string;
  description?: string | null;
  url?: string | null;
  pin_count: number;
  follower_count: number;
  board_created_at?: string | null;
  last_pinned_at?: string | null;
  updated_at: string;
}

export interface CompetitorDeltaStats {
  reachChange: number;
  reachPercent: number;
  viewsChange: number;
  viewsPercent: number;
  followersChange: number;
  followersPercent: number;
  pinsChange: number;
  pinsPercent: number;
}

export type PinterestPayloadType = 'user_profile' | 'user_boards' | 'unknown';

export interface ParsedPinterestPayload {
  type: PinterestPayloadType;
  username?: string;
  profileData?: {
    full_name?: string;
    profile_reach?: number;
    profile_views?: number;
    follower_count?: number;
    pin_count?: number;
    avatar_url?: string;
    about?: string;
    website_url?: string;
    domain_verified?: boolean;
    last_pin_at?: string;
  };
  boardsData?: Array<{
    board_id: string;
    name: string;
    description?: string;
    url?: string;
    pin_count: number;
    follower_count: number;
    board_created_at?: string;
    last_pinned_at?: string;
  }>;
  rawJson?: any;
}

// ==============================================================================
// Pinner Analytics Types (V11/V12 Locked)
// ==============================================================================

export type PinnerSortBy = 'IMPRESSION' | 'OUTBOUND_CLICK' | 'SAVE' | 'ENGAGEMENT' | 'PIN_CLICK';

export type PinnerMetricName =
  | 'ENGAGEMENT'
  | 'ENGAGEMENT_RATE'
  | 'IMPRESSION'
  | 'OUTBOUND_CLICK'
  | 'OUTBOUND_CLICK_RATE'
  | 'PIN_CLICK'
  | 'PIN_CLICK_RATE'
  | 'SAVE'
  | 'SAVE_RATE'
  | 'VIDEO_10S_VIEW'
  | 'VIDEO_AVG_WATCH_TIME'
  | 'VIDEO_MRC_VIEW'
  | 'VIDEO_START'
  | 'VIDEO_V50_WATCH_TIME'
  | 'QUARTILE_95_PERCENT_VIEW';

export interface PinnerRawMetrics {
  ENGAGEMENT?: number;
  ENGAGEMENT_RATE?: number;
  IMPRESSION?: number;
  OUTBOUND_CLICK?: number;
  OUTBOUND_CLICK_RATE?: number;
  PIN_CLICK?: number;
  PIN_CLICK_RATE?: number;
  SAVE?: number;
  SAVE_RATE?: number;
  VIDEO_10S_VIEW?: number;
  VIDEO_AVG_WATCH_TIME?: number;
  VIDEO_MRC_VIEW?: number;
  VIDEO_START?: number;
  VIDEO_V50_WATCH_TIME?: number;
  QUARTILE_95_PERCENT_VIEW?: number;
  [key: string]: any;
}

export interface TopPinSnapshot {
  id: string;
  workspace_id: string;
  connection_id: string;
  window_start: string;
  window_end: string;
  sort_by: PinnerSortBy;
  rank_position: number;
  pin_id: string;
  recorded_at: string;
  impressions: number;
  engagement: number;
  outbound_clicks: number;
  pin_clicks: number;
  saves: number;
  video_10s_view: number;
  video_mrc_view: number;
  video_start: number;
  quartile_95_percent_view: number;
  engagement_rate: number;
  outbound_click_rate: number;
  pin_click_rate: number;
  save_rate: number;
  video_avg_watch_time: number;
  video_v50_watch_time: number;
  data_status: Record<string, string>;
  date_availability?: {
    is_realtime?: boolean;
    latest_available_timestamp?: number;
  } | null;
  title?: string | null;
  destination_url?: string | null;
  image_url?: string | null;
  pin_metadata?: Record<string, any> | null;
  raw_metrics?: Record<string, any> | null;
  raw_pin?: Record<string, any> | null;
  raw_headers?: Record<string, any> | null;
  created_at: string;
}

export interface AccountAnalyticsDaily {
  id: string;
  workspace_id: string;
  connection_id: string;
  window_start: string;
  window_end: string;
  metric_date: string;
  data_status: string;
  impressions: number;
  engagements: number;
  outbound_clicks: number;
  pin_clicks: number;
  saves: number;
  video_10s_view: number;
  video_mrc_view: number;
  video_start: number;
  quartile_95_percent_view: number;
  engagement_rate: number;
  outbound_click_rate: number;
  pin_click_rate: number;
  save_rate: number;
  video_avg_watch_time?: number | null;
  video_v50_watch_time?: number | null;
  profile_visits?: number | null;
  closeups?: number | null;
  raw_metrics?: Record<string, any> | null;
  recorded_at: string;
  created_at: string;
}

export interface AccountAnalyticsSummary {
  id: string;
  workspace_id: string;
  connection_id: string;
  window_start: string;
  window_end: string;
  summary_impressions: number;
  summary_engagements: number;
  summary_outbound_clicks: number;
  summary_pin_clicks: number;
  summary_saves: number;
  summary_video_10s_view: number;
  summary_video_mrc_view: number;
  summary_video_start: number;
  summary_quartile_95_percent_view: number;
  summary_engagement_rate: number;
  summary_outbound_click_rate: number;
  summary_pin_click_rate: number;
  summary_save_rate: number;
  summary_profile_visits?: number | null;
  summary_closeups?: number | null;
  summary_video_avg_watch_time?: number | null;
  summary_video_v50_watch_time?: number | null;
  raw_summary?: Record<string, any> | null;
  recorded_at: string;
  created_at: string;
}

export interface DailyWorkspaceMetric {
  id: string;
  workspace_id: string;
  metric_date: string;
  total_impressions: number;
  total_engagements: number;
  total_saves: number;
  total_outbound_clicks: number;
  total_pin_clicks: number;
  total_profile_visits: number;
  top_pin_impressions: number;
  top_pin_outbound_clicks: number;
  top_pin_saves: number;
  active_top_pins_count: number;
  recorded_at: string;
  created_at: string;
}

export interface PinnerMakeRequestContext {
  start_date?: string;
  end_date?: string;
  start_offset_days?: number;
  end_offset_days?: number;
  sort_modes?: string[] | string;
  sort_by?: string;
  job_type?: string;
  raw_headers?: Record<string, any>;
  [key: string]: any;
}

export interface PinnerErrorDetails {
  http_status?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  failed_module?: string | null;
}

export interface PinnerIngestPayload {
  success: boolean;
  request_id?: string;
  channel?: 'account_analytics' | 'top_pins' | string;
  workspace_id: string;
  connection_id: string;
  request_context?: PinnerMakeRequestContext;
  account_analytics?: any | null;
  top_pins_analytics?: ({
    [key in PinnerSortBy]?: any;
  } & Record<string, any>) | null;
  pins?: any[];
  date_availability?: any;
  raw_headers?: Record<string, any>;
  error_details?: PinnerErrorDetails;
  [key: string]: any;
}

export interface PinnerOverviewKPIs {
  impressions: number;
  engagements: number;
  pinClicks: number;
  outboundClicks: number;
  saves: number;
  engagementRate: number;
  outboundClickRate: number;
  pinClickRate: number;
  saveRate: number;
  activeTopPinsCount: number;
  windowStart: string;
  windowEnd: string;
  lastIngestedAt?: string | null;
  connectionId: string;
  workspaceId: string;
}

// ==============================================================================
// V16 Control Plane & Settings Types (Project 3 Dedicated Ownership)
// ==============================================================================

export interface WorkspaceAnalyticsSettings {
  workspace_id: string;
  fastcron_token?: string | null;
  timezone: string;
  is_sync_enabled: boolean;
  auto_backfill_on_connect: boolean;
  updated_at: string;
}

export interface WorkspaceAnalyticsSettingsResponse {
  fastcron_token_configured: boolean;
  timezone: string;
  is_sync_enabled: boolean;
  auto_backfill_on_connect: boolean;
}

export interface AnalyticsConnection {
  id: string;
  workspace_id: string;
  display_name: string;
  analytics_enabled: boolean;
  deleted_at?: string | null;
  revoked_at?: string | null;
  last_analytics_sync_at?: string | null;

  // Pipeline A: /v5/user_account/analytics
  analytics_webhook_url?: string | null;
  analytics_sync_time: string;
  analytics_cron_expression: string;
  analytics_fastcron_job_id?: number | null;
  analytics_schedule_status: 'synced' | 'pending' | 'error';
  analytics_start_offset_days?: number;
  analytics_end_offset_days?: number;

  // Pipeline B: /v5/user_account/analytics/top_pins
  top_pins_webhook_url?: string | null;
  top_pins_sync_time: string;
  top_pins_cron_expression: string;
  top_pins_fastcron_job_id?: number | null;
  top_pins_schedule_status: 'synced' | 'pending' | 'error';
  top_pins_start_offset_days?: number;
  top_pins_end_offset_days?: number;
  top_pins_num_of_pins?: number;
  top_pins_sort_modes?: string[];

  // FastCron Execution Options (V23 & R16)
  fastcron_token?: string | null;
  fastcron_notify: boolean;
  fastcron_timeout: number;
  fastcron_instances: number;
  analytics_fastcron_token?: string | null;
  top_pins_fastcron_token?: string | null;

  created_at: string;
  updated_at: string;
}

export interface AnalyticsIngestionRun {
  id: string;
  workspace_id: string;
  connection_id: string;
  channel: 'account_analytics' | 'top_pins';
  job_type: 'daily_sync' | 'manual_sync' | 'backfill' | 'ping';
  status: 'processing' | 'completed' | 'failed';
  request_context?: Record<string, any> | null;
  rows_processed: number;
  error_details?: Record<string, any> | null;
  started_at: string;
  completed_at?: string | null;
}

export interface AnalyticsRunsResponse {
  success: boolean;
  data: AnalyticsIngestionRun[];
  error?: string;
}

export interface AnalyticsConnectionSettingsResponse {
  id: string;
  display_name: string;
  revoked_at?: string | null;
  analytics_webhook_url: string | null;
  analytics_sync_time: string;
  analytics_cron_expression: string;
  analytics_schedule_status: 'synced' | 'pending' | 'error';
  analytics_start_offset_days?: number;
  analytics_end_offset_days?: number;
  top_pins_webhook_url: string | null;
  top_pins_sync_time: string;
  top_pins_cron_expression: string;
  top_pins_schedule_status: 'synced' | 'pending' | 'error';
  top_pins_start_offset_days?: number;
  top_pins_end_offset_days?: number;
  top_pins_num_of_pins?: number;
  top_pins_sort_modes?: string[];
  has_fastcron_token?: boolean;
  has_analytics_fastcron_token?: boolean;
  has_top_pins_fastcron_token?: boolean;
  fastcron_notify?: boolean;
  fastcron_timeout?: number;
  fastcron_instances?: number;
  token_fingerprint?: string | null;
  analytics_token_fingerprint?: string | null;
  top_pins_token_fingerprint?: string | null;
  analytics_fastcron_token_fingerprint?: string | null;
  top_pins_fastcron_token_fingerprint?: string | null;
  last_analytics_sync_at?: string | null;
  last_error_a?: string | null;
  last_error_b?: string | null;
  health?: {
    total_runs: number;
    consecutive_failures: number;
    last_success_at: string | null;
    revoked?: boolean;
  } | null;
}

export type PinnerConnection = AnalyticsConnection;

export interface PinnerConnectionInput {
  display_name: string;
  analytics_enabled?: boolean;
}

export interface ScheduleSyncRequest {
  connection_id: string;
  channel: 'analytics' | 'top_pins';
}

export interface ScheduleSyncResponse {
  success: boolean;
  connection_id: string;
  channel: 'analytics' | 'top_pins';
  schedule_status: 'synced' | 'error';
  fastcron_job_id?: number | null;
  message?: string;
  error?: string;
}

export interface TriggerSyncRequest {
  connection_id: string;
  channel: 'analytics' | 'top_pins';
  mode: 'ping' | 'sync';
}

export interface TriggerSyncResponse {
  success: boolean;
  message?: string;
  fastcron_job_id?: number | null;
  mode?: 'ping' | 'sync';
  error?: string;
  connection_id?: string;
  channel?: 'analytics' | 'top_pins';
  webhookResponseStatus?: number;
  startDate?: string;
  endDate?: string;
}

export interface PinLeaderboardItem {
  pin_id: string;
  title: string | null;
  image_url?: string | null;
  destination_url?: string | null;
  appearances: number;
  best_rank: number;
  total_impressions: number;
  total_engagements: number;
  total_saves: number;
  total_outbound_clicks: number;
  total_pin_clicks: number;
  last_seen: string;
  prev_rank?: number | null;
  trend: string;
  // V36 additive pooled rates
  engagement_rate?: number;
  outbound_click_rate?: number;
  pin_click_rate?: number;
  save_rate?: number;
}

export type PinLeaderboardSortField =
  | 'appearances'
  | 'best_rank'
  | 'total_impressions'
  | 'total_saves'
  | 'last_seen'
  | 'total_engagements'
  | 'total_outbound_clicks'
  | 'total_pin_clicks';

export type PinLeaderboardTrendFilter = 'ALL' | 'NEW' | 'RISING' | 'FALLING';

export interface PinLeaderboardOptions {
  page?: number;
  page_size?: number;
  sort?: PinLeaderboardSortField | string;
  sort_dir?: 'asc' | 'desc';
  min_impressions?: number;
  min_appearances?: number;
  trend?: PinLeaderboardTrendFilter | string;
  has_link?: boolean | null;
}

export interface PinLeaderboardResult {
  items: PinLeaderboardItem[];
  total_unique: number;
  page: number;
  page_size: number;
}

export interface PinTrendPoint {
  window_end: string;
  rank_position: number;
  impressions: number;
  engagements: number;
  saves: number;
  engagement_rate: number;
  outbound_clicks: number;
  pin_clicks: number;
  outbound_click_rate?: number;
  pin_click_rate?: number;
  save_rate?: number;
  title?: string | null;
  image_url?: string | null;
  destination_url?: string | null;
}

export type PurgeTarget = 'daily' | 'top_pins';

export interface PurgePreviewCounts {
  daily_count: number;
  summaries_count: number;
  top_pins_count: number;
  url_perf_count: number;
  affected_rollup_dates: string[];
  total_records: number;
}

export interface PurgeResultCounts {
  daily_deleted: number;
  summaries_deleted: number;
  rollups_rebuilt: number;
  top_pins_deleted: number;
  url_perf_deleted: number;
  url_perf_rebuilt?: number;
}

export interface PurgeResponse {
  success: boolean;
  purge_log_id?: string;
  counts?: PurgeResultCounts;
  error?: string;
}

