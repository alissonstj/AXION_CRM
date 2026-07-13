-- ============================================================
-- broadcasts: freeform (non-template) content for Evolution
-- accounts, plus a provider snapshot.
--
-- template_name/template_language were NOT NULL (migration 001) —
-- relaxed here since a freeform broadcast has neither. `kind` drives
-- which set of columns is populated; the CHECK enforces the pairing
-- so a row can't end up with neither template nor freeform content.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcasts
  ALTER COLUMN template_name DROP NOT NULL,
  ALTER COLUMN template_language DROP NOT NULL;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'template'
    CHECK (kind IN ('template', 'freeform')),
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'evolution')),
  ADD COLUMN IF NOT EXISTS message_text TEXT,
  ADD COLUMN IF NOT EXISTS message_media_url TEXT,
  ADD COLUMN IF NOT EXISTS message_media_type TEXT
    CHECK (message_media_type IS NULL OR message_media_type IN ('image', 'video', 'document', 'audio'));

ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_kind_content_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_kind_content_check CHECK (
    (kind = 'template' AND template_name IS NOT NULL)
    OR (kind = 'freeform' AND (message_text IS NOT NULL OR message_media_url IS NOT NULL))
  );
