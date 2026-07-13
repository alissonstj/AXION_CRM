import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockConfig: Record<string, unknown> | null = null;
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (t: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: t === 'profiles' ? { account_id: 'acc-1' } : mockConfig,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

beforeEach(() => { mockConfig = null; });

import { GET } from './route';

describe('GET /api/channels/evolution/state', () => {
  it('returns disconnected with no qr when no config row exists', async () => {
    const res = await GET(new Request('http://localhost/api/channels/evolution/state'));
    const json = await res.json();
    expect(json).toEqual({ status: 'disconnected', qrCode: null, qrUpdatedAt: null, detail: null });
  });

  it('returns the cached connecting state + qr', async () => {
    mockConfig = {
      evolution_connection_state: 'connecting',
      evolution_qr_code: 'data:image/png;base64,AAA',
      evolution_qr_updated_at: '2026-07-12T20:00:00.000Z',
      evolution_last_error: null,
    };
    const res = await GET(new Request('http://localhost/api/channels/evolution/state'));
    const json = await res.json();
    expect(json).toEqual({
      status: 'connecting', qrCode: 'data:image/png;base64,AAA',
      qrUpdatedAt: '2026-07-12T20:00:00.000Z', detail: null,
    });
  });

  it('surfaces evolution_last_error as detail when status is error', async () => {
    mockConfig = { evolution_connection_state: 'error', evolution_qr_code: null, evolution_qr_updated_at: null, evolution_last_error: 'state=refused reason=428' };
    const res = await GET(new Request('http://localhost/api/channels/evolution/state'));
    const json = await res.json();
    expect(json).toMatchObject({ status: 'error', detail: 'state=refused reason=428' });
  });
});
