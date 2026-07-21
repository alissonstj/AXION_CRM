import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/evolution-api', () => ({
  findEvolutionChats: vi.fn(),
  findEvolutionMessages: vi.fn(),
  findEvolutionContacts: vi.fn(),
}));

vi.mock('./ingest', () => ({
  findOrCreateContact: vi.fn(),
  findOrCreateConversation: vi.fn(),
  findOrCreateGroupConversation: vi.fn(),
}));

import { runEvolutionHistoryBackfill } from './history-backfill';
import { findEvolutionChats, findEvolutionMessages, findEvolutionContacts } from '@/lib/whatsapp/evolution-api';
import { findOrCreateContact, findOrCreateConversation, findOrCreateGroupConversation } from './ingest';

const mockFindChats = vi.mocked(findEvolutionChats);
const mockFindMessages = vi.mocked(findEvolutionMessages);
const mockFindContacts = vi.mocked(findEvolutionContacts);
const mockFindOrCreateGroupConv = vi.mocked(findOrCreateGroupConversation);
const mockFindOrCreateContact = vi.mocked(findOrCreateContact);
const mockFindOrCreateConversation = vi.mocked(findOrCreateConversation);

const NOW = new Date('2026-07-15T12:00:00.000Z').getTime();
const NOW_S = Math.floor(NOW / 1000);
const DAY_S = 86_400;

const BASE_ARGS = {
  accountId: 'acct-1',
  configOwnerUserId: 'user-1',
  baseUrl: 'http://evo.local',
  apiKey: 'k',
  instanceName: 'axion-acc1',
  // These tests aren't about the chat-list stabilization wait (see the
  // dedicated describe block below) — one poll reproduces the old
  // single-call behavior with no added delay.
  chatListMaxPolls: 1,
};

function textRecord(overrides: Record<string, unknown> = {}) {
  return {
    key: { id: 'WA-1', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' },
    pushName: 'Alisson',
    messageType: 'conversation',
    message: { conversation: 'oi' },
    messageTimestamp: NOW_S,
    ...overrides,
  };
}

// ------------------------------------------------------------
// Minimal fake Supabase client covering exactly what
// runEvolutionHistoryBackfill talks to directly: the dedup select +
// insert on `messages`, the last-message update on `conversations`,
// and the idempotency marker update on `whatsapp_config`.
// findOrCreateContact/findOrCreateConversation are mocked above, so
// their own `contacts`/`conversations` insert/select calls never reach
// this fake.
// ------------------------------------------------------------
function makeFakeDb(state: {
  existingMessageIds: Set<string>;
  messageInserts: Record<string, unknown>[];
  conversationUpdates: Record<string, unknown>[];
  configUpdates: Record<string, unknown>[];
  currentConvLastMessageAt: string | null;
  contactUpdates?: Record<string, unknown>[];
}): SupabaseClient {
  let table = '';
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    limit: () => builder,
    maybeSingle: async () => {
      if (table === 'messages') {
        // Dedup check — presence keyed by the last `.eq('message_id', x)` call
        // is approximated here by just checking the most recently inserted id.
        return { data: null, error: null };
      }
      if (table === 'conversations') {
        return { data: { last_message_at: state.currentConvLastMessageAt }, error: null };
      }
      return { data: null, error: null };
    },
    insert: (row: Record<string, unknown>) => {
      if (table === 'messages') state.messageInserts.push(row);
      return { select: () => builder, single: async () => ({ data: { id: 'row-1' }, error: null }) };
    },
    update: (row: Record<string, unknown>) => {
      if (table === 'conversations') state.conversationUpdates.push(row);
      if (table === 'whatsapp_config') state.configUpdates.push(row);
      if (table === 'contacts') state.contactUpdates?.push(row);
      return builder;
    },
    then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onF),
  };
  return {
    from: (t: string) => {
      table = t;
      return builder;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindContacts.mockResolvedValue([]);
  mockFindOrCreateContact.mockResolvedValue({
    contact: { id: 'contact-1' },
    wasCreated: false,
  } as never);
  mockFindOrCreateConversation.mockResolvedValue({
    conversation: { id: 'conv-1' },
    created: false,
  } as never);
  mockFindOrCreateGroupConv.mockResolvedValue({
    conversation: { id: 'group-conv-1' },
    created: false,
  } as never);
});

