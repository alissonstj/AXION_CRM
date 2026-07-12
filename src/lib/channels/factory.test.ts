import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace('enc:', ''),
}));

import { getChannelForAccount, ChannelConfigError, ChannelLookupError } from './factory';
import { MetaProvider } from './providers/meta';

function dbReturning(row: unknown, error: unknown = null) {
  // Stub mínimo do query-builder do supabase-js usado pela factory:
  // db.from(...).select(...).eq(...).maybeSingle() => { data, error }
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error }),
  };
  return { from: () => chain } as never;
}

describe('getChannelForAccount', () => {
  it('returns a MetaProvider for a provider=meta row', async () => {
    const db = dbReturning({
      provider: 'meta', phone_number_id: 'PNID',
      access_token: 'enc:TOKEN', waba_id: 'WABA',
    });
    const provider = await getChannelForAccount('acc-1', db);
    expect(provider).toBeInstanceOf(MetaProvider);
    expect(provider.id).toBe('meta');
  });

  it('throws ChannelConfigError when no config row exists', async () => {
    const db = dbReturning(null);
    await expect(getChannelForAccount('acc-x', db)).rejects.toBeInstanceOf(ChannelConfigError);
  });

  it('throws ChannelLookupError (not ChannelConfigError) on a real DB error', async () => {
    const db = dbReturning(null, { message: 'connection reset' });
    await expect(getChannelForAccount('acc-x', db)).rejects.toBeInstanceOf(ChannelLookupError);
  });
});
