import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResumePendingExecution, mockGetChannelForAccount, mockSendText, mockSendMedia } = vi.hoisted(() => ({
  mockResumePendingExecution: vi.fn(),
  mockGetChannelForAccount: vi.fn(),
  mockSendText: vi.fn(),
  mockSendMedia: vi.fn(),
}));

vi.mock('@/lib/automations/engine', () => ({
  resumePendingExecution: mockResumePendingExecution,
}));

vi.mock('@/lib/channels/factory', () => ({
  getChannelForAccount: mockGetChannelForAccount,
  ChannelConfigError: class ChannelConfigError extends Error {},
}));

// ------------------------------------------------------------
// In-memory fake admin client. Each table gets a chainable builder
// tailored to the exact call shapes route.ts issues against it — not a
// generic ORM emulator. `update()` builders are reused for BOTH the
// claim chain (.eq('id').eq('status').select().maybeSingle()) and the
// plain final-status chain (.eq('id') awaited directly), since both
// shapes appear in the route for the same table.
// ------------------------------------------------------------
interface State {
  automationPending: Record<string, unknown>[];
  scheduledMessages: Record<string, unknown>[];
  messageInserts: Record<string, unknown>[];
  conversationUpdates: Record<string, unknown>[];
}

function selectBuilder(rows: () => Record<string, unknown>[]) {
  const builder = {
    eq: () => builder,
    lte: () => builder,
    order: () => builder,
    limit: async () => ({ data: rows().filter((r) => r.status === 'pending'), error: null }),
  };
  return builder;
}

