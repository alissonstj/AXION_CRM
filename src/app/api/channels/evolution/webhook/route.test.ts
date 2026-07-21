import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` factories run during ESM import resolution — before any of
// this file's own top-level statements execute (imports always resolve
// ahead of the importing module's body). A plain `const mockIngestInbound
// = vi.fn()` read directly inside the factory below hits the TDZ.
// `vi.hoisted()` runs its initializer as part of that same hoisting
// phase, so the value exists by the time the factory needs it.
const { mockIngestInbound, mockDecrypt, mockDispatchWebhookEvent, mockFetchProfilePicture, mockWasSentByCrm } = vi.hoisted(() => ({
  mockIngestInbound: vi.fn().mockResolvedValue(undefined),
  mockDecrypt: vi.fn((v: string) => v.replace('enc:', '')),
  mockDispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
  mockFetchProfilePicture: vi.fn().mockResolvedValue(null),
  mockWasSentByCrm: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/channels/ingest', () => ({ ingestInbound: mockIngestInbound }));
vi.mock('@/lib/channels/evolution-media', () => ({
  uploadEvolutionMedia: vi.fn().mockResolvedValue('https://cdn.local/chat-media/x.jpg'),
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: mockDispatchWebhookEvent }));
vi.mock('@/lib/whatsapp/evolution-api', () => ({ fetchEvolutionProfilePicture: mockFetchProfilePicture }));
vi.mock('@/lib/channels/sent-by-crm-cache', () => ({ wasSentByCrm: mockWasSentByCrm }));

let mockConfigRow: Record<string, unknown> | null;
let mockMessageRow: Record<string, unknown> | null;
let mockRecipientRow: Record<string, unknown> | null;
let mockContactRow: Record<string, unknown> | null;
let mockConversationRow: Record<string, unknown> | null;
let lastMessageUpdate: Record<string, unknown> | null;
let lastRecipientUpdate: Record<string, unknown> | null;
let lastContactUpdate: Record<string, unknown> | null;
let lastConversationUpdate: Record<string, unknown> | null;
// Records every .eq() call made against `contacts`/`conversations`
// while resolving a presence.update, in order — lets tests assert
// which column (phone vs lid) the lookup actually filtered on.
let eqCallsByTable: Record<string, [string, unknown][]>;

// Table-aware chainable stub. `whatsapp_config` keeps the original
// single-config behavior; `messages`/`broadcast_recipients` are new,
// added for the messages.update status-tick handling; `contacts` is
// new for the avatar-sync hook; `conversations` is new for the
// presence.update (typing indicator) handling.
function makeDb() {
  let lastTable = '';
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      (eqCallsByTable[lastTable] ??= []).push([col, val]);
      return chain;
    },
    limit: () => chain,
    maybeSingle: async () => {
      if (lastTable === 'whatsapp_config') return { data: mockConfigRow, error: null };
      if (lastTable === 'messages') return { data: mockMessageRow, error: null };
      if (lastTable === 'broadcast_recipients') return { data: mockRecipientRow, error: null };
      if (lastTable === 'contacts') return { data: mockContactRow, error: null };
      if (lastTable === 'conversations') return { data: mockConversationRow, error: null };
      return { data: null, error: null };
    },
    update: (patch: Record<string, unknown>) => {
      if (lastTable === 'messages') lastMessageUpdate = patch;
      if (lastTable === 'broadcast_recipients') lastRecipientUpdate = patch;
      if (lastTable === 'contacts') lastContactUpdate = patch;
      if (lastTable === 'conversations') lastConversationUpdate = patch;
      return { eq: async () => ({ error: null }) };
    },
  };
  return { from: (t: string) => { lastTable = t; return chain; } } as never;
}

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => makeDb() }));

beforeEach(() => {
  mockIngestInbound.mockClear();
  mockDecrypt.mockClear();
  mockDispatchWebhookEvent.mockClear();
  mockFetchProfilePicture.mockReset().mockResolvedValue(null);
  mockWasSentByCrm.mockReset().mockReturnValue(false);
  mockDecrypt.mockImplementation((v: string) => v.replace('enc:', ''));
  mockConfigRow = {
    account_id: 'acc-1', user_id: 'user-1',
    evolution_instance_name: 'axion-acc1', evolution_instance_token: 'enc:tok',
  };
  mockMessageRow = null;
  mockRecipientRow = null;
  mockContactRow = null;
  mockConversationRow = null;
  lastMessageUpdate = null;
  lastRecipientUpdate = null;
  lastContactUpdate = null;
  lastConversationUpdate = null;
  eqCallsByTable = {};
});

// decrypt('enc:tok') must resolve to a plain token for the apikey check —
// mock it deterministically rather than pulling in real AES.
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: mockDecrypt }));

import { POST } from './route';
import { TEXT_INBOUND_SAMPLE, FROM_ME_ECHO_SAMPLE } from '@/lib/channels/providers/__fixtures__/evolution-webhook-samples';

function req(body: unknown) {
  return new Request('http://localhost/api/channels/evolution/webhook', {
    method: 'POST', body: JSON.stringify(body),
  });
}