describe('runEvolutionHistoryBackfill', () => {
  it('imports a group chat (@g.us): names the group conversation and records the participant sender', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '120363427655738502@g.us', pushName: 'A Grande Família', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 1, pages: 1, currentPage: 1,
      records: [textRecord({
        key: {
          id: 'WA-G1', fromMe: false, remoteJid: '120363427655738502@g.us',
          participant: '88511457796327@lid', participantAlt: '556294008178@s.whatsapp.net',
        },
        pushName: 'Yeda Braga',
        message: { conversation: 'bom dia grupo' },
      })],
    });
    const state = {
      existingMessageIds: new Set<string>(), messageInserts: [] as Record<string, unknown>[],
      conversationUpdates: [] as Record<string, unknown>[], configUpdates: [] as Record<string, unknown>[],
      currentConvLastMessageAt: null,
    };
    const db = makeFakeDb(state);

    const result = await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(result.chatsProcessed).toBe(1);
    expect(mockFindOrCreateGroupConv).toHaveBeenCalledWith(
      db, 'acct-1', 'user-1', '120363427655738502@g.us', 'A Grande Família',
    );
    expect(state.messageInserts).toHaveLength(1);
    expect(state.messageInserts[0]).toMatchObject({
      conversation_id: 'group-conv-1',
      sender_type: 'customer',
      content_text: 'bom dia grupo',
      sender_participant_name: 'Yeda Braga',
      sender_participant_phone: '556294008178',
    });
    // group backfill must NOT create 1:1 contacts/conversations
    expect(mockFindOrCreateContact).not.toHaveBeenCalled();
  });

  it('skips newsletter/channel and bot chats — never pages their messages', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '120363225660181599@newsletter', lastMessage: { messageTimestamp: NOW_S } },
      { remoteJid: '13135550002@bot', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null,
    });

    const result = await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(mockFindMessages).not.toHaveBeenCalled();
    expect(result.chatsProcessed).toBe(0);
  });

  it('skips a chat whose last message is older than the given cutoff — never pages its messages', async () => {
    mockFindChats.mockResolvedValue([
      {
        remoteJid: '5511999999999@s.whatsapp.net',
        lastMessage: { messageTimestamp: NOW_S - 200 * DAY_S }, // past this test's 90-day cutoff
      },
    ]);
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null,
    });

    // Explicit cutoffDays — this test is about the skip-when-older-than-
    // cutoff behavior itself, not about whatever the default happens to
    // be (see the DEFAULT_CUTOFF_DAYS test below for that).
    const result = await runEvolutionHistoryBackfill({ ...BASE_ARGS, db, cutoffDays: 90 });

    expect(mockFindMessages).not.toHaveBeenCalled();
    expect(result.chatsProcessed).toBe(0);
  });

  it('defaults to a generous cutoff (years, not 90 days) — a dormant chat from over a year ago must still import', async () => {
    // investigacao: real account data showed 11 of 94 real chats (dated
    // as far back as 2024-02-02) silently excluded by the old 90-day
    // default, even though Evolution had their full history — the
    // account's own WhatsApp history-sync goes back that far, our own
    // cutoff was the only thing throwing it away.
    mockFindChats.mockResolvedValue([
      {
        remoteJid: '5511999999999@s.whatsapp.net',
        lastMessage: { messageTimestamp: NOW_S - 500 * DAY_S }, // ~1.4 years old
      },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 1, pages: 1, currentPage: 1,
      records: [textRecord({
        key: { id: 'WA-old', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' },
        messageTimestamp: NOW_S - 500 * DAY_S,
      })],
    });
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null,
    });

    // No cutoffDays passed — exercises the default.
    const result = await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(result.chatsProcessed).toBe(1);
    expect(result.messagesImported).toBe(1);
  });

  it('imports a text message within the cutoff, mapping sender_type from fromMe', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 1, pages: 1, currentPage: 1,
      records: [textRecord({ key: { id: 'WA-1', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' } })],
    });
    const state = {
      existingMessageIds: new Set<string>(), messageInserts: [] as Record<string, unknown>[],
      conversationUpdates: [] as Record<string, unknown>[], configUpdates: [] as Record<string, unknown>[],
      currentConvLastMessageAt: null,
    };
    const db = makeFakeDb(state);

    const result = await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(result.chatsProcessed).toBe(1);
    expect(result.messagesImported).toBe(1);
    expect(state.messageInserts).toHaveLength(1);
    expect(state.messageInserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'oi',
      message_id: 'WA-1',
    });
  });

  it('imports a @lid chat with no phone alt — identifies the contact by LID instead of skipping it (investigacao-completude-sync-conversas.md)', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '175441461657751@lid', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 1, pages: 1, currentPage: 1,
      records: [textRecord({
        key: { id: 'WA-LID', fromMe: false, remoteJid: '175441461657751@lid' },
        pushName: 'Alguém',
        message: { conversation: 'mensagem so com lid' },
      })],
    });
    const state = {
      existingMessageIds: new Set<string>(), messageInserts: [] as Record<string, unknown>[],
      conversationUpdates: [] as Record<string, unknown>[], configUpdates: [] as Record<string, unknown>[],
      currentConvLastMessageAt: null,
    };
    const db = makeFakeDb(state);

    const result = await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(result.chatsProcessed).toBe(1);
    expect(result.messagesImported).toBe(1);
    expect(mockFindOrCreateContact).toHaveBeenCalledWith(
      db, 'acct-1', 'user-1', '', 'Alguém', '175441461657751',
    );
    expect(state.messageInserts).toHaveLength(1);
    expect(state.messageInserts[0]).toMatchObject({ content_text: 'mensagem so com lid' });
  });

  it('names the contact from the address book (findContacts) in preference to the message pushName', async () => {
    mockFindContacts.mockResolvedValue([
      // Address-book name for this phone — the authoritative source.
      { remoteJid: '5511999999999@s.whatsapp.net', pushName: 'Ana Luiza', isSaved: true },
    ]);
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 1, pages: 1, currentPage: 1,
      // The message's own pushName is a weaker source (here just the number).
      records: [textRecord({
        key: { id: 'WA-1', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' },
        pushName: '5511999999999',
      })],
    });
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null,
    });

    await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(mockFindOrCreateContact).toHaveBeenCalledWith(
      db, 'acct-1', 'user-1', '5511999999999', 'Ana Luiza', undefined,
    );
  });

  it('sets avatar_url on a newly-created contact from the address book (findContacts) profilePicUrl — reuses the same call the name comes from, no extra API round-trip', async () => {
    mockFindContacts.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', pushName: 'Ana Luiza', isSaved: true, profilePicUrl: 'https://x/photo.jpg' },
    ]);
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 1, pages: 1, currentPage: 1,
      records: [textRecord({ key: { id: 'WA-1', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' } })],
    });
    mockFindOrCreateContact.mockResolvedValue({
      contact: { id: 'contact-1' }, wasCreated: true,
    } as never);
    const contactUpdates: Record<string, unknown>[] = [];
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null, contactUpdates,
    });

    await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(contactUpdates).toHaveLength(1);
    expect(contactUpdates[0]).toMatchObject({ avatar_url: 'https://x/photo.jpg' });
  });

  it('does not touch avatar_url when the contact already existed (wasCreated: false) — live path already owns avatar sync for existing contacts', async () => {
    mockFindContacts.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', pushName: 'Ana Luiza', isSaved: true, profilePicUrl: 'https://x/photo.jpg' },
    ]);
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 1, pages: 1, currentPage: 1,
      records: [textRecord({ key: { id: 'WA-1', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' } })],
    });
    mockFindOrCreateContact.mockResolvedValue({
      contact: { id: 'contact-1' }, wasCreated: false,
    } as never);
    const contactUpdates: Record<string, unknown>[] = [];
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null, contactUpdates,
    });

    await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(contactUpdates).toHaveLength(0);
  });

  it('sets conversation last_message_at to the newest imported message timestamp (drives phone-mirror ordering)', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 2, pages: 1, currentPage: 1,
      records: [
        textRecord({ key: { id: 'WA-new', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' }, messageTimestamp: NOW_S }),
        textRecord({ key: { id: 'WA-old', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' }, messageTimestamp: NOW_S - 3600 }),
      ],
    });
    const state = {
      existingMessageIds: new Set<string>(), messageInserts: [] as Record<string, unknown>[],
      conversationUpdates: [] as Record<string, unknown>[], configUpdates: [] as Record<string, unknown>[],
      currentConvLastMessageAt: null,
    };
    const db = makeFakeDb(state);

    await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(state.conversationUpdates).toHaveLength(1);
    expect(state.conversationUpdates[0].last_message_at).toBe(new Date(NOW_S * 1000).toISOString());
  });

  it('marks fromMe messages as sender_type "agent"', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 1, pages: 1, currentPage: 1,
      records: [textRecord({ key: { id: 'WA-2', fromMe: true, remoteJid: '5511999999999@s.whatsapp.net' } })],
    });
    const state = {
      existingMessageIds: new Set<string>(), messageInserts: [] as Record<string, unknown>[],
      conversationUpdates: [] as Record<string, unknown>[], configUpdates: [] as Record<string, unknown>[],
      currentConvLastMessageAt: null,
    };
    const db = makeFakeDb(state);

    await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(state.messageInserts[0]).toMatchObject({ sender_type: 'agent', status: 'sent' });
  });

  it('stops paging a chat once a record crosses the cutoff, without importing it', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 2, pages: 1, currentPage: 1,
      records: [
        textRecord({ key: { id: 'WA-recent', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' }, messageTimestamp: NOW_S }),
        textRecord({ key: { id: 'WA-stale', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' }, messageTimestamp: NOW_S - 200 * DAY_S }),
      ],
    });
    const state = {
      existingMessageIds: new Set<string>(), messageInserts: [] as Record<string, unknown>[],
      conversationUpdates: [] as Record<string, unknown>[], configUpdates: [] as Record<string, unknown>[],
      currentConvLastMessageAt: null,
    };
    const db = makeFakeDb(state);

    // Explicit cutoffDays — same reasoning as the chat-level skip test
    // above.
    const result = await runEvolutionHistoryBackfill({ ...BASE_ARGS, db, cutoffDays: 90 });

    expect(result.messagesImported).toBe(1);
    expect(state.messageInserts.map((m) => m.message_id)).toEqual(['WA-recent']);
  });

  it('sets evolution_history_synced_at on whatsapp_config after processing', async () => {
    mockFindChats.mockResolvedValue([]);
    const state = {
      existingMessageIds: new Set<string>(), messageInserts: [] as Record<string, unknown>[],
      conversationUpdates: [] as Record<string, unknown>[], configUpdates: [] as Record<string, unknown>[],
      currentConvLastMessageAt: null,
    };
    const db = makeFakeDb(state);

    await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(state.configUpdates).toHaveLength(1);
    expect(state.configUpdates[0]).toHaveProperty('evolution_history_synced_at');
  });

  it('keeps looking for a real customer pushName later in the same chat when the message that first resolved the contact was one we sent (fromMe:true, no usable name)', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 2, pages: 1, currentPage: 1,
      records: [
        textRecord({
          key: { id: 'WA-outbound', fromMe: true, remoteJid: '5511999999999@s.whatsapp.net' },
          pushName: 'Alisson',
          messageTimestamp: NOW_S,
        }),
        textRecord({
          key: { id: 'WA-inbound', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' },
          pushName: 'Real Customer',
          messageTimestamp: NOW_S - 60,
        }),
      ],
    });
    const state = {
      existingMessageIds: new Set<string>(), messageInserts: [] as Record<string, unknown>[],
      conversationUpdates: [] as Record<string, unknown>[], configUpdates: [] as Record<string, unknown>[],
      currentConvLastMessageAt: null,
    };
    const db = makeFakeDb(state);

    await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    // First call resolves the contact off the fromMe:true message — no
    // usable name yet (mapEvolutionMessage strips pushName for fromMe).
    expect(mockFindOrCreateContact).toHaveBeenNthCalledWith(
      1, db, 'acct-1', 'user-1', '5511999999999', '', undefined,
    );
    // Second call, once the older customer-sent message is reached,
    // backfills the real name instead of leaving it on the placeholder.
    expect(mockFindOrCreateContact).toHaveBeenNthCalledWith(
      2, db, 'acct-1', 'user-1', '5511999999999', 'Real Customer', undefined,
    );
  });

  it('does not re-call findOrCreateContact when the first message already had a real customer name', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511999999999@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({
      total: 2, pages: 1, currentPage: 1,
      records: [
        textRecord({
          key: { id: 'WA-1', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' },
          pushName: 'Real Customer',
          messageTimestamp: NOW_S,
        }),
        textRecord({
          key: { id: 'WA-2', fromMe: false, remoteJid: '5511999999999@s.whatsapp.net' },
          pushName: 'Real Customer',
          messageTimestamp: NOW_S - 60,
        }),
      ],
    });
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null,
    });

    await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(mockFindOrCreateContact).toHaveBeenCalledTimes(1);
  });

  it('does not throw when findEvolutionChats itself fails — logs and returns zero counts', async () => {
    mockFindChats.mockRejectedValue(new Error('network down'));
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null,
    });

    const result = await runEvolutionHistoryBackfill({ ...BASE_ARGS, db });

    expect(result).toEqual({ chatsProcessed: 0, messagesImported: 0 });
  });
});

