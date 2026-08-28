import { supabase, isSupabaseConfigured } from './supabase';
import type {
  Competitor,
  CompetitorSnapshot,
  CompetitorBoard,
  CompetitorDeltaStats,
  CompetitorDailySnapshot,
  ParsedPinterestPayload,
  PinterestPayloadType,
} from './types';

// Mock Data for Preview / Unconfigured Mode
let mockCompetitors: Competitor[] = [
  {
    id: 'comp-1',
    username: 'tastyrecipes',
    full_name: 'Tasty Recipes & Food Ideas',
    niche: 'Food & Cooking',
    profile_reach: 4500000,
    profile_views: 1200000,
    follower_count: 320000,
    pin_count: 8450,
    avatar_url: 'https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&w=200&h=200&q=80',
    notes: 'Primary competitor in budget meal prep and quick dinner ideas.',
    last_checked_at: new Date(Date.now() - 3600000 * 5).toISOString(),
    created_at: new Date(Date.now() - 86400000 * 30).toISOString(),
    boards_count: 18,
    strategy_age_days: 1420,
    oldest_board_date: new Date(Date.now() - 86400000 * 1420).toISOString(),
  },
  {
    id: 'comp-2',
    username: 'ketodietmaster',
    full_name: 'Keto Diet & Low Carb Living',
    niche: 'Health & Fitness',
    profile_reach: 2100000,
    profile_views: 680000,
    follower_count: 145000,
    pin_count: 4200,
    avatar_url: 'https://images.unsplash.com/photo-1498837167922-ddd27525d352?auto=format&fit=crop&w=200&h=200&q=80',
    notes: 'High engagement on meal plan infographics.',
    last_checked_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    created_at: new Date(Date.now() - 86400000 * 45).toISOString(),
    boards_count: 12,
    strategy_age_days: 890,
    oldest_board_date: new Date(Date.now() - 86400000 * 890).toISOString(),
  },
  {
    id: 'comp-3',
    username: 'healthyhomekitchen',
    full_name: 'Healthy Home Kitchen',
    niche: 'Food & Wellness',
    profile_reach: 890000,
    profile_views: 240000,
    follower_count: 68000,
    pin_count: 2100,
    avatar_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&h=200&q=80',
    notes: 'Fast growing competitor focused on air fryer recipes.',
    last_checked_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    created_at: new Date(Date.now() - 86400000 * 15).toISOString(),
    boards_count: 9,
    strategy_age_days: 430,
    oldest_board_date: new Date(Date.now() - 86400000 * 430).toISOString(),
  },
];

let mockSnapshots: Record<string, CompetitorSnapshot[]> = {
  'comp-1': [
    {
      id: 'snap-1-prev',
      competitor_id: 'comp-1',
      profile_reach: 4100000,
      profile_views: 1100000,
      follower_count: 312000,
      pin_count: 8200,
      recorded_at: new Date(Date.now() - 86400000 * 7).toISOString(),
    },
    {
      id: 'snap-1-curr',
      competitor_id: 'comp-1',
      profile_reach: 4500000,
      profile_views: 1200000,
      follower_count: 320000,
      pin_count: 8450,
      recorded_at: new Date(Date.now() - 3600000 * 5).toISOString(),
    },
  ],
  'comp-2': [
    {
      id: 'snap-2-prev',
      competitor_id: 'comp-2',
      profile_reach: 1950000,
      profile_views: 620000,
      follower_count: 140000,
      pin_count: 4050,
      recorded_at: new Date(Date.now() - 86400000 * 7).toISOString(),
    },
    {
      id: 'snap-2-curr',
      competitor_id: 'comp-2',
      profile_reach: 2100000,
      profile_views: 680000,
      follower_count: 145000,
      pin_count: 4200,
      recorded_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    },
  ],
};

