import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireRole, mockResolveConversationByPhone } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockResolveConversationByPhone: vi.fn(),
}));

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return { ...actual, requireRole: mockRequireRole };
});

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: mockResolveConversationByPhone,
}));

let mockDeal: Record<string, unknown> | null;
let lastInsert: Record<string, unknown> | null;

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'deals') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: mockDeal, error: null }) }),
            }),
          }),
        };
      }
      if (table === 'scheduled_messages') {
        return {
          insert: (row: Record<string, unknown>) => {
            lastInsert = row;
            return {
              select: () => ({
                single: async () => ({ data: { id: 'sched-1', ...row }, error: null }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table in this test: ${table}`);
    },
  }),
}));

import { POST } from './route';
import { ForbiddenError } from '@/lib/auth/account';
import { SendMessageError } from '@/lib/whatsapp/send-message';

function req(body: unknown) {
  return new Request('http://localhost/api/scheduled-messages', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const FUTURE = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

beforeEach(() => {
  mockRequireRole.mockReset().mockResolvedValue({
    supabase: {}, userId: 'user-1', accountId: 'acc-1', role: 'agent',
    account: { id: 'acc-1', name: 'Acc' },
  });
  mockResolveConversationByPhone.mockReset().mockResolvedValue({
    conversationId: 'conv-1', contactId: 'contact-1', contactCreated: false,
  });
  mockDeal = { id: 'deal-1', contact: { id: 'contact-1', phone: '+15551234567', name: 'Alisson' } };
  lastInsert = null;
});

describe('POST /api/scheduled-messages', () => {
  it('403s when the caller lacks the agent role', async () => {
    mockRequireRole.mockRejectedValue(new ForbiddenError("This action requires the 'agent' role or higher"));
    const res = await POST(req({ deal_id: 'deal-1', content_type: 'text', content_text: 'oi', scheduled_at: FUTURE }));
    expect(res.status).toBe(403);
  });

  it('400s on invalid JSON', async () => {
    const res = await POST(req(undefined));
    expect(res.status).toBe(400);
  });

  it('400s when deal_id is missing', async () => {
    const res = await POST(req({ content_type: 'text', content_text: 'oi', scheduled_at: FUTURE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/deal_id/);
  });

  it('400s on an unsupported content_type', async () => {
    const res = await POST(req({ deal_id: 'deal-1', content_type: 'sticker', scheduled_at: FUTURE }));
    expect(res.status).toBe(400);
  });

  it('400s when a text message has no content_text', async () => {
    const res = await POST(req({ deal_id: 'deal-1', content_type: 'text', scheduled_at: FUTURE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/content_text/);
  });

  it('400s when a media message has no media_url', async () => {
    const res = await POST(req({ deal_id: 'deal-1', content_type: 'image', scheduled_at: FUTURE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/media_url/);
  });

  it('400s when scheduled_at is missing or not a valid date', async () => {
    expect((await POST(req({ deal_id: 'deal-1', content_type: 'text', content_text: 'oi' }))).status).toBe(400);
    expect((await POST(req({ deal_id: 'deal-1', content_type: 'text', content_text: 'oi', scheduled_at: 'not-a-date' }))).status).toBe(400);
  });

  it('400s when scheduled_at is in the past', async () => {
    const res = await POST(req({ deal_id: 'deal-1', content_type: 'text', content_text: 'oi', scheduled_at: PAST }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/future/);
  });

  it('404s when the deal does not belong to the caller\'s account', async () => {
    mockDeal = null;
    const res = await POST(req({ deal_id: 'deal-1', content_type: 'text', content_text: 'oi', scheduled_at: FUTURE }));
    expect(res.status).toBe(404);
  });

  it('400s when the deal has no linked contact', async () => {
    mockDeal = { id: 'deal-1', contact: null };
    const res = await POST(req({ deal_id: 'deal-1', content_type: 'text', content_text: 'oi', scheduled_at: FUTURE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no linked contact/);
  });

  it('surfaces resolveConversationByPhone failures with their own status/message (e.g. no WhatsApp configured)', async () => {
    mockResolveConversationByPhone.mockRejectedValue(
      new SendMessageError('whatsapp_not_configured', 'WhatsApp not configured. Please set up your WhatsApp integration first.', 400),
    );
    const res = await POST(req({ deal_id: 'deal-1', content_type: 'text', content_text: 'oi', scheduled_at: FUTURE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/WhatsApp not configured/);
  });

  it('creates a pending scheduled text message on the happy path', async () => {
    const res = await POST(req({
      deal_id: 'deal-1', title: '20-day follow-up', content_type: 'text',
      content_text: 'Oi #primeiroNome', scheduled_at: FUTURE,
    }));
    expect(res.status).toBe(201);
    expect(mockResolveConversationByPhone).toHaveBeenCalledWith(expect.anything(), 'acc-1', '+15551234567', 'Alisson');
    expect(lastInsert).toMatchObject({
      account_id: 'acc-1', user_id: 'user-1', contact_id: 'contact-1', conversation_id: 'conv-1',
      deal_id: 'deal-1', title: '20-day follow-up', content_type: 'text', content_text: 'Oi #primeiroNome',
    });
    expect((await res.json()).scheduled_message.id).toBe('sched-1');
  });

  it('creates a pending scheduled media message with media_url and no title', async () => {
    const res = await POST(req({
      deal_id: 'deal-1', content_type: 'image', media_url: 'https://cdn.local/x.jpg', scheduled_at: FUTURE,
    }));
    expect(res.status).toBe(201);
    expect(lastInsert).toMatchObject({ content_type: 'image', media_url: 'https://cdn.local/x.jpg', title: null });
  });

  it('passes through quick_reply_id when provided', async () => {
    await POST(req({
      deal_id: 'deal-1', content_type: 'text', content_text: 'oi', quick_reply_id: 'qr-1', scheduled_at: FUTURE,
    }));
    expect(lastInsert).toMatchObject({ quick_reply_id: 'qr-1' });
  });
});
