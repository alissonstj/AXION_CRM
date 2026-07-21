-- ============================================================
-- 046_group_conversations
--
-- WhatsApp group support. Until now conversations were strictly 1:1
-- (conversations.contact_id NOT NULL, keyed to a single person by
-- phone), and both the webhook parser and the history backfill dropped
-- @g.us messages entirely. A group doesn't fit the 1:1 contact model:
-- it has its own identity (a @g.us JID + a group name) and its messages
-- come from many different participants, each a distinct person.
--
-- This migration makes conversations able to represent a group and
-- messages able to record which participant sent each one:
--   1. conversations.contact_id becomes nullable (a group conversation
--      has no single contact).
--   2. conversations gains is_group + group_jid + group_name +
--      group_avatar_url.
--   3. A partial unique index on (account_id, group_jid) gives groups
--      the same "one conversation per group" backstop that
--      (account_id, contact_id) gives 1:1 chats — with no collision
--      between the two (group rows have contact_id NULL, which Postgres
--      treats as distinct in the existing 036 index).
--   4. messages gains sender_participant_name + sender_participant_phone
--      — populated only for group messages, to show WHO in the group
--      sent each message (like WhatsApp shows the sender name above a
--      bubble). 1:1 messages leave them NULL and behave identically.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1) A group conversation has no single contact.
ALTER TABLE conversations
  ALTER COLUMN contact_id DROP NOT NULL;

-- 2) Group identity columns.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS group_jid TEXT,
  ADD COLUMN IF NOT EXISTS group_name TEXT,
  ADD COLUMN IF NOT EXISTS group_avatar_url TEXT;

-- 3) One conversation per (account, group). Partial so it only applies
--    to group rows; 1:1 rows (group_jid IS NULL) are unaffected and
--    keep using idx_conversations_account_contact (migration 036).
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_group
  ON conversations (account_id, group_jid)
  WHERE group_jid IS NOT NULL;

-- 4) Per-message sender identity within a group. NULL for 1:1 messages.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_participant_name TEXT,
  ADD COLUMN IF NOT EXISTS sender_participant_phone TEXT;
