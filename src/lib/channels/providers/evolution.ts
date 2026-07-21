import {
  sendEvolutionText,
  sendEvolutionMedia,
  createEvolutionInstance,
  connectEvolutionInstance,
  logoutEvolutionInstance,
  deleteEvolutionInstance,
  markEvolutionMessageAsRead,
  sendEvolutionPresence,
  type EvolutionMediaType,
  type EvolutionQuotedRef,
} from '@/lib/whatsapp/evolution-api';
import { markSentByCrm } from '../sent-by-crm-cache';
import type {
  ChannelProvider,
  ChannelProviderId,
  ChannelSender,
  ConnectionState,
  MarkAsReadArgs,
  NormalizedInbound,
  OutboundResult,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  SendMediaArgs,
  SendReactionArgs,
  SendTextArgs,
  SendTypingArgs,
} from '../types';

export interface EvolutionProviderConfig {
  baseUrl: string;
  /** Instance-scoped token for send/connect/logout calls. Fallback for admin
   *  actions (create, delete) when adminApiKey is absent. */
  apiKey: string;
  instanceName: string;
  /** Global EVOLUTION_API_KEY — used by connect() when creating a
   *  brand-new instance (admin action) and by disconnect() when deleting
   *  the instance. Optional because most methods never need it (see design
   *  doc "Chaves de API"). */
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

/** Builds the quoted-message key sendEvolutionText/sendEvolutionMedia
 *  expect, from the args every ChannelSender caller already provides
 *  (contextProviderMessageId + the new contextFromMe). `to` doubles as
 *  the chat's remoteJid: a bare phone for a 1:1 chat (needs the
 *  @s.whatsapp.net suffix) or an already-qualified JID for a group
 *  ("...@g.us" — used as-is). Returns undefined when there's no reply
 *  target, so callers can pass it straight through without a branch. */
function buildQuotedRef(to: string, contextProviderMessageId?: string, contextFromMe?: boolean): EvolutionQuotedRef | undefined {
  if (!contextProviderMessageId) return undefined;
  const remoteJid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  return { remoteJid, fromMe: contextFromMe ?? false, id: contextProviderMessageId };
}

export class EvolutionProvider implements ChannelProvider {
  readonly id: ChannelProviderId = 'evolution';
  readonly sender: ChannelSender;

  constructor(private readonly config: EvolutionProviderConfig) {
    const { baseUrl, apiKey, instanceName } = config;
    this.sender = {
      sendText: async (args: SendTextArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionText({
          baseUrl, apiKey, instanceName, to: args.to, text: args.text,
          quoted: buildQuotedRef(args.to, args.contextProviderMessageId, args.contextFromMe),
        });
        markSentByCrm(messageId);
        return { providerMessageId: messageId };
      },
      sendMedia: async (args: SendMediaArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionMedia({
          baseUrl, apiKey, instanceName, to: args.to,
          mediatype: MEDIA_KIND_TO_EVOLUTION[args.kind],
          media: args.link, caption: args.caption, fileName: args.filename,
          quoted: buildQuotedRef(args.to, args.contextProviderMessageId, args.contextFromMe),
        });
        markSentByCrm(messageId);
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
        markSentByCrm(messageId);
        return { providerMessageId: messageId };
      },
      sendInteractiveList: async (args: SendInteractiveListArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionList({
          baseUrl, apiKey, instanceName, to: args.to, bodyText: args.bodyText,
          buttonLabel: args.buttonLabel, headerText: args.headerText,
          footerText: args.footerText, sections: args.sections,
        });
        markSentByCrm(messageId);
        return { providerMessageId: messageId };
      },
      // Same confidence tier as sendEvolutionButtons/sendEvolutionList
      // above: documented Evolution API v2 shape, not live-verified.
      sendReaction: async (args: SendReactionArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionReaction({
          baseUrl, apiKey, instanceName, to: args.to,
          targetMessageId: args.targetProviderMessageId,
          targetFromMe: args.targetFromMe, emoji: args.emoji,
        });
        markSentByCrm(messageId);
        return { providerMessageId: messageId };
      },
      markAsRead: async (args: MarkAsReadArgs): Promise<void> => {
        await markEvolutionMessageAsRead({
          baseUrl, apiKey, instanceName,
          remoteJid: `${args.to}@s.whatsapp.net`,
          messageId: args.providerMessageId,
        });
      },
      // contextProviderMessageId is Meta-only (see SendTypingArgs) —
      // Evolution's presence update is chat-scoped, no message to
      // attach to. sendEvolutionPresence itself blocks for `delay` ms
      // before auto-reverting to 'paused', which is what satisfies the
      // "resolves after durationMs" contract here.
      sendTyping: async (args: SendTypingArgs): Promise<void> => {
        await sendEvolutionPresence({
          baseUrl, apiKey, instanceName, to: args.to,
          presence: 'composing', delay: args.durationMs,
        });
      },
    };
  }

