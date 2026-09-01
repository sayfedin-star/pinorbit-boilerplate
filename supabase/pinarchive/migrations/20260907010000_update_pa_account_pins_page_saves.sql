-- Migration: Add p_max_saves and p_min_saves filters to pa_account_pins_page RPC
-- Allows filtering pins table/cards by maximum or minimum saves directly in SQL.

CREATE OR REPLACE FUNCTION public.pa_account_pins_page(
  p_workspace_id uuid,
  p_account_id uuid,
  p_q text DEFAULT NULL,
  p_board text DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_sort text DEFAULT 'saves',
  p_asc boolean DEFAULT false,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_max_saves bigint DEFAULT NULL,
  p_min_saves bigint DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  pin_id text,
  title text,
  image_url text,
  link text,
  saves bigint,
  repins bigint,
  comments integer,
  share_count bigint,
  reactions jsonb,
  velocity numeric,
  annotations jsonb,
  board_name text,
  seo_category text,
  created_at_pinterest timestamp with time zone,
  archived_at timestamp with time zone,
  first_seen_at timestamp with time zone,
  delta_saves bigint,
  delta_repins bigint,
  delta_shares bigint,
  delta_reactions bigint,
  last_snapshot_at timestamp with time zone,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
AS \$\$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH base_pins AS (
    SELECT
      p.id,
      p.pin_id,
      p.title,
      p.image_url,
      p.link,
      p.saves,
      p.repins,
      p.comments,
      p.share_count,
      p.reactions,
      p.velocity,
      p.annotations,
      p.board_name,
      p.seo_category,
      p.created_at_pinterest,
      p.archived_at,
      p.first_seen_at,
      metrics.delta_saves,
      metrics.delta_repins,
      metrics.delta_shares,
      metrics.delta_reactions,
      metrics.last_snapshot_at,
      CASE
        WHEN p.velocity < 0.5 THEN 'DORMANT'
        WHEN p.velocity < 2 AND coalesce(metrics.delta_saves, 0) < 0 THEN 'COOLING'
        WHEN (EXTRACT(EPOCH FROM (now() - coalesce(p.created_at_pinterest, p.archived_at, now()))) / 86400.0) <= 14 THEN 'NEW'
        WHEN p.velocity >= 10 THEN 'GROWING'
        WHEN p.velocity >= 2 THEN 'MATURE'
        ELSE 'DORMANT'
      END AS computed_stage
    FROM public.pa_pins p
    LEFT JOIN LATERAL (
      WITH ordered_snaps AS (
        SELECT pm.recorded_at, pm.saves, pm.repins, pm.shares, pm.reactions_total
        FROM public.pa_pin_metrics pm
        WHERE pm.pin_ref = p.id
        ORDER BY pm.recorded_at DESC
        LIMIT 2
      ),
      numbered AS (
        SELECT os.*, row_number() OVER (ORDER BY os.recorded_at DESC) AS rnum FROM ordered_snaps os
      )
      SELECT
        max(CASE WHEN rnum = 1 THEN recorded_at END) AS last_snapshot_at,
        CASE
          WHEN count(*) >= 2 THEN
            (max(CASE WHEN rnum = 1 THEN os2.saves END) - max(CASE WHEN rnum = 2 THEN os2.saves END))
          ELSE 0
        END::bigint AS delta_saves,
        CASE
          WHEN count(*) >= 2 THEN
            GREATEST(0, max(CASE WHEN rnum = 1 THEN os2.repins END) - max(CASE WHEN rnum = 2 THEN os2.repins END))
          ELSE 0
        END::bigint AS delta_repins,
        CASE
          WHEN count(*) >= 2 THEN
            GREATEST(0, max(CASE WHEN rnum = 1 THEN os2.shares END) - max(CASE WHEN rnum = 2 THEN os2.shares END))
          ELSE 0
        END::bigint AS delta_shares,
        CASE
          WHEN count(*) >= 2 THEN
            GREATEST(0, max(CASE WHEN rnum = 1 THEN os2.reactions_total END) - max(CASE WHEN rnum = 2 THEN os2.reactions_total END))
          ELSE 0
        END::bigint AS delta_reactions
      FROM numbered os2
    ) metrics ON true
    WHERE p.workspace_id = p_workspace_id
      AND p.account_id = p_account_id
      AND (p_q IS NULL OR trim(p_q) = '' OR p.title ILIKE '%' || trim(p_q) || '%')
      AND (p_board IS NULL OR trim(p_board) = '' OR p.board_name = trim(p_board))
      AND (p_max_saves IS NULL OR p.saves <= p_max_saves)
      AND (p_min_saves IS NULL OR p.saves >= p_min_saves)
  ),
  filtered_pins AS (
    SELECT
      bp.*,
      count(*) OVER ()::bigint AS total_count
    FROM base_pins bp
    WHERE (p_stage IS NULL OR trim(p_stage) = '' OR bp.computed_stage = upper(trim(p_stage)))
  )
  SELECT
    fp.id,
    fp.pin_id,
    fp.title,
    fp.image_url,
    fp.link,
    fp.saves,
    fp.repins,
    fp.comments,
    fp.share_count,
    fp.reactions,
    fp.velocity,
    fp.annotations,
    fp.board_name,
    fp.seo_category,
    fp.created_at_pinterest,
    fp.archived_at,
    fp.first_seen_at,
    fp.delta_saves,
    fp.delta_repins,
    fp.delta_shares,
    fp.delta_reactions,
    fp.last_snapshot_at,
    fp.total_count
  FROM filtered_pins fp
  ORDER BY
    CASE WHEN NOT coalesce(p_asc, false) AND coalesce(p_sort, 'saves') = 'saves' THEN fp.saves END DESC NULLS LAST,
    CASE WHEN coalesce(p_asc, false) AND coalesce(p_sort, 'saves') = 'saves' THEN fp.saves END ASC NULLS LAST,
    CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'repins' THEN fp.repins END DESC NULLS LAST,
    CASE WHEN coalesce(p_asc, false) AND p_sort = 'repins' THEN fp.repins END ASC NULLS LAST,
    CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'velocity' THEN fp.velocity END DESC NULLS LAST,
    CASE WHEN coalesce(p_asc, false) AND p_sort = 'velocity' THEN fp.velocity END ASC NULLS LAST,
    CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'first_seen_at' THEN fp.first_seen_at END DESC NULLS LAST,
    CASE WHEN coalesce(p_asc, false) AND p_sort = 'first_seen_at' THEN fp.first_seen_at END ASC NULLS LAST,
    CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'delta_repins' THEN fp.delta_repins END DESC NULLS LAST,
    CASE WHEN coalesce(p_asc, false) AND p_sort = 'delta_repins' THEN fp.delta_repins END ASC NULLS LAST,
    CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'share_count' THEN fp.share_count END DESC NULLS LAST,
    CASE WHEN coalesce(p_asc, false) AND p_sort = 'share_count' THEN fp.share_count END ASC NULLS LAST,
    CASE WHEN NOT coalesce(p_asc, false) AND (p_sort = 'created_at_pinterest' OR p_sort = 'newest') THEN fp.created_at_pinterest END DESC NULLS LAST,
    CASE WHEN coalesce(p_asc, false) AND (p_sort = 'created_at_pinterest' OR p_sort = 'newest') THEN fp.created_at_pinterest END ASC NULLS LAST,
    CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'delta_saves' THEN fp.delta_saves END DESC NULLS LAST,
    CASE WHEN coalesce(p_asc, false) AND p_sort = 'delta_saves' THEN fp.delta_saves END ASC NULLS LAST,
    fp.saves DESC,
    fp.id ASC
  LIMIT coalesce(p_limit, 50)
  OFFSET coalesce(p_offset, 0);
END;
\$\$;

