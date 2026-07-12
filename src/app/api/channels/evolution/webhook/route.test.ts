import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` factories run during ESM import resolution — before any of
// this file's own top-level statements execute (imports always resolve
// ahead of the importing module's body). A plain `const mockIngestInbound
// = vi.fn()` read directly inside the factory below hits the TDZ.
// `vi.hoisted()` runs its initializer as part of that same hoisting
// phase, so the value exists by the time the factory needs it.
const { mockIngestInbound } = vi.hoisted(() => ({
  mockIngestInbound: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/channels/ingest', () => ({ ingestInbound: mockIngestInbound }));
vi.mock('@/lib/channels/evolution-media', () => ({
  uploadEvolutionMedia: vi.fn().mockResolvedValue('https://cdn.local/chat-media/x.jpg'),
}));

function dbReturning(config: Record<string, unknown> | null) {
  const chain = {
    select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: config, error: null }),
    update: () => ({ eq: async () => ({ error: null }) }),
  };
  return { from: () => chain } as never;
}

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => dbReturning(mockConfigRow) }));

let mockConfigRow: Record<string, unknown> | null;

beforeEach(() => {
  mockIngestInbound.mockClear();
  mockConfigRow = {
    account_id: 'acc-1', user_id: 'user-1',
    evolution_instance_name: 'axion-acc1', evolution_instance_token: 'enc:tok',
  };
});

// decrypt('enc:tok') must resolve to a plain token for the apikey check —
// mock it deterministically rather than pulling in real AES.
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace('enc:', '') }));

import { POST } from './route';
import { TEXT_INBOUND_SAMPLE } from '@/lib/channels/providers/__fixtures__/evolution-webhook-samples';

function req(body: unknown) {
  return new Request('http://localhost/api/channels/evolution/webhook', {
    method: 'POST', body: JSON.stringify(body),
  });
}

describe('POST /api/channels/evolution/webhook', () => {
  it('rejects a request whose body apikey does not match the instance token', async () => {
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'wrong' }));
    expect(res.status).toBe(401);
    expect(mockIngestInbound).not.toHaveBeenCalled();
  });

  it('ingests a valid messages.upsert with matching apikey', async () => {
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'text', text: 'Oiiiii teste' }),
      expect.objectContaining({ accountId: 'acc-1', configOwnerUserId: 'user-1' }),
    );
  });

  it('returns 200 without ingesting when no config matches the instance name', async () => {
    mockConfigRow = null;
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).not.toHaveBeenCalled();
  });
});
