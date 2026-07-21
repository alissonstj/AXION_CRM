import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUser = { id: 'user-1' };
let mockProfile: { account_id: string } | null = { account_id: 'acc-1' };
let mockConfig: Record<string, unknown> | null = null;
let lastUpsert: Record<string, unknown> | null = null;
let lastUpdate: Record<string, unknown> | null = null;
let capturedProviderConfig: Record<string, unknown> | null = null;

function makeSupabase() {
  let lastTable = '';
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => {
      if (lastTable === 'profiles') return { data: mockProfile, error: null };
      return { data: mockConfig, error: null };
    },
    upsert: (row: Record<string, unknown>) => {
      lastUpsert = row;
      return { select: () => ({ single: async () => ({ data: { ...row, id: 'cfg-1' }, error: null }) }) };
    },
    update: (row: Record<string, unknown>) => {
      lastUpdate = row;
      return { eq: async () => ({ error: null }) };
    },
  };
  return {
    auth: { getUser: async () => ({ data: { user: mockUser }, error: null }) },
    from: (t: string) => { lastTable = t; return chain; },
  } as never;
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeSupabase() }));
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace('enc:', '') }));
vi.mock('@/lib/whatsapp/evolution-api', () => ({
  createEvolutionInstance: vi.fn(),
  connectEvolutionInstance: vi.fn(),
  setEvolutionWebhook: vi.fn(),
}));

const mockDisconnect = vi.fn();
vi.mock('@/lib/channels/providers/evolution', () => ({
  // vitest v4 requires an actual `function` (not an arrow fn) for a mock
  // implementation to be usable with `new` — see
  // https://vitest.dev/api/vi#vi-spyon. The brief's arrow-fn sketch throws
  // "is not a constructor" here; this is behaviourally identical (returns
  // an object exposing `disconnect`), just constructor-callable.
  EvolutionProvider: vi.fn().mockImplementation(function (config: Record<string, unknown>) {
    capturedProviderConfig = config;
    return { disconnect: mockDisconnect };
  }),
}));

beforeEach(() => {
  mockProfile = { account_id: 'acc-1' };
  mockConfig = null;
  lastUpsert = null;
  lastUpdate = null;
  capturedProviderConfig = null;
  mockDisconnect.mockReset().mockResolvedValue(undefined);
  vi.mocked(setEvolutionWebhook).mockReset().mockResolvedValue(undefined);
  process.env.EVOLUTION_API_KEY = 'test-admin-key';
  process.env.EVOLUTION_API_URL = 'http://localhost:3001';
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
});

import { POST, DELETE } from './route';
import { createEvolutionInstance, connectEvolutionInstance, setEvolutionWebhook } from '@/lib/whatsapp/evolution-api';

describe('POST /api/channels/evolution/connect', () => {
  it('creates a new instance (global key), encrypts + persists the returned token, and returns the QR', async () => {
    vi.mocked(createEvolutionInstance).mockResolvedValue({ token: 'fresh-token', qrCode: 'data:image/png;base64,AAA' });
    const res = await POST(new Request('http://localhost/api/channels/evolution/connect', { method: 'POST' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'connecting', qrCode: 'data:image/png;base64,AAA' });
    expect(lastUpsert).toMatchObject({
      account_id: 'acc-1', user_id: 'user-1', provider: 'evolution',
      evolution_instance_token: 'enc:fresh-token',
      evolution_qr_code: 'data:image/png;base64,AAA',
    });
    // The whole point of the fix: createEvolutionInstance must never be
    // called with a webhook block (see its own doc comment for why), and
    // setEvolutionWebhook only turns delivery on AFTER the token above is
    // already saved via the upsert.
    expect(createEvolutionInstance).toHaveBeenCalledWith(
      expect.not.objectContaining({ webhookUrl: expect.anything() }),
    );
    expect(setEvolutionWebhook).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'fresh-token',
      webhookUrl: 'http://localhost:3000/api/channels/evolution/webhook',
    }));
  });

  it('reconnects an existing instance (instance token) without calling createEvolutionInstance', async () => {
    mockConfig = { evolution_instance_token: 'enc:existing-token' };
    vi.mocked(connectEvolutionInstance).mockResolvedValue({ qrCode: 'data:image/png;base64,BBB' });
    const res = await POST(new Request('http://localhost/api/channels/evolution/connect', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(createEvolutionInstance).not.toHaveBeenCalled();
    expect(connectEvolutionInstance).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'existing-token' }));
    expect(lastUpsert).toMatchObject({ evolution_instance_token: 'enc:existing-token', evolution_qr_code: 'data:image/png;base64,BBB' });
    expect(setEvolutionWebhook).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'existing-token' }));
  });

  it('still returns the QR even when setEvolutionWebhook fails — the pairing flow must not be blocked by it', async () => {
    vi.mocked(createEvolutionInstance).mockResolvedValue({ token: 'fresh-token', qrCode: 'data:image/png;base64,AAA' });
    vi.mocked(setEvolutionWebhook).mockRejectedValue(new Error('evolution unreachable'));
    const res = await POST(new Request('http://localhost/api/channels/evolution/connect', { method: 'POST' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'connecting', qrCode: 'data:image/png;base64,AAA' });
  });

  it('401s when unauthenticated', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
    }));
    vi.resetModules();
    const { POST: freshPost } = await import('./route');
    const res = await freshPost(new Request('http://localhost/api/channels/evolution/connect', { method: 'POST' }));
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/channels/evolution/connect', () => {
  it('calls disconnect and marks the row disconnected', async () => {
    mockConfig = { id: 'cfg-1', account_id: 'acc-1', evolution_instance_name: 'axion-acc1', evolution_instance_token: 'enc:tok' };
    const res = await DELETE(new Request('http://localhost/api/channels/evolution/connect', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(mockDisconnect).toHaveBeenCalled();
    expect(capturedProviderConfig).toMatchObject({
      adminApiKey: expect.any(String),
    });
  });

  it('clears evolution_instance_token so a later connect creates a fresh instance instead of trying to reconnect to the one just deleted', async () => {
    // Regression: disconnect() deletes the instance in Evolution, but the
    // old code left evolution_instance_token in place — so POST's
    // `isNewInstance = !existing?.evolution_instance_token` read it as
    // "still exists" and called connectEvolutionInstance against an
    // instance Evolution had already deleted, failing with "instance does
    // not exist" (reproduced live 2026-07-17).
    mockConfig = { id: 'cfg-1', account_id: 'acc-1', evolution_instance_name: 'axion-acc1', evolution_instance_token: 'enc:tok' };
    await DELETE(new Request('http://localhost/api/channels/evolution/connect', { method: 'DELETE' }));
    expect(lastUpdate).toMatchObject({ evolution_instance_token: null });
  });
});
