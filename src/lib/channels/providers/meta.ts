import {
  sendTextMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import { phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils';
import type {
  ChannelProvider,
  ChannelProviderId,
  ChannelSender,
  ConnectionState,
  InboundKind,
  NormalizedInbound,
  OutboundResult,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  SendMediaArgs,
  SendTextArgs,
} from '../types';

export interface MetaProviderConfig {
  phoneNumberId: string;
  accessToken: string;
  wabaId?: string | null;
}

/**
 * Roda `send` para cada variante de `to` até uma passar. Quando a Meta
 * rejeita com "recipient not allowed", tenta a próxima; qualquer outro
 * erro sobe imediatamente. Devolve o resultado + a variante que funcionou.
 */
async function withPhoneVariantRetry(
  to: string,
  send: (variant: string) => Promise<{ messageId: string }>,
): Promise<OutboundResult> {
  const variants = phoneVariants(to);
  let lastError: unknown = null;
  for (const variant of variants) {
    try {
      const { messageId } = await send(variant);
      return {
        providerMessageId: messageId,
        workingRecipient: variant !== to ? variant : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(message)) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error('Meta send failed for all phone variants');
}

export class MetaProvider implements ChannelProvider {
  readonly id: ChannelProviderId = 'meta';
  readonly sender: ChannelSender;

  constructor(private readonly config: MetaProviderConfig) {
    const { phoneNumberId, accessToken } = config;
    this.sender = {
      sendText: (args: SendTextArgs) =>
        withPhoneVariantRetry(args.to, (to) =>
          sendTextMessage({
            phoneNumberId, accessToken, to, text: args.text,
            contextMessageId: args.contextProviderMessageId,
          }),
        ),
      sendMedia: (args: SendMediaArgs) =>
        withPhoneVariantRetry(args.to, (to) =>
          sendMediaMessage({
            phoneNumberId, accessToken, to, kind: args.kind, link: args.link,
            caption: args.caption, filename: args.filename,
            contextMessageId: args.contextProviderMessageId,
          }),
        ),
      sendInteractiveButtons: (args: SendInteractiveButtonsArgs) =>
        withPhoneVariantRetry(args.to, (to) =>
          sendInteractiveButtons({
            phoneNumberId, accessToken, to, bodyText: args.bodyText,
            headerText: args.headerText, footerText: args.footerText,
            buttons: args.buttons, contextMessageId: args.contextProviderMessageId,
          }),
        ),
      sendInteractiveList: (args: SendInteractiveListArgs) =>
        withPhoneVariantRetry(args.to, (to) =>
          sendInteractiveList({
            phoneNumberId, accessToken, to, bodyText: args.bodyText,
            buttonLabel: args.buttonLabel, headerText: args.headerText,
            footerText: args.footerText, sections: args.sections,
            contextMessageId: args.contextProviderMessageId,
          }),
        ),
    };
  }

  // parseWebhook + lifecycle: implementados nas Tasks 3 e 4.
  parseWebhook(payload: unknown): NormalizedInbound[] {
    const body = payload as { entry?: MetaEntry[] } | null;
    if (!body?.entry) return [];
    const out: NormalizedInbound[] = [];
    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        if (!value.messages || !value.contacts) continue; // status/template → ignora
        for (let i = 0; i < value.messages.length; i++) {
          const m = value.messages[i];
          const contact = value.contacts[i] ?? value.contacts[0];
          out.push(mapMetaMessage(m, contact));
        }
      }
    }
    return out;
  }
  async connect(): Promise<ConnectionState> {
    return this.getConnectionState();
  }

  async getConnectionState(): Promise<ConnectionState> {
    try {
      const info = await verifyPhoneNumber({
        phoneNumberId: this.config.phoneNumberId,
        accessToken: this.config.accessToken,
      });
      return { status: 'connected', detail: info.display_phone_number };
    } catch (err) {
      return { status: 'error', detail: err instanceof Error ? err.message : 'Meta verification failed' };
    }
  }

  async disconnect(): Promise<void> {
    // Meta: sem sessão para encerrar — o reset de credenciais segue na
    // rota DELETE /api/whatsapp/config. No-op intencional.
  }
}

// ---- Shapes de entrada da Meta (subconjunto que usamos) ----
interface MetaContact { profile?: { name?: string }; wa_id: string }
interface MetaMessage {
  id: string; from: string; timestamp: string; type: string;
  text?: { body: string };
  image?: { id: string; caption?: string };
  video?: { id: string; caption?: string };
  document?: { id: string; filename?: string; caption?: string };
  audio?: { id: string };
  sticker?: { id: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { message_id: string; emoji: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  context?: { id: string };
}
interface MetaEntry {
  changes?: Array<{ field: string; value: {
    contacts?: MetaContact[];
    messages?: MetaMessage[];
    statuses?: unknown[];
  } }>;
}

const META_TO_INBOUND_KIND: Record<string, InboundKind> = {
  text: 'text', image: 'image', video: 'video', document: 'document',
  audio: 'audio', sticker: 'image', location: 'location',
  interactive: 'interactive_reply', reaction: 'reaction',
};

/** Marca `mediaUrl` com o caminho do proxy quando há media_id; a
 *  verificação/resolução real acontece no route handler (não muda). */
function mediaProxyPath(id?: string): string | null {
  return id ? `/api/whatsapp/media/${id}` : null;
}

function mapMetaMessage(m: MetaMessage, contact: MetaContact): NormalizedInbound {
  const base = {
    from: m.from,
    contactName: contact.profile?.name,
    providerMessageId: m.id,
    timestamp: new Date(parseInt(m.timestamp, 10) * 1000),
    replyToProviderMessageId: m.context?.id ?? null,
  };
  const kind = META_TO_INBOUND_KIND[m.type] ?? 'text';

  switch (m.type) {
    case 'text':
      return { ...base, kind, text: m.text?.body ?? null };
    case 'image':
      return { ...base, kind, text: m.image?.caption ?? null, mediaUrl: mediaProxyPath(m.image?.id) };
    case 'video':
      return { ...base, kind, text: m.video?.caption ?? null, mediaUrl: mediaProxyPath(m.video?.id) };
    case 'document':
      return { ...base, kind, text: m.document?.caption ?? m.document?.filename ?? null, mediaUrl: mediaProxyPath(m.document?.id) };
    case 'audio':
      return { ...base, kind, mediaUrl: mediaProxyPath(m.audio?.id) };
    case 'sticker':
      return { ...base, kind, mediaUrl: mediaProxyPath(m.sticker?.id) };
    case 'location': {
      const loc = m.location;
      const text = loc ? [loc.name, loc.address, `${loc.latitude},${loc.longitude}`].filter(Boolean).join(' - ') : null;
      return { ...base, kind, text };
    }
    case 'reaction':
      return { ...base, kind, reaction: m.reaction ? { targetProviderMessageId: m.reaction.message_id, emoji: m.reaction.emoji } : null };
    case 'interactive': {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return { ...base, kind, text: reply?.title ?? reply?.id ?? '[Interactive reply]', interactiveReplyId: reply?.id ?? null };
    }
    default:
      return { ...base, kind: 'text', text: `[Unsupported message type: ${m.type}]` };
  }
}