describe('POST /api/channels/evolution/webhook', () => {
  it('rejects a request whose body apikey does not match the instance token', async () => {
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'wrong' }));
    expect(res.status).toBe(401);
    expect(mockIngestInbound).not.toHaveBeenCalled();
  });

  it('ingests a valid messages.upsert with matching apikey', async () => {
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'text', text: 'Oiiiii teste' }),
      expect.objectContaining({ accountId: 'acc-1', configOwnerUserId: 'user-1' }),
    );
  });

  it('returns 200 without ingesting when no config matches the instance name', async () => {
    mockConfigRow = null;
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).not.toHaveBeenCalled();
  });

  it('returns 200 even when decrypt throws during processing', async () => {
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error('Simulated GCM auth-tag failure');
    });
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).not.toHaveBeenCalled();
  });
});

describe('POST /api/channels/evolution/webhook — messages.update (status ticks)', () => {
  // Real payload shape, captured live 2026-07-14 from a self-sent text
  // on a connected instance (anonymized ids). Confirms `keyId`, not the
  // sibling `messageId`, is the WhatsApp wire id we match against.
  function statusEvent(status: string) {
    return {
      event: 'messages.update',
      instance: 'axion-acc1',
      apikey: 'tok',
      data: {
        keyId: '3EB0C6810F1BA185D26B02',
        remoteJid: '38745604669544@lid',
        fromMe: true,
        status,
        instanceId: 'f0346a75-13cc-4ae6-bcc8-9b3526258697',
        messageId: 'cmrjy3h5n0dy2qz5x49ksaavt', // Evolution's own row id — must NOT be matched against
      },
    };
  }

  it('maps DELIVERY_ACK to delivered and updates the matching message', async () => {
    mockMessageRow = { id: 'msg-1', status: 'sent', conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } };
    const res = await POST(req(statusEvent('DELIVERY_ACK')));
    expect(res.status).toBe(200);
    expect(lastMessageUpdate).toEqual({ status: 'delivered' });
  });

  it('maps SERVER_ACK to sent, READ/PLAYED to read, ERROR to failed', async () => {
    mockMessageRow = { id: 'msg-1', status: 'sending', conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } };
    await POST(req(statusEvent('SERVER_ACK')));
    expect(lastMessageUpdate).toEqual({ status: 'sent' });

    mockMessageRow = { id: 'msg-1', status: 'delivered', conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } };
    await POST(req(statusEvent('READ')));
    expect(lastMessageUpdate).toEqual({ status: 'read' });

    mockMessageRow = { id: 'msg-1', status: 'sent', conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } };
    await POST(req(statusEvent('ERROR')));
    expect(lastMessageUpdate).toEqual({ status: 'failed' });
  });

  it('ignores PENDING (not on our status vocabulary) and does not touch the DB', async () => {
    mockMessageRow = { id: 'msg-1', status: 'sending', conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } };
    await POST(req(statusEvent('PENDING')));
    expect(lastMessageUpdate).toBeNull();
  });

  it('rejects a backward transition — the exact out-of-order case seen live (DELIVERY_ACK before SERVER_ACK)', async () => {
    // Message is already 'delivered'; a late SERVER_ACK ("sent") must
    // not regress it. This guard exists specifically because live
    // capture showed Evolution can deliver these events out of order.
    mockMessageRow = { id: 'msg-1', status: 'delivered', conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } };
    await POST(req(statusEvent('SERVER_ACK')));
    expect(lastMessageUpdate).toBeNull();
  });

  it('no-ops cleanly (still 200) when no message row matches the keyId', async () => {
    mockMessageRow = null;
    const res = await POST(req(statusEvent('DELIVERY_ACK')));
    expect(res.status).toBe(200);
    expect(lastMessageUpdate).toBeNull();
  });

  it('mirrors onto broadcast_recipients when the message was part of a broadcast, stamping delivered_at', async () => {
    mockMessageRow = { id: 'msg-1', status: 'sent', conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } };
    mockRecipientRow = { id: 'rec-1', status: 'sent' };
    await POST(req(statusEvent('DELIVERY_ACK')));
    expect(lastRecipientUpdate).toMatchObject({ status: 'delivered', delivered_at: expect.any(String) });
  });

  it('does not touch broadcast_recipients when no matching recipient row exists', async () => {
    mockMessageRow = { id: 'msg-1', status: 'sent', conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } };
    mockRecipientRow = null;
    await POST(req(statusEvent('DELIVERY_ACK')));
    expect(lastRecipientUpdate).toBeNull();
  });

  it('fans out message.status_updated via dispatchWebhookEvent with the resolved account', async () => {
    mockMessageRow = { id: 'msg-1', status: 'sent', conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } };
    await POST(req(statusEvent('DELIVERY_ACK')));
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'message.status_updated',
      expect.objectContaining({ whatsapp_message_id: '3EB0C6810F1BA185D26B02', conversation_id: 'conv-1', status: 'delivered' }),
    );
  });
});