let mockBoards: Record<string, CompetitorBoard[]> = {
  'comp-1': [
    {
      id: 'board-1-1',
      competitor_id: 'comp-1',
      board_id: '109283741',
      name: 'Easy 30-Minute Dinners',
      description: 'Quick and tasty dinner recipes for busy weeknights. Simple ingredients and step-by-step guides.',
      url: '/tastyrecipes/easy-30-minute-dinners/',
      pin_count: 1840,
      follower_count: 45200,
      board_created_at: '2022-09-15T10:00:00Z',
      last_pinned_at: new Date(Date.now() - 3600000 * 2).toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'board-1-2',
      competitor_id: 'comp-1',
      board_id: '109283742',
      name: 'High Protein Meal Prep Ideas',
      description: 'Healthy Sunday meal prep ideas to stay on track all week. Macro friendly and delicious.',
      url: '/tastyrecipes/high-protein-meal-prep/',
      pin_count: 2410,
      follower_count: 89100,
      board_created_at: '2021-03-20T14:30:00Z',
      last_pinned_at: new Date(Date.now() - 3600000 * 6).toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'board-1-3',
      competitor_id: 'comp-1',
      board_id: '109283743',
      name: 'Air Fryer Magic',
      description: 'Crispy, healthy air fryer recipes for veggies, chicken wings, and desserts.',
      url: '/tastyrecipes/air-fryer-magic/',
      pin_count: 980,
      follower_count: 28400,
      board_created_at: '2023-01-10T09:15:00Z',
      last_pinned_at: new Date(Date.now() - 86400000 * 2).toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'board-1-4',
      competitor_id: 'comp-1',
      board_id: '109283744',
      name: 'Budget Comfort Food Foundation',
      description: 'Our foundational board created when launching the account.',
      url: '/tastyrecipes/budget-comfort-food/',
      pin_count: 3220,
      follower_count: 112000,
      board_created_at: '2020-05-01T12:00:00Z',
      last_pinned_at: new Date(Date.now() - 86400000 * 10).toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
  'comp-2': [
    {
      id: 'board-2-1',
      competitor_id: 'comp-2',
      board_id: '209283741',
      name: 'Strict Keto Dinners',
      description: 'Low carb high fat recipes for weight loss and energy.',
      url: '/ketodietmaster/strict-keto-dinners/',
      pin_count: 1200,
      follower_count: 34000,
      board_created_at: '2022-02-14T08:00:00Z',
      last_pinned_at: new Date(Date.now() - 3600000 * 18).toISOString(),
      updated_at: new Date().toISOString(),
    },
  ],
};

/**
 * Parses raw Pinterest JSON payloads (UserResource or BoardsResource).
 * Supports DevTools network dump payloads, direct API response objects, or custom JSON structures.
 */
export function parsePinterestPayload(input: string | object): ParsedPinterestPayload {
  let jsonObj: any;

  if (typeof input === 'string') {
    try {
      jsonObj = JSON.parse(input.trim());
    } catch (e) {
      return { type: 'unknown' };
    }
  } else {
    jsonObj = input;
  }

  if (!jsonObj || typeof jsonObj !== 'object') {
    return { type: 'unknown' };
  }

  // Extract primary payload container
  const endpointName = jsonObj.endpoint_name || jsonObj.resource?.name || jsonObj.resource_name || '';
  const resourceResponse = jsonObj.resource_response || jsonObj.response || jsonObj;
  const data = resourceResponse.data || jsonObj.data || jsonObj;

  // 1. Detect User Profile Endpoint (UserResource / v3_get_user_handler)
  const isUserEndpointName =
    endpointName === 'v3_get_user_handler' ||
    endpointName === 'UserResource' ||
    endpointName.includes('UserResource');

  const hasUserProfileFields =
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data.profile_reach !== undefined ||
      data.profile_views !== undefined ||
      data.follower_count !== undefined ||
      data.type === 'user' ||
      (data.username && (data.pin_count !== undefined || data.first_name || data.full_name)));

  if (isUserEndpointName || hasUserProfileFields) {
    const rawReach = data.profile_reach ?? data.profile_views ?? data.monthly_views ?? 0;
    const rawViews = data.profile_views ?? data.monthly_views ?? data.profile_reach ?? 0;
    const avatarUrl =
      data.image_large_url ||
      data.image_medium_url ||
      data.image_xlarge_url ||
      data.avatar_url ||
      data.image_small_url ||
      null;

    const fullName =
      data.full_name ||
      (data.first_name ? `${data.first_name} ${data.last_name || ''}`.trim() : null) ||
      data.username ||
      '';

    const websiteUrl = data.website_url || (data.domain_url ? `https://${data.domain_url}` : undefined);
    const domainVerified = !!data.domain_verified;
    const lastPinAt = data.last_pin_save_time ? new Date(data.last_pin_save_time).toISOString() : undefined;

    return {
      type: 'user_profile',
      username: data.username || '',
      profileData: {
        full_name: fullName,
        profile_reach: typeof rawReach === 'string' ? parseInt(rawReach, 10) || 0 : Number(rawReach) || 0,
        profile_views: typeof rawViews === 'string' ? parseInt(rawViews, 10) || 0 : Number(rawViews) || 0,
        follower_count: Number(data.follower_count) || 0,
        pin_count: Number(data.pin_count) || 0,
        avatar_url: avatarUrl,
        about: data.about || data.bio || '',
        website_url: websiteUrl,
        domain_verified: domainVerified,
        last_pin_at: lastPinAt,
      },
      rawJson: jsonObj,
    };
  }

  // 2. Detect User Boards Endpoint (BoardsResource / v3_user_profile_boards_feed)
  const isBoardEndpointName =
    endpointName === 'v3_user_profile_boards_feed' ||
    endpointName === 'BoardsResource' ||
    endpointName.includes('BoardsResource');

  const isBoardDataArray = Array.isArray(data) && data.some((item) => item.type === 'board' || item.node_id || item.board_order_modified_at);

  if (isBoardEndpointName || isBoardDataArray) {
    const items = Array.isArray(data) ? data : data.items || [];
    const boardsData: ParsedPinterestPayload['boardsData'] = [];

    for (const item of items) {
      if (item && (item.type === 'board' || item.id || item.node_id)) {
        const boardId = String(item.id || item.node_id || item.board_id || '');
        const name = item.name || 'Untitled Board';
        const description = item.description || item.about || '';
        const url = item.url || '';
        const pinCount = Number(item.pin_count) || 0;
        const followerCount = Number(item.follower_count) || 0;
        const boardCreatedAt = item.created_at || item.board_created_at || null;
        const lastPinnedAt = item.board_order_modified_at || item.last_pinned_at || item.updated_at || null;

        const safeIsoDate = (val: any): string | undefined => {
          if (!val) return undefined;
          const d = new Date(val);
          return isNaN(d.getTime()) ? undefined : d.toISOString();
        };

        boardsData.push({
          board_id: boardId,
          name,
          description,
          url,
          pin_count: pinCount,
          follower_count: followerCount,
          board_created_at: safeIsoDate(boardCreatedAt),
          last_pinned_at: safeIsoDate(lastPinnedAt),
        });
      }
    }

    const usernameFromContext = jsonObj.options?.username || jsonObj.resource?.options?.username || '';

    return {
      type: 'user_boards',
      username: usernameFromContext,
      boardsData,
      rawJson: jsonObj,
    };
  }

  return { type: 'unknown' };
}

/**
 * Calculates growth metrics and percentage deltas between current and snapshot values.
 */
export function calculateCompetitorDeltas(
  current: { profile_reach: number; profile_views: number; follower_count: number; pin_count: number },
  previous?: { profile_reach: number; profile_views: number; follower_count: number; pin_count: number }
): CompetitorDeltaStats {
  if (!previous) {
    return {
      reachChange: 0,
      reachPercent: 0,
      viewsChange: 0,
      viewsPercent: 0,
      followersChange: 0,
      followersPercent: 0,
      pinsChange: 0,
      pinsPercent: 0,
    };
  }

  const reachChange = current.profile_reach - previous.profile_reach;
  const reachPercent = previous.profile_reach > 0 ? (reachChange / previous.profile_reach) * 100 : 0;

  const viewsChange = current.profile_views - previous.profile_views;
  const viewsPercent = previous.profile_views > 0 ? (viewsChange / previous.profile_views) * 100 : 0;

  const followersChange = current.follower_count - previous.follower_count;
  const followersPercent = previous.follower_count > 0 ? (followersChange / previous.follower_count) * 100 : 0;

  const pinsChange = current.pin_count - previous.pin_count;
  const pinsPercent = previous.pin_count > 0 ? (pinsChange / previous.pin_count) * 100 : 0;

  return {
    reachChange,
    reachPercent: Math.round(reachPercent * 10) / 10,
    viewsChange,
    viewsPercent: Math.round(viewsPercent * 10) / 10,
    followersChange,
    followersPercent: Math.round(followersPercent * 10) / 10,
    pinsChange,
    pinsPercent: Math.round(pinsPercent * 10) / 10,
  };
}

/**
 * Finds the oldest board created date and calculates account strategy age in days.
 */
export function calculateStrategyAge(boards: Array<{ created_at?: string | null; board_created_at?: string | null; last_pinned_at?: string | null }>): {
  label: string;
  days: number;
  oldestBoardDate: string | null;
} {
  if (!boards || boards.length === 0) {
    return { label: 'Unknown', days: 0, oldestBoardDate: null };
  }

  const dates = boards
    .map(b => b.board_created_at || b.created_at || b.last_pinned_at)
    .filter((d): d is string => !!d)
    .map(d => new Date(d).getTime())
    .filter(t => !isNaN(t));

  if (dates.length === 0) {
    return { label: 'Unknown', days: 0, oldestBoardDate: null };
  }

  const oldestTimestamp = Math.min(...dates);
  const oldestDate = new Date(oldestTimestamp);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - oldestTimestamp);
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return { label: 'Active today', days: 0, oldestBoardDate: oldestDate.toISOString() };
  }

  return {
    label: `${diffDays}d active`,
    days: diffDays,
    oldestBoardDate: oldestDate.toISOString()
  };
}

