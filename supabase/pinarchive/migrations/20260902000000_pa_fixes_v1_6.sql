-- Migration: 20260902000000_pa_fixes_v1_6.sql
-- Description: Add refresh_max_pins setting, fix COOLING stage calculation, restore annotations merge, and deduplicate ingest batch pin IDs

-- 1. Add refresh_max_pins column to pa_workspace_settings
ALTER TABLE public.pa_workspace_settings
  ADD COLUMN IF NOT EXISTS refresh_max_pins int NOT NULL DEFAULT 0
  CHECK (refresh_max_pins >= 0 AND refresh_max_pins <= 10000);

COMMENT ON COLUMN public.pa_workspace_settings.refresh_max_pins IS '0=unlimited, else max pins per refresh run (pagination respects it)';


-- 2. Update pa_account_pins_page with signed delta_saves for COOLING stage
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
  first_seen_at timestamptz,
  delta_saves bigint,
  delta_repins bigint,
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
$$;

REVOKE ALL ON FUNCTION public.pa_account_pins_page(uuid, uuid, text, text, text, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_account_pins_page(uuid, uuid, text, text, text, text, boolean, int, int) TO service_role;


-- 3. Update pa_ingest_pin_batch with distinct CTE and full outer join annotations merge
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

  CREATE TEMP TABLE temp_incoming_pins ON COMMIT DROP AS
  SELECT DISTINCT ON (r.pin_id)
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
  WHERE r.pin_id IS NOT NULL AND trim(r.pin_id) <> ''
  ORDER BY r.pin_id;

  SELECT count(*)::int INTO v_updated_count
  FROM temp_incoming_pins tip
  JOIN public.pa_pins p ON p.workspace_id = tip.workspace_id AND p.pin_id = tip.pin_id;

  v_added_count := v_pins_count - v_updated_count;

  SELECT coalesce(array_agg(tip.pin_id), ARRAY[]::text[]) INTO v_archived_ids
  FROM temp_incoming_pins tip;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'dry_run', true,
      'incoming_count', v_pins_count,
      'added', v_added_count,
      'updated', v_updated_count,
      'snapshots', 0,
      'archived_pin_ids', to_jsonb(v_archived_ids)
    );
  END IF;

  WITH upserted AS (
    INSERT INTO public.pa_pins (
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
      -- Preserve monotonic max for lifetime cumulative metrics
      saves = GREATEST(excluded.saves, target.saves),
      repins = GREATEST(excluded.repins, target.repins),
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
      share_count = GREATEST(coalesce(excluded.share_count, 0), coalesce(target.share_count, 0)),
      last_updated_at = p_fetched_at,
      reactions = CASE
        WHEN excluded.reactions IS NOT NULL AND excluded.reactions <> '{}'::jsonb THEN excluded.reactions
        ELSE target.reactions
      END,
      annotations = CASE
        WHEN excluded.annotations IS NOT NULL AND excluded.annotations <> '[]'::jsonb AND target.annotations IS NOT NULL AND target.annotations <> '[]'::jsonb THEN
          (
            SELECT coalesce(jsonb_agg(
              jsonb_build_object(
                'name', merged.name,
                'idea_id', merged.idea_id,
                'url', merged.url
              )
            ), '[]'::jsonb)
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
      END,
      board_pin_count = coalesce(excluded.board_pin_count, target.board_pin_count),
      board_last_modified_at = coalesce(excluded.board_last_modified_at, target.board_last_modified_at),
      seo_category = coalesce(excluded.seo_category, target.seo_category),
      canonical_pin_id = coalesce(excluded.canonical_pin_id, target.canonical_pin_id),
      utm_link = coalesce(excluded.utm_link, target.utm_link),
      image_signature = coalesce(excluded.image_signature, target.image_signature),
      dominant_color = coalesce(excluded.dominant_color, target.dominant_color),
      seo_alt_text = coalesce(excluded.seo_alt_text, target.seo_alt_text)
    RETURNING id, workspace_id, saves, repins, comments, share_count, reactions
  ),
  inserted_metrics AS (
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
      u.id,
      p_fetched_at,
      u.saves,
      u.repins,
      u.comments,
      u.share_count,
      coalesce((u.reactions->>'total')::int, 0)
    FROM upserted u
    WHERE NOT EXISTS (
      SELECT 1 FROM public.pa_pin_metrics pm
      WHERE pm.pin_ref = u.id
        AND pm.saves >= u.saves
        AND pm.repins >= u.repins
        AND pm.shares >= u.share_count
    )
    ON CONFLICT (pin_ref, recorded_at) DO NOTHING
    RETURNING id
  )
  SELECT count(*)::int INTO v_snapshots_count FROM inserted_metrics;

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


-- 4. Create pa_topic_pins RPC for honest, un-capped topic member pin retrieval
CREATE OR REPLACE FUNCTION public.pa_topic_pins(
  p_workspace_id uuid,
  p_name text,
  p_account_id uuid DEFAULT NULL,
  p_board text DEFAULT NULL
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
  velocity numeric,
  annotations jsonb,
  seo_category text,
  canonical_pin_id text,
  archived_at timestamptz,
  board_name text,
  board_id text,
  account_id uuid,
  is_video boolean,
  created_at_pinterest timestamptz,
  notes text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
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
    p.velocity,
    p.annotations,
    p.seo_category,
    p.canonical_pin_id,
    p.archived_at,
    p.board_name,
    p.board_id,
    p.account_id,
    p.is_video,
    p.created_at_pinterest,
    p.notes
  FROM public.pa_pins p
  WHERE p.workspace_id = p_workspace_id
    AND (
      p.annotations @> jsonb_build_array(jsonb_build_object('name', p_name))
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.annotations) a
        WHERE (a->>'name') = p_name OR a #>> '{}' = p_name
      )
    )
    AND (p_account_id IS NULL OR p.account_id = p_account_id)
    AND (p_board IS NULL OR trim(p_board) = '' OR p.board_name = trim(p_board))
  ORDER BY p.saves DESC;
$$;

REVOKE ALL ON FUNCTION public.pa_topic_pins(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_topic_pins(uuid, text, uuid, text) TO service_role;
