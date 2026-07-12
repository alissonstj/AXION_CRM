import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createEvolutionInstance,
  connectEvolutionInstance,
  logoutEvolutionInstance,
  deleteEvolutionInstance,
  sendEvolutionText,
  sendEvolutionMedia,
} from './evolution-api';

const BASE = { baseUrl: 'http://evo.local', apiKey: 'k' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEvolutionInstance', () => {
  it('POSTs to /instance/create with the webhook block and returns the token + qr', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        hash: 'tok-123',
        qrcode: { base64: 'data:image/png;base64,AAA', code: 'raw-code' },
      }),
    } as Response);

    const result = await createEvolutionInstance({
      ...BASE,
      instanceName: 'axion-acc1',
      webhookUrl: 'https://app.local/api/channels/evolution/webhook',
    });

    expect(result).toEqual({ token: 'tok-123', qrCode: 'data:image/png;base64,AAA' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/instance/create');
    expect(init?.headers).toMatchObject({ apikey: 'k', 'Content-Type': 'application/json' });
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      instanceName: 'axion-acc1',
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      webhook: {
        url: 'https://app.local/api/channels/evolution/webhook',
        byEvents: false,
        base64: true,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
      },
    });
  });

  it('throws with the server error message on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Instance already exists' }),
    } as Response);
    await expect(
      createEvolutionInstance({ ...BASE, instanceName: 'x', webhookUrl: 'https://x' }),
    ).rejects.toThrow('Instance already exists');
  });
});

describe('connectEvolutionInstance', () => {
  it('GETs /instance/connect/{name} and returns the qr', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ base64: 'data:image/png;base64,BBB', code: 'raw' }),
    } as Response);
    const result = await connectEvolutionInstance({ ...BASE, instanceName: 'axion-acc1' });
    expect(result).toEqual({ qrCode: 'data:image/png;base64,BBB' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://evo.local/instance/connect/axion-acc1');
  });
});

describe('logoutEvolutionInstance / deleteEvolutionInstance', () => {
  it('logoutEvolutionInstance DELETEs /instance/logout/{name}', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await logoutEvolutionInstance({ ...BASE, instanceName: 'axion-acc1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/instance/logout/axion-acc1');
    expect(init?.method).toBe('DELETE');
  });

  it('deleteEvolutionInstance DELETEs /instance/delete/{name}', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await deleteEvolutionInstance({ ...BASE, instanceName: 'axion-acc1' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://evo.local/instance/delete/axion-acc1');
  });
});

describe('sendEvolutionText', () => {
  it('POSTs a flat body (no nested textMessage) and returns the message id from key.id', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'WA-ID-1' } }),
    } as Response);
    const result = await sendEvolutionText({ ...BASE, instanceName: 'axion-acc1', to: '5511999999999', text: 'oi' });
    expect(result).toEqual({ messageId: 'WA-ID-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/message/sendText/axion-acc1');
    expect(JSON.parse(init?.body as string)).toEqual({ number: '5511999999999', text: 'oi' });
  });
});

describe('sendEvolutionMedia', () => {
  it('POSTs mediatype + media (url) as plain JSON, not multipart', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'WA-ID-2' } }),
    } as Response);
    const result = await sendEvolutionMedia({
      ...BASE, instanceName: 'axion-acc1', to: '5511999999999',
      mediatype: 'image', media: 'https://example.com/a.jpg', caption: 'oi',
    });
    expect(result).toEqual({ messageId: 'WA-ID-2' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      number: '5511999999999', mediatype: 'image', media: 'https://example.com/a.jpg', caption: 'oi',
    });
  });
});
