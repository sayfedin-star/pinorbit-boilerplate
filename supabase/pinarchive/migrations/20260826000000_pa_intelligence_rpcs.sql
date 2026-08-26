-- PinArchive Intelligence RPCs & Batch Ingestion Layer
-- Migration: 20260826000000_pa_intelligence_rpcs.sql
-- Target Database: Project 4 (PinArchive) ONLY
--
-- R1: pa_topic_clusters_page (server-paginated clusters with search, sorting, min pins filter)
-- R2: pa_account_pins_page (server-paginated account pins with lateral snapshot deltas & lifecycle stages)
-- R3: pa_account_boards (distinct boards with pin counts per account)
-- R4: pa_ingest_pin_batch (atomic batch ingest procedure with snapshot diffing & dry-run support)

-- ============================================================================
-- R1: pa_topic_clusters_page
-- ============================================================================
CREATE OR REPLACE FUNCTION public.pa_topic_clusters_page(
  p_workspace_id uuid,
  p_search text DEFAULT NULL,
  p_min_pins int DEFAULT 1,
  p_sort text DEFAULT 'sum_saves',
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  name text,
  pins bigint,
  sum_saves numeric,
  avg_saves bigint,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH extracted AS (
    SELECT
      p.pin_id,
      p.saves,
      CASE
        WHEN jsonb_typeof(a) = 'string' THEN a #>> '{}'
        WHEN jsonb_typeof(a) = 'object' AND a ? 'name' THEN a ->> 'name'
        ELSE NULL
      END AS raw_topic_name
    FROM public.pa_pins p,
    LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(p.annotations) = 'array' THEN p.annotations
        ELSE '[]'::jsonb
      END
    ) AS a
    WHERE p.workspace_id = p_workspace_id
  ),
  cleaned AS (
    SELECT
      trim(raw_topic_name) AS topic_name,
      pin_id,
      saves
    FROM extracted
    WHERE raw_topic_name IS NOT NULL AND trim(raw_topic_name) <> ''
  ),
  aggregated AS (
    SELECT
      c.topic_name AS name,
      count(DISTINCT c.pin_id)::bigint AS pins,
      coalesce(sum(c.saves), 0)::numeric AS sum_saves,
      CASE
        WHEN count(DISTINCT c.pin_id) > 0 THEN (coalesce(sum(c.saves), 0) / count(DISTINCT c.pin_id))::bigint
        ELSE 0::bigint
      END AS avg_saves
    FROM cleaned c
    WHERE (p_search IS NULL OR trim(p_search) = '' OR c.topic_name ILIKE '%' || trim(p_search) || '%')
    GROUP BY c.topic_name
    HAVING count(DISTINCT c.pin_id) >= coalesce(p_min_pins, 1)
  ),
  counted AS (
    SELECT
      a.name,
      a.pins,
      a.sum_saves,
      a.avg_saves,
      count(*) OVER ()::bigint AS total_count
    FROM aggregated a
  )
  SELECT
    counted.name,
    counted.pins,
    counted.sum_saves,
    counted.avg_saves,
    counted.total_count
  FROM counted
  ORDER BY
    CASE WHEN p_sort = 'name' THEN counted.name END ASC,
    CASE WHEN p_sort = 'pins' THEN counted.pins END DESC,
    CASE WHEN p_sort = 'avg_saves' THEN counted.avg_saves END DESC,
    CASE WHEN coalesce(p_sort, 'sum_saves') = 'sum_saves' THEN counted.sum_saves END DESC,
    counted.sum_saves DESC,
    counted.name ASC
  LIMIT coalesce(p_limit, 50)
  OFFSET coalesce(p_offset, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.pa_topic_clusters_page(uuid, text, int, text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_topic_clusters_page(uuid, text, int, text, int, int) TO service_role;

-- ============================================================================
-- R2: pa_account_pins_page
-- ============================================================================
CREATE OR REPLACE FUNCTION public.pa_account_pins_page(
  p_workspace_id uuid,
  p_account_id uuid,
  p_q text DEFAULT NULL,
  p_board text DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_sort text DEFAULT 'saves',
  p_asc boolean DEFAULT false,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  pin_id text,
  title text,
  image_url text,
  link text,
  saves bigint,
  repins bigint,
  comments int,
  share_count bigint,
  reactions jsonb,
  velocity numeric,
  annotations jsonb,
  board_name text,
  seo_category text,
  created_at_pinterest timestamptz,
  archived_at timestamptz,
  delta_saves bigint,
  delta_shares bigint,
  delta_reactions bigint,
  last_snapshot_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
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
      metrics.delta_saves,
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
        SELECT pm.recorded_at, pm.saves, pm.shares, pm.reactions_total
        FROM public.pa_pin_metrics pm
        WHERE pm.pin_ref = p.id
        ORDER BY pm.recorded_at DESC
        LIMIT 2
      ),
      numbered AS (
        SELECT os.*, row_number() OVER () AS rnum FROM ordered_snaps os
      )
      SELECT
        max(CASE WHEN rnum = 1 THEN recorded_at END) AS last_snapshot_at,
        CASE
          WHEN count(*) >= 2 THEN
            max(CASE WHEN rnum = 1 THEN saves END) - max(CASE WHEN rnum = 2 THEN saves END)
          ELSE 0
        END::bigint AS delta_saves,
        CASE
          WHEN count(*) >= 2 THEN
            max(CASE WHEN rnum = 1 THEN shares END) - max(CASE WHEN rnum = 2 THEN shares END)
          ELSE 0
        END::bigint AS delta_shares,
        CASE
          WHEN count(*) >= 2 THEN
            max(CASE WHEN rnum = 1 THEN reactions_total END) - max(CASE WHEN rnum = 2 THEN reactions_total END)
          ELSE 0
        END::bigint AS delta_reactions
      FROM numbered
    ) metrics ON true
    WHERE p.workspace_id = p_workspace_id
      AND p.account_id = p_account_id
      AND (p_q IS NULL OR trim(p_q) = '' OR p.title ILIKE '%' || trim(p_q) || '%')
      AND (p_board IS NULL OR trim(p_board) = '' OR p.board_name = trim(p_board))
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
    fp.delta_saves,
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
$$;

REVOKE ALL ON FUNCTION public.pa_account_pins_page(uuid, uuid, text, text, text, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_account_pins_page(uuid, uuid, text, text, text, text, boolean, int, int) TO service_role;

-- ============================================================================
-- R3: pa_account_boards
-- ============================================================================
CREATE OR REPLACE FUNCTION public.pa_account_boards(
  p_workspace_id uuid,
  p_account_id uuid
)
RETURNS TABLE (
  board_name text,
  pins bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    p.board_name,
    count(*)::bigint AS pins
  FROM public.pa_pins p
  WHERE p.workspace_id = p_workspace_id
    AND p.account_id = p_account_id
    AND p.board_name IS NOT NULL
    AND trim(p.board_name) <> ''
  GROUP BY p.board_name
  ORDER BY pins DESC, p.board_name ASC;
$$;

REVOKE ALL ON FUNCTION public.pa_account_boards(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_account_boards(uuid, uuid) TO service_role;

-- ============================================================================
-- R4: pa_ingest_pin_batch (Atomic Option B Batch Ingestion)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.pa_ingest_pin_batch(
  p_workspace_id uuid,
  p_account_id uuid,
  p_fetched_at timestamptz,
  p_pins jsonb,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_pins_count int := 0;
  v_added_count int := 0;
  v_updated_count int := 0;
  v_snapshots_count int := 0;
  v_archived_ids text[] := ARRAY[]::text[];
BEGIN
  IF p_pins IS NULL OR jsonb_typeof(p_pins) <> 'array' OR jsonb_array_length(p_pins) = 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'added', 0,
      'updated', 0,
      'snapshots', 0,
      'archived_pin_ids', '[]'::jsonb
    );
  END IF;

  v_pins_count := jsonb_array_length(p_pins);

  -- Temporary table for incoming pins to enable set-based processing
  CREATE TEMP TABLE temp_incoming_pins ON COMMIT DROP AS
  SELECT
    p_workspace_id AS workspace_id,
    p_account_id AS account_id,
    r.pin_id,
    r.node_id,
    r.title,
    r.description,
    r.link,
    r.utm_link,
    r.domain,
    r.board_id,
    r.board_name,
    r.created_at_pinterest,
    r.image_url,
    r.image_signature,
    r.dominant_color,
    coalesce(r.is_video, false) AS is_video,
    coalesce(r.is_product, false) AS is_product,
    r.price,
    r.currency,
    r.site_name,
    coalesce(r.saves, 0)::bigint AS saves,
    coalesce(r.repins, 0)::bigint AS repins,
    coalesce(r.comments, 0)::int AS comments,
    r.reactions,
    coalesce(r.velocity, 0)::numeric AS velocity,
    coalesce(r.promoted, false) AS promoted,
    r.share_count,
    r.archived_at,
    r.annotations,
    r.board_pin_count,
    r.board_last_modified_at,
    r.seo_category,
    r.canonical_pin_id,
    r.seo_alt_text
  FROM jsonb_to_recordset(p_pins) AS r(
    pin_id text,
    node_id text,
    title text,
    description text,
    link text,
    utm_link text,
    domain text,
    board_id text,
    board_name text,
    created_at_pinterest timestamptz,
    image_url text,
    image_signature text,
    dominant_color text,
    is_video boolean,
    is_product boolean,
    price numeric,
    currency text,
    site_name text,
    saves bigint,
    repins bigint,
    comments int,
    reactions jsonb,
    velocity numeric,
    promoted boolean,
    share_count bigint,
    archived_at timestamptz,
    annotations jsonb,
    board_pin_count int,
    board_last_modified_at timestamptz,
    seo_category text,
    canonical_pin_id text,
    seo_alt_text text
  )
  WHERE r.pin_id IS NOT NULL AND trim(r.pin_id) <> '';

  -- Collect all pin_ids for return
  SELECT coalesce(array_agg(pin_id), ARRAY[]::text[]) INTO v_archived_ids FROM temp_incoming_pins;

  -- Count new vs existing
  SELECT count(*) INTO v_updated_count
  FROM public.pa_pins p
  INNER JOIN temp_incoming_pins tip ON p.workspace_id = tip.workspace_id AND p.pin_id = tip.pin_id;

  v_added_count := v_pins_count - v_updated_count;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'success', true,
      'dry_run', true,
      'added', v_added_count,
      'updated', v_updated_count,
      'snapshots', 0,
      'archived_pin_ids', to_jsonb(v_archived_ids)
    );
  END IF;

  -- UPSERT into pa_pins
  WITH upserted AS (
    INSERT INTO public.pa_pins AS target (
      workspace_id,
      account_id,
      pin_id,
      node_id,
      title,
      description,
      link,
      utm_link,
      domain,
      board_id,
      board_name,
      created_at_pinterest,
      image_url,
      image_signature,
      dominant_color,
      is_video,
      is_product,
      price,
      currency,
      site_name,
      saves,
      repins,
      comments,
      reactions,
      velocity,
      promoted,
      share_count,
      first_seen_at,
      last_updated_at,
      archived_at,
      annotations,
      board_pin_count,
      board_last_modified_at,
      seo_category,
      canonical_pin_id,
      seo_alt_text
    )
    SELECT
      tip.workspace_id,
      tip.account_id,
      tip.pin_id,
      tip.node_id,
      tip.title,
      tip.description,
      tip.link,
      tip.utm_link,
      tip.domain,
      tip.board_id,
      tip.board_name,
      tip.created_at_pinterest,
      tip.image_url,
      tip.image_signature,
      tip.dominant_color,
      tip.is_video,
      tip.is_product,
      tip.price,
      tip.currency,
      tip.site_name,
      tip.saves,
      tip.repins,
      tip.comments,
      coalesce(tip.reactions, '{}'::jsonb),
      tip.velocity,
      tip.promoted,
      coalesce(tip.share_count, 0),
      p_fetched_at AS first_seen_at,
      p_fetched_at AS last_updated_at,
      coalesce(tip.archived_at, p_fetched_at) AS archived_at,
      coalesce(tip.annotations, '[]'::jsonb),
      tip.board_pin_count,
      tip.board_last_modified_at,
      tip.seo_category,
      tip.canonical_pin_id,
      tip.seo_alt_text
    FROM temp_incoming_pins tip
    ON CONFLICT (workspace_id, pin_id) DO UPDATE SET
      -- Always overwrite core Pinterest metrics & attributes
      saves = excluded.saves,
      repins = excluded.repins,
      comments = excluded.comments,
      velocity = excluded.velocity,
      title = coalesce(excluded.title, target.title),
      description = coalesce(excluded.description, target.description),
      link = coalesce(excluded.link, target.link),
      domain = coalesce(excluded.domain, target.domain),
      board_name = coalesce(excluded.board_name, target.board_name),
      image_url = coalesce(excluded.image_url, target.image_url),
      is_video = excluded.is_video,
      is_product = excluded.is_product,
      price = coalesce(excluded.price, target.price),
      currency = coalesce(excluded.currency, target.currency),
      site_name = coalesce(excluded.site_name, target.site_name),
      promoted = excluded.promoted,
      last_updated_at = p_fetched_at,

      -- Provided-only enrichment preservation
      node_id = coalesce(excluded.node_id, target.node_id),
      board_id = coalesce(excluded.board_id, target.board_id),
      utm_link = coalesce(excluded.utm_link, target.utm_link),
      canonical_pin_id = coalesce(excluded.canonical_pin_id, target.canonical_pin_id),
      seo_category = coalesce(excluded.seo_category, target.seo_category),
      seo_alt_text = coalesce(excluded.seo_alt_text, target.seo_alt_text),
      board_pin_count = coalesce(excluded.board_pin_count, target.board_pin_count),
      board_last_modified_at = coalesce(excluded.board_last_modified_at, target.board_last_modified_at),
      image_signature = coalesce(excluded.image_signature, target.image_signature),
      dominant_color = coalesce(excluded.dominant_color, target.dominant_color),
      share_count = coalesce(excluded.share_count, target.share_count),
      reactions = CASE
        WHEN excluded.reactions IS NOT NULL AND excluded.reactions <> '{}'::jsonb THEN excluded.reactions
        ELSE target.reactions
      END,
      archived_at = coalesce(excluded.archived_at, target.archived_at),
      annotations = CASE
        WHEN excluded.annotations IS NOT NULL AND excluded.annotations <> '[]'::jsonb AND target.annotations IS NOT NULL AND target.annotations <> '[]'::jsonb THEN
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'name', merged.name,
                'idea_id', merged.idea_id,
                'url', merged.url
              )
            )
            FROM (
              SELECT
                coalesce(e->>'name', t->>'name') AS name,
                coalesce(e->>'idea_id', t->>'idea_id') AS idea_id,
                coalesce(e->>'url', t->>'url') AS url
              FROM jsonb_array_elements(target.annotations) t
              FULL OUTER JOIN jsonb_array_elements(excluded.annotations) e
                ON (t->>'name') = (e->>'name')
              WHERE coalesce(e->>'name', t->>'name') IS NOT NULL
            ) merged
          )
        WHEN excluded.annotations IS NOT NULL AND excluded.annotations <> '[]'::jsonb THEN excluded.annotations
        ELSE target.annotations
      END
    RETURNING
      target.id,
      target.pin_id,
      target.workspace_id,
      target.saves,
      target.repins,
      target.comments,
      target.share_count,
      target.reactions,
      (xmax = 0) AS is_insert
  )
  -- Insert snapshot records into pa_pin_metrics when saves, repins, or share_count differ or new pin
  , snap_insert AS (
    INSERT INTO public.pa_pin_metrics (
      workspace_id,
      pin_ref,
      recorded_at,
      saves,
      repins,
      comments,
      shares,
      reactions_total
    )
    SELECT
      u.workspace_id,
      u.id AS pin_ref,
      p_fetched_at AS recorded_at,
      u.saves,
      u.repins,
      u.comments,
      u.share_count AS shares,
      coalesce((u.reactions->>'total')::bigint, 0) AS reactions_total
    FROM upserted u
    LEFT JOIN LATERAL (
      SELECT pm.saves, pm.repins, pm.shares
      FROM public.pa_pin_metrics pm
      WHERE pm.pin_ref = u.id
      ORDER BY pm.recorded_at DESC
      LIMIT 1
    ) prev ON true
    WHERE prev.saves IS NULL
       OR prev.saves IS DISTINCT FROM u.saves
       OR prev.repins IS DISTINCT FROM u.repins
    ON CONFLICT (pin_ref, recorded_at) DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO v_snapshots_count FROM snap_insert;

  RETURN jsonb_build_object(
    'success', true,
    'added', v_added_count,
    'updated', v_updated_count,
    'snapshots', v_snapshots_count,
    'archived_pin_ids', to_jsonb(v_archived_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pa_ingest_pin_batch(uuid, uuid, timestamptz, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_ingest_pin_batch(uuid, uuid, timestamptz, jsonb, boolean) TO service_role;

-- ============================================================================
-- DOWN (Rollback Documentation)
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.pa_ingest_pin_batch(uuid, uuid, timestamptz, jsonb, boolean);
-- DROP FUNCTION IF EXISTS public.pa_account_boards(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.pa_account_pins_page(uuid, uuid, text, text, text, text, boolean, int, int);
-- DROP FUNCTION IF EXISTS public.pa_topic_clusters_page(uuid, text, int, text, int, int);
