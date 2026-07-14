import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createEvolutionInstance,
  connectEvolutionInstance,
  logoutEvolutionInstance,
  deleteEvolutionInstance,
  sendEvolutionText,
  sendEvolutionMedia,
  markEvolutionMessageAsRead,
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
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
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

  it('throws with the nested response.message on a duplicate-instance-name rejection', async () => {
    // Real shape from a live instance: 403 with a generic top-level
    // "error": "Forbidden" and the actual reason nested one level down.
    // Before this fix, throwEvolutionError only read the top-level
    // fields and surfaced the opaque "Forbidden" instead.
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        status: 403,
        error: 'Forbidden',
        response: { message: ['This name "axion-acc1" is already in use.'] },
      }),
    } as Response);
    await expect(
      createEvolutionInstance({ ...BASE, instanceName: 'axion-acc1', webhookUrl: 'https://x' }),
    ).rejects.toThrow('This name "axion-acc1" is already in use.');
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
    expect(JSON.parse(init?.body as string)).toEqual({ number: '5511999999999', text: 'oi', linkPreview: true });
  });

  it('wraps `quoted` as { key: quoted } — confirmed live 2026-07-14 against a real quoted reply', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'WA-ID-1b' } }),
    } as Response);
    await sendEvolutionText({
      ...BASE, instanceName: 'axion-acc1', to: '5511999999999', text: 'resposta',
      quoted: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: true, id: 'PARENT-ID' },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      number: '5511999999999', text: 'resposta', linkPreview: true,
      quoted: { key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: true, id: 'PARENT-ID' } },
    });
  });

  it('omits `quoted` entirely when not replying to anything', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'WA-ID-1c' } }),
    } as Response);
    await sendEvolutionText({ ...BASE, instanceName: 'axion-acc1', to: '5511999999999', text: 'oi' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).not.toHaveProperty('quoted');
  });

  it('always sends linkPreview: true', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'WA-ID-1d' } }),
    } as Response);
    await sendEvolutionText({ ...BASE, instanceName: 'axion-acc1', to: '5511999999999', text: 'confira https://x.com' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({ linkPreview: true });
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

  it('wraps `quoted` the same way sendText does', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'WA-ID-2b' } }),
    } as Response);
    await sendEvolutionMedia({
      ...BASE, instanceName: 'axion-acc1', to: '5511999999999',
      mediatype: 'image', media: 'https://example.com/a.jpg',
      quoted: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'PARENT-ID' },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({
      quoted: { key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'PARENT-ID' } },
    });
  });
});

describe('markEvolutionMessageAsRead', () => {
  it('POSTs readMessages: [{remoteJid, fromMe: false, id}] — confirmed live 2026-07-14 (HTTP 201, "read":"success")', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'Read messages', read: 'success' }),
    } as Response);
    await markEvolutionMessageAsRead({
      ...BASE, instanceName: 'axion-acc1',
      remoteJid: '5511999999999@s.whatsapp.net', messageId: 'MSG-ID',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/chat/markMessageAsRead/axion-acc1');
    expect(JSON.parse(init?.body as string)).toEqual({
      readMessages: [{ remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'MSG-ID' }],
    });
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
    await expect(
      markEvolutionMessageAsRead({ ...BASE, instanceName: 'axion-acc1', remoteJid: 'x@s.whatsapp.net', messageId: 'y' }),
    ).rejects.toThrow('Evolution API error: 404');
  });
});
