import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Os engines são fire-and-forget; mocká-los para no-op mantém o teste
// focado na persistência.
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn().mockResolvedValue({ consumed: false }) }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn().mockResolvedValue(null),
  findExistingContactByLid: vi.fn().mockResolvedValue(null),
  isUniqueViolation: () => false,
}));

import { ingestInbound } from './ingest';
import { findExistingContact, findExistingContactByLid } from '@/lib/contacts/dedupe';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

// ------------------------------------------------------------
// Chainable Supabase stub, scripted per table — same shape as
// `makeDb` in src/lib/whatsapp/resolve-conversation.test.ts. Records
// every insert payload into `inserts[table]` and resolves terminal
// methods (select/limit, single, thenable update/insert) with the
// minimal data ingestInbound needs to keep moving forward:
//   - contacts / conversations: no existing row → insert path,
//     `.select().single()` returns the inserted row with a fake id.
//   - conversations select().order().limit(1): empty (no existing
//     conversation) so a new one gets created.
//   - messages: the count-select (prior customer messages) resolves to
//     0, and the plain insert is a thenable that resolves to no error.
//   - broadcast_recipients: empty list, so flagBroadcastReplyIfAny is a
//     no-op.
// ------------------------------------------------------------
function makeFakeDb(
  inserts: Record<string, unknown[]>,
  updates: Record<string, unknown[]> = {},
  rpcCalls: { fn: string; args: unknown }[] = [],
): SupabaseClient {
  let table = '';
  let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let pendingInsert: Record<string, unknown> | null = null;

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: (row: Record<string, unknown>) => {
      mode = 'insert';
      pendingInsert = row;
      inserts[table]?.push(row);
      return builder;
    },
    // Only message_reactions upserts in this file's exercised paths;
    // awaited directly (no further .select().single() chain), so it
    // resolves to a Promise rather than returning `builder`.
    upsert: (row: Record<string, unknown>) => {
      inserts[table]?.push(row);
      return Promise.resolve({ data: null, error: null });
    },
    update: (row: Record<string, unknown>) => {
      mode = 'update';
      updates[table]?.push(row);
      return builder;
    },
    delete: () => {
      mode = 'delete';
      return builder;
    },
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    // Chainable AND directly awaitable: conversations' find-or-create
    // path awaits `.limit(1)` directly, while the duplicate-webhook-
    // delivery guard chains `.limit(1).maybeSingle()` on top of it.
    limit: () => Object.assign(Promise.resolve({ data: [], error: null }), {
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => {
      if (table === 'contacts' && mode === 'insert') {
        return Promise.resolve({ data: { id: 'contact-1', ...pendingInsert }, error: null });
      }
      if (table === 'conversations' && mode === 'insert') {
        return Promise.resolve({ data: { id: 'conv-1', unread_count: 0, ...pendingInsert }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    // Thenable: covers the messages count-select and the plain
    // insert/update calls that are awaited directly without a
    // terminal method (`.eq()` / bare `.insert()` chains).
    then: (resolve: (v: { data: null; error: null; count: number }) => void) =>
      resolve({ data: null, error: null, count: 0 }),
  };

  return {
    from: (t: string) => {
      table = t;
      mode = 'select';
      pendingInsert = null;
      return builder;
    },
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
}

describe('ingestInbound', () => {
  it('creates contact + conversation + message for a text inbound', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    await ingestInbound(
      { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.a',
        timestamp: new Date(), kind: 'text', text: 'oi' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(inserts.messages).toHaveLength(1);
    expect(inserts.messages[0]).toMatchObject({ content_type: 'text', content_text: 'oi', sender_type: 'customer' });
  });

  it('bumps unread_count via the atomic increment RPC (not a read-then-write update) for a genuine customer inbound', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const updates: Record<string, unknown[]> = { conversations: [] };
    const rpcCalls: { fn: string; args: unknown }[] = [];
    const db = makeFakeDb(inserts, updates, rpcCalls);
    await ingestInbound(
      { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.unread1',
        timestamp: new Date(), kind: 'text', text: 'oi' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    // Two concurrent inbound messages for the same conversation must not
    // be able to both read a stale unread_count and both write N+1 —
    // same lost-update race already fixed once in this codebase for
    // automations.execution_count (migration 007). The plain conversations
    // update must NOT carry unread_count at all; only the RPC touches it.
    expect(rpcCalls).toEqual([
      { fn: 'increment_conversation_unread', args: { p_conversation_id: 'conv-1' } },
    ]);
    expect(updates.conversations[0]).not.toHaveProperty('unread_count');
  });

  it('names a new contact with a formatted phone number when no name is available', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    await ingestInbound(
      { from: '556188885665', contactName: '', providerMessageId: 'wamid.noname',
        timestamp: new Date(), kind: 'text', text: 'oi' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(inserts.contacts).toHaveLength(1);
    expect(inserts.contacts[0]).toMatchObject({ name: '+55 61 8888-5665', phone: '556188885665' });
  });

  it('stores the contact LID on creation when the inbound is LID-addressed (so a later presence.update, which arrives LID-only, can resolve back to this contact)', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    await ingestInbound(
      { from: '556183565665', contactName: 'Ana', providerMessageId: 'wamid.lid1',
        timestamp: new Date(), kind: 'text', text: 'oi', contactLid: '224876350689405' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(inserts.contacts[0]).toMatchObject({ lid: '224876350689405' });
  });

  it('backfills lid onto an existing contact that was created before its LID was known', async () => {
    vi.mocked(findExistingContact).mockResolvedValueOnce({
      id: 'contact-existing', name: 'Ana', phone: '556183565665', lid: null,
    } as never);
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const updates: Record<string, unknown[]> = { contacts: [] };
    const db = makeFakeDb(inserts, updates);
    await ingestInbound(
      { from: '556183565665', contactName: 'Ana', providerMessageId: 'wamid.lid2',
        timestamp: new Date(), kind: 'text', text: 'oi', contactLid: '224876350689405' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(updates.contacts[0]).toMatchObject({ lid: '224876350689405' });
  });

  it("still syncs the name from WhatsApp's pushName when it differs and the contact's name was never manually edited", async () => {
    vi.mocked(findExistingContact).mockResolvedValueOnce({
      id: 'contact-existing', name: 'Ana (velho)', phone: '556183565665',
      name_edited_manually: false,
    } as never);
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const updates: Record<string, unknown[]> = { contacts: [] };
    const db = makeFakeDb(inserts, updates);
    await ingestInbound(
      { from: '556183565665', contactName: 'Ana Nova', providerMessageId: 'wamid.namesync',
        timestamp: new Date(), kind: 'text', text: 'oi' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(updates.contacts[0]).toMatchObject({ name: 'Ana Nova' });
  });

  it("does not overwrite a manually-edited contact name, even when WhatsApp's pushName differs (investigacao: reconnect reverted edited names)", async () => {
    vi.mocked(findExistingContact).mockResolvedValueOnce({
      id: 'contact-existing', name: 'Nome Editado Pelo Agente', phone: '556183565665',
      name_edited_manually: true,
    } as never);
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const updates: Record<string, unknown[]> = { contacts: [] };
    const db = makeFakeDb(inserts, updates);
    await ingestInbound(
      { from: '556183565665', contactName: 'PushName Diferente', providerMessageId: 'wamid.namelocked',
        timestamp: new Date(), kind: 'text', text: 'oi' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(updates.contacts).toHaveLength(0);
  });

  it('creates a contact keyed by LID alone when no phone is resolvable (investigacao-completude-sync-conversas.md — @lid chat with no phone alt)', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    await ingestInbound(
      { from: '', contactName: 'Alguém', providerMessageId: 'wamid.lidonly',
        timestamp: new Date(), kind: 'text', text: 'oi', contactLid: '175441461657751' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(findExistingContactByLid).toHaveBeenCalledWith(db, 'acc-1', '175441461657751');
    expect(inserts.contacts).toHaveLength(1);
    expect(inserts.contacts[0]).toMatchObject({ phone: null, lid: '175441461657751', name: 'Alguém' });
    expect(inserts.messages).toHaveLength(1);
  });

  it('finds the existing LID-only contact instead of creating a duplicate on a later message', async () => {
    vi.mocked(findExistingContactByLid).mockResolvedValueOnce({
      id: 'contact-lid-existing', name: 'Alguém', phone: null, lid: '175441461657751',
    } as never);
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    await ingestInbound(
      { from: '', contactName: 'Alguém', providerMessageId: 'wamid.lidonly2',
        timestamp: new Date(), kind: 'text', text: 'de novo', contactLid: '175441461657751' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(inserts.contacts).toHaveLength(0);
  });

  it('does not overwrite a manually-edited LID-only contact name when a later pushName differs', async () => {
    vi.mocked(findExistingContactByLid).mockResolvedValueOnce({
      id: 'contact-lid-existing', name: 'Nome Editado Pelo Agente', phone: null,
      lid: '175441461657751', name_edited_manually: true,
    } as never);
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const updates: Record<string, unknown[]> = { contacts: [] };
    const db = makeFakeDb(inserts, updates);
    await ingestInbound(
      { from: '', contactName: 'PushName Diferente', providerMessageId: 'wamid.lidonly3',
        timestamp: new Date(), kind: 'text', text: 'de novo', contactLid: '175441461657751' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(inserts.contacts).toHaveLength(0);
    expect(updates.contacts).toHaveLength(0);
  });

  it('ingests a group message: creates a group conversation and records the participant sender (no contact created)', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    await ingestInbound(
      { from: '556294008178', contactName: 'Yeda Braga', providerMessageId: 'wamid.grp1',
        timestamp: new Date(), kind: 'text', text: 'bom dia grupo',
        group: { jid: '120363427655738502@g.us', name: 'A Grande Família' } },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(inserts.contacts).toHaveLength(0);
    expect(inserts.conversations).toHaveLength(1);
    expect(inserts.conversations[0]).toMatchObject({
      is_group: true, group_jid: '120363427655738502@g.us',
      group_name: 'A Grande Família', contact_id: null,
    });
    expect(inserts.messages).toHaveLength(1);
    expect(inserts.messages[0]).toMatchObject({
      sender_type: 'customer', content_text: 'bom dia grupo',
      sender_participant_name: 'Yeda Braga', sender_participant_phone: '556294008178',
    });
  });

  it('bumps unread_count via the atomic increment RPC for a group message too', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const updates: Record<string, unknown[]> = { conversations: [] };
    const rpcCalls: { fn: string; args: unknown }[] = [];
    const db = makeFakeDb(inserts, updates, rpcCalls);
    await ingestInbound(
      { from: '556294008178', contactName: 'Yeda Braga', providerMessageId: 'wamid.grp-unread',
        timestamp: new Date(), kind: 'text', text: 'bom dia grupo',
        group: { jid: '120363427655738502@g.us', name: 'A Grande Família' } },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(rpcCalls).toEqual([
      { fn: 'increment_conversation_unread', args: { p_conversation_id: 'conv-1' } },
    ]);
    expect(updates.conversations[0]).not.toHaveProperty('unread_count');
  });

  it('does not dispatch automations / AI / flows for a group message', async () => {
    vi.mocked(runAutomationsForTrigger).mockClear();
    vi.mocked(dispatchInboundToAiReply).mockClear();
    vi.mocked(dispatchInboundToFlows).mockClear();
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    await ingestInbound(
      { from: '556294008178', contactName: 'Yeda', providerMessageId: 'wamid.grp2',
        timestamp: new Date(), kind: 'text', text: 'oi',
        group: { jid: '120363427655738502@g.us', name: 'G' } },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
    expect(dispatchInboundToFlows).not.toHaveBeenCalled();
  });

  it('records a fromMe group message as an agent message with no participant identity', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    await ingestInbound(
      { from: '', contactName: undefined, providerMessageId: 'wamid.grp3',
        timestamp: new Date(), kind: 'text', text: 'aviso do grupo', fromMe: true,
        group: { jid: '120363427655738502@g.us', name: 'G' } },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(inserts.messages).toHaveLength(1);
    expect(inserts.messages[0]).toMatchObject({
      sender_type: 'agent', sender_participant_name: null, sender_participant_phone: null,
    });
  });

  it('passes the inbound providerMessageId to dispatchInboundToAiReply as triggeringProviderMessageId', async () => {
    vi.mocked(dispatchInboundToAiReply).mockClear();
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    await ingestInbound(
      { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.trigger-1',
        timestamp: new Date(), kind: 'text', text: 'oi' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ triggeringProviderMessageId: 'wamid.trigger-1' }),
    );
  });

  describe('duplicate webhook delivery guard', () => {
    it('skips re-ingestion entirely when a message with this id already exists in the conversation', async () => {
      vi.mocked(dispatchInboundToFlows).mockClear();
      vi.mocked(runAutomationsForTrigger).mockClear();
      vi.mocked(dispatchInboundToAiReply).mockClear();
      vi.mocked(findExistingContact).mockResolvedValueOnce({
        id: 'contact-1', phone: '15551234567', name: 'Ana',
      } as never);
      const inserts: Record<string, unknown[]> = { messages: [] };
      const db = {
        from: (table: string) => {
          if (table === 'conversations') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({ limit: () => Promise.resolve({ data: [{ id: 'conv-1', unread_count: 0 }], error: null }) }),
                  }),
                }),
              }),
            };
          }
          if (table === 'messages') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    limit: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'existing-msg-1' }, error: null }) }),
                  }),
                }),
              }),
              // Would only be reached if the guard failed to short-circuit.
              insert: (row: Record<string, unknown>) => {
                inserts.messages.push(row);
                return { select: () => ({ single: () => Promise.resolve({ data: { id: 'new-msg' }, error: null }) }) };
              },
            };
          }
          throw new Error(`unexpected table in this test: ${table}`);
        },
      } as unknown as SupabaseClient;

      await ingestInbound(
        { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.retry-1',
          timestamp: new Date(), kind: 'text', text: 'reenvio do provedor' },
        { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
      );

      expect(inserts.messages).toHaveLength(0);
      expect(dispatchInboundToFlows).not.toHaveBeenCalled();
      expect(runAutomationsForTrigger).not.toHaveBeenCalled();
      expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
    });
  });

  it('fires onContactCreated with the new contact row when a contact is actually created', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    const onContactCreated = vi.fn();
    await ingestInbound(
      { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.a',
        timestamp: new Date(), kind: 'text', text: 'oi' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db, onContactCreated },
    );
    expect(onContactCreated).toHaveBeenCalledTimes(1);
    expect(onContactCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'contact-1' }));
  });

  it('does not fire onContactCreated when the contact already existed', async () => {
    vi.mocked(findExistingContact).mockResolvedValueOnce({
      id: 'existing-contact', phone: '15551234567', name: 'Ana',
    } as never);
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    const onContactCreated = vi.fn();
    await ingestInbound(
      { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.b',
        timestamp: new Date(), kind: 'text', text: 'oi de novo' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db, onContactCreated },
    );
    expect(onContactCreated).not.toHaveBeenCalled();
  });

  it('does not throw or abort ingestion when onContactCreated itself throws', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts);
    const onContactCreated = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(
      ingestInbound(
        { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.c',
          timestamp: new Date(), kind: 'text', text: 'oi' },
        { accountId: 'acc-1', configOwnerUserId: 'user-1', db, onContactCreated },
      ),
    ).resolves.toBeUndefined();
    expect(inserts.messages).toHaveLength(1);
  });

  // ------------------------------------------------------------
  // fromMe: true — a message sent from the linked phone directly (the
  // caller has already ruled out "this is our own CRM-send echo" before
  // it reaches ingestInbound; see sent-by-crm-cache.ts /
  // isKnownCrmEcho in the Evolution webhook route).
  // ------------------------------------------------------------
  describe('fromMe: true (phone-sent message)', () => {
    it('records it as sender_type agent / status sent, not a customer message', async () => {
      const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
      const db = makeFakeDb(inserts);
      await ingestInbound(
        { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.phone1',
          timestamp: new Date(), kind: 'text', text: 'respondido do celular', fromMe: true },
        { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
      );
      expect(inserts.messages).toHaveLength(1);
      expect(inserts.messages[0]).toMatchObject({
        content_text: 'respondido do celular', sender_type: 'agent', status: 'sent',
      });
    });

    it('does not bump the conversation unread_count', async () => {
      const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
      const updates: Record<string, unknown[]> = { conversations: [] };
      const rpcCalls: { fn: string; args: unknown }[] = [];
      const db = makeFakeDb(inserts, updates, rpcCalls);
      await ingestInbound(
        { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.phone2',
          timestamp: new Date(), kind: 'text', text: 'oi', fromMe: true },
        { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
      );
      // A phone-sent message doesn't touch unread_count at all — not even
      // a same-value update — so the atomic-increment RPC must not fire.
      expect(rpcCalls).toHaveLength(0);
    });

    it('does not dispatch the flow runner, automations, AI auto-reply, or message.received', async () => {
      vi.mocked(dispatchInboundToFlows).mockClear();
      vi.mocked(runAutomationsForTrigger).mockClear();
      vi.mocked(dispatchInboundToAiReply).mockClear();
      vi.mocked(dispatchWebhookEvent).mockClear();

      const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
      const db = makeFakeDb(inserts);
      await ingestInbound(
        { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.phone3',
          timestamp: new Date(), kind: 'text', text: 'oi', fromMe: true },
        { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
      );

      expect(dispatchInboundToFlows).not.toHaveBeenCalled();
      expect(runAutomationsForTrigger).not.toHaveBeenCalled();
      expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
      // conversation.created is still allowed to fire (a phone-sent
      // message can open a brand-new thread) — only message.received
      // must be suppressed.
      expect(dispatchWebhookEvent).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), 'message.received', expect.anything(),
      );
    });

    it('still inserts the message even when a customer inbound would have', async () => {
      // Regression guard: the isFromMe early-return must come AFTER the
      // message insert + conversation update, not before — otherwise a
      // phone-sent message silently never reaches the inbox at all.
      const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
      const db = makeFakeDb(inserts);
      await ingestInbound(
        { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.phone4',
          timestamp: new Date(), kind: 'text', text: 'oi', fromMe: true },
        { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
      );
      expect(inserts.messages).toHaveLength(1);
    });

    it('attributes a phone-added reaction to the config owner (actor_type agent), not the contact', async () => {
      // Dedicated minimal stub rather than makeFakeDb: the reaction path
      // only touches contacts/conversations (find-or-create, both via
      // findExistingContact/existing-conversation branches below) and
      // messages (lookupInternalIdByMetaId's select().eq().eq().maybeSingle()
      // chain, which needs to resolve a target row) + message_reactions
      // (the upsert this test asserts on).
      vi.mocked(findExistingContact).mockResolvedValueOnce({
        id: 'contact-1', phone: '15551234567', name: 'Ana',
      } as never);
      const inserts: Record<string, unknown[]> = { message_reactions: [] };
      const db = {
        from: (table: string) => {
          if (table === 'conversations') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({ limit: () => Promise.resolve({ data: [{ id: 'conv-1', unread_count: 0 }], error: null }) }),
                  }),
                }),
              }),
            };
          }
          if (table === 'messages') {
            return {
              select: () => ({
                // Two different queries land on this table: the new
                // duplicate-webhook-delivery guard (`.eq('conversation_id',
                // ...).eq('message_id', ...).limit(1).maybeSingle()`) runs
                // first for every inbound, and lookupInternalIdByMetaId
                // (`.eq('message_id', ...).eq('conversation_id',
                // ...).maybeSingle()`, no `.limit()`) runs after, to resolve
                // the reaction's target. Branch on which column is `.eq()`d
                // first to tell them apart.
                eq: (col1: string) => ({
                  eq: () =>
                    col1 === 'conversation_id'
                      ? { limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }
                      : { maybeSingle: () => Promise.resolve({ data: { id: 'target-msg-1' }, error: null }) },
                }),
              }),
            };
          }
          if (table === 'message_reactions') {
            return {
              upsert: (row: Record<string, unknown>) => {
                inserts.message_reactions.push(row);
                return Promise.resolve({ data: null, error: null });
              },
            };
          }
          throw new Error(`unexpected table in this test: ${table}`);
        },
      } as unknown as SupabaseClient;

      await ingestInbound(
        { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.reaction1',
          timestamp: new Date(), kind: 'reaction', fromMe: true,
          reaction: { targetProviderMessageId: 'wamid.target', emoji: '👍' } },
        { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
      );

      expect(inserts.message_reactions).toHaveLength(1);
      expect(inserts.message_reactions[0]).toMatchObject({
        actor_type: 'agent', actor_id: 'user-1', emoji: '👍',
      });
    });
  });
});
