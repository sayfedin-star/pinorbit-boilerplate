import { dbClients } from './clients';

export interface CompetitorRecord {
  id: string;
  workspace_id: string;
  user_id?: string | null;
  username: string;
  full_name: string | null;
  niche: string | null;
  profile_reach: number;
  profile_views: number;
  follower_count: number;
  pin_count: number;
  avatar_url: string | null;
  website_url: string | null;
  domain_verified: boolean;
  notes: string | null;
  tags: string[];
  account_type: string;
  last_checked_at: string | null;
  last_pin_at: string | null;
  created_at: string;
}

export interface CompetitorBoardRecord {
  id: string;
  workspace_id: string;
  competitor_id: string;
  board_id: string;
  name: string;
  description: string | null;
  url: string | null;
  pin_count: number;
  follower_count: number;
  board_created_at: string | null;
  last_pinned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompetitorSnapshotRecord {
  id: string;
  competitor_id: string;
  profile_reach: number;
  profile_views: number;
  follower_count: number;
  pin_count: number;
  recorded_at: string;
}

export interface CompetitorDailySnapshotRecord {
  id: string;
  competitor_id: string;
  snapshot_date: string;
  profile_reach: number;
  profile_views: number;
  follower_count: number;
  pin_count: number;
  created_at: string;
}

/**
 * Server-Only Project 2 (Competitors) Data Layer.
 * Directives:
 * 1. Must never be imported from browser code.
 * 2. Every operation MUST enforce workspace_id tenant boundary.
 */
export const competitorsDb = {
  /**
   * Lists all competitors for an authorized workspace.
   */
  async listCompetitors(
    workspaceId: string,
    options?: { niche?: string; limit?: number; offset?: number }
  ): Promise<{ competitors: CompetitorRecord[]; count: number }> {
    if (!workspaceId) {
      throw new Error('Tenant Boundary Violation: workspaceId is mandatory for competitors query.');
    }

    const client = dbClients.getCompetitors();
    let query = client
      .from('competitors')
      .select('*', { count: 'exact' })
      .eq('workspace_id', workspaceId);

    if (options?.niche) {
      query = query.eq('niche', options.niche);
    }

    query = query.order('created_at', { ascending: false });

    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
    } else if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, count, error } = await query;
    if (error) throw error;

    return {
      competitors: (data as CompetitorRecord[]) || [],
      count: count || 0,
    };
  },

  /**
   * Retrieves single competitor profile within an authorized workspace.
   */
  async getCompetitor(workspaceId: string, competitorId: string): Promise<CompetitorRecord | null> {
    if (!workspaceId || !competitorId) {
      throw new Error('Tenant Boundary Violation: workspaceId and competitorId are required.');
    }

    const client = dbClients.getCompetitors();
    const { data, error } = await client
      .from('competitors')
      .select('*')
      .eq('id', competitorId)
      .eq('workspace_id', workspaceId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }

    return data as CompetitorRecord;
  },

  /**
   * Lists competitor boards scoped to workspace.
   */
  async listCompetitorBoards(
    workspaceId: string,
    competitorId: string
  ): Promise<CompetitorBoardRecord[]> {
    if (!workspaceId || !competitorId) {
      throw new Error('Tenant Boundary Violation: workspaceId and competitorId are required.');
    }

    const client = dbClients.getCompetitors();
    const { data, error } = await client
      .from('competitor_boards')
      .select('*')
      .eq('competitor_id', competitorId)
      .eq('workspace_id', workspaceId)
      .order('pin_count', { ascending: false });

    if (error) throw error;
    return (data as CompetitorBoardRecord[]) || [];
  },

  /**
   * Retrieves daily snapshots for trend calculation.
   */
  async getCompetitorDailySnapshots(
    workspaceId: string,
    competitorId: string,
    days: number = 30
  ): Promise<CompetitorDailySnapshotRecord[]> {
    if (!workspaceId || !competitorId) {
      throw new Error('Tenant Boundary Violation: workspaceId and competitorId are required.');
    }

    // Verify competitor belongs to workspace first
    const competitor = await this.getCompetitor(workspaceId, competitorId);
    if (!competitor) {
      throw new Error(`Forbidden: Competitor ${competitorId} not found in workspace ${workspaceId}.`);
    }

    const client = dbClients.getCompetitors();
    const { data, error } = await client
      .from('competitor_daily_snapshots')
      .select('*')
      .eq('competitor_id', competitorId)
      .order('snapshot_date', { ascending: false })
      .limit(days);

    if (error) throw error;
    const rows = (data as CompetitorDailySnapshotRecord[]) || [];
    return rows.reverse();
  },

  /**
   * Creates or updates a competitor in the tenant's workspace.
   */
  async upsertCompetitor(
    workspaceId: string,
    competitor: Partial<CompetitorRecord> & { username: string }
  ): Promise<CompetitorRecord> {
    if (!workspaceId || !competitor.username) {
      throw new Error('Tenant Boundary Violation: workspaceId and username are required.');
    }

    const client = dbClients.getCompetitors();
    const { data, error } = await client
      .from('competitors')
      .upsert({
        ...competitor,
        workspace_id: workspaceId,
      })
      .select()
      .single();

    if (error) throw error;
    return data as CompetitorRecord;
  },
};
