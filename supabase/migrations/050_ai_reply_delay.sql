-- ============================================================
-- 050_ai_reply_delay.sql — configurable AI auto-reply delay
--
-- The auto-reply bot waited a hardcoded 4-5s (randomized) before
-- sending, to simulate typing rather than replying instantly. Exposes
-- that as a per-account setting instead — an exact number of seconds,
-- no more baked-in randomness, so "how long before it replies" is
-- something the account can actually see and change.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS reply_delay_seconds integer NOT NULL DEFAULT 4;

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_reply_delay_seconds_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_reply_delay_seconds_check
  CHECK (reply_delay_seconds BETWEEN 0 AND 60);
