import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
  sendReactionMessage: vi.fn(),
  verifyPhoneNumber: vi.fn(),
}));

import {
  sendTextMessage,
  sendMediaMessage,
  sendReactionMessage,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import { MetaProvider } from './meta';

const cfg = { phoneNumberId: 'PNID', accessToken: 'TOKEN', wabaId: 'WABA' };

describe('MetaProvider.sender', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sendText maps args onto meta-api and returns the message id', async () => {
    vi.mocked(sendTextMessage).mockResolvedValue({ messageId: 'wamid.1' });
    const provider = new MetaProvider(cfg);

    const result = await provider.sender.sendText({
      to: '+15551234567',
      text: 'oi',
      contextProviderMessageId: 'wamid.parent',
    });

    expect(sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID',
      accessToken: 'TOKEN',
      to: '+15551234567',
      text: 'oi',
      contextMessageId: 'wamid.parent',
    });
    expect(result).toEqual({ providerMessageId: 'wamid.1' });
  });

  it('sendText retries the next phone variant on "recipient not allowed" and reports workingRecipient', async () => {
    vi.mocked(sendTextMessage)
      .mockRejectedValueOnce(new Error('(#131030) Recipient phone number not in allowed list'))
      .mockResolvedValueOnce({ messageId: 'wamid.2' });
    const provider = new MetaProvider(cfg);

    const result = await provider.sender.sendText({ to: '+5511987654321', text: 'oi' });

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(result.providerMessageId).toBe('wamid.2');
    expect(result.workingRecipient).toBeTruthy();
    expect(result.workingRecipient).not.toBe('+5511987654321');
  });

  it('sendMedia forwards kind/link/caption/filename', async () => {
    vi.mocked(sendMediaMessage).mockResolvedValue({ messageId: 'wamid.3' });
    const provider = new MetaProvider(cfg);

    await provider.sender.sendMedia({
      to: '+15551234567', kind: 'document', link: 'https://x/y.pdf',
      caption: 'nota', filename: 'y.pdf',
    });

    expect(sendMediaMessage).toHaveBeenCalledWith(expect.objectContaining({
      phoneNumberId: 'PNID', accessToken: 'TOKEN', to: '+15551234567',
      kind: 'document', link: 'https://x/y.pdf', caption: 'nota', filename: 'y.pdf',
    }));
  });

  it('sendReaction forwards targetProviderMessageId + emoji, ignores targetFromMe', async () => {
    vi.mocked(sendReactionMessage).mockResolvedValue({ messageId: 'wamid.4' });
    const provider = new MetaProvider(cfg);

    const result = await provider.sender.sendReaction({
      to: '+15551234567', targetProviderMessageId: 'wamid.parent', targetFromMe: true, emoji: '👍',
    });

    expect(sendReactionMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID', accessToken: 'TOKEN', to: '+15551234567',
      targetMessageId: 'wamid.parent', emoji: '👍',
    });
    expect(result).toEqual({ providerMessageId: 'wamid.4' });
  });

  it('sendReaction retries the next phone variant on "recipient not allowed"', async () => {
    vi.mocked(sendReactionMessage)
      .mockRejectedValueOnce(new Error('(#131030) Recipient phone number not in allowed list'))
      .mockResolvedValueOnce({ messageId: 'wamid.5' });
    const provider = new MetaProvider(cfg);

    const result = await provider.sender.sendReaction({
      to: '+5511987654321', targetProviderMessageId: 'wamid.parent', targetFromMe: false, emoji: '',
    });

    expect(sendReactionMessage).toHaveBeenCalledTimes(2);
    expect(result.providerMessageId).toBe('wamid.5');
  });
});

describe('MetaProvider.parseWebhook', () => {
  const provider = new MetaProvider(cfg);

  it('maps a text message', () => {
    const payload = {
      entry: [{ id: 'e', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'PNID', display_phone_number: '1' },
        contacts: [{ profile: { name: 'Ana' }, wa_id: '15551234567' }],
        messages: [{ id: 'wamid.a', from: '15551234567', timestamp: '1700000000', type: 'text', text: { body: 'oi' } }],
      } }] }],
    };
    const out = provider.parseWebhook(payload);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.a',
      kind: 'text', text: 'oi',
    });
    expect(out[0].timestamp).toBeInstanceOf(Date);
  });

  it('maps an interactive button reply to interactive_reply with the id', () => {
    const payload = { entry: [{ id: 'e', changes: [{ field: 'messages', value: {
      contacts: [{ profile: { name: 'Bo' }, wa_id: '15550000000' }],
      messages: [{ id: 'wamid.b', from: '15550000000', timestamp: '1700000001', type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Sim' } } }],
    } }] }] };
    const out = provider.parseWebhook(payload);
    expect(out[0]).toMatchObject({ kind: 'interactive_reply', interactiveReplyId: 'yes', text: 'Sim' });
  });

  it('maps a reaction with its target', () => {
    const payload = { entry: [{ id: 'e', changes: [{ field: 'messages', value: {
      contacts: [{ profile: { name: 'C' }, wa_id: '15550000001' }],
      messages: [{ id: 'wamid.c', from: '15550000001', timestamp: '1700000002', type: 'reaction',
        reaction: { message_id: 'wamid.target', emoji: '👍' } }],
    } }] }] };
    const out = provider.parseWebhook(payload);
    expect(out[0]).toMatchObject({ kind: 'reaction', reaction: { targetProviderMessageId: 'wamid.target', emoji: '👍' } });
  });

  it('ignores status-only and template change payloads (returns [])', () => {
    const statusPayload = { entry: [{ id: 'e', changes: [{ field: 'messages', value: {
      statuses: [{ id: 'wamid.s', status: 'delivered', timestamp: '1700000003', recipient_id: '1' }],
    } }] }] };
    expect(provider.parseWebhook(statusPayload)).toEqual([]);
  });
});

describe('MetaProvider lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getConnectionState returns connected when Meta verifies the number', async () => {
    vi.mocked(verifyPhoneNumber).mockResolvedValue({ id: 'PNID', display_phone_number: '+1 555' });
    const provider = new MetaProvider(cfg);
    const state = await provider.getConnectionState();
    expect(state.status).toBe('connected');
    expect(verifyPhoneNumber).toHaveBeenCalledWith({ phoneNumberId: 'PNID', accessToken: 'TOKEN' });
  });

  it('getConnectionState returns error when Meta rejects', async () => {
    vi.mocked(verifyPhoneNumber).mockRejectedValue(new Error('Invalid OAuth token'));
    const provider = new MetaProvider(cfg);
    const state = await provider.getConnectionState();
    expect(state.status).toBe('error');
    expect(state.detail).toContain('Invalid OAuth token');
  });

  it('disconnect is a no-op for Meta (does not throw)', async () => {
    const provider = new MetaProvider(cfg);
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });
});
