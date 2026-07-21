import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createEvolutionInstance,
  connectEvolutionInstance,
  logoutEvolutionInstance,
  deleteEvolutionInstance,
  sendEvolutionText,
  sendEvolutionMedia,
  markEvolutionMessageAsRead,
  fetchEvolutionProfilePicture,
  sendEvolutionPresence,
  findEvolutionChats,
  findEvolutionContacts,
  findEvolutionMessages,
  fetchEvolutionGroupInfo,
  setEvolutionWebhook,
} from './evolution-api';

const BASE = { baseUrl: 'http://evo.local', apiKey: 'k' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEvolutionInstance', () => {
  it('POSTs to /instance/create with NO webhook block and returns the token + qr', async () => {
    // Deliberately no `webhook` in the create body — see setEvolutionWebhook
    // below. /instance/create starts the Baileys channel synchronously and
    // can fire qrcode.updated before this call's own HTTP response even
    // returns, i.e. before the caller has had a chance to persist the
    // token anywhere. Registering the webhook here guaranteed a 401 on
    // that very first delivery (confirmed live 2026-07-15 — reproduced 4/4
    // times, each one spiraling into a channel restart loop). The two-step
    // fix: create with no webhook, persist the token, THEN
    // setEvolutionWebhook.
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        hash: 'tok-123',
        qrcode: { base64: 'data:image/png;base64,AAA', code: 'raw-code' },
      }),
    } as Response);

    const result = await createEvolutionInstance({ ...BASE, instanceName: 'axion-acc1' });

    expect(result).toEqual({ token: 'tok-123', qrCode: 'data:image/png;base64,AAA' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/instance/create');
    expect(init?.headers).toMatchObject({ apikey: 'k', 'Content-Type': 'application/json' });
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      instanceName: 'axion-acc1',
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    });
    expect(body).not.toHaveProperty('webhook');
  });

  it('throws with the server error message on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Instance already exists' }),
    } as Response);
    await expect(
      createEvolutionInstance({ ...BASE, instanceName: 'x' }),
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
      createEvolutionInstance({ ...BASE, instanceName: 'axion-acc1' }),
    ).rejects.toThrow('This name "axion-acc1" is already in use.');
  });
});

describe('setEvolutionWebhook', () => {
  it('POSTs { webhook: { enabled: true, url, events, ... } } to /webhook/set/{instance}', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true }),
    } as Response);

    await setEvolutionWebhook({
      ...BASE, instanceName: 'axion-acc1',
      webhookUrl: 'https://app.local/api/channels/evolution/webhook',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/webhook/set/axion-acc1');
    expect(JSON.parse(init?.body as string)).toEqual({
      webhook: {
        enabled: true,
        url: 'https://app.local/api/channels/evolution/webhook',
        byEvents: false,
        base64: true,
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED', 'PRESENCE_UPDATE'],
      },
    });
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    await expect(
      setEvolutionWebhook({ ...BASE, instanceName: 'axion-acc1', webhookUrl: 'https://x' }),
    ).rejects.toThrow('Evolution API error: 500');
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

describe('sendEvolutionPresence', () => {
  it('POSTs { number, presence, delay } to /chat/sendPresence/{instance}', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);
    await sendEvolutionPresence({
      ...BASE, instanceName: 'axion-acc1',
      to: '5511999999999', presence: 'composing', delay: 5500,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/chat/sendPresence/axion-acc1');
    expect(JSON.parse(init?.body as string)).toEqual({
      number: '5511999999999', presence: 'composing', delay: 5500,
    });
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    await expect(
      sendEvolutionPresence({ ...BASE, instanceName: 'axion-acc1', to: '5511999999999', presence: 'composing', delay: 5500 }),
    ).rejects.toThrow('Evolution API error: 500');
  });
});

describe('fetchEvolutionProfilePicture', () => {
  it('returns the URL for a contact with a photo — confirmed live 2026-07-14', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ wuid: '5511999999999@s.whatsapp.net', profilePictureUrl: 'https://pps.whatsapp.net/x.jpg' }),
    } as Response);
    const result = await fetchEvolutionProfilePicture({ ...BASE, instanceName: 'axion-acc1', number: '5511999999999' });
    expect(result).toBe('https://pps.whatsapp.net/x.jpg');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/chat/fetchProfilePictureUrl/axion-acc1');
    expect(JSON.parse(init?.body as string)).toEqual({ number: '5511999999999' });
  });

  it('returns null (not an error) for a contact with no photo — confirmed live 2026-07-14, HTTP 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ wuid: '5511999999999@s.whatsapp.net', profilePictureUrl: null }),
    } as Response);
    const result = await fetchEvolutionProfilePicture({ ...BASE, instanceName: 'axion-acc1', number: '5511999999999' });
    expect(result).toBeNull();
  });

  it('throws on a genuine non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    await expect(
      fetchEvolutionProfilePicture({ ...BASE, instanceName: 'axion-acc1', number: '5511999999999' }),
    ).rejects.toThrow('Evolution API error: 500');
  });
});

