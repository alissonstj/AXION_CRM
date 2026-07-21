-- ============================================================
-- 049_typing_indicator
--
-- Support for showing "digitando…" in the CRM when the CUSTOMER is
-- typing on WhatsApp (the reverse direction of the existing outbound
-- typing indicator — sendTyping already tells WhatsApp when the agent/
-- AI is typing; nothing told the CRM when the customer was).
--
-- Confirmed live 2026-07-17: Evolution DOES forward Baileys presence
-- updates when subscribed to the PRESENCE_UPDATE webhook event. Payload
-- shape (captured from a real "composing" event):
--   { "id": "<jid>", "presences": { "<jid>": { "lastKnownPresence": "composing" } } }
-- `id` is often a LID (@lid), not the phone — unlike message events, a
-- presence.update payload carries NO remoteJidAlt to resolve the real
-- phone from. So this migration adds two things:
--
--   1. contacts.lid — the contact's LID form, captured opportunistically
--      whenever a MESSAGE arrives with both a LID and its phone alt
--      (data we already parse and, until now, discarded). Lets a later
--      presence event addressed only by LID resolve back to the right
--      contact/conversation.
--   2. conversations.typing_until — set to "now + a few seconds" each
--      time a `composing` presence arrives for that contact, cleared on
--      any other presence value. Time-boxed rather than a plain boolean
--      so a missed "stopped typing" event (phone backgrounded mid-type,
--      a dropped webhook delivery) can't leave the indicator stuck on
--      forever — the UI just checks `typing_until > now()`.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lid TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_account_lid
  ON contacts (account_id, lid)
  WHERE lid IS NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS typing_until TIMESTAMPTZ;