const DEFAULT_WS_ID = '00000000-0000-0000-0000-000000000001';

function matchesWorkspace(entityWsId?: string, targetWsId?: string): boolean {
  if (!targetWsId) return true;
  const actualWs = entityWsId || DEFAULT_WS_ID;
  return actualWs === targetWsId;
}

/**
 * Fetch all tracked competitors for a workspace.
 */
export async function getCompetitors(workspaceId?: string): Promise<Competitor[]> {
  if (!isSupabaseConfigured || !supabase) {
    return workspaceId
      ? mockCompetitors.filter((c) => matchesWorkspace(c.workspace_id, workspaceId))
      : [...mockCompetitors];
  }

  try {
    let query = supabase
      .from('competitors')
      .select('*')
      .order('created_at', { ascending: false });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    const { data: competitors, error } = await query;

    if (error || !competitors || competitors.length === 0) {
      if (error) console.warn('Supabase competitors query failed, falling back to mock state:', error);
      return workspaceId
        ? mockCompetitors.filter((c) => matchesWorkspace(c.workspace_id, workspaceId))
        : [...mockCompetitors];
    }

    // Attach board count & strategy age scoped to workspace competitors
    const competitorIds = competitors.map((c) => c.id);
    let boards: Array<{ competitor_id: string; board_created_at: string | null }> = [];
    if (competitorIds.length > 0) {
      const { data: bData } = await supabase
        .from('competitor_boards')
        .select('competitor_id, board_created_at')
        .in('competitor_id', competitorIds);
      boards = (bData as any) || [];
    }

    const result: Competitor[] = competitors.map((c) => {
      const compBoards = boards.filter((b) => b.competitor_id === c.id);
      const boardsCount = compBoards.length;
      const { days: strategyAgeDays, oldestBoardDate } = calculateStrategyAge(compBoards as any);

      return {
        ...c,
        profile_reach: Number(c.profile_reach) || 0,
        profile_views: Number(c.profile_views) || 0,
        boards_count: boardsCount,
        strategy_age_days: strategyAgeDays,
        oldest_board_date: oldestBoardDate,
      };
    });

    return result;
  } catch (err) {
    console.error('Error fetching competitors:', err);
    return workspaceId
      ? mockCompetitors.filter((c) => !c.workspace_id || c.workspace_id === workspaceId)
      : [...mockCompetitors];
  }
}

