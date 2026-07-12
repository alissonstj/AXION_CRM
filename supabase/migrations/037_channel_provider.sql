-- ============================================================
-- whatsapp_config: generalizar para múltiplos provedores de canal.
--
-- MVP: um provedor ativo por conta (UNIQUE(account_id) preservado).
-- Linhas existentes ficam com provider='meta' (default) e leem as
-- mesmas colunas de sempre — zero mudança para o caminho Meta.
--
-- Colunas Evolution ficam nuláveis; usadas só quando provider='evolution'
-- (Fase 2). A base URL + API key global do servidor Evolution NÃO ficam
-- aqui — são env vars (EVOLUTION_API_URL / EVOLUTION_API_KEY).
--
-- Idempotente — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'evolution')),
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS evolution_connection_state TEXT,
  ADD COLUMN IF NOT EXISTS evolution_connected_at TIMESTAMPTZ;

-- O webhook da Evolution resolve a conta pelo nome da instância —
-- espelha como o webhook Meta resolve por phone_number_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_evolution_instance
  ON whatsapp_config (evolution_instance_name)
  WHERE evolution_instance_name IS NOT NULL;