describe('runEvolutionHistoryBackfill — chat list stabilization', () => {
  // investigacao-completude-sync-conversas.md: connection.update fires
  // as soon as the socket opens, but WhatsApp's own history sync to
  // Baileys/Evolution is itself asynchronous — findChats called too
  // early can see a still-growing, incomplete chat list. These tests
  // use pollIntervalMs: 0 so the retry loop itself is exercised without
  // adding real wall-clock delay to the suite.
  it('polls findEvolutionChats until the count stops growing, then backfills with the stable list', async () => {
    mockFindChats
      .mockResolvedValueOnce([
        { remoteJid: '5511111111111@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
      ])
      .mockResolvedValueOnce([
        { remoteJid: '5511111111111@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
        { remoteJid: '5511222222222@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
      ])
      // Same count as the previous call — stable, stop polling here.
      .mockResolvedValueOnce([
        { remoteJid: '5511111111111@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
        { remoteJid: '5511222222222@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
      ]);
    mockFindMessages.mockResolvedValue({ total: 0, pages: 1, currentPage: 1, records: [] });
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null,
    });

    const result = await runEvolutionHistoryBackfill({
      ...BASE_ARGS, db, chatListMaxPolls: 6, chatListPollIntervalMs: 0,
    });

    expect(mockFindChats).toHaveBeenCalledTimes(3);
    expect(result.chatsProcessed).toBe(2);
  });

  it('gives up after chatListMaxPolls and proceeds with whatever the last call returned', async () => {
    // Count keeps growing on every call — never stabilizes within budget.
    mockFindChats
      .mockResolvedValueOnce([{ remoteJid: '5511111111111@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } }])
      .mockResolvedValueOnce([
        { remoteJid: '5511111111111@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
        { remoteJid: '5511222222222@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
      ])
      .mockResolvedValueOnce([
        { remoteJid: '5511111111111@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
        { remoteJid: '5511222222222@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
        { remoteJid: '5511333333333@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
      ]);
    mockFindMessages.mockResolvedValue({ total: 0, pages: 1, currentPage: 1, records: [] });
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null,
    });

    const result = await runEvolutionHistoryBackfill({
      ...BASE_ARGS, db, chatListMaxPolls: 3, chatListPollIntervalMs: 0,
    });

    expect(mockFindChats).toHaveBeenCalledTimes(3);
    // Proceeds with the 3rd (last) call's list rather than hanging forever.
    expect(result.chatsProcessed).toBe(3);
  });

  it('makes exactly one call when chatListMaxPolls is 1 (no stabilization wait)', async () => {
    mockFindChats.mockResolvedValue([
      { remoteJid: '5511111111111@s.whatsapp.net', lastMessage: { messageTimestamp: NOW_S } },
    ]);
    mockFindMessages.mockResolvedValue({ total: 0, pages: 1, currentPage: 1, records: [] });
    const db = makeFakeDb({
      existingMessageIds: new Set(), messageInserts: [], conversationUpdates: [], configUpdates: [],
      currentConvLastMessageAt: null,
    });

    await runEvolutionHistoryBackfill({ ...BASE_ARGS, db, chatListMaxPolls: 1, chatListPollIntervalMs: 0 });

    expect(mockFindChats).toHaveBeenCalledTimes(1);
  });
});