function updateBuilder(rows: Record<string, unknown>[], patch: Record<string, unknown>) {
  let targetId: string | null = null;
  let expectedStatus: string | null = null;
  const builder = {
    eq: (col: string, val: string) => {
      if (col === 'id') targetId = val;
      if (col === 'status') expectedStatus = val;
      return builder;
    },
    select: () => builder,
    maybeSingle: async () => {
      const row = rows.find((r) => r.id === targetId);
      if (!row) return { data: null, error: null };
      if (expectedStatus && row.status !== expectedStatus) return { data: null, error: null };
      Object.assign(row, patch);
      return { data: { id: targetId }, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      const row = rows.find((r) => r.id === targetId);
      if (row) Object.assign(row, patch);
      resolve({ data: null, error: null });
    },
  };
  return builder;
}

function makeAdmin(state: State) {
  return {
    from(table: string) {
      if (table === 'automation_pending_executions') {
        return {
          select: () => selectBuilder(() => state.automationPending),
          update: (patch: Record<string, unknown>) => updateBuilder(state.automationPending, patch),
        };
      }
      if (table === 'scheduled_messages') {
        return {
          select: () => selectBuilder(() => state.scheduledMessages),
          update: (patch: Record<string, unknown>) => updateBuilder(state.scheduledMessages, patch),
        };
      }
      if (table === 'messages') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const id = `msg-${state.messageInserts.length + 1}`;
                state.messageInserts.push({ id, ...row });
                return { data: { id }, error: null };
              },
            }),
          }),
        };
      }
      if (table === 'conversations') {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              state.conversationUpdates.push({ id, ...patch });
              return { data: null, error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table in this test: ${table}`);
    },
  };
}

let state: State;
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => makeAdmin(state) }));

import { GET } from './route';

function req(secret: string | null) {
  const headers = new Headers();
  if (secret !== null) headers.set('x-cron-secret', secret);
  return new Request('http://localhost/api/automations/cron', { headers });
}

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 'test-secret';
  state = { automationPending: [], scheduledMessages: [], messageInserts: [], conversationUpdates: [] };
  mockResumePendingExecution.mockReset().mockResolvedValue(undefined);
  mockSendText.mockReset().mockResolvedValue({ providerMessageId: 'wamid.sent' });
  mockSendMedia.mockReset().mockResolvedValue({ providerMessageId: 'wamid.media-sent' });
  mockGetChannelForAccount.mockReset().mockResolvedValue({
    sender: { sendText: mockSendText, sendMedia: mockSendMedia },
  });
});

describe('GET /api/automations/cron — auth guard (unchanged)', () => {
  it('503s when AUTOMATION_CRON_SECRET is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    const res = await GET(req('anything'));
    expect(res.status).toBe(503);
  });

  it('401s when the secret header is missing or wrong', async () => {
    expect((await GET(req(null))).status).toBe(401);
    expect((await GET(req('wrong'))).status).toBe(401);
  });
});

describe('GET /api/automations/cron — automation_pending_executions (regression)', () => {
  it('claims and resumes a due row', async () => {
    state.automationPending = [
      { id: 'pe-1', status: 'pending', run_at: new Date(Date.now() - 1000).toISOString(), automation_id: 'a1', account_id: 'acc-1', user_id: 'u1', contact_id: 'c1', next_step_position: 2, context: { foo: 'bar' } },
    ];
    const res = await GET(req('test-secret'));
    const json = await res.json();
    expect(json.automation_pending_executions).toBe(1);
    expect(mockResumePendingExecution).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pe-1', automation_id: 'a1', account_id: 'acc-1', next_step_position: 2, context: { foo: 'bar' } }),
    );
  });
});

describe('GET /api/automations/cron — scheduled_messages', () => {
  function pendingRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'sm-1', status: 'pending', account_id: 'acc-1', conversation_id: 'conv-1',
      content_type: 'text', content_text: 'Oi #primeiroNome, tudo bem?', media_url: null,
      contact: { id: 'contact-1', phone: '+5511999999999', name: 'Alisson Alves' },
      ...overrides,
    };
  }

  it('sends a text message with variables substituted and marks it sent', async () => {
    state.scheduledMessages = [pendingRow()];
    const res = await GET(req('test-secret'));
    const json = await res.json();

    expect(json.scheduled_messages).toBe(1);
    expect(mockSendText).toHaveBeenCalledWith({ to: '5511999999999', text: 'Oi Alisson, tudo bem?' });
    expect(state.messageInserts[0]).toMatchObject({
      conversation_id: 'conv-1', sender_type: 'agent', content_type: 'text',
      content_text: 'Oi Alisson, tudo bem?', message_id: 'wamid.sent', status: 'sent',
    });
    expect(state.conversationUpdates[0]).toMatchObject({ id: 'conv-1', last_message_text: 'Oi Alisson, tudo bem?' });
    expect(state.scheduledMessages[0]).toMatchObject({ status: 'sent', sent_message_id: 'msg-1' });
  });

  it('sends a media message via sendMedia, using content_text as the caption', async () => {
    state.scheduledMessages = [pendingRow({
      content_type: 'image', content_text: 'Foto pra #primeiroNome', media_url: 'https://cdn.local/x.jpg',
    })];
    await GET(req('test-secret'));

    expect(mockSendMedia).toHaveBeenCalledWith({
      to: '5511999999999', kind: 'image', link: 'https://cdn.local/x.jpg', caption: 'Foto pra Alisson',
    });
    expect(state.messageInserts[0]).toMatchObject({ content_type: 'image', media_url: 'https://cdn.local/x.jpg' });
  });

  it('respects provider (Meta or Evolution) via getChannelForAccount — no provider-specific branching here', async () => {
    state.scheduledMessages = [pendingRow()];
    await GET(req('test-secret'));
    expect(mockGetChannelForAccount).toHaveBeenCalledWith('acc-1', expect.anything());
  });

  it('marks failed (no send attempted) when the contact has no phone number', async () => {
    state.scheduledMessages = [pendingRow({ contact: { id: 'contact-1', phone: '', name: 'Alisson' } })];
    await GET(req('test-secret'));
    expect(mockSendText).not.toHaveBeenCalled();
    expect(state.scheduledMessages[0]).toMatchObject({ status: 'failed', error_message: 'Contact has no phone number' });
  });

  it('marks failed with the provider error message when the send itself throws', async () => {
    mockSendText.mockRejectedValue(new Error('Evolution API error: 500'));
    state.scheduledMessages = [pendingRow()];
    await GET(req('test-secret'));
    expect(state.scheduledMessages[0]).toMatchObject({ status: 'failed', error_message: 'Evolution API error: 500' });
    expect(state.messageInserts).toHaveLength(0);
  });

  it('marks failed with a clear reason when the account has no channel configured', async () => {
    const { ChannelConfigError } = await import('@/lib/channels/factory');
    mockGetChannelForAccount.mockRejectedValue(new ChannelConfigError('acc-1'));
    state.scheduledMessages = [pendingRow()];
    await GET(req('test-secret'));
    expect(state.scheduledMessages[0]).toMatchObject({ status: 'failed', error_message: 'WhatsApp not configured for this account' });
  });

  it('skips a row that lost the claim race (already picked up by an overlapping sweep)', async () => {
    state.scheduledMessages = [pendingRow({ status: 'sending' })]; // not 'pending' anymore
    const res = await GET(req('test-secret'));
    const json = await res.json();
    expect(json.scheduled_messages).toBe(0);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('processes multiple due rows independently in one sweep', async () => {
    state.scheduledMessages = [
      pendingRow({ id: 'sm-1' }),
      pendingRow({ id: 'sm-2', contact: { id: 'contact-2', phone: '+5511888888888', name: 'Bruna Costa' } }),
    ];
    const res = await GET(req('test-secret'));
    const json = await res.json();
    expect(json.scheduled_messages).toBe(2);
    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText).toHaveBeenCalledWith({ to: '5511888888888', text: 'Oi Bruna, tudo bem?' });
  });
});
