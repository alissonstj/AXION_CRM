-- ============================================================
-- whatsapp_config: phone_number_id/access_token are Meta-only fields
-- (migration 001, both NOT NULL) — migration 037 added provider=
-- 'evolution' support without relaxing them, so every Evolution
-- connect insert for a brand-new account violates the NOT NULL
-- constraint before it ever reaches the CHECK layer. Confirmed against
-- a real Postgres instance with the full migration chain applied
-- (not just the mocked Supabase client tests) — see
-- src/lib/supabase/whatsapp-config-schema.test.ts.
--
-- Relaxed here, same pattern as migration 039 for broadcasts: drop
-- NOT NULL, enforce the pairing via CHECK instead so the Meta path's
-- existing data-integrity guarantee is preserved (a provider='meta'
-- row still can't be saved without both fields).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_meta_fields_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_meta_fields_check CHECK (
    provider != 'meta' OR (phone_number_id IS NOT NULL AND access_token IS NOT NULL)
  );
