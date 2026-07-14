import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockTargetMessage: Record<string, unknown> | null;
let lastReactionDelete: { messageId: string } | null;
let lastReactionUpsert: Record<string, unknown> | null;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (t: string) => {
      if (t === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_id: 'acc-1' } }) }) }) };
      }
      if (t === 'messages') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mockTargetMessage, error: null }) }) }) };
      }
      if (t === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: 'conv-1', account_id: 'acc-1', contact: { phone: '+15551234567' } },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (t === 'message_reactions') {
        return {
          delete: () => ({
            eq: (col: string, val: string) => {
              if (col === 'message_id') lastReactionDelete = { messageId: val };
              return { eq: () => ({ eq: async () => ({ error: null }) }) };
            },
          }),
          upsert: (row: Record<string, unknown>) => {
            lastReactionUpsert = row;
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table in test: ${t}`);
    },
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { react: {} },
}));

const { mockSendReaction, providerState } = vi.hoisted(() => ({
  mockSendReaction: vi.fn(),
  providerState: { id: 'evolution' },
}));

vi.mock('@/lib/channels/factory', () => ({
  getChannelForAccount: vi.fn(async () => ({
    id: providerState.id,
    sender: { sendReaction: mockSendReaction },
  })),
  ChannelConfigError: class ChannelConfigError extends Error {},
}));

import { POST } from './route';
import { getChannelForAccount, ChannelConfigError } from '@/lib/channels/factory';

function req(body: unknown) {
  return new Request('http://localhost/api/whatsapp/react', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  providerState.id = 'evolution';
  mockSendReaction.mockReset().mockResolvedValue({ providerMessageId: 'REACT-1' });
  vi.mocked(getChannelForAccount).mockReset().mockImplementation(
    async () => ({ id: providerState.id, sender: { sendReaction: mockSendReaction } }) as never,
  );
  mockTargetMessage = { id: 'msg-1', message_id: 'WAMID-1', conversation_id: 'conv-1', sender_type: 'customer' };
  lastReactionDelete = null;
  lastReactionUpsert = null;
});

describe('POST /api/whatsapp/react', () => {
  it('sends via provider.sender.sendReaction and upserts the DB row (Evolution account)', async () => {
    const res = await POST(req({ message_id: 'msg-1', emoji: '👍' }));
    expect(res.status).toBe(200);
    expect(mockSendReaction).toHaveBeenCalledWith({
      to: '15551234567', targetProviderMessageId: 'WAMID-1', targetFromMe: false, emoji: '👍',
    });
    expect(lastReactionUpsert).toMatchObject({ message_id: 'msg-1', actor_type: 'agent', actor_id: 'user-1', emoji: '👍' });
  });

  it('works identically for a Meta account — the route does not branch on provider.id', async () => {
    providerState.id = 'meta';
    const res = await POST(req({ message_id: 'msg-1', emoji: '❤️' }));
    expect(res.status).toBe(200);
    expect(mockSendReaction).toHaveBeenCalledWith(expect.objectContaining({ emoji: '❤️' }));
  });

  it('derives targetFromMe from sender_type: agent → true', async () => {
    mockTargetMessage = { id: 'msg-1', message_id: 'WAMID-1', conversation_id: 'conv-1', sender_type: 'agent' };
    await POST(req({ message_id: 'msg-1', emoji: '👍' }));
    expect(mockSendReaction).toHaveBeenCalledWith(expect.objectContaining({ targetFromMe: true }));
  });

  it('an empty emoji deletes the reaction instead of upserting', async () => {
    const res = await POST(req({ message_id: 'msg-1', emoji: '' }));
    expect(res.status).toBe(200);
    expect(lastReactionDelete).toEqual({ messageId: 'msg-1' });
    expect(lastReactionUpsert).toBeNull();
  });

  it('404s when the target message does not exist', async () => {
    mockTargetMessage = null;
    const res = await POST(req({ message_id: 'missing', emoji: '👍' }));
    expect(res.status).toBe(404);
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it('400s when the target message was never sent to WhatsApp (no message_id)', async () => {
    mockTargetMessage = { id: 'msg-1', message_id: null, conversation_id: 'conv-1', sender_type: 'agent' };
    const res = await POST(req({ message_id: 'msg-1', emoji: '👍' }));
    expect(res.status).toBe(400);
    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it('400s with a clear message when the account has no channel configured', async () => {
    vi.mocked(getChannelForAccount).mockRejectedValueOnce(new ChannelConfigError('acc-1'));
    const res = await POST(req({ message_id: 'msg-1', emoji: '👍' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/not configured/i);
  });

  it('502s with the provider error when sendReaction fails — this is the exact path that used to crash', async () => {
    // Before routing through the seam, this path unconditionally
    // decrypted whatsapp_config.access_token regardless of provider —
    // for an Evolution account (access_token NULL since migration 040)
    // that threw a raw TypeError instead of reaching this clean 502.
    mockSendReaction.mockRejectedValue(new Error('Evolution API error: 404'));
    const res = await POST(req({ message_id: 'msg-1', emoji: '👍' }));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('Failed to send reaction: Evolution API error: 404');
  });
});
