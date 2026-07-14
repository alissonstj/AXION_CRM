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
  isUniqueViolation: () => false,
}));

import { ingestInbound } from './ingest';
import { findExistingContact } from '@/lib/contacts/dedupe';

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
function makeFakeDb(inserts: Record<string, unknown[]>): SupabaseClient {
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
    update: () => {
      mode = 'update';
      return builder;
    },
    delete: () => {
      mode = 'delete';
      return builder;
    },
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => Promise.resolve({ data: [], error: null }),
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
});
