-- ============================================================
-- 051_lid_only_contacts.sql
--
-- investigacao-completude-sync-conversas.md: ~half of one live
-- account's WhatsApp chats are addressed by @lid (WhatsApp's privacy-
-- preserving id) with no phone-number alt ever provided by Evolution/
-- Baileys — these were being silently dropped everywhere (live
-- webhook AND history backfill), since `contacts.phone` was required
-- and every insert needed a real phone.
--
-- This lets a contact exist keyed by `lid` alone. `phone` stays the
-- primary identifier whenever it's known — this only adds the
-- fallback for when it isn't.
-- ============================================================

ALTER TABLE contacts
  ALTER COLUMN phone DROP NOT NULL;

-- A CHECK, not just app-level discipline: every contact must be
-- identifiable by at least one of phone/lid, or it isn't really a
-- WhatsApp contact at all.
ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_phone_or_lid_required;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_phone_or_lid_required
  CHECK (phone IS NOT NULL OR lid IS NOT NULL);

-- Same dedup guarantee migration 022 gives phone_normalized, for lid.
-- A given LID is one WhatsApp account — it must never fragment into
-- two contact rows in the same CRM account, whether or not either row
-- also happens to know a phone number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_lid_unique
  ON contacts (account_id, lid)
  WHERE lid IS NOT NULL;
