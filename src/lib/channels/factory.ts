import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { MetaProvider } from './providers/meta';
import type { ChannelProvider } from './types';

/** Config de canal ausente para a conta. */
export class ChannelConfigError extends Error {
  constructor(accountId: string) {
    super(`No channel config for account ${accountId}`);
    this.name = 'ChannelConfigError';
  }
}

/** Provedor ainda não implementado nesta fase (Evolution → Fase 2). */
export class ChannelNotImplementedError extends Error {
  constructor(provider: string) {
    super(`Channel provider "${provider}" is not implemented yet`);
    this.name = 'ChannelNotImplementedError';
  }
}

/** Falha real do Supabase ao buscar a config — distinta de "sem config",
 *  para não mascarar uma falha de infra como ChannelConfigError. */
export class ChannelLookupError extends Error {
  constructor(accountId: string, cause: unknown) {
    super(`Failed to look up channel config for account ${accountId}: ${String(cause)}`);
    this.name = 'ChannelLookupError';
  }
}

/**
 * Resolve o provedor de canal ativo da conta. Costura única entre os
 * callers e a implementação de provedor — o formato de armazenamento
 * pode mudar aqui embaixo sem tocar em nenhum caller.
 */
export async function getChannelForAccount(
  accountId: string,
  db: SupabaseClient,
): Promise<ChannelProvider> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) throw new ChannelLookupError(accountId, error);
  if (!config) throw new ChannelConfigError(accountId);

  const provider = (config.provider as string) ?? 'meta';
  if (provider === 'meta') {
    return new MetaProvider({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      wabaId: config.waba_id ?? null,
    });
  }
  throw new ChannelNotImplementedError(provider);
}
