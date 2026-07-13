import { NextResponse } from 'next/server';
import { decrypt } from '@/lib/whatsapp/encryption';
import { EvolutionProvider } from '@/lib/channels/providers/evolution';
import { ingestInbound } from '@/lib/channels/ingest';
import { uploadEvolutionMedia } from '@/lib/channels/evolution-media';
import { supabaseAdmin } from '@/lib/supabase/admin';

interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  apikey?: string;
  data?: {
    state?: string;
    statusReason?: number;
    base64?: string;
  };
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
  } catch (error) {
    console.error('[evolution webhook] error processing event:', {
      instance: body.instance,
      event: body.event,
      error: error instanceof Error ? error.message : error,
    });
  }

  return NextResponse.json({ status: 'received' }, { status: 200 });
}
