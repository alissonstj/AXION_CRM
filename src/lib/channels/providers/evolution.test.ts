import { describe, it, expect, vi } from 'vitest';
import * as evolutionApi from '@/lib/whatsapp/evolution-api';
import { EvolutionProvider } from './evolution';
import {
  TEXT_INBOUND_SAMPLE, FROM_ME_ECHO_SAMPLE, IMAGE_INBOUND_SAMPLE, AUDIO_INBOUND_SAMPLE,
  VIDEO_GROUP_SAMPLE, DOCUMENT_INBOUND_SAMPLE, LOCATION_INBOUND_SAMPLE, REACTION_INBOUND_SAMPLE,
  BUTTON_REPLY_INBOUND_SAMPLE, CONNECTION_UPDATE_ERROR_SAMPLE, REPLY_INBOUND_SAMPLE,
  STICKER_INBOUND_SAMPLE,
} from './__fixtures__/evolution-webhook-samples';

const config = { baseUrl: 'http://evo.local', apiKey: 'instance-token', instanceName: 'axion-acc1' };

describe('EvolutionProvider.sender', () => {
  it('sendText calls sendEvolutionText with the instance config and args', async () => {
    vi.spyOn(evolutionApi, 'sendEvolutionText').mockResolvedValue({ messageId: 'ID1' });
    const provider = new EvolutionProvider(config);
    const result = await provider.sender.sendText({ to: '5511999999999', text: 'oi' });
    expect(result).toEqual({ providerMessageId: 'ID1' });
    expect(evolutionApi.sendEvolutionText).toHaveBeenCalledWith({
      baseUrl: 'http://evo.local', apiKey: 'instance-token', instanceName: 'axion-acc1',
      to: '5511999999999', text: 'oi',
    });
  });

  it('sendMedia maps kind/link/caption/filename to mediatype/media/caption/fileName', async () => {
    vi.spyOn(evolutionApi, 'sendEvolutionMedia').mockResolvedValue({ messageId: 'ID2' });
    const provider = new EvolutionProvider(config);
    const result = await provider.sender.sendMedia({
      to: '5511999999999', kind: 'document', link: 'https://x/a.pdf', caption: 'cap', filename: 'a.pdf',
    });
    expect(result).toEqual({ providerMessageId: 'ID2' });
    expect(evolutionApi.sendEvolutionMedia).toHaveBeenCalledWith({
      baseUrl: 'http://evo.local', apiKey: 'instance-token', instanceName: 'axion-acc1',
      to: '5511999999999', mediatype: 'document', media: 'https://x/a.pdf', caption: 'cap', fileName: 'a.pdf',
    });
  });

  it('never re-sanitizes `to` — passes it through unchanged', async () => {
    vi.spyOn(evolutionApi, 'sendEvolutionText').mockResolvedValue({ messageId: 'ID3' });
    const provider = new EvolutionProvider(config);
    await provider.sender.sendText({ to: '+1 (555) 123-4567', text: 'x' });
    expect(evolutionApi.sendEvolutionText).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+1 (555) 123-4567' }),
    );
  });

  it('propagates errors from the HTTP layer unchanged (no retry)', async () => {
    vi.spyOn(evolutionApi, 'sendEvolutionText').mockRejectedValue(new Error('boom'));
    const provider = new EvolutionProvider(config);
    await expect(provider.sender.sendText({ to: '5511999999999', text: 'x' })).rejects.toThrow('boom');
  });

  it('sendText builds the quoted key from to + contextProviderMessageId + contextFromMe', async () => {
    const spy = vi.spyOn(evolutionApi, 'sendEvolutionText').mockResolvedValue({ messageId: 'ID4' });
    const provider = new EvolutionProvider(config);
    await provider.sender.sendText({
      to: '5511999999999', text: 'resposta', contextProviderMessageId: 'PARENT-ID', contextFromMe: true,
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      quoted: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: true, id: 'PARENT-ID' },
    }));
  });

  it('sendText omits quoted when there is no contextProviderMessageId', async () => {
    const spy = vi.spyOn(evolutionApi, 'sendEvolutionText').mockResolvedValue({ messageId: 'ID5' });
    const provider = new EvolutionProvider(config);
    await provider.sender.sendText({ to: '5511999999999', text: 'oi' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ quoted: undefined }));
  });

  it('sendText defaults contextFromMe to false when omitted but a context id is present', async () => {
    const spy = vi.spyOn(evolutionApi, 'sendEvolutionText').mockResolvedValue({ messageId: 'ID6' });
    const provider = new EvolutionProvider(config);
    await provider.sender.sendText({ to: '5511999999999', text: 'x', contextProviderMessageId: 'PARENT-ID' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      quoted: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'PARENT-ID' },
    }));
  });

  it('sendMedia also builds the quoted key', async () => {
    const spy = vi.spyOn(evolutionApi, 'sendEvolutionMedia').mockResolvedValue({ messageId: 'ID7' });
    const provider = new EvolutionProvider(config);
    await provider.sender.sendMedia({
      to: '5511999999999', kind: 'image', link: 'https://x/a.jpg',
      contextProviderMessageId: 'PARENT-ID', contextFromMe: false,
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      quoted: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'PARENT-ID' },
    }));
  });

  // sendReaction's HTTP call is local to evolution.ts (not exported from
  // evolution-api.ts), same as sendInteractiveButtons/List — mocked via
  // global.fetch directly, matching evolution-api.test.ts's convention.
  it('sendReaction POSTs the full Baileys message key (remoteJid + fromMe + id) and the emoji', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'REACT-ID-1' } }),
    } as Response);
    const provider = new EvolutionProvider(config);

    const result = await provider.sender.sendReaction({
      to: '5511999999999', targetProviderMessageId: 'MSG-ID-1', targetFromMe: false, emoji: '👍',
    });

    expect(result).toEqual({ providerMessageId: 'REACT-ID-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/message/sendReaction/axion-acc1');
    expect(init?.headers).toMatchObject({ apikey: 'instance-token' });
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'MSG-ID-1' },
      reaction: '👍',
    });
  });

  it('sendReaction with an empty emoji removes the reaction (still sends the empty string)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'REACT-ID-2' } }),
    } as Response);
    const provider = new EvolutionProvider(config);

    await provider.sender.sendReaction({
      to: '5511999999999', targetProviderMessageId: 'MSG-ID-1', targetFromMe: true, emoji: '',
    });

    const fetchMock = vi.mocked(global.fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body).toMatchObject({ key: { fromMe: true }, reaction: '' });
  });

  it('sendReaction throws on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);
    const provider = new EvolutionProvider(config);
    await expect(
      provider.sender.sendReaction({ to: '5511999999999', targetProviderMessageId: 'x', targetFromMe: false, emoji: '👍' }),
    ).rejects.toThrow('Evolution API error: 404');
  });

  it('markAsRead builds remoteJid from `to` and always sends fromMe: false', async () => {
    const spy = vi.spyOn(evolutionApi, 'markEvolutionMessageAsRead').mockResolvedValue(undefined);
    const provider = new EvolutionProvider(config);
    await provider.sender.markAsRead({ to: '5511999999999', providerMessageId: 'MSG-ID' });
    expect(spy).toHaveBeenCalledWith({
      baseUrl: 'http://evo.local', apiKey: 'instance-token', instanceName: 'axion-acc1',
      remoteJid: '5511999999999@s.whatsapp.net', messageId: 'MSG-ID',
    });
  });

  it('sendTyping calls sendEvolutionPresence with presence:composing and delay:durationMs, ignoring contextProviderMessageId', async () => {
    const spy = vi.spyOn(evolutionApi, 'sendEvolutionPresence').mockResolvedValue(undefined);
    const provider = new EvolutionProvider(config);
    await provider.sender.sendTyping({ to: '5511999999999', contextProviderMessageId: 'unused', durationMs: 5500 });
    expect(spy).toHaveBeenCalledWith({
      baseUrl: 'http://evo.local', apiKey: 'instance-token', instanceName: 'axion-acc1',
      to: '5511999999999', presence: 'composing', delay: 5500,
    });
  });
});

