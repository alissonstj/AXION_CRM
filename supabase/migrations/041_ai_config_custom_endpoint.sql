-- ============================================================
-- ai_configs: optional custom endpoint override for the chat
-- provider (OpenAI/Anthropic-compatible base URL).
--
-- Lets an account point the "openai" or "anthropic" provider slot at
-- a compatible third-party host (e.g. Groq's OpenAI-compatible
-- endpoint, https://api.groq.com/openai/v1) instead of the real
-- api.openai.com / api.anthropic.com — useful for testing the
-- assistant against a provider with a genuine free tier before
-- committing to a paid key. NULL (the default for every existing
-- row) means "use the real provider URL" — zero behavior change for
-- accounts that never set this.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS base_url TEXT;
