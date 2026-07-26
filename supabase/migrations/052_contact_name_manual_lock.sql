-- ============================================================
-- 052_contact_name_manual_lock.sql
--
-- ingest.ts's find-or-create-contact path silently overwrites a
-- contact's name with WhatsApp's pushName whenever they differ, every
-- time a message arrives (live) or gets backfilled (history resync) —
-- with no protection for a name an agent manually edited via the CRM.
-- Reported live: reconnecting the WhatsApp account (which re-runs the
-- history backfill) reverted several manually-corrected names back to
-- whatever pushName WhatsApp reports, while contacts that happened not
-- to receive a message during that window kept the edited name —
-- explaining the inconsistent symptom.
--
-- `name_edited_manually` marks a contact whose name was set through
-- the CRM's own edit UI (not synced from WhatsApp). Once true,
-- ingest.ts's pushName patch must never touch `name` again for that
-- contact.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS name_edited_manually BOOLEAN NOT NULL DEFAULT false;
