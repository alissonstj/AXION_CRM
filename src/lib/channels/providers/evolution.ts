import {
  sendEvolutionText,
  sendEvolutionMedia,
  createEvolutionInstance,
  connectEvolutionInstance,
  logoutEvolutionInstance,
  deleteEvolutionInstance,
  type EvolutionMediaType,
} from '@/lib/whatsapp/evolution-api';
import type {
  ChannelProvider,
  ChannelProviderId,
  ChannelSender,
  ConnectionState,
  NormalizedInbound,
  OutboundResult,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  SendMediaArgs,
  SendTextArgs,
} from '../types';

export interface EvolutionProviderConfig {
  baseUrl: string;
  /** Instance-scoped token for send/connect/logout calls. */
  apiKey: string;
  instanceName: string;
  /** Global EVOLUTION_API_KEY — only used by connect() when creating a
   *  brand-new instance (admin action). Optional because most methods
   *  never need it (see design doc "Chaves de API"). */
  adminApiKey?: string;
  /** True when this account has never connected before (no
   *  evolution_instance_token saved yet) — connect() must create the
   *  instance first. False means the instance already exists and
   *  connect() should just re-fetch a QR. */
  isNewInstance?: boolean;
  /** Where the Evolution server should POST webhook events — passed
   *  straight through to createEvolutionInstance. */
  webhookUrl?: string;
}

const MEDIA_KIND_TO_EVOLUTION: Record<SendMediaArgs['kind'], EvolutionMediaType> = {
  image: 'image', video: 'video', document: 'document', audio: 'audio',
};

export class EvolutionProvider implements ChannelProvider {
  readonly id: ChannelProviderId = 'evolution';
  readonly sender: ChannelSender;

  constructor(private readonly config: EvolutionProviderConfig) {
    const { baseUrl, apiKey, instanceName } = config;
    this.sender = {
      sendText: async (args: SendTextArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionText({
          baseUrl, apiKey, instanceName, to: args.to, text: args.text,
        });
        return { providerMessageId: messageId };
      },
      sendMedia: async (args: SendMediaArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionMedia({
          baseUrl, apiKey, instanceName, to: args.to,
          mediatype: MEDIA_KIND_TO_EVOLUTION[args.kind],
          media: args.link, caption: args.caption, fileName: args.filename,
        });
        return { providerMessageId: messageId };
      },
      // Baileys button/list support is experimental and unvalidated
      // against a real device in this phase (declared risk — see design
      // doc). Implemented against the documented request shape only.
      sendInteractiveButtons: async (args: SendInteractiveButtonsArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionButtons({
          baseUrl, apiKey, instanceName, to: args.to, bodyText: args.bodyText,
          headerText: args.headerText, footerText: args.footerText, buttons: args.buttons,
        });
        return { providerMessageId: messageId };
      },
      sendInteractiveList: async (args: SendInteractiveListArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionList({
          baseUrl, apiKey, instanceName, to: args.to, bodyText: args.bodyText,
          buttonLabel: args.buttonLabel, headerText: args.headerText,
          footerText: args.footerText, sections: args.sections,
        });
        return { providerMessageId: messageId };
      },
    };
  }

  parseWebhook(payload: unknown): NormalizedInbound[] {
    const body = payload as EvolutionWebhookBody | null;
    if (!body || body.event !== 'messages.upsert' || !body.data) return [];
    const data = body.data;

    // Never re-ingest our own sends, whether they came through this CRM
    // or were sent directly from the linked phone (approved design
    // decision — see design doc section 2, "parseWebhook").
    if (data.key.fromMe) return [];

    // Groups: remoteJid ends in @g.us and the real sender lives in
    // participant/participantAlt, not remoteJid — out of scope (design
    // doc, "Fora de escopo"). Skip rather than misattribute the group
    // as if it were a 1:1 contact.
    if (data.key.remoteJid.endsWith('@g.us')) return [];

    const inbound = mapEvolutionMessage(data);
    return inbound ? [inbound] : [];
  }
  async connect(): Promise<ConnectionState> {
    const { baseUrl, apiKey, instanceName, adminApiKey, isNewInstance, webhookUrl } = this.config;
    if (isNewInstance) {
      const result = await createEvolutionInstance({
        baseUrl, apiKey: adminApiKey ?? apiKey, instanceName, webhookUrl: webhookUrl ?? '',
      });
      return { status: 'connecting', qrCode: result.qrCode };
    }
    const result = await connectEvolutionInstance({ baseUrl, apiKey, instanceName });
    return { status: 'connecting', qrCode: result.qrCode };
  }

