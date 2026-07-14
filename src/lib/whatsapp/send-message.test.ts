import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockSendText = vi.fn();
vi.mock('@/lib/channels/factory', () => ({
  getChannelForAccount: vi.fn(async () => ({
    id: 'evolution',
    sender: { sendText: mockSendText },
  })),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({
          eq: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
      }),
    }),
  }),
}));

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('sendMessageToConversation — Evolution provider (full DB path)', () => {
  // whatsapp_config.access_token is NULL for provider='evolution' rows
  // (migration 040). Before the fix, this unconditionally decrypted it
  // for every message type — not just 'template', the only type that
  // actually uses it — so any real reply on a connected Evolution
  // account crashed with "Cannot read properties of null (reading
  // 'split')" instead of sending. This pins the fix: a non-template
  // send must reach the provider and succeed without touching
  // access_token at all.
  function makeEvolutionDb(parentMessageRow: Record<string, unknown> | null = null): SupabaseClient {
    const conversation = {
      id: 'cv-1',
      contact: { id: 'contact-1', phone: '+14155550123' },
    };
    const config = {
      id: 'cfg-1',
      provider: 'evolution',
      access_token: null,
      phone_number_id: null,
    };
    let lastTable = '';
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      single: async () => {
        if (lastTable === 'conversations') return { data: conversation, error: null };
        if (lastTable === 'whatsapp_config') return { data: config, error: null };
        if (lastTable === 'messages') return { data: { id: 'msg-1' }, error: null };
        return { data: null, error: null };
      },
      // The reply-target lookup (replyToMessageId) uses maybeSingle on
      // 'messages' — distinct from the post-send insert result above,
      // which uses .single(). Parametrized so reply tests can supply a
      // parent row with sender_type.
      maybeSingle: async () => {
        if (lastTable === 'messages') return { data: parentMessageRow, error: null };
        return { data: null, error: null };
      },
      insert: () => chain,
      update: () => chain,
    };
    return { from: (t: string) => { lastTable = t; return chain; } } as unknown as SupabaseClient;
  }

  it('sends a text reply on an Evolution account without decrypting access_token', async () => {
    mockSendText.mockReset().mockResolvedValue({ providerMessageId: 'evo-msg-1' });
    const result = await sendMessageToConversation(makeEvolutionDb(), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hey there',
    });
    expect(result).toEqual({ messageId: 'msg-1', whatsappMessageId: 'evo-msg-1' });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ to: '14155550123', text: 'hey there' })
    );
  });

  it('resolves contextFromMe=true from the parent message sender_type=agent and forwards it', async () => {
    mockSendText.mockReset().mockResolvedValue({ providerMessageId: 'evo-msg-2' });
    const db = makeEvolutionDb({ message_id: 'PARENT-WAMID', conversation_id: 'cv-1', sender_type: 'agent' });
    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'reply text',
      replyToMessageId: 'parent-uuid',
    });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ contextProviderMessageId: 'PARENT-WAMID', contextFromMe: true }),
    );
  });

  it('resolves contextFromMe=false from the parent message sender_type=customer', async () => {
    mockSendText.mockReset().mockResolvedValue({ providerMessageId: 'evo-msg-3' });
    const db = makeEvolutionDb({ message_id: 'PARENT-WAMID', conversation_id: 'cv-1', sender_type: 'customer' });
    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'reply text',
      replyToMessageId: 'parent-uuid',
    });
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ contextProviderMessageId: 'PARENT-WAMID', contextFromMe: false }),
    );
  });

  it('rejects a template send on an Evolution account with a clear error, not a crash', async () => {
    await expect(
      sendMessageToConversation(makeEvolutionDb(), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'promo',
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});
