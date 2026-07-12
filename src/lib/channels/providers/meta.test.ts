import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}));

import {
  sendTextMessage,
  sendMediaMessage,
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
});
