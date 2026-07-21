-- ============================================================
-- 047_deal_open_dedup
--
-- Prevent the same contact from accumulating multiple OPEN deals in
-- the same pipeline (investigacao-duplicacao-novo-lead.md).
--
-- The `create_deal` automation step has always had a pre-insert dedup
-- guard (engine.ts), but it read the existing-deal check with
-- `.maybeSingle()` — which only tolerates 0 or 1 matching rows and
-- THROWS once 2+ already exist (PGRST116). The guard code discarded
-- that error, so the throw silently looked like "no existing deal" and
-- let another duplicate through. Once an ordinary race (two
-- near-simultaneous trigger firings both passing the check before
-- either's insert lands) created a 2nd duplicate, every future check
-- for that contact+pipeline hit the same throw — unbounded duplication
-- snowballed exactly like migration 036's conversation bug did. The
-- application-code fix (this same change: `.limit(1)` instead of
-- `.maybeSingle()`) ships alongside this migration.
--
-- Mirrors 022_contact_phone_dedup / 036_conversation_contact_dedup:
--   1. merges existing duplicate OPEN deals into the oldest row per
--      (contact_id, pipeline_id), re-pointing scheduled_messages.deal_id
--      first so nothing is lost;
--   2. adds a partial UNIQUE index on (contact_id, pipeline_id) WHERE
--      status = 'open' — the authoritative guarantee, scoped to open
--      deals only so a contact can still have closed/lost deals
--      alongside a fresh open one in the same pipeline.
--
-- Idempotent. **No data loss** — duplicate deals are merged, not
-- dropped: scheduled_messages referencing a loser deal are re-pointed
-- to the survivor before the losers are deleted.
-- ============================================================

-- 1) One-time (re-runnable) merge of existing duplicate open deals.
CREATE OR REPLACE FUNCTION public.merge_duplicate_open_deals()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT contact_id,
           pipeline_id,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids
    FROM deals
    WHERE status = 'open'
    GROUP BY contact_id, pipeline_id
    HAVING count(*) > 1
  LOOP
    v_survivor := v_group.ids[1];
    v_losers   := v_group.ids[2:array_length(v_group.ids, 1)];

    -- Re-point the one known child (scheduled_messages.deal_id) before
    -- deleting the losers — it's ON DELETE SET NULL, so this saves the
    -- link instead of just nulling it out.
    UPDATE scheduled_messages SET deal_id = v_survivor WHERE deal_id = ANY(v_losers);

    DELETE FROM deals WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_open_deals() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_open_deals() FROM PUBLIC;

-- Collapse whatever duplicates exist right now.
SELECT public.merge_duplicate_open_deals();

-- 2) Authoritative guarantee: one OPEN deal per (contact, pipeline).
--    Partial so a contact can still have a closed/lost deal in the same
--    pipeline alongside a new open one (re-engagement is a valid case).
CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_contact_pipeline_open
  ON deals (contact_id, pipeline_id)
  WHERE status = 'open';