  // Deliberately does not call Evolution — the webhook-fed cache (Task 7)
  // is the source of truth for connection state, per the approved design
  // ("cache alimentado pelo webhook"). Any caller wanting the *cached*
  // state should read whatsapp_config directly (Task 8's routes do this);
  // this method exists only to satisfy the ChannelProvider interface and
  // returns a conservative default.
  async getConnectionState(): Promise<ConnectionState> {
    return { status: 'disconnected' };
  }

  async disconnect(): Promise<void> {
    const { baseUrl, apiKey, instanceName } = this.config;
    await logoutEvolutionInstance({ baseUrl, apiKey, instanceName });
    await deleteEvolutionInstance({ baseUrl, apiKey, instanceName });
  }
}

// ---- Interactive send helpers (POST /message/sendButtons, /message/sendList) ----
// Kept local to this file (not evolution-api.ts) since they're speculative/
// unvalidated per the design doc's remaining risk — easy to find and revise
// once real interactive-send payloads are validated, without touching the
// HTTP client file Task 2 already tested against real DTOs.

import type { OutboundButton, OutboundListSection } from '../types';

interface EvolutionAuth { baseUrl: string; apiKey: string; instanceName: string }

async function sendEvolutionButtons(
  args: EvolutionAuth & { to: string; bodyText: string; headerText?: string; footerText?: string; buttons: OutboundButton[] },
): Promise<{ messageId: string }> {
  const { baseUrl, apiKey, instanceName, to, bodyText, headerText, footerText, buttons } = args;
  const response = await fetch(`${baseUrl}/message/sendButtons/${instanceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({
      number: to, title: headerText, description: bodyText, footer: footerText,
      buttons: buttons.map((b) => ({ type: 'reply', displayText: b.title, id: b.id })),
    }),
  });
  if (!response.ok) throw new Error(`Evolution API error: ${response.status}`);
  const data = await response.json();
  return { messageId: data.key?.id };
}

// ---- Shapes of Evolution's inbound webhook (subset we use) ----

interface EvolutionMessageKey {
  remoteJid: string;
  remoteJidAlt?: string;
  fromMe: boolean;
  id: string;
  participant?: string;
  participantAlt?: string;
}

interface EvolutionMessageContent {
  conversation?: string;
  imageMessage?: { caption?: string; mimetype?: string };
  videoMessage?: { caption?: string; mimetype?: string };
  audioMessage?: { mimetype?: string };
  documentMessage?: { caption?: string; fileName?: string; mimetype?: string };
  locationMessage?: { degreesLatitude: number; degreesLongitude: number; name?: string; address?: string };
  reactionMessage?: { key: { id: string }; text: string };
  buttonsResponseMessage?: { selectedButtonId: string; selectedDisplayText?: string };
  listResponseMessage?: { singleSelectReply?: { selectedRowId: string }; title?: string };
  /** Sibling of the type-keyed object above, not nested inside it —
   *  confirmed live for image/video/audio. Present only when the
   *  instance's webhook was created with `base64: true` (Task 5). */
  base64?: string;
}

interface EvolutionUpsertData {
  key: EvolutionMessageKey;
  pushName?: string;
  message: EvolutionMessageContent;
  messageType: string;
  messageTimestamp: number;
}

interface EvolutionWebhookBody {
  event: string;
  instance: string;
  data: EvolutionUpsertData;
}

/** Strips the @s.whatsapp.net / @lid suffix. Falls back to
 *  `remoteJidAlt` when `remoteJid` doesn't look like a phone number —
 *  covers the "LID" privacy addressing mode (documented limitation,
 *  see design doc). */
function extractPhone(key: EvolutionMessageKey): string {
  const raw = key.remoteJid.split('@')[0];
  if (/^\d+$/.test(raw)) return raw;
  const alt = key.remoteJidAlt?.split('@')[0];
  return alt && /^\d+$/.test(alt) ? alt : raw;
}

function mapEvolutionMessage(data: EvolutionUpsertData): NormalizedInbound | null {
  const base = {
    from: extractPhone(data.key),
    contactName: data.pushName,
    providerMessageId: data.key.id,
    timestamp: new Date(data.messageTimestamp * 1000),
  };
  const m = data.message;

  switch (data.messageType) {
    case 'conversation':
      return { ...base, kind: 'text', text: m.conversation ?? null };
    case 'imageMessage':
      return {
        ...base, kind: 'image', text: m.imageMessage?.caption ?? null,
        mediaBase64: m.base64 ?? null, mediaMimeType: m.imageMessage?.mimetype ?? null,
      };
    case 'videoMessage':
      return {
        ...base, kind: 'video', text: m.videoMessage?.caption ?? null,
        mediaBase64: m.base64 ?? null, mediaMimeType: m.videoMessage?.mimetype ?? null,
      };
    case 'audioMessage':
      return {
        ...base, kind: 'audio', text: null,
        mediaBase64: m.base64 ?? null, mediaMimeType: m.audioMessage?.mimetype ?? null,
      };
    case 'documentMessage':
      return {
        ...base, kind: 'document',
        text: m.documentMessage?.caption ?? m.documentMessage?.fileName ?? null,
        mediaBase64: m.base64 ?? null, mediaMimeType: m.documentMessage?.mimetype ?? null,
        mediaFileName: m.documentMessage?.fileName ?? null,
      };
    case 'locationMessage': {
      const loc = m.locationMessage;
      const text = loc
        ? [loc.name, loc.address, `${loc.degreesLatitude},${loc.degreesLongitude}`].filter(Boolean).join(' - ')
        : null;
      return { ...base, kind: 'location', text };
    }
    case 'reactionMessage': {
      const r = m.reactionMessage;
      return {
        ...base, kind: 'reaction',
        reaction: r ? { targetProviderMessageId: r.key.id, emoji: r.text } : null,
      };
    }
    case 'buttonsResponseMessage': {
      const r = m.buttonsResponseMessage;
      return { ...base, kind: 'interactive_reply', interactiveReplyId: r?.selectedButtonId ?? null, text: r?.selectedDisplayText ?? null };
    }
    case 'listResponseMessage': {
      const r = m.listResponseMessage;
      return { ...base, kind: 'interactive_reply', interactiveReplyId: r?.singleSelectReply?.selectedRowId ?? null, text: r?.title ?? null };
    }
    default:
      return { ...base, kind: 'text', text: `[Unsupported message type: ${data.messageType}]` };
  }
}

async function sendEvolutionList(
  args: EvolutionAuth & {
    to: string; bodyText: string; buttonLabel: string; headerText?: string;
    footerText?: string; sections: OutboundListSection[];
  },
): Promise<{ messageId: string }> {
  const { baseUrl, apiKey, instanceName, to, bodyText, buttonLabel, headerText, footerText, sections } = args;
  const response = await fetch(`${baseUrl}/message/sendList/${instanceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({
      number: to, title: headerText, description: bodyText, footerText, buttonText: buttonLabel,
      sections: sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({ title: r.title, description: r.description, rowId: r.id })),
      })),
    }),
  });
  if (!response.ok) throw new Error(`Evolution API error: ${response.status}`);
  const data = await response.json();
  return { messageId: data.key?.id };
}
