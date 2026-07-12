-- ============================================================
-- whatsapp_config: Evolution connection cache.
--
-- Fase 1 (migration 037) already added provider, evolution_instance_name,
-- evolution_connection_state, evolution_connected_at. This adds what the
-- QR-connect flow needs: the per-instance auth token, the latest QR (fed
-- by the webhook, never fetched live by the UI), and a human-readable
-- last error so a failed connection doesn't just spin forever.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS evolution_qr_code TEXT,
  ADD COLUMN IF NOT EXISTS evolution_qr_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evolution_last_error TEXT;
