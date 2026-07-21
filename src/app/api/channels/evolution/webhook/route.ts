import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { EvolutionProvider } from '@/lib/channels/providers/evolution';
import { ingestInbound } from '@/lib/channels/ingest';
import { uploadEvolutionMedia } from '@/lib/channels/evolution-media';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { fetchEvolutionProfilePicture, fetchEvolutionGroupInfo } from '@/lib/whatsapp/evolution-api';
import { wasSentByCrm } from '@/lib/channels/sent-by-crm-cache';
import { runEvolutionHistoryBackfill } from '@/lib/channels/history-backfill';

interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  apikey?: string;
  data?: {
    state?: string;
    statusReason?: number;
    base64?: string;
    /** qrcode.updated's actual shape (v2.3.7) — the QR image is nested
     *  here, not at data.base64 directly (see the handler's comment). */
    qrcode?: { base64?: string };
    /** messages.update — the WhatsApp wire message id (matches what
     *  sendEvolutionText/sendEvolutionMedia return as providerMessageId
     *  and what we store in messages.message_id). NOT the same as the
     *  sibling `messageId` field, which is Evolution's own internal
     *  Postgres row id — confirmed via a live capture against a real
     *  connected instance, see mapEvolutionMessageStatus below. */
    keyId?: string;
    /** messages.update — Baileys' WAMessageStatus enum name. */
    status?: string;
    /** presence.update — the chat JID this presence report is about.
     *  Often a LID (@lid), not the phone — unlike message events, a
     *  presence payload carries no remoteJidAlt to resolve a phone from
     *  (confirmed live 2026-07-17). */
    id?: string;
    /** presence.update — keyed by the same `id` above (Baileys reports
     *  one presence per JID in the map, even though only a single chat
     *  is ever included per event, confirmed live). */
    presences?: Record<string, { lastKnownPresence?: string }>;
  };
}

/**
 * Baileys' WAMessageStatus enum: ERROR=0, PENDING=1, SERVER_ACK=2,
 * DELIVERY_ACK=3, READ=4, PLAYED=5. SERVER_ACK and DELIVERY_ACK are
 * confirmed live against a real connected instance (captured
 * 2026-07-14: a self-sent text produced DELIVERY_ACK then SERVER_ACK —
 * note the events arrived out of numeric order, which is why the
 * transition guard below is forward-only rather than trusting arrival
 * order). READ/PLAYED/ERROR are the documented remaining enum values,
 * not yet live-verified — mapped on the same confidence basis as the
 * rest of this Baileys integration (see evolution-webhook-samples.ts).
 */
function mapEvolutionMessageStatus(raw: string | undefined): 'sent' | 'delivered' | 'read' | 'failed' | null {
  switch (raw) {
    case 'SERVER_ACK': return 'sent';
    case 'DELIVERY_ACK': return 'delivered';
    case 'READ':
    case 'PLAYED':
      return 'read';
    case 'ERROR':
      return 'failed';
    default:
      return null; // PENDING, or an unrecognized future enum value.
  }
}

// Forward-only guards, same shape as the Meta webhook's
// RECIPIENT_STATUS_LADDER/isValidStatusTransition (src/app/api/whatsapp/webhook/route.ts)
// but scoped to this route's two target tables. Meta's own handler
// doesn't guard the plain `messages.status` update — added here
// specifically because live capture showed Evolution can deliver
// messages.update events out of order.
const MESSAGE_STATUS_LADDER = ['sending', 'sent', 'delivered', 'read'] as const;
const RECIPIENT_STATUS_LADDER = ['pending', 'sent', 'delivered', 'read', 'replied'] as const;

function isValidTransition(ladder: readonly string[], failedFrom: readonly string[], current: string, incoming: string): boolean {
  if (incoming === 'failed') return failedFrom.includes(current);
  if (current === 'failed') return false;
  const ci = ladder.indexOf(current);
  const ii = ladder.indexOf(incoming);
  if (ii < 0) return false;
  if (ci < 0) return true;
  return ii > ci;
}

/**
 * Mirrors handleStatusUpdate in src/app/api/whatsapp/webhook/route.ts:
 * updates the sent message's status, mirrors onto broadcast_recipients
 * when the message was part of a broadcast, and fans out
 * message.status_updated. Best-effort — errors are caught by the
 * caller's outer try/catch, matching this route's ack-200-always intent.
 */
