-- ============================================================
-- 043_automation_contact_runs.sql
--
-- Per-(automation, contact) execution log, needed by the upcoming
-- inactivity follow-up trigger (Fase 4 — extends `time_based`
-- automations with an `inactivity_days` config: "message this contact
-- if they haven't messaged us in N days").
--
-- Unlike automations.last_executed_at (automation-scoped, migration
-- 006), an inactivity sweep needs a per-contact record: without one,
-- a contact that stays inactive would get the same follow-up re-sent
-- every time the daily sweep runs. Deliberately no uniqueness
-- constraint — the sweep's own dedupe rule is "skip this contact if
-- the automation already ran for them more recently than their last
-- customer message", which lets the automation fire again in a later
-- inactivity window without needing to delete/upsert old rows.
--
-- Created now (schema only) alongside the scheduled_messages table
-- since both ship as part of the same follow-up feature set; the
-- cron sweep that actually writes to this table lands in Fase 4.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_contact_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite, matching the sweep's exact lookup shape: "most recent run
-- of this automation for this contact".
CREATE INDEX IF NOT EXISTS idx_automation_contact_runs_lookup
  ON automation_contact_runs(automation_id, contact_id, executed_at);

-- No RLS/app-facing policies: written only by the cron sweep on the
-- service-role client (same as automation_pending_executions, 006),
-- never read or written from an authenticated request.
ALTER TABLE automation_contact_runs ENABLE ROW LEVEL SECURITY;
