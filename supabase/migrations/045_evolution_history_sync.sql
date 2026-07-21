-- ============================================================
-- whatsapp_config: history-backfill idempotency marker.
--
-- Set once the one-time retroactive chat/message import (Evolution's
-- REST findChats/findMessages endpoints, triggered from the webhook's
-- connection.update handler when state flips to 'connected') has run
-- for this config row. NULL means "never run" — a reconnect fires the
-- backfill again only in that case, so a routine disconnect/reconnect
-- doesn't re-import the whole history every time.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_history_synced_at TIMESTAMPTZ;