describe('EvolutionProvider lifecycle', () => {
  it('connect() creates the instance (global key) then connects (instance token) and returns the QR', async () => {
    const createSpy = vi.spyOn(evolutionApi, 'createEvolutionInstance').mockResolvedValue({
      token: 'new-instance-token', qrCode: 'data:image/png;base64,AAA',
    });
    const provider = new EvolutionProvider({ ...config, isNewInstance: true });
    const state = await provider.connect();
    expect(state).toEqual({ status: 'connecting', qrCode: 'data:image/png;base64,AAA' });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: 'axion-acc1' }),
    );
  });

  it('connect() uses adminApiKey for create-instance (admin action) when provided', async () => {
    const createSpy = vi.spyOn(evolutionApi, 'createEvolutionInstance').mockResolvedValue({
      token: 'new-instance-token', qrCode: 'data:image/png;base64,AAA',
    });
    const configWithAdmin = {
      ...config,
      apiKey: 'instance-token',
      adminApiKey: 'global-admin-key',
      isNewInstance: true
    };
    const provider = new EvolutionProvider(configWithAdmin);
    await provider.connect();
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'global-admin-key', instanceName: 'axion-acc1' })
    );
  });

  it('connect() on an existing instance calls connectEvolutionInstance, not createEvolutionInstance', async () => {
    vi.spyOn(evolutionApi, 'connectEvolutionInstance').mockResolvedValue({ qrCode: 'data:image/png;base64,BBB' });
    const createSpy = vi.spyOn(evolutionApi, 'createEvolutionInstance');
    const provider = new EvolutionProvider({ ...config, isNewInstance: false });
    const state = await provider.connect();
    expect(state).toEqual({ status: 'connecting', qrCode: 'data:image/png;base64,BBB' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('getConnectionState() returns disconnected without calling Evolution (no cache passed)', async () => {
    const provider = new EvolutionProvider(config);
    const state = await provider.getConnectionState();
    expect(state).toEqual({ status: 'disconnected' });
    expect(evolutionApi.connectEvolutionInstance).not.toHaveBeenCalled();
  });

  it('disconnect() calls logout then delete', async () => {
    const logoutSpy = vi.spyOn(evolutionApi, 'logoutEvolutionInstance').mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(evolutionApi, 'deleteEvolutionInstance').mockResolvedValue(undefined);
    const provider = new EvolutionProvider(config);
    await provider.disconnect();
    expect(logoutSpy).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'axion-acc1' }));
    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'axion-acc1' }));
  });

  it('disconnect() uses adminApiKey for delete (admin action) while using instance apiKey for logout', async () => {
    const logoutSpy = vi.spyOn(evolutionApi, 'logoutEvolutionInstance').mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(evolutionApi, 'deleteEvolutionInstance').mockResolvedValue(undefined);
    const configWithAdmin = {
      ...config,
      apiKey: 'instance-token',
      adminApiKey: 'global-admin-key'
    };
    const provider = new EvolutionProvider(configWithAdmin);
    await provider.disconnect();
    expect(logoutSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'instance-token', instanceName: 'axion-acc1' })
    );
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'global-admin-key', instanceName: 'axion-acc1' })
    );
  });

  it('disconnect() falls back to apiKey when adminApiKey is absent', async () => {
    const deleteSpy = vi.spyOn(evolutionApi, 'deleteEvolutionInstance').mockResolvedValue(undefined);
    vi.spyOn(evolutionApi, 'logoutEvolutionInstance').mockResolvedValue(undefined);
    const configNoAdmin = { ...config, apiKey: 'fallback-key' };
    const provider = new EvolutionProvider(configNoAdmin);
    await provider.disconnect();
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'fallback-key', instanceName: 'axion-acc1' })
    );
  });
});