describe('findEvolutionChats', () => {
  it('POSTs an empty body to /chat/findChats/{instance} and returns the array — confirmed live 2026-07-15', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ([
        { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: 1784068410 } },
      ]),
    } as Response);
    const result = await findEvolutionChats({ ...BASE, instanceName: 'axion-acc1' });
    expect(result).toEqual([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: 1784068410 } },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/chat/findChats/axion-acc1');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({});
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    await expect(
      findEvolutionChats({ ...BASE, instanceName: 'axion-acc1' }),
    ).rejects.toThrow('Evolution API error: 500');
  });
});

describe('fetchEvolutionGroupInfo', () => {
  it('GETs /group/findGroupInfos with the groupJid query and returns subject + pictureUrl', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ subject: 'A Grande Família', pictureUrl: 'https://x/p.jpg', participants: [] }),
    } as Response);
    const result = await fetchEvolutionGroupInfo({
      ...BASE, instanceName: 'axion-acc1', groupJid: '120363427655738502@g.us',
    });
    expect(result).toEqual({ subject: 'A Grande Família', pictureUrl: 'https://x/p.jpg' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/group/findGroupInfos/axion-acc1?groupJid=120363427655738502%40g.us');
    expect(init?.method).toBe('GET');
  });

  it('returns nulls when fields are absent', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const result = await fetchEvolutionGroupInfo({ ...BASE, instanceName: 'axion-acc1', groupJid: 'g@g.us' });
    expect(result).toEqual({ subject: null, pictureUrl: null });
  });
});

describe('findEvolutionContacts', () => {
  it('POSTs an empty body to /chat/findContacts/{instance} and returns the array — the address-book name lives in pushName', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ([
        { remoteJid: '556195268242@s.whatsapp.net', pushName: 'Ana Luiza', isSaved: true },
        { remoteJid: '175441461657751@lid', pushName: '', isSaved: true },
      ]),
    } as Response);
    const result = await findEvolutionContacts({ ...BASE, instanceName: 'axion-acc1' });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ remoteJid: '556195268242@s.whatsapp.net', pushName: 'Ana Luiza' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/chat/findContacts/axion-acc1');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({});
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    await expect(
      findEvolutionContacts({ ...BASE, instanceName: 'axion-acc1' }),
    ).rejects.toThrow('Evolution API error: 500');
  });
});

describe('findEvolutionMessages', () => {
  it('POSTs { where: { key: { remoteJid } }, page } and returns the paginated result — confirmed live 2026-07-15', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: {
          total: 141,
          pages: 3,
          currentPage: 1,
          records: [
            { key: { id: 'WA-1', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' }, messageType: 'conversation', message: { conversation: 'oi' }, messageTimestamp: 1784068410 },
          ],
        },
      }),
    } as Response);
    const result = await findEvolutionMessages({
      ...BASE, instanceName: 'axion-acc1', remoteJid: '5511999999999@s.whatsapp.net', page: 1,
    });
    expect(result.total).toBe(141);
    expect(result.pages).toBe(3);
    expect(result.records).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/chat/findMessages/axion-acc1');
    expect(JSON.parse(init?.body as string)).toEqual({
      where: { key: { remoteJid: '5511999999999@s.whatsapp.net' } },
      page: 1,
    });
  });

  it('defaults page to 1 when not given', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: { total: 0, pages: 0, currentPage: 1, records: [] } }),
    } as Response);
    await findEvolutionMessages({ ...BASE, instanceName: 'axion-acc1', remoteJid: 'x@s.whatsapp.net' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({ page: 1 });
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    await expect(
      findEvolutionMessages({ ...BASE, instanceName: 'axion-acc1', remoteJid: 'x@s.whatsapp.net' }),
    ).rejects.toThrow('Evolution API error: 500');
  });
});