  parseWebhook(payload: unknown): NormalizedInbound[] {
    const body = payload as EvolutionWebhookBody | null;
    if (!body || body.event !== 'messages.upsert' || !body.data) return [];
    const data = body.data;

    // `fromMe: true` covers two very different cases: an echo of a
    // message the CRM itself just sent (via sendText/sendMedia/etc.),
    // and a message actually sent from the linked phone directly,
    // outside the CRM. Both look identical here — parseWebhook has no
    // DB access to tell them apart. It passes `fromMe` through on the
    // normalized shape and leaves the split to the webhook route (which
    // checks the in-memory CRM-send marker + a DB fallback before
    // deciding whether to ingest at all — see sent-by-crm-cache.ts).

    // WhatsApp Channels/newsletters (@newsletter) and bot chats (@bot)
    // are not real people and must never become contacts — skip them.
    // Groups (@g.us) ARE handled: mapEvolutionMessage produces a group
    // inbound keyed by the group JID, with the real sender resolved from
    // participant/participantAlt.
    const jid = data.key.remoteJid;
    if (jid.endsWith('@newsletter') || jid.endsWith('@bot')) return [];

    const inbound = mapEvolutionMessage(data);
    return inbound ? [inbound] : [];
  }
  // Not on the live connect path today — src/app/api/channels/evolution/
  // connect/route.ts calls createEvolutionInstance/connectEvolutionInstance
  // directly so it can sequence the DB write and setEvolutionWebhook call
  // around them (see that route's own comments for why the ordering
  // matters). Kept here for ChannelProvider interface conformance/tests;
  // a caller using this method directly still gets the no-webhook-at-
  // creation half of the fix, but must call setEvolutionWebhook itself
  // once it has durably persisted the returned token — this method has
  // no DB access to do that safely on its own.
  async connect(): Promise<ConnectionState> {
    const { baseUrl, apiKey, instanceName, adminApiKey, isNewInstance } = this.config;
    if (isNewInstance) {
      const result = await createEvolutionInstance({
        baseUrl, apiKey: adminApiKey ?? apiKey, instanceName,
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
    const { baseUrl, apiKey, instanceName, adminApiKey } = this.config;
    await logoutEvolutionInstance({ baseUrl, apiKey, instanceName });
    await deleteEvolutionInstance({ baseUrl, apiKey: adminApiKey ?? apiKey, instanceName });
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
  stickerMessage?: { mimetype?: string };
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

export interface EvolutionUpsertData {
  key: EvolutionMessageKey;
  pushName?: string;
  message: EvolutionMessageContent;
  messageType: string;
  messageTimestamp: number;
  /** Sibling of `message`, not nested inside it — confirmed against
   *  real historical data in Evolution's own Postgres store (its
   *  `Message` table has `contextInfo` as its own top-level jsonb
   *  column, separate from `message`), and matches the shape of a
   *  quoted reply's own send-response captured live 2026-07-14.
   *  `stanzaId` is the quoted message's WhatsApp id. */
  contextInfo?: { stanzaId?: string };
}

interface EvolutionWebhookBody {
  event: string;
  instance: string;
  data: EvolutionUpsertData;
}

/** Resolves the contact's REAL phone — the digits of an
 *  `@s.whatsapp.net` JID — from a message key, or null when only a LID
 *  is available.
 *
 *  WhatsApp's newer `@lid` addressing puts an internal LID in
 *  `remoteJid` and the real phone JID in `remoteJidAlt`. A LID's own
 *  digits are NOT a phone number and must never be stored as one — the
 *  old code did exactly that (`/^\d+$/.test(raw)` matches a LID), which
 *  leaked 14-15 digit LIDs in as bogus "phone numbers". We therefore
 *  scan for an `@s.whatsapp.net` JID across `remoteJid` then
 *  `remoteJidAlt` and return its digits; if neither is a phone JID we
 *  return null and the caller drops the message (approved design:
 *  "só telefone real, ocultar LID"). */
function extractPhone(key: EvolutionMessageKey): string | null {
  for (const jid of [key.remoteJid, key.remoteJidAlt]) {
    if (jid && jid.endsWith('@s.whatsapp.net')) {
      const digits = jid.split('@')[0];
      if (/^\d+$/.test(digits)) return digits;
    }
  }
  return null;
}

/** The contact's LID form, when the chat is LID-addressed — captured
 *  opportunistically so a later presence.update event (which arrives
 *  addressed ONLY by LID, with no phone alt at all) can be resolved back
 *  to this contact. Only meaningful for 1:1 chats (mapEvolutionMessage
 *  only calls this outside the group branch). */
function extractLid(key: EvolutionMessageKey): string | null {
  for (const jid of [key.remoteJid, key.remoteJidAlt]) {
    if (jid && jid.endsWith('@lid')) {
      const digits = jid.split('@')[0];
      if (/^\d+$/.test(digits)) return digits;
    }
  }
  return null;
}

/** In a group message the sender isn't `remoteJid` (that's the group) —
 *  it's `participant`/`participantAlt`. Same @s.whatsapp.net-preferring
 *  resolution as extractPhone, but over the participant fields. Returns
 *  '' when no real phone is available: unlike a 1:1 message, a group
 *  message is still kept (it belongs to the group), just with an empty
 *  sender phone. */
function extractParticipantPhone(key: EvolutionMessageKey): string {
  for (const jid of [key.participant, key.participantAlt]) {
    if (jid && jid.endsWith('@s.whatsapp.net')) {
      const digits = jid.split('@')[0];
      if (/^\d+$/.test(digits)) return digits;
    }
  }
  return '';
}

/** Exported for reuse by the one-time history backfill
 *  (src/lib/channels/history-backfill.ts) — `findEvolutionMessages`'
 *  records share this exact wire shape with the live
 *  `messages.upsert` webhook's `data`, so the mapping logic is
 *  identical for both without duplication. */
export function mapEvolutionMessage(data: EvolutionUpsertData): NormalizedInbound | null {
  const isGroup = data.key.remoteJid.endsWith('@g.us');

  // Sender resolution differs by chat type:
  //   1:1   → `from` is the contact's phone when WhatsApp provides one.
  //           When it doesn't (LID-addressed with no @s.whatsapp.net alt
  //           anywhere — investigacao-completude-sync-conversas.md found
  //           this true for the large majority of @lid chats), `from`
  //           stays '' and `contactLid` carries the identity instead — a
  //           contact keyed by LID alone (migration 051) rather than
  //           dropping the message. Only drop when NEITHER is available;
  //           that message truly can't be attributed to anyone.
  //   group → `from` is the PARTICIPANT (sender) phone, best-effort; the
  //           message is kept regardless (it belongs to the group), and
  //           `group.jid` carries the conversation key.
  const resolvedPhone = isGroup ? extractParticipantPhone(data.key) : extractPhone(data.key);
  const contactLid = isGroup ? null : extractLid(data.key);
  if (!isGroup && !resolvedPhone && !contactLid) return null;
  const from: string = resolvedPhone ?? '';
  const group = isGroup ? { jid: data.key.remoteJid } : undefined;

  // pushName is whoever sent THIS message. Two cases make it NOT a usable
  // contact name:
  //   1. fromMe: true — the linked phone sending directly, outside the
  //      CRM. pushName is then the account owner's own display name, not
  //      the customer's (confirmed live: 16/41 contacts came back named
  //      "Você"/the owner's real name after backfill).
  //   2. pushName equal to the sender number — WhatsApp's placeholder for
  //      a contact with no saved name; storing it would show a raw digit
  //      string instead of the nicely-formatted number fallback.
  const rawName = data.key.fromMe ? undefined : data.pushName;
  // Drop the name when it's purely digits — WhatsApp's placeholder for
  // "no name set", whether that's the sender's own resolved phone (1:1)
  // or some other numeric id, e.g. a LID, reported for a group
  // participant we couldn't resolve a phone for at all (`from === ''`,
  // so there's no known phone to compare against — the placeholder is
  // still recognizable because a real human name is never all digits).
  const contactName =
    rawName && !/^\d+$/.test(rawName.trim()) ? rawName : undefined;
  const base = {
    from,
    contactName,
    contactLid,
    group,
    providerMessageId: data.key.id,
    timestamp: new Date(data.messageTimestamp * 1000),
    replyToProviderMessageId: data.contextInfo?.stanzaId ?? null,
    fromMe: data.key.fromMe,
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
    case 'stickerMessage':
      // Same treatment as Meta's sticker mapping (meta.ts:
      // META_TO_INBOUND_KIND['sticker'] = 'image') — InboundKind has no
      // separate sticker kind, and stickers carry no caption. Same
      // base64-sibling convention already live-verified for image/
      // video/audio; evolution-media.ts already maps image/webp
      // (stickers' typical mimetype) to a .webp extension.
      return {
        ...base, kind: 'image', text: null,
        mediaBase64: m.base64 ?? null, mediaMimeType: m.stickerMessage?.mimetype ?? null,
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

/** POST /message/sendReaction/{instance}. Documented Evolution API v2
 *  shape — Baileys identifies the target by its full message key
 *  (remoteJid + fromMe + id), not the id alone, so `targetFromMe`
 *  (whether the original message was ours or the contact's) is
 *  required to construct it correctly. Empty `emoji` removes the
 *  reaction (same convention as the Meta side / message_reactions). */
async function sendEvolutionReaction(
  args: EvolutionAuth & { to: string; targetMessageId: string; targetFromMe: boolean; emoji: string },
): Promise<{ messageId: string }> {
  const { baseUrl, apiKey, instanceName, to, targetMessageId, targetFromMe, emoji } = args;
  const response = await fetch(`${baseUrl}/message/sendReaction/${instanceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({
      key: { remoteJid: `${to}@s.whatsapp.net`, fromMe: targetFromMe, id: targetMessageId },
      reaction: emoji,
    }),
  });
  if (!response.ok) throw new Error(`Evolution API error: ${response.status}`);
  const data = await response.json();
  return { messageId: data.key?.id };
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