describe('EvolutionProvider.parseWebhook', () => {
  const provider = new EvolutionProvider(config);

  it('maps a text inbound', () => {
    const [inbound] = provider.parseWebhook(TEXT_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      from: '5511900000002', contactName: 'Test Customer',
      providerMessageId: 'ANON0000000000000000000000000001',
      kind: 'text', text: 'Oiiiii teste',
      replyToProviderMessageId: null,
    });
    expect(inbound.timestamp).toEqual(new Date(1783887066 * 1000));
  });

  it('maps replyToProviderMessageId from contextInfo.stanzaId (sibling of message, not nested)', () => {
    const [inbound] = provider.parseWebhook(REPLY_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'text', text: 'claro, aqui esta a resposta',
      replyToProviderMessageId: 'ANON0000000000000000000000000001',
    });
  });

  it('tags fromMe messages instead of dropping them — the CRM-echo vs phone-send split happens in the webhook route, not here', () => {
    const [inbound] = provider.parseWebhook(FROM_ME_ECHO_SAMPLE);
    expect(inbound).toMatchObject({ fromMe: true, kind: 'text' });
  });

  it('sets fromMe: false (not undefined) for a genuine customer inbound', () => {
    const [inbound] = provider.parseWebhook(TEXT_INBOUND_SAMPLE);
    expect(inbound.fromMe).toBe(false);
  });

  it('drops group messages entirely', () => {
    expect(provider.parseWebhook(VIDEO_GROUP_SAMPLE)).toEqual([]);
  });

  it('maps an image inbound with base64 + mimetype + caption', () => {
    const [inbound] = provider.parseWebhook(IMAGE_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'image', text: 'olha isso',
      mediaBase64: 'ZmFrZS1pbWFnZS1ieXRlcw==', mediaMimeType: 'image/jpeg',
    });
  });

  it('maps an audio inbound with no caption', () => {
    const [inbound] = provider.parseWebhook(AUDIO_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'audio', text: null,
      mediaBase64: 'ZmFrZS1hdWRpby1ieXRlcw==', mediaMimeType: 'audio/ogg; codecs=opus',
    });
  });

  it('maps a sticker inbound to kind=image (same as Meta), no caption', () => {
    const [inbound] = provider.parseWebhook(STICKER_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'image', text: null,
      mediaBase64: 'ZmFrZS1zdGlja2VyLWJ5dGVz', mediaMimeType: 'image/webp',
    });
  });

  it('maps a document inbound with fileName fallback for text', () => {
    const [inbound] = provider.parseWebhook(DOCUMENT_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'document', text: 'contrato.pdf',
      mediaBase64: 'ZmFrZS1kb2MtYnl0ZXM=', mediaMimeType: 'application/pdf',
      mediaFileName: 'contrato.pdf',
    });
  });

  it('maps a location inbound to a human-readable text summary', () => {
    const [inbound] = provider.parseWebhook(LOCATION_INBOUND_SAMPLE);
    expect(inbound.kind).toBe('location');
    expect(inbound.text).toBe('Praça da Sé - São Paulo, SP - -23.55,-46.63');
  });

  it('maps a reaction inbound', () => {
    const [inbound] = provider.parseWebhook(REACTION_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'reaction',
      reaction: { targetProviderMessageId: 'ANON0000000000000000000000000001', emoji: '👍' },
    });
  });

  it('maps a button-reply inbound', () => {
    const [inbound] = provider.parseWebhook(BUTTON_REPLY_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({ kind: 'interactive_reply', interactiveReplyId: 'btn-1', text: 'Sim' });
  });

  it('returns [] for non-message events (connection.update, qrcode.updated)', () => {
    expect(provider.parseWebhook(CONNECTION_UPDATE_ERROR_SAMPLE)).toEqual([]);
  });
});
