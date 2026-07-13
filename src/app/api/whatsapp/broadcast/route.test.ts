import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (t: string) => {
      if (t === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_id: 'acc-1' } }) }) }) };
      }
      // Only reached by the untouched template path — freeform never
      // queries these (it resolves the provider via the fully-mocked
      // `getChannelForAccount` below, which doesn't touch supabase).
      if (t === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { access_token: 'enc-token', phone_number_id: 'PN-1' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (t === 'message_templates') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
          }),
        };
      }
      throw new Error(`unexpected table in test: ${t}`);
    },
  }),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { broadcast: {} },
}));

const { mockSendText, mockSendMedia, mockSendTemplateMessage, providerState } = vi.hoisted(() => ({
  mockSendText: vi.fn(),
  mockSendMedia: vi.fn(),
  mockSendTemplateMessage: vi.fn(),
  providerState: { id: 'evolution' },
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage: mockSendTemplateMessage }));

vi.mock('@/lib/channels/factory', () => ({
  getChannelForAccount: vi.fn(async () => ({
    id: providerState.id,
    sender: { sendText: mockSendText, sendMedia: mockSendMedia },
  })),
  ChannelConfigError: class ChannelConfigError extends Error {},
}));

import { POST } from './route';

function req(body: unknown) {
  return new Request('http://localhost/api/whatsapp/broadcast', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  providerState.id = 'evolution';
  mockSendText.mockReset().mockResolvedValue({ providerMessageId: 'EVO-1' });
  mockSendMedia.mockReset().mockResolvedValue({ providerMessageId: 'EVO-2' });
  mockSendTemplateMessage.mockReset().mockResolvedValue({ messageId: 'WA-1' });
});

describe('POST /api/whatsapp/broadcast — freeform', () => {
  it('sends text via provider.sender.sendText for an evolution account', async () => {
    const res = await POST(req({
      kind: 'freeform',
      recipients: [{ phone: '+15551234567', text: 'oi joao' }],
      message_media_url: undefined,
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sent).toBe(1);
    // sanitizePhoneForMeta strips non-digit chars (incl. the leading
    // `+`) before the number reaches the provider — see phone-utils.ts.
    expect(mockSendText).toHaveBeenCalledWith(expect.objectContaining({ to: '15551234567', text: 'oi joao' }));
  });

  it('sends media via provider.sender.sendMedia when message_media_url is present', async () => {
    const res = await POST(req({
      kind: 'freeform',
      recipients: [{ phone: '+15551234567', text: 'legenda' }],
      message_media_url: 'https://x/a.jpg',
      message_media_type: 'image',
    }));
    expect(res.status).toBe(200);
    expect(mockSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ to: '15551234567', kind: 'image', link: 'https://x/a.jpg', caption: 'legenda' }),
    );
  });

  it('rejects freeform for a meta account', async () => {
    providerState.id = 'meta';
    const res = await POST(req({
      kind: 'freeform',
      recipients: [{ phone: '+15551234567', text: 'oi' }],
    }));
    expect(res.status).toBe(400);
    expect(mockSendText).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/broadcast — template', () => {
  it('sends via sendTemplateMessage for a meta account (unchanged path)', async () => {
    providerState.id = 'meta';
    const res = await POST(req({
      kind: 'template',
      recipients: [{ phone: '+15551234567', params: ['x'] }],
      template_name: 'hello_world',
      template_language: 'en_US',
    }));
    expect(res.status).toBe(200);
    expect(mockSendTemplateMessage).toHaveBeenCalled();
  });

  it('rejects template for an evolution account', async () => {
    const res = await POST(req({
      kind: 'template',
      recipients: [{ phone: '+15551234567', params: [] }],
      template_name: 'hello_world',
    }));
    expect(res.status).toBe(400);
    expect(mockSendTemplateMessage).not.toHaveBeenCalled();
  });
});