async function handleEvolutionStatusUpdate(
  db: SupabaseClient,
  statusEvent: { keyId?: string; status?: string },
): Promise<void> {
  const keyId = statusEvent.keyId;
  const mappedStatus = mapEvolutionMessageStatus(statusEvent.status);
  if (!keyId || !mappedStatus) return;

  // message_id isn't unique (mirrors the Meta handler's own note —
  // ids can repeat across providers/numbers), so resolve one row to
  // decide the transition and derive the owning account, same as Meta.
  const { data: msgRow, error: fetchErr } = await db
    .from('messages')
    .select('id, status, conversation_id, conversations(account_id)')
    .eq('message_id', keyId)
    .limit(1)
    .maybeSingle();

  if (fetchErr || !msgRow) return;

  if (isValidTransition(MESSAGE_STATUS_LADDER, ['sending', 'sent'], msgRow.status as string, mappedStatus)) {
    await db.from('messages').update({ status: mappedStatus }).eq('id', msgRow.id);
  }

  const { data: recipient } = await db
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', keyId)
    .maybeSingle();

  if (recipient && isValidTransition(RECIPIENT_STATUS_LADDER, ['pending', 'sent'], recipient.status as string, mappedStatus)) {
    const update: Record<string, unknown> = { status: mappedStatus };
    const tsIso = new Date().toISOString();
    if (mappedStatus === 'delivered') update.delivered_at = tsIso;
    if (mappedStatus === 'read') update.read_at = tsIso;
    await db.from('broadcast_recipients').update(update).eq('id', recipient.id);
  }

  const conv = msgRow.conversations as unknown as { account_id: string } | null;
  if (conv?.account_id) {
    await dispatchWebhookEvent(db, conv.account_id, 'message.status_updated', {
      whatsapp_message_id: keyId,
      conversation_id: msgRow.conversation_id,
      status: mappedStatus,
    });
  }
}

/** How long a "composing" presence keeps the inbox's typing indicator
 *  showing without a follow-up event. Time-boxed rather than cleared
 *  only by an explicit "stopped typing" event, so a dropped webhook
 *  delivery or a backgrounded phone mid-type can't leave "digitando…"
 *  stuck on forever — the UI just checks `typing_until > now()`. */
const TYPING_INDICATOR_TTL_MS = 8_000;

/**
 * Mirrors the OUTBOUND typing indicator (sendTyping — tells WhatsApp
 * when the agent/AI is typing) in the other direction: tells the CRM
 * when the CUSTOMER is typing, so the inbox can show "digitando…" too.
 *
 * Resolves the chat's `id` (often a LID, not a phone — presence
 * payloads carry no phone alt, unlike message events) to a contact via
 * `contacts.lid` or `contacts.phone`, then to that contact's 1:1
 * conversation, and stamps/clears `conversations.typing_until`.
 * Best-effort throughout — this is cosmetic UI state, never worth
 * surfacing an error for. Never touches groups: a group's `id` is a
 * @g.us JID, which matches neither the phone nor lid column, so the
 * contact lookup naturally no-ops for those.
 */
async function handleEvolutionPresenceUpdate(
  db: SupabaseClient,
  accountId: string,
  data: EvolutionWebhookPayload['data'],
): Promise<void> {
  const id = data?.id;
  if (!id) return;
  const [rawId, suffix] = id.split('@');
  if (!rawId) return;

  const presence = data?.presences?.[id]?.lastKnownPresence;
  if (!presence) return;

  const column = suffix === 'lid' ? 'lid' : 'phone';
  const { data: contact } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq(column, rawId)
    .maybeSingle();
  if (!contact) return;

  // UNIQUE(account_id, contact_id) (migration 036) guarantees at most
  // one row — .maybeSingle() is safe here, no multi-row risk.
  const { data: conversation } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .maybeSingle();
  if (!conversation) return;

  const typingUntil = presence === 'composing'
    ? new Date(Date.now() + TYPING_INDICATOR_TTL_MS).toISOString()
    : null;

  await db.from('conversations').update({ typing_until: typingUntil }).eq('id', conversation.id);
}

