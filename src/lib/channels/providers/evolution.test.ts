import { describe, it, expect, vi } from 'vitest';
import * as evolutionApi from '@/lib/whatsapp/evolution-api';
import { EvolutionProvider } from './evolution';

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
  it('parseWebhook/connect/getConnectionState/disconnect throw not-implemented', async () => {
    const provider = new EvolutionProvider(config);
    expect(() => provider.parseWebhook({})).toThrow(/Task 4/);
    await expect(provider.connect()).rejects.toThrow(/Task 5/);
    await expect(provider.getConnectionState()).rejects.toThrow(/Task 5/);
    await expect(provider.disconnect()).rejects.toThrow(/Task 5/);
  });
});
