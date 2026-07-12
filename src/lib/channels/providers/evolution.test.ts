import { describe, it, expect, vi } from 'vitest';
import * as evolutionApi from '@/lib/whatsapp/evolution-api';
import { EvolutionProvider } from './evolution';
import {
  TEXT_INBOUND_SAMPLE, FROM_ME_ECHO_SAMPLE, IMAGE_INBOUND_SAMPLE, AUDIO_INBOUND_SAMPLE,
  VIDEO_GROUP_SAMPLE, DOCUMENT_INBOUND_SAMPLE, LOCATION_INBOUND_SAMPLE, REACTION_INBOUND_SAMPLE,
  BUTTON_REPLY_INBOUND_SAMPLE, CONNECTION_UPDATE_ERROR_SAMPLE,
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
});

describe('EvolutionProvider stubs', () => {
  it('connect/getConnectionState/disconnect throw not-implemented', async () => {
    const provider = new EvolutionProvider(config);
    await expect(provider.connect()).rejects.toThrow(/Task 5/);
    await expect(provider.getConnectionState()).rejects.toThrow(/Task 5/);
    await expect(provider.disconnect()).rejects.toThrow(/Task 5/);
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
    });
    expect(inbound.timestamp).toEqual(new Date(1783887066 * 1000));
  });

  it('drops fromMe echoes entirely', () => {
    expect(provider.parseWebhook(FROM_ME_ECHO_SAMPLE)).toEqual([]);
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
