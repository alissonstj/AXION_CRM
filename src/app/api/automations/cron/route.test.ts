import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResumePendingExecution, mockRunAutomationsForTrigger, mockGetChannelForAccount, mockSendText, mockSendMedia } = vi.hoisted(() => ({
  mockResumePendingExecution: vi.fn(),
  mockRunAutomationsForTrigger: vi.fn(),
  mockGetChannelForAccount: vi.fn(),
  mockSendText: vi.fn(),
  mockSendMedia: vi.fn(),
}));

vi.mock('@/lib/automations/engine', () => ({
  resumePendingExecution: mockResumePendingExecution,
  runAutomationsForTrigger: mockRunAutomationsForTrigger,
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
  timeBasedAutomations: Record<string, unknown>[];
  automationContactRunInserts: Record<string, unknown>[];
  /** Failing this insert simulates losing the claim race (a concurrent
   *  sweep already recorded this automation+contact pair first). */
  automationContactRunInsertShouldFail: boolean;
  /** automation_id -> contact rows the inactivity RPC should return. */
  inactiveContactsByAutomation: Record<string, { contact_id: string }[]>;
  rpcError: string | null;
  rpcCalls: { automationId: string; cutoff: string }[];
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

/** `.select(...).eq(...).eq(...)` awaited directly — no order/limit. */
function selectEqAwaitBuilder(rows: () => Record<string, unknown>[]) {
  const builder = {
    eq: () => builder,
    then: (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null }),
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
      if (table === 'automations') {
        return { select: () => selectEqAwaitBuilder(() => state.timeBasedAutomations) };
      }
      if (table === 'automation_contact_runs') {
        return {
          insert: (row: Record<string, unknown>) => {
            if (state.automationContactRunInsertShouldFail) {
              return Promise.resolve({ data: null, error: { message: 'conflict' } });
            }
            state.automationContactRunInserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table in this test: ${table}`);
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name !== 'inactive_contacts_for_automation') throw new Error(`unexpected rpc: ${name}`);
      const automationId = params.p_automation_id as string;
      state.rpcCalls.push({ automationId, cutoff: params.p_cutoff as string });
      if (state.rpcError) return { data: null, error: { message: state.rpcError } };
      return { data: state.inactiveContactsByAutomation[automationId] ?? [], error: null };
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
  state = {
    automationPending: [], scheduledMessages: [], messageInserts: [], conversationUpdates: [],
    timeBasedAutomations: [], automationContactRunInserts: [], automationContactRunInsertShouldFail: false,
    inactiveContactsByAutomation: {}, rpcError: null, rpcCalls: [],
  };
  mockResumePendingExecution.mockReset().mockResolvedValue(undefined);
  mockRunAutomationsForTrigger.mockReset().mockResolvedValue(undefined);
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

describe('GET /api/automations/cron — inactivity follow-up sweep (Fase 4)', () => {
  function timeBasedAutomation(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'auto-1', account_id: 'acc-1', trigger_config: { schedule: '09:00', inactivity_days: 20 },
      ...overrides,
    };
  }

  it('dispatches once per contact the RPC returns, recording automation_contact_runs first', async () => {
    state.timeBasedAutomations = [timeBasedAutomation()];
    state.inactiveContactsByAutomation['auto-1'] = [{ contact_id: 'contact-1' }, { contact_id: 'contact-2' }];

    const res = await GET(req('test-secret'));
    const json = await res.json();

    expect(json.inactivity_follow_ups).toBe(2);
    expect(mockRunAutomationsForTrigger).toHaveBeenCalledTimes(2);
    expect(mockRunAutomationsForTrigger).toHaveBeenCalledWith({
      accountId: 'acc-1', triggerType: 'time_based', contactId: 'contact-1', context: {},
    });
    expect(mockRunAutomationsForTrigger).toHaveBeenCalledWith({
      accountId: 'acc-1', triggerType: 'time_based', contactId: 'contact-2', context: {},
    });
    expect(state.automationContactRunInserts).toEqual([
      { automation_id: 'auto-1', contact_id: 'contact-1' },
      { automation_id: 'auto-1', contact_id: 'contact-2' },
    ]);
  });

  it('passes a cutoff derived from inactivity_days (now minus N days) to the RPC', async () => {
    state.timeBasedAutomations = [timeBasedAutomation({ trigger_config: { schedule: '09:00', inactivity_days: 5 } })];
    const before = Date.now();
    await GET(req('test-secret'));
    const after = Date.now();

    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].automationId).toBe('auto-1');
    const cutoffMs = new Date(state.rpcCalls[0].cutoff).getTime();
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    expect(cutoffMs).toBeGreaterThanOrEqual(before - fiveDaysMs - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(after - fiveDaysMs + 1000);
  });

  it('skips automations with no inactivity_days configured (schedule-only config, not yet migrated)', async () => {
    state.timeBasedAutomations = [timeBasedAutomation({ trigger_config: { schedule: '09:00' } })];
    const res = await GET(req('test-secret'));
    expect((await res.json()).inactivity_follow_ups).toBe(0);
    expect(mockRunAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it('skips automations with inactivity_days <= 0', async () => {
    state.timeBasedAutomations = [timeBasedAutomation({ trigger_config: { schedule: '09:00', inactivity_days: 0 } })];
    await GET(req('test-secret'));
    expect(mockRunAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it('skips a contact when claiming automation_contact_runs fails (lost the race to an overlapping sweep)', async () => {
    state.timeBasedAutomations = [timeBasedAutomation()];
    state.inactiveContactsByAutomation['auto-1'] = [{ contact_id: 'contact-1' }];
    state.automationContactRunInsertShouldFail = true;

    const res = await GET(req('test-secret'));
    expect((await res.json()).inactivity_follow_ups).toBe(0);
    expect(mockRunAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it('does not crash the sweep when the RPC itself errors — just skips that automation', async () => {
    state.timeBasedAutomations = [timeBasedAutomation()];
    state.rpcError = 'function does not exist';
    const res = await GET(req('test-secret'));
    expect(res.status).toBe(200);
    expect((await res.json()).inactivity_follow_ups).toBe(0);
  });

  it('processes multiple time_based automations independently, each against its own account', async () => {
    state.timeBasedAutomations = [
      timeBasedAutomation({ id: 'auto-1', account_id: 'acc-1' }),
      timeBasedAutomation({ id: 'auto-2', account_id: 'acc-2' }),
    ];
    state.inactiveContactsByAutomation['auto-1'] = [{ contact_id: 'contact-1' }];
    state.inactiveContactsByAutomation['auto-2'] = [{ contact_id: 'contact-9' }];

    await GET(req('test-secret'));

    expect(mockRunAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-1', contactId: 'contact-1' }),
    );
    expect(mockRunAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-2', contactId: 'contact-9' }),
    );
  });

  it('rolls the inactivity count into the top-level processed total', async () => {
    state.automationPending = [
      { id: 'pe-1', status: 'pending', run_at: new Date(Date.now() - 1000).toISOString(), automation_id: 'a1', account_id: 'acc-1', user_id: 'u1', contact_id: 'c1', next_step_position: 1, context: {} },
    ];
    state.timeBasedAutomations = [timeBasedAutomation()];
    state.inactiveContactsByAutomation['auto-1'] = [{ contact_id: 'contact-1' }];

    const res = await GET(req('test-secret'));
    const json = await res.json();
    expect(json.processed).toBe(json.automation_pending_executions + json.scheduled_messages + json.inactivity_follow_ups);
    expect(json.processed).toBe(2);
  });
});
