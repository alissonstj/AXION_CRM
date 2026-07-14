import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { EvolutionProvider } from '@/lib/channels/providers/evolution';
import { ingestInbound } from '@/lib/channels/ingest';
import { uploadEvolutionMedia } from '@/lib/channels/evolution-media';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  apikey?: string;
  data?: {
    state?: string;
    statusReason?: number;
    base64?: string;
    /** messages.update — the WhatsApp wire message id (matches what
     *  sendEvolutionText/sendEvolutionMedia return as providerMessageId
     *  and what we store in messages.message_id). NOT the same as the
     *  sibling `messageId` field, which is Evolution's own internal
     *  Postgres row id — confirmed via a live capture against a real
     *  connected instance, see mapEvolutionMessageStatus below. */
    keyId?: string;
    /** messages.update — Baileys' WAMessageStatus enum name. */
    status?: string;
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
      await db.from('whatsapp_config').update({
        evolution_qr_code: body.data?.base64 ?? null,
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
      return NextResponse.json({ status: 'received' }, { status: 200 });
    }

    if (body.event === 'messages.upsert') {
      const provider = new EvolutionProvider({
        baseUrl: process.env.EVOLUTION_API_URL!,
        apiKey: expectedToken,
        instanceName: body.instance,
      });
      const inbounds = provider.parseWebhook(body);

      for (const inbound of inbounds) {
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
        });
      }
    }

    if (body.event === 'messages.update') {
      await handleEvolutionStatusUpdate(db, { keyId: body.data?.keyId, status: body.data?.status });
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
