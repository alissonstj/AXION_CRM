-- ============================================================
-- 048_conversation_unread_atomic_increment
--
-- Atomic increment of conversations.unread_count
-- (investigacao-indicadores-lista-conversas.md, PONTO 1).
--
-- Before this, ingest.ts did a read-modify-write: it read
-- `conversation.unread_count` once (when the conversation was resolved,
-- earlier in the same request) and later wrote back `<cached> + 1`. Two
-- inbound messages for the same conversation processed concurrently — a
-- customer sending several messages seconds apart, each its own webhook
-- delivery — could both read the same stale count and both write back
-- N+1, permanently losing one bump. That's the "unread badge sometimes
-- doesn't show even after a new message" inconsistency reported: it's a
-- race, not a deterministic difference between conversation types, so it
-- shows up unpredictably. Exact same bug class already fixed once in
-- this codebase for automations.execution_count — see migration 007's
-- doc comment, which describes the identical mechanism.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION increment_conversation_unread(p_conversation_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count = unread_count + 1
  WHERE id = p_conversation_id;
$$;

-- Only the service role needs to call this (ingest.ts uses the
-- service-role client). Explicitly lock anon / authenticated out so an
-- authenticated user can't juice another account's counter via RPC.
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID) FROM anon;
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_conversation_unread(UUID) TO service_role;
