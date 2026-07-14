import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockConversation: Record<string, unknown> | null;
let mockLastCustomerMessage: Record<string, unknown> | null;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (t: string) => {
      if (t === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_id: 'acc-1' } }) }) }) };
      }
      if (t === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: mockConversation, error: null }) }),
            }),
          }),
        };
      }
      if (t === 'messages') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                not: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({ data: mockLastCustomerMessage, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table in test: ${t}`);
    },
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { markRead: {} },
}));

const { mockMarkAsRead, providerState } = vi.hoisted(() => ({
  mockMarkAsRead: vi.fn(),
  providerState: { id: 'evolution' },
}));

vi.mock('@/lib/channels/factory', () => ({
  getChannelForAccount: vi.fn(async () => ({
    id: providerState.id,
    sender: { markAsRead: mockMarkAsRead },
  })),
  ChannelConfigError: class ChannelConfigError extends Error {},
}));

import { POST } from './route';
import { getChannelForAccount, ChannelConfigError } from '@/lib/channels/factory';

function req(body: unknown) {
  return new Request('http://localhost/api/whatsapp/mark-read', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  providerState.id = 'evolution';
  mockMarkAsRead.mockReset().mockResolvedValue(undefined);
  vi.mocked(getChannelForAccount).mockReset().mockImplementation(
    async () => ({ id: providerState.id, sender: { markAsRead: mockMarkAsRead } }) as never,
  );
  mockConversation = { id: 'conv-1', contact: { phone: '+15551234567' } };
  mockLastCustomerMessage = { message_id: 'WAMID-LAST' };
});

describe('POST /api/whatsapp/mark-read', () => {
  it('marks the most recent customer message as read via the provider', async () => {
    const res = await POST(req({ conversation_id: 'conv-1' }));
    expect(res.status).toBe(200);
    expect(mockMarkAsRead).toHaveBeenCalledWith({ to: '15551234567', providerMessageId: 'WAMID-LAST' });
  });

  it('works for a Meta account too — no provider-specific branching', async () => {
    providerState.id = 'meta';
    const res = await POST(req({ conversation_id: 'conv-1' }));
    expect(res.status).toBe(200);
    expect(mockMarkAsRead).toHaveBeenCalled();
  });

  it('400s when conversation_id is missing', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(mockMarkAsRead).not.toHaveBeenCalled();
  });

  it('404s when the conversation does not belong to the caller\'s account', async () => {
    mockConversation = null;
    const res = await POST(req({ conversation_id: 'conv-999' }));
    expect(res.status).toBe(404);
    expect(mockMarkAsRead).not.toHaveBeenCalled();
  });

  it('no-ops (200) when the contact has no phone number', async () => {
    mockConversation = { id: 'conv-1', contact: null };
    const res = await POST(req({ conversation_id: 'conv-1' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('noop');
    expect(mockMarkAsRead).not.toHaveBeenCalled();
  });

  it('no-ops (200) when the customer has never sent a message with a provider id', async () => {
    mockLastCustomerMessage = null;
    const res = await POST(req({ conversation_id: 'conv-1' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('noop');
    expect(mockMarkAsRead).not.toHaveBeenCalled();
  });

  it('no-ops (200), not an error, when the account has no channel configured', async () => {
    vi.mocked(getChannelForAccount).mockRejectedValueOnce(new ChannelConfigError('acc-1'));
    const res = await POST(req({ conversation_id: 'conv-1' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('noop');
  });

  it('still returns 200 when the provider call itself fails — best-effort, never surfaced as an error', async () => {
    mockMarkAsRead.mockRejectedValue(new Error('Evolution API error: 500'));
    const res = await POST(req({ conversation_id: 'conv-1' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
  });
});
