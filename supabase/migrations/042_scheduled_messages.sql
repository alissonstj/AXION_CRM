-- ============================================================
-- 042_scheduled_messages.sql
--
-- Manual per-lead message scheduling ("Follow-up"). An agent picks a
-- contact/conversation (from a deal's Kanban card, or from an open
-- inbox conversation), writes or picks content, and a future
-- date/time — a cron sweep (see 043 for the follow-up-by-inactivity
-- sibling feature) sends it when due.
--
-- Distinct from:
--   - Automations (event-triggered, not a hand-picked date)
--   - Broadcasts (mass send to many contacts, not one lead)
--   - automation_pending_executions (an automation's internal `wait`
--     step resume queue, not user-facing)
--
-- contact_id/conversation_id are the real, required tenancy link —
-- deal_id is optional attribution, populated only when the agent
-- scheduled from a Kanban card. conversation_id is resolved (find-or-
-- create) at schedule-creation time, not at send time, so the cron
-- sweep never needs conversation-resolution logic of its own.
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Optional: only set when scheduled from a deal's Kanban card. Not
  -- cascaded — losing/deleting the deal shouldn't silently drop a
  -- follow-up the agent already committed to sending.
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  title TEXT,
  content_type TEXT NOT NULL CHECK (content_type IN ('text', 'image', 'video', 'document', 'audio')),
  content_text TEXT,
  media_url TEXT,
  -- Attribution only, when the agent picked a saved quick reply as the
  -- starting content — never read back at send time.
  quick_reply_id UUID REFERENCES quick_replies(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  -- 'sending' is a transient claim state (mirrors automation_pending_
  -- executions' 'running'): the cron sweep flips pending -> sending in
  -- a conditional UPDATE as its lock, so two overlapping sweep
  -- invocations can't both send the same row.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  sent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial index: the cron sweep only ever looks at pending, due rows.
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages(scheduled_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_contact
  ON scheduled_messages(contact_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_deal
  ON scheduled_messages(deal_id) WHERE deal_id IS NOT NULL;

ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

-- Same account-scoped shape as quick_replies (035): any member reads,
-- agent+ creates/cancels. The cron sweep runs on the service-role
-- client and bypasses RLS entirely, same as every other background
-- job in this codebase.
DROP POLICY IF EXISTS scheduled_messages_select ON scheduled_messages;
DROP POLICY IF EXISTS scheduled_messages_insert ON scheduled_messages;
DROP POLICY IF EXISTS scheduled_messages_update ON scheduled_messages;
CREATE POLICY scheduled_messages_select ON scheduled_messages FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY scheduled_messages_insert ON scheduled_messages FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
-- UPDATE covers cancellation (status -> 'cancelled'); the cron sweep
-- itself never uses this policy (service-role bypass).
CREATE POLICY scheduled_messages_update ON scheduled_messages FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON scheduled_messages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
