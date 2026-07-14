-- ============================================================
-- 044_inactive_contacts_function.sql
--
-- Backs the `time_based` automation trigger's inactivity mode (Fase 4
-- of the follow-up feature — see 042/043's header comments for the
-- rest of the feature). "Contact hasn't messaged us in N days" isn't
-- expressible through a simple column comparison: it needs the MAX
-- created_at of that contact's CUSTOMER messages across their
-- conversation, which conversations.last_message_at does NOT give you
-- (it's bumped by agent sends too — see ingest.ts/send-message.ts,
-- both update it regardless of sender_type). A SQL function keeps this
-- aggregation server-side instead of an N+1 fetch-then-filter loop in
-- the cron sweep.
--
-- Self-contained given just an automation id + cutoff: the target
-- account is derived from the automation itself, so the cron route
-- doesn't need to pass account_id separately.
--
-- Dedup rule: a contact is excluded if this automation already ran for
-- them (automation_contact_runs, migration 043) MORE RECENTLY than
-- their last customer message — i.e. we already followed up since they
-- last went quiet. If they message again and go quiet a second time,
-- last_at moves forward and they become eligible again automatically.
-- ============================================================

CREATE OR REPLACE FUNCTION inactive_contacts_for_automation(
  p_automation_id UUID,
  p_cutoff TIMESTAMPTZ
)
RETURNS TABLE(contact_id UUID) AS $$
  WITH last_customer_msg AS (
    SELECT c.contact_id, MAX(m.created_at) AS last_at
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id AND m.sender_type = 'customer'
    WHERE c.account_id = (SELECT account_id FROM automations WHERE id = p_automation_id)
    GROUP BY c.contact_id
  )
  SELECT lcm.contact_id
  FROM last_customer_msg lcm
  WHERE lcm.last_at <= p_cutoff
    AND NOT EXISTS (
      SELECT 1 FROM automation_contact_runs r
      WHERE r.automation_id = p_automation_id
        AND r.contact_id = lcm.contact_id
        AND r.executed_at > lcm.last_at
    )
$$ LANGUAGE sql STABLE;