/**
 * A `fromMe: true` inbound is either an echo of a message the CRM
 * itself just sent, or a message sent directly from the linked phone.
 * The fast path checks the in-memory marker `EvolutionProvider.sender`
 * writes the instant it gets a `providerMessageId` back (see
 * sent-by-crm-cache.ts); the DB fallback covers the case where the
 * webhook echo's `messages.upsert` event somehow wins the race against
 * our own `messages` insert in send-message.ts, still before the
 * marker was set or after it expired.
 */
async function isKnownCrmEcho(
  db: SupabaseClient,
  accountId: string,
  providerMessageId: string,
): Promise<boolean> {
  if (wasSentByCrm(providerMessageId)) return true;

  const { data } = await db
    .from('messages')
    .select('id, conversations!inner(account_id)')
    .eq('message_id', providerMessageId)
    .eq('conversations.account_id', accountId)
    .limit(1)
    .maybeSingle();

  return !!data;
}

export async function POST(request: Request) {
  let body: EvolutionWebhookPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const db = supabaseAdmin();
    const { data: config } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('evolution_instance_name', body.instance)
      .maybeSingle();

    // No config for this instance name — ack 200 anyway so Evolution
    // doesn't treat it as a delivery failure and retry forever (mirrors
    // the Meta webhook's best-effort ack semantics).
    if (!config) return NextResponse.json({ status: 'no config' }, { status: 200 });

    // Auth: the webhook body carries the instance's own token in `apikey`
    // (confirmed live — no header is sent). Reject a mismatch outright.
    const expectedToken = config.evolution_instance_token ? decrypt(config.evolution_instance_token) : null;
    if (!expectedToken || body.apikey !== expectedToken) {
      console.warn('[evolution webhook] apikey mismatch for instance', body.instance);
      return NextResponse.json({ error: 'Invalid apikey' }, { status: 401 });
    }
    if (body.event === 'qrcode.updated') {
      // Evolution v2.3.7 nests the QR under data.qrcode.base64, not
      // data.base64 directly — confirmed live 2026-07-20 by logging the
      // raw payload (investigacao: QR never appeared on reconnect).
      // The old `body.data?.base64` was always undefined, so every
      // delivery (Baileys refreshes the QR periodically while waiting
      // for a scan) stomped evolution_qr_code back to null — the
      // connect POST's own synchronous save (a *flat* REST response,
      // correctly shaped) kept getting overwritten moments later.
      await db.from('whatsapp_config').update({
        evolution_qr_code: body.data?.qrcode?.base64 ?? null,
        evolution_qr_updated_at: new Date().toISOString(),
      }).eq('id', config.id);
      return NextResponse.json({ status: 'received' }, { status: 200 });
    }

    if (body.event === 'connection.update') {
      const state = body.data?.state;
      const mapped = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : state === 'close' ? 'disconnected' : 'error';
      const update: Record<string, unknown> = { evolution_connection_state: mapped };
      if (mapped === 'connected') {
        update.evolution_connected_at = new Date().toISOString();
        update.evolution_qr_code = null;
        update.evolution_last_error = null;
      } else if (mapped === 'disconnected') {
        update.evolution_qr_code = null;
      } else if (mapped === 'error') {
        update.evolution_last_error = `state=${state} reason=${body.data?.statusReason ?? 'unknown'}`;
      }
      await db.from('whatsapp_config').update(update).eq('id', config.id);

      // One-time retroactive history import (Ponto 2, 2026-07-15) — only
      // the first time this config ever reaches 'connected'.
      // evolution_history_synced_at is the idempotency marker: a routine
      // disconnect/reconnect after the first successful run must not
      // re-import the whole history. Fire-and-forget, same reasoning as
      // ingestInbound's automation/AI dispatch — a slow or failing
      // backfill (potentially thousands of messages) must not hold up
      // this webhook's 200 ack to Evolution.
      if (mapped === 'connected' && !config.evolution_history_synced_at && expectedToken) {
        runEvolutionHistoryBackfill({
          accountId: config.account_id,
          configOwnerUserId: config.user_id,
          db,
          baseUrl: process.env.EVOLUTION_API_URL!,
          apiKey: expectedToken,
          instanceName: body.instance,
        }).catch((err) => console.error('[history-backfill] run failed:', err));
      }

      return NextResponse.json({ status: 'received' }, { status: 200 });
    }

    if (body.event === 'messages.upsert') {
      const provider = new EvolutionProvider({
        baseUrl: process.env.EVOLUTION_API_URL!,
        apiKey: expectedToken,
        instanceName: body.instance,
      });
      const inbounds = provider.parseWebhook(body);

      // One-time avatar sync, fired only when ingestInbound just
      // created a brand-new contact — not on every message, so this
      // never adds a second Evolution call to the steady-state inbound
      // path. Fire-and-forget: does not delay the webhook's ack, and a
      // failed fetch/update is logged but never surfaces anywhere.
      // Evolution-only — Meta's Cloud API has no equivalent endpoint
      // for a customer's profile picture (confirmed 2026-07-14; only
      // the business's own profile picture is queryable there).
      const syncEvolutionAvatar = (contact: { id: string; phone: string }) => {
        void fetchEvolutionProfilePicture({
          baseUrl: process.env.EVOLUTION_API_URL!,
          apiKey: expectedToken,
          instanceName: body.instance,
          number: contact.phone,
        })
          .then((url) => {
            if (!url) return;
            return db.from('contacts').update({ avatar_url: url }).eq('id', contact.id);
          })
          .catch((err) => {
            console.error('[evolution webhook] avatar sync failed:', err instanceof Error ? err.message : err);
          });
      };

      // One-time group name/avatar sync, fired only when ingestInbound
      // just created a brand-new group conversation (the message webhook
      // carries neither the group's subject nor its picture). Same
      // fire-and-forget, best-effort contract as syncEvolutionAvatar.
      const syncEvolutionGroupInfo = (conv: { id: string; groupJid: string }) => {
        void fetchEvolutionGroupInfo({
          baseUrl: process.env.EVOLUTION_API_URL!,
          apiKey: expectedToken,
          instanceName: body.instance,
          groupJid: conv.groupJid,
        })
          .then((info) => {
            if (!info.subject && !info.pictureUrl) return;
            return db.from('conversations').update({
              ...(info.subject ? { group_name: info.subject } : {}),
              ...(info.pictureUrl ? { group_avatar_url: info.pictureUrl } : {}),
            }).eq('id', conv.id);
          })
          .catch((err) => {
            console.error('[evolution webhook] group info sync failed:', err instanceof Error ? err.message : err);
          });
      };

      for (const inbound of inbounds) {
        // fromMe: true is either an echo of our own CRM send, or a
        // message sent directly from the linked phone — see
        // isKnownCrmEcho's doc comment. Only the former gets dropped
        // here; the latter falls through to ingestInbound below, which
        // records it with sender_type: 'agent' and skips the customer-
        // facing automation/flow/AI dispatch (see ingest.ts).
        if (inbound.fromMe && (await isKnownCrmEcho(db, config.account_id, inbound.providerMessageId))) {
          continue;
        }

        // Media resolution stays here — provider-specific, mirrors how
        // the Meta webhook route verifies media before calling
        // ingestInbound (see src/app/api/whatsapp/webhook/route.ts).
        if (inbound.mediaBase64) {
          const url = await uploadEvolutionMedia(db, {
            accountId: config.account_id,
            base64: inbound.mediaBase64,
            mimeType: inbound.mediaMimeType,
            fileName: inbound.mediaFileName,
            providerMessageId: inbound.providerMessageId,
          });
          inbound.mediaUrl = url;
          inbound.mediaBase64 = null;
        }

        await ingestInbound(inbound, {
          accountId: config.account_id,
          configOwnerUserId: config.user_id,
          db,
          onContactCreated: syncEvolutionAvatar,
          onGroupCreated: syncEvolutionGroupInfo,
        });
      }
    }

    if (body.event === 'messages.update') {
      await handleEvolutionStatusUpdate(db, { keyId: body.data?.keyId, status: body.data?.status });
    }

    if (body.event === 'presence.update') {
      await handleEvolutionPresenceUpdate(db, config.account_id, body.data);
    }
  } catch (error) {
    console.error('[evolution webhook] error processing event:', {
      instance: body.instance,
      event: body.event,
      error: error instanceof Error ? error.message : error,
    });
  }

  return NextResponse.json({ status: 'received' }, { status: 200 });
}