/**
 * Fetch detailed information for a single competitor including snapshots and boards.
 */
export async function getCompetitorDetails(competitorId: string): Promise<{
  competitor: Competitor | null;
  snapshots: CompetitorSnapshot[];
  boards: CompetitorBoard[];
  deltas: CompetitorDeltaStats;
}> {
  if (!isSupabaseConfigured || !supabase) {
    const competitor = mockCompetitors.find((c) => c.id === competitorId) || null;
    const snapshots = mockSnapshots[competitorId] || [];
    const boards = mockBoards[competitorId] || [];

    const prevSnap = snapshots.length > 1 ? snapshots[snapshots.length - 2] : undefined;
    const deltas = competitor ? calculateCompetitorDeltas(competitor, prevSnap) : calculateCompetitorDeltas({ profile_reach: 0, profile_views: 0, follower_count: 0, pin_count: 0 });

    if (competitor) {
      const { days: strategyAgeDays, oldestBoardDate } = calculateStrategyAge(boards);
      competitor.strategy_age_days = strategyAgeDays;
      competitor.oldest_board_date = oldestBoardDate;
      competitor.boards_count = boards.length;
    }

    return { competitor, snapshots, boards, deltas };
  }

  try {
    // Fetch competitor profile, raw snapshots (for history log), and boards in parallel.
    // Daily rollup is fetched separately so we can apply the fallback logic cleanly.
    const [compRes, rawSnapRes, boardRes, dailySnapRes] = await Promise.all([
      supabase.from('competitors').select('*').eq('id', competitorId).single(),
      // Raw snapshots — always fetched; used for the intraday history log table (recorded_at DESC)
      supabase
        .from('competitor_snapshots')
        .select('*')
        .eq('competitor_id', competitorId)
        .order('recorded_at', { ascending: false })
        .limit(60),
      supabase
        .from('competitor_boards')
        .select('*')
        .eq('competitor_id', competitorId)
        .order('last_pinned_at', { ascending: false }),
      // Daily rollup — primary source for growth chart and trend indicators
      supabase
        .from('competitor_daily_snapshots')
        .select('*')
        .eq('competitor_id', competitorId)
        .order('snapshot_date', { ascending: true }),
    ]);

    const competitor = compRes.data as Competitor | null;
    const rawSnapshots = (rawSnapRes.data || []) as CompetitorSnapshot[];
    const boards = (boardRes.data || []) as CompetitorBoard[];
    const dailyRows = (dailySnapRes.data || []) as CompetitorDailySnapshot[];

    if (competitor) {
      competitor.profile_reach = Number(competitor.profile_reach) || 0;
      competitor.profile_views = Number(competitor.profile_views) || 0;
      const { days: strategyAgeDays, oldestBoardDate } = calculateStrategyAge(boards);
      competitor.strategy_age_days = strategyAgeDays;
      competitor.oldest_board_date = oldestBoardDate;
      competitor.boards_count = boards.length;
    }

    // --- Chart data strategy ---
    // Primary: competitor_daily_snapshots (one canonical row per day, ordered ASC)
    // Fallback: competitor_snapshots grouped ascending (when daily table is empty)
    let chartSnapshots: CompetitorSnapshot[];

    if (dailyRows.length > 0) {
      // Normalise daily rows into CompetitorSnapshot shape so chart rendering requires no changes
      chartSnapshots = dailyRows.map((d) => ({
        id: d.id,
        competitor_id: d.competitor_id,
        profile_reach: Number(d.profile_reach) || 0,
        profile_views: Number(d.profile_views) || 0,
        follower_count: Number(d.follower_count) || 0,
        pin_count: Number(d.pin_count) || 0,
        // Map snapshot_date (DATE) to recorded_at (TIMESTAMPTZ) expected by chart logic
        recorded_at: d.snapshot_date + 'T00:00:00.000Z',
      }));
    } else {
      // Fallback: use raw snapshots in chronological order for chart rendering
      chartSnapshots = [...rawSnapshots].sort(
        (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
      );
    }

    // Deltas are computed from chart snapshots (most recent two data points)
    const prevSnap =
      chartSnapshots.length > 1 ? chartSnapshots[chartSnapshots.length - 2] : undefined;
    const deltas = competitor
      ? calculateCompetitorDeltas(competitor, prevSnap)
      : calculateCompetitorDeltas({
          profile_reach: 0,
          profile_views: 0,
          follower_count: 0,
          pin_count: 0,
        });

    // Return:
    //   snapshots → chart data (daily rollup primary, raw fallback)
    //   rawSnapshots are not in the return shape but the page's history log
    //   table already re-fetches them via renderSnapshotsLogTable() which reads
    //   from snapshotsList (populated from this same snapshots field).
    //   To keep the raw history log working correctly we return raw snapshots
    //   DESC so the table renders newest-first.
    return {
      competitor,
      snapshots: rawSnapshots, // raw snapshots (DESC) for history log table
      boards,
      deltas,
      // Expose chart data separately via the extended shape below
      chartSnapshots,
    } as {
      competitor: Competitor | null;
      snapshots: CompetitorSnapshot[];
      boards: CompetitorBoard[];
      deltas: CompetitorDeltaStats;
      chartSnapshots: CompetitorSnapshot[];
    };
  } catch (err) {
    console.error('Error fetching competitor details:', err);
    return {
      competitor: null,
      snapshots: [],
      boards: [],
      deltas: calculateCompetitorDeltas({
        profile_reach: 0,
        profile_views: 0,
        follower_count: 0,
        pin_count: 0,
      }),
      chartSnapshots: [],
    } as {
      competitor: Competitor | null;
      snapshots: CompetitorSnapshot[];
      boards: CompetitorBoard[];
      deltas: CompetitorDeltaStats;
      chartSnapshots: CompetitorSnapshot[];
    };
  }
}

/**
 * Add a new competitor.
 */
export async function addCompetitor(data: {
  username: string;
  niche?: string;
  notes?: string;
  account_type?: 'own' | 'competitor' | string;
  tags?: string[] | string;
  workspace_id?: string;
}): Promise<Competitor> {
  const cleanUsername = data.username.trim().replace(/^@/, '').toLowerCase();
  const accountType = data.account_type || 'competitor';
  const targetWsId = data.workspace_id || '00000000-0000-0000-0000-000000000001';
  const tagsArr = Array.isArray(data.tags)
    ? data.tags
    : typeof data.tags === 'string'
      ? data.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : [];

  if (!isSupabaseConfigured || !supabase) {
    const newComp: Competitor = {
      id: `comp-${Date.now()}`,
      workspace_id: targetWsId,
      username: cleanUsername,
      full_name: cleanUsername.charAt(0).toUpperCase() + cleanUsername.slice(1),
      niche: data.niche || 'General',
      profile_reach: 0,
      profile_views: 0,
      follower_count: 0,
      pin_count: 0,
      avatar_url: `https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&h=200&q=80`,
      notes: data.notes || '',
      account_type: accountType,
      tags: tagsArr,
      last_checked_at: null,
      created_at: new Date().toISOString(),
      boards_count: 0,
      strategy_age_days: 0,
      oldest_board_date: null,
    };

    mockCompetitors.unshift(newComp);
    return newComp;
  }

  const { data: user } = await supabase.auth.getUser();
  const userId = user?.user?.id || null;

  const { data: created, error } = await supabase
    .from('competitors')
    .insert([
      {
        workspace_id: targetWsId,
        user_id: userId,
        username: cleanUsername,
        full_name: cleanUsername,
        niche: data.niche || 'General',
        notes: data.notes || '',
        account_type: accountType,
        tags: tagsArr,
      },
    ])
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return created;
}

/**
 * Update an existing competitor's profile metadata.
 */
export async function updateCompetitor(
  id: string,
  data: {
    full_name?: string;
    username?: string;
    account_type?: string;
    niche?: string;
    tags?: string[];
  }
): Promise<Competitor> {
  if (!isSupabaseConfigured || !supabase) {
    const idx = mockCompetitors.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error('Competitor not found');
    mockCompetitors[idx] = { ...mockCompetitors[idx], ...data };
    return { ...mockCompetitors[idx] };
  }

  const tagsArr = Array.isArray(data.tags) ? data.tags : data.tags ? (data.tags as any as string).split(',').map((t: string) => t.trim()).filter(Boolean) : undefined;

  const updatePayload: Record<string, any> = {};
  if (data.full_name !== undefined) updatePayload.full_name = data.full_name;
  if (data.username !== undefined) updatePayload.username = data.username.trim().replace(/^@/, '').toLowerCase();
  if (data.account_type !== undefined) updatePayload.account_type = data.account_type;
  if (data.niche !== undefined) updatePayload.niche = data.niche;
  if (tagsArr !== undefined) updatePayload.tags = tagsArr;

  const { error: updateErr } = await supabase
    .from('competitors')
    .update(updatePayload)
    .eq('id', id);

  if (updateErr) throw new Error(updateErr.message);

  const { data: updated, error: fetchErr } = await supabase
    .from('competitors')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !updated) throw new Error(fetchErr?.message || 'Failed to fetch updated competitor');

  return updated as Competitor;
}