describe('POST /api/channels/evolution/webhook — avatar sync on new contact', () => {
  it('passes an onContactCreated hook to ingestInbound on messages.upsert', async () => {
    await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    expect(mockIngestInbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ onContactCreated: expect.any(Function) }),
    );
  });

  it('the hook fetches the photo and updates contacts.avatar_url when one exists', async () => {
    mockFetchProfilePicture.mockResolvedValue('https://pps.whatsapp.net/real-photo.jpg');
    await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    const { onContactCreated } = mockIngestInbound.mock.calls[0][1];
    onContactCreated({ id: 'contact-1', phone: '5511900000002' });

    await vi.waitFor(() => {
      expect(mockFetchProfilePicture).toHaveBeenCalledWith(
        expect.objectContaining({ number: '5511900000002' }),
      );
      expect(lastContactUpdate).toEqual({ avatar_url: 'https://pps.whatsapp.net/real-photo.jpg' });
    });
  });

  it('the hook does not touch contacts when the contact has no photo (null, not an error)', async () => {
    mockFetchProfilePicture.mockResolvedValue(null);
    await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    const { onContactCreated } = mockIngestInbound.mock.calls[0][1];
    onContactCreated({ id: 'contact-1', phone: '5511900000002' });

    await vi.waitFor(() => {
      expect(mockFetchProfilePicture).toHaveBeenCalled();
    });
    expect(lastContactUpdate).toBeNull();
  });

  it('a failed fetch is swallowed — never rejects, never surfaces', async () => {
    mockFetchProfilePicture.mockRejectedValue(new Error('Evolution API error: 500'));
    await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    const { onContactCreated } = mockIngestInbound.mock.calls[0][1];
    expect(() => onContactCreated({ id: 'contact-1', phone: '5511900000002' })).not.toThrow();

    await vi.waitFor(() => {
      expect(mockFetchProfilePicture).toHaveBeenCalled();
    });
    expect(lastContactUpdate).toBeNull();
  });
});

describe('POST /api/channels/evolution/webhook — fromMe: true (CRM echo vs phone-sent split)', () => {
  it('drops it without ingesting when the in-memory CRM-send marker matches (fast path)', async () => {
    mockWasSentByCrm.mockReturnValue(true);
    const res = await POST(req({ ...FROM_ME_ECHO_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).not.toHaveBeenCalled();
  });

  it('drops it without ingesting when the marker misses but a message row already exists (DB fallback)', async () => {
    mockWasSentByCrm.mockReturnValue(false);
    mockMessageRow = { id: 'existing-msg', conversations: { account_id: 'acc-1' } };
    const res = await POST(req({ ...FROM_ME_ECHO_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).not.toHaveBeenCalled();
  });

  it('ingests it as a genuine phone-sent message when neither the marker nor the DB knows about it', async () => {
    mockWasSentByCrm.mockReturnValue(false);
    mockMessageRow = null;
    const res = await POST(req({ ...FROM_ME_ECHO_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).toHaveBeenCalledWith(
      expect.objectContaining({ fromMe: true }),
      expect.objectContaining({ accountId: 'acc-1', configOwnerUserId: 'user-1' }),
    );
  });
});

describe('POST /api/channels/evolution/webhook — presence.update (typing indicator)', () => {
  function presenceReq(id: string, lastKnownPresence: string) {
    return POST(req({
      event: 'presence.update', instance: 'axion-acc1', apikey: 'tok',
      data: { id, presences: { [id]: { lastKnownPresence } } },
    }));
  }

  it('sets conversations.typing_until on a "composing" presence for a phone-addressed contact', async () => {
    mockContactRow = { id: 'contact-1' };
    mockConversationRow = { id: 'conv-1' };
    const res = await presenceReq('556183565665@s.whatsapp.net', 'composing');
    expect(res.status).toBe(200);
    expect(eqCallsByTable.contacts).toContainEqual(['phone', '556183565665']);
    expect(lastConversationUpdate).toHaveProperty('typing_until');
    expect(typeof lastConversationUpdate?.typing_until).toBe('string');
  });

  it('resolves a LID-addressed contact by the lid column, not phone', async () => {
    mockContactRow = { id: 'contact-1' };
    mockConversationRow = { id: 'conv-1' };
    await presenceReq('38745604669544@lid', 'composing');
    expect(eqCallsByTable.contacts).toContainEqual(['lid', '38745604669544']);
  });

  it('clears typing_until (sets it null) on a non-composing presence', async () => {
    mockContactRow = { id: 'contact-1' };
    mockConversationRow = { id: 'conv-1' };
    await presenceReq('556183565665@s.whatsapp.net', 'available');
    expect(lastConversationUpdate).toEqual({ typing_until: null });
  });

  it('no-ops cleanly when no contact matches (still 200, no conversation update)', async () => {
    mockContactRow = null;
    const res = await presenceReq('556100000000@s.whatsapp.net', 'composing');
    expect(res.status).toBe(200);
    expect(lastConversationUpdate).toBeNull();
  });

  it('no-ops cleanly when the contact has no 1:1 conversation yet', async () => {
    mockContactRow = { id: 'contact-1' };
    mockConversationRow = null;
    const res = await presenceReq('556183565665@s.whatsapp.net', 'composing');
    expect(res.status).toBe(200);
    expect(lastConversationUpdate).toBeNull();
  });
});
