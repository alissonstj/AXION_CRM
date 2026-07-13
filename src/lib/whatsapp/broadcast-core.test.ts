import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBroadcast, BroadcastError } from './broadcast-core';

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('createBroadcast — provider guard', () => {
  // Public v1 broadcasts are template-only by design; access_token is
  // NULL for provider='evolution' rows (migration 040). This pins the
  // guard added alongside that migration: an Evolution-connected
  // account must get a clear 400, not decrypt() throwing on null.
  function dbWithConfig(config: Record<string, unknown> | null): SupabaseClient {
    const chain = {
      select: () => chain,
      eq: () => chain,
      single: async () => ({ data: config, error: config ? null : { message: 'not found' } }),
    };
    return { from: () => chain } as unknown as SupabaseClient;
  }

  it('rejects a provider=evolution account with a clear message instead of crashing', async () => {
    const db = dbWithConfig({ id: 'cfg-1', provider: 'evolution', access_token: null, phone_number_id: null });
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400, message: expect.stringMatching(/Meta/) });
  });
});