/**
 * Delete a competitor.
 */
export async function deleteCompetitor(id: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) {
    mockCompetitors = mockCompetitors.filter((c) => c.id !== id);
    delete mockSnapshots[id];
    delete mockBoards[id];
    return true;
  }

  const { error } = await supabase.from('competitors').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return true;
}

/**
 * Delete an individual competitor snapshot record.
 */
export async function deleteCompetitorSnapshot(snapshotId: string, competitorId?: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) {
    if (competitorId && mockSnapshots[competitorId]) {
      mockSnapshots[competitorId] = mockSnapshots[competitorId].filter((s) => s.id !== snapshotId);
    }
    return true;
  }

  const { error } = await supabase.from('competitor_snapshots').delete().eq('id', snapshotId);
  if (error) throw new Error(error.message);
  return true;
}


/**
 * Ingest DevTools JSON payload for a target competitor.
 */
export async function ingestDevToolsPayload(
  competitorId: string,
  payloadText: string
): Promise<{ success: boolean; type: PinterestPayloadType; message: string }> {
  const parsed = parsePinterestPayload(payloadText);

  if (parsed.type === 'unknown') {
    return {
      success: false,
      type: 'unknown',
      message: 'Unrecognized Pinterest JSON payload. Please check raw network response in DevTools.',
    };
  }

  if (!isSupabaseConfigured || !supabase) {
    const comp = mockCompetitors.find((c) => c.id === competitorId);
    if (!comp) return { success: false, type: parsed.type, message: 'Competitor not found' };

    if (parsed.type === 'user_profile' && parsed.profileData) {
      comp.full_name = parsed.profileData.full_name || comp.full_name;
      comp.profile_reach = parsed.profileData.profile_reach ?? comp.profile_reach;
      comp.profile_views = parsed.profileData.profile_views ?? comp.profile_views;
      comp.follower_count = parsed.profileData.follower_count ?? comp.follower_count;
      comp.pin_count = parsed.profileData.pin_count ?? comp.pin_count;
      if (parsed.profileData.avatar_url) comp.avatar_url = parsed.profileData.avatar_url;
      comp.last_checked_at = new Date().toISOString();

      if (!mockSnapshots[competitorId]) mockSnapshots[competitorId] = [];
      mockSnapshots[competitorId].push({
        id: `snap-${Date.now()}`,
        competitor_id: competitorId,
        profile_reach: comp.profile_reach,
        profile_views: comp.profile_views,
        follower_count: comp.follower_count,
        pin_count: comp.pin_count,
        recorded_at: new Date().toISOString(),
      });

      return {
        success: true,
        type: 'user_profile',
        message: `Successfully parsed User Profile! Updated reach (${comp.profile_reach.toLocaleString()}), views, and follower count.`,
      };
    }

    if (parsed.type === 'user_boards' && parsed.boardsData) {
      if (!mockBoards[competitorId]) mockBoards[competitorId] = [];
      for (const b of parsed.boardsData) {
        const existingIdx = mockBoards[competitorId].findIndex((eb) => eb.board_id === b.board_id);
        const boardObj: CompetitorBoard = {
          id: existingIdx >= 0 ? mockBoards[competitorId][existingIdx].id : `board-${Date.now()}-${Math.random()}`,
          competitor_id: competitorId,
          board_id: b.board_id,
          name: b.name,
          description: b.description || '',
          url: b.url || '',
          pin_count: b.pin_count,
          follower_count: b.follower_count,
          board_created_at: b.board_created_at || new Date().toISOString(),
          last_pinned_at: b.last_pinned_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        if (existingIdx >= 0) {
          mockBoards[competitorId][existingIdx] = boardObj;
        } else {
          mockBoards[competitorId].push(boardObj);
        }
      }

      const { days: strategyAgeDays, oldestBoardDate } = calculateStrategyAge(mockBoards[competitorId]);
      comp.strategy_age_days = strategyAgeDays;
      comp.oldest_board_date = oldestBoardDate;
      comp.boards_count = mockBoards[competitorId].length;

      return {
        success: true,
        type: 'user_boards',
        message: `Successfully parsed ${parsed.boardsData.length} boards! Updated board strategy and creation dates.`,
      };
    }
  }

  // Supabase implementation
  try {
    if (parsed.type === 'user_profile' && parsed.profileData) {
      const { full_name, profile_reach, profile_views, follower_count, pin_count, avatar_url, website_url, domain_verified, last_pin_at } = parsed.profileData;

      // Update competitors table
      const { error: updateErr } = await supabase
        .from('competitors')
        .update({
          full_name,
          profile_reach,
          profile_views,
          follower_count,
          pin_count,
          ...(avatar_url ? { avatar_url } : {}),
          ...(website_url !== undefined ? { website_url } : {}),
          ...(domain_verified !== undefined ? { domain_verified } : {}),
          ...(last_pin_at !== undefined ? { last_pin_at } : {}),
          last_checked_at: new Date().toISOString(),
        })
        .eq('id', competitorId);

      if (updateErr) throw new Error(updateErr.message);

      // Insert snapshot record
      await supabase.from('competitor_snapshots').insert([
        {
          competitor_id: competitorId,
          profile_reach,
          profile_views,
          follower_count,
          pin_count,
        },
      ]);

      return {
        success: true,
        type: 'user_profile',
        message: `Successfully parsed & saved User Profile data for competitor!`,
      };
    }

    if (parsed.type === 'user_boards' && parsed.boardsData) {
      for (const b of parsed.boardsData) {
        await supabase.from('competitor_boards').upsert(
          [
            {
              competitor_id: competitorId,
              board_id: b.board_id,
              name: b.name,
              description: b.description,
              url: b.url,
              pin_count: b.pin_count,
              follower_count: b.follower_count,
              board_created_at: b.board_created_at,
              last_pinned_at: b.last_pinned_at,
              updated_at: new Date().toISOString(),
            },
          ],
          { onConflict: 'competitor_id,board_id' }
        );
      }

      await supabase
        .from('competitors')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('id', competitorId);

      return {
        success: true,
        type: 'user_boards',
        message: `Successfully upserted ${parsed.boardsData.length} boards into DB!`,
      };
    }
  } catch (err: any) {
    console.warn('Supabase competitors query failed, falling back to mock state:', err);
    const comp = mockCompetitors.find((c) => c.id === competitorId);
    if (comp && parsed.type === 'user_profile' && parsed.profileData) {
      comp.full_name = parsed.profileData.full_name || comp.full_name;
      comp.profile_reach = parsed.profileData.profile_reach ?? comp.profile_reach;
      comp.profile_views = parsed.profileData.profile_views ?? comp.profile_views;
      comp.follower_count = parsed.profileData.follower_count ?? comp.follower_count;
      comp.pin_count = parsed.profileData.pin_count ?? comp.pin_count;
      if (parsed.profileData.avatar_url) comp.avatar_url = parsed.profileData.avatar_url;
      comp.last_checked_at = new Date().toISOString();
      return {
        success: true,
        type: 'user_profile',
        message: `Successfully parsed User Profile (fallback)!`,
      };
    }
    return {
      success: false,
      type: parsed.type,
      message: err.message || 'Failed to persist competitor payload.',
    };
  }

  return { success: false, type: 'unknown', message: 'Failed to process payload.' };
}
