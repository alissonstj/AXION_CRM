/**
 * Evolution API v2 HTTP helpers. Mirrors meta-api.ts's shape: named-param
 * options objects (no positional args — see meta-api.ts's header comment
 * for why), one shared error-throwing helper.
 *
 * Request/response shapes below are grounded in two sources, not the
 * (confirmed incomplete) doc site:
 *   1. The upstream DTOs (EvolutionAPI/evolution-api, src/api/dto/sendMessage.dto.ts)
 *   2. A live local instance — see docs/superpowers/specs/2026-07-12-evolution-api-phase-2-design.md
 */

interface EvolutionErrorResponse {
  message?: string;
  error?: string;
  // Validation-style rejections (e.g. duplicate instance name) nest the
  // actual reason here instead of the top-level fields — confirmed
  // against a live instance: 403 duplicate-name gives
  // {"error":"Forbidden","response":{"message":["...already in use."]}}.
  // Checked first since it's the most specific reason when present.
  response?: { message?: string | string[] };
}

async function throwEvolutionError(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as EvolutionErrorResponse;
    const nested = data.response?.message;
    if (Array.isArray(nested) && nested.length > 0) message = nested.join('; ');
    else if (typeof nested === 'string' && nested) message = nested;
    else if (data.message) message = data.message;
    else if (data.error) message = data.error;
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message);
}

interface EvolutionAuth {
  baseUrl: string;
  apiKey: string;
}

function headers(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', apikey: apiKey };
}

// ============================================================
// Instance lifecycle
// ============================================================

export interface CreateEvolutionInstanceArgs extends EvolutionAuth {
  instanceName: string;
}
export interface EvolutionCreateResult {
  token: string;
  /** Data-URI base64 QR, present when the instance isn't already linked. */
  qrCode?: string;
}

/** POST /instance/create. Uses the caller's `apiKey` — Task 6's factory
 *  passes the global EVOLUTION_API_KEY here (admin action).
 *
 *  Deliberately does NOT register a webhook here — `/instance/create`
 *  starts the Baileys channel synchronously and can fire
 *  `qrcode.updated` before this call's own HTTP response even returns
 *  to the caller, i.e. before there's been any chance to persist the
 *  new instance token anywhere the webhook route could look it up.
 *  Registering the webhook at creation time guaranteed a 401 on that
 *  very first delivery — confirmed live 2026-07-15, reproduced 4/4
 *  times, each one spiraling into a Baileys channel restart loop. The
 *  fix: create with no webhook, let the caller persist the token, THEN
 *  call `setEvolutionWebhook` below. */
export async function createEvolutionInstance(
  args: CreateEvolutionInstanceArgs,
): Promise<EvolutionCreateResult> {
  const { baseUrl, apiKey, instanceName } = args;
  const response = await fetch(`${baseUrl}/instance/create`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return { token: data.hash, qrCode: data.qrcode?.base64 };
}

export interface SetEvolutionWebhookArgs extends EvolutionAuth {
  instanceName: string;
  webhookUrl: string;
}

/** POST /webhook/set/{instance}. Call ONLY after the instance's token
 *  has been durably persisted (see createEvolutionInstance's doc
 *  comment) — this is what actually turns on event delivery, so
 *  calling it any earlier reopens the exact race that function exists
 *  to avoid. */
export async function setEvolutionWebhook(args: SetEvolutionWebhookArgs): Promise<void> {
  const { baseUrl, apiKey, instanceName, webhookUrl } = args;
  const response = await fetch(`${baseUrl}/webhook/set/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        base64: true,
        // Note: we deliberately do NOT subscribe to CHATS_UPSERT/
        // CHATS_UPDATE. They were trialled to mirror a chat's `pinned`
        // state, but a live capture (2026-07-16) proved Evolution strips
        // `pinned` from the Baileys event before forwarding — the payload
        // carries only remoteJid + instanceId — and its Chat table has no
        // pinned column either. So pinned is unobtainable via Evolution
        // and the extra events would just be noise.
        //
        // PRESENCE_UPDATE IS subscribed — confirmed live 2026-07-17 that
        // Evolution forwards Baileys "composing"/"available"/"paused"/
        // "unavailable" presence reports (unlike pinned above, this one's
        // real and used — see handleEvolutionPresenceUpdate, migration
        // 049 — to show "digitando…" in the inbox when the CUSTOMER is
        // typing).
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED', 'PRESENCE_UPDATE'],
      },
    }),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
}

export interface ConnectEvolutionInstanceArgs extends EvolutionAuth {
  instanceName: string;
}
export interface EvolutionConnectResult {
  qrCode?: string;
}

/** GET /instance/connect/{instance}. Uses the instance's own token. */
export async function connectEvolutionInstance(
  args: ConnectEvolutionInstanceArgs,
): Promise<EvolutionConnectResult> {
  const { baseUrl, apiKey, instanceName } = args;
  const response = await fetch(`${baseUrl}/instance/connect/${instanceName}`, {
    headers: headers(apiKey),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return { qrCode: data.base64 };
}

export interface EvolutionInstanceArgs extends EvolutionAuth {
  instanceName: string;
}

/** DELETE /instance/logout/{instance}. Uses the instance's own token. */
export async function logoutEvolutionInstance(args: EvolutionInstanceArgs): Promise<void> {
  const { baseUrl, apiKey, instanceName } = args;
  const response = await fetch(`${baseUrl}/instance/logout/${instanceName}`, {
    method: 'DELETE',
    headers: headers(apiKey),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
}

/** DELETE /instance/delete/{instance}. Uses the global EVOLUTION_API_KEY
 *  (admin action) — the instance's own token stops working once deleted. */
export async function deleteEvolutionInstance(args: EvolutionInstanceArgs): Promise<void> {
  const { baseUrl, apiKey, instanceName } = args;
  const response = await fetch(`${baseUrl}/instance/delete/${instanceName}`, {
    method: 'DELETE',
    headers: headers(apiKey),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
}

// ============================================================
// Sending
// ============================================================

/** The message being quoted, keyed the same way Baileys identifies any
 *  message (matches `sendReaction`'s target key). Confirmed live
 *  2026-07-14: sending `{ quoted: { key: {...} } }` produced a real
 *  quoted reply, and the resulting message's `contextInfo.stanzaId`/
 *  `quotedMessage` correctly resolved the parent — even tested with a
 *  deliberately wrong `fromMe` and it still resolved (self-chat may be
 *  lenient here since remoteJid was identical either way; kept correct
 *  regardless since Baileys message ids are only unique per
 *  (remoteJid, fromMe), not globally). */
export interface EvolutionQuotedRef {
  remoteJid: string;
  fromMe: boolean;
  id: string;
}

export interface SendEvolutionTextArgs extends EvolutionAuth {
  instanceName: string;
  to: string;
  text: string;
  quoted?: EvolutionQuotedRef;
}
export interface EvolutionSendResult {
  messageId: string;
}

/** POST /message/sendText/{instance}. Flat JSON body — NOT the nested
 *  `{textMessage:{text}}` shape the doc site (incorrectly) describes;
 *  confirmed against the upstream DTO (SendTextDto extends Metadata).
 *  `linkPreview: true` is always sent — same "always on, harmless
 *  no-op without a URL" reasoning as Meta's preview_url. This field is
 *  documented in the DTO (see design doc's sendText shape) but, unlike
 *  `quoted`, was not independently live-verified this session. */
export async function sendEvolutionText(args: SendEvolutionTextArgs): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, to, text, quoted } = args;
  const body: Record<string, unknown> = { number: to, text, linkPreview: true };
  if (quoted) body.quoted = { key: quoted };
  const response = await fetch(`${baseUrl}/message/sendText/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return { messageId: data.key?.id };
}

export type EvolutionMediaType = 'image' | 'video' | 'document' | 'audio';

export interface SendEvolutionMediaArgs extends EvolutionAuth {
  instanceName: string;
  to: string;
  mediatype: EvolutionMediaType;
  /** URL or base64 — confirmed via upstream DTO (`media: string`); this
   *  is a plain JSON POST, NOT multipart/form-data as the doc site says. */
  media: string;
  caption?: string;
  fileName?: string;
  /** Same shape as sendText's — not independently live-verified for
   *  sendMedia specifically, inferred by symmetry (same DTO family,
   *  same `quoted`/`key` convention observed live on sendText). */
  quoted?: EvolutionQuotedRef;
}

/** POST /message/sendMedia/{instance}. */
export async function sendEvolutionMedia(args: SendEvolutionMediaArgs): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, to, mediatype, media, caption, fileName, quoted } = args;
  const body: Record<string, unknown> = { number: to, mediatype, media };
  if (caption) body.caption = caption;
  if (fileName) body.fileName = fileName;
  if (quoted) body.quoted = { key: quoted };
  const response = await fetch(`${baseUrl}/message/sendMedia/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return { messageId: data.key?.id };
}

export interface MarkEvolutionAsReadArgs extends EvolutionAuth {
  instanceName: string;
  /** Always the customer's message — `fromMe: false` is not a caller
   *  choice, see MarkAsReadArgs in types.ts. */
  remoteJid: string;
  messageId: string;
}

/** POST /chat/markMessageAsRead/{instance}. Confirmed live 2026-07-14
 *  against a real historical message: returns
 *  {"message":"Read messages","read":"success"}, HTTP 201. Takes an
 *  array (`readMessages`) even for a single message — no batching
 *  need here, this provider always marks exactly one. */
export async function markEvolutionMessageAsRead(args: MarkEvolutionAsReadArgs): Promise<void> {
  const { baseUrl, apiKey, instanceName, remoteJid, messageId } = args;
  const response = await fetch(`${baseUrl}/chat/markMessageAsRead/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ readMessages: [{ remoteJid, fromMe: false, id: messageId }] }),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
}

export type EvolutionPresence = 'unavailable' | 'available' | 'composing' | 'recording' | 'paused';

export interface SendEvolutionPresenceArgs extends EvolutionAuth {
  instanceName: string;
  /** Bare number — same convention as sendText's `to`. */
  to: string;
  presence: EvolutionPresence;
  /** Milliseconds. Confirmed against the upstream service
   *  (whatsapp.baileys.service.ts): the server sends `presence`
   *  immediately, blocks for exactly `delay` ms, then automatically
   *  reverts to 'paused' and only THEN responds — this call is the
   *  timer, there's no separate "stop typing" request. */
  delay: number;
}

/** POST /chat/sendPresence/{instance}. Body/behavior confirmed against
 *  the upstream source (chat.schema.ts's presenceSchema requires
 *  number+presence+delay; whatsapp.baileys.service.ts's sendPresence
 *  awaits `delay` ms before auto-reverting to 'paused') — not
 *  independently live-verified against a real instance this session,
 *  same confidence tier as sendEvolutionButtons/List. */
export async function sendEvolutionPresence(args: SendEvolutionPresenceArgs): Promise<void> {
  const { baseUrl, apiKey, instanceName, to, presence, delay } = args;
  const response = await fetch(`${baseUrl}/chat/sendPresence/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ number: to, presence, delay }),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
}

// ============================================================
// Retroactive history — one-time backfill on connect (see
// src/lib/channels/history-backfill.ts), NOT the steady-state webhook
// path. Response shapes confirmed live 2026-07-15 against a real
// connected instance (1,678 chats / 15,837 messages on record).
// ============================================================

export interface FindEvolutionChatsArgs extends EvolutionAuth {
  instanceName: string;
}
export interface EvolutionChatSummary {
  remoteJid: string;
  /** For a group chat (@g.us), findChats returns the group's name here.
   *  Used by the history backfill to name the group conversation without
   *  a second findGroupInfos call. */
  pushName?: string | null;
  lastMessage?: { messageTimestamp: number } | null;
}

/** POST /chat/findChats/{instance}. No filter body — returns every
 *  chat (paginated server-side at 100/page; see history-backfill.ts
 *  for how the caller pages through the full set). */
export async function findEvolutionChats(
  args: FindEvolutionChatsArgs,
): Promise<EvolutionChatSummary[]> {
  const { baseUrl, apiKey, instanceName } = args;
  const response = await fetch(`${baseUrl}/chat/findChats/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({}),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  return (await response.json()) as EvolutionChatSummary[];
}

export interface EvolutionContactSummary {
  remoteJid: string;
  /** The contact's display name. For a saved contact this is the
   *  address-book name the owner set (what WhatsApp Web shows) — NOT the
   *  per-message pushName (which is the self-set name / often just the
   *  number). Empty string when WhatsApp has no name on record. */
  pushName: string;
  isSaved?: boolean;
  /** Profile picture URL, when WhatsApp has one on record. Confirmed
   *  live 2026-07-16: present for ~2/3 of real contacts in the same
   *  findContacts response the name comes from — the one-time history
   *  backfill reuses this instead of a separate per-contact
   *  fetchProfilePictureUrl call. */
  profilePicUrl?: string | null;
}

/** POST /chat/findContacts/{instance}. No filter body — returns every
 *  known contact (address book + anyone messaged). Its `pushName` is the
 *  authoritative address-book name; the per-message pushName in the
 *  webhook/findMessages is not. Confirmed live 2026-07-16: recovered
 *  real names ("Ana Luiza", "Elsin Silva") for contacts whose message
 *  pushName was empty or the bare number. */
export async function findEvolutionContacts(
  args: FindEvolutionChatsArgs,
): Promise<EvolutionContactSummary[]> {
  const { baseUrl, apiKey, instanceName } = args;
  const response = await fetch(`${baseUrl}/chat/findContacts/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({}),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  return (await response.json()) as EvolutionContactSummary[];
}

export interface FindEvolutionMessagesArgs extends EvolutionAuth {
  instanceName: string;
  remoteJid: string;
  /** 1-based; Evolution paginates findMessages results. Defaults to 1. */
  page?: number;
}
export interface EvolutionMessagesPage {
  total: number;
  pages: number;
  currentPage: number;
  /** Same wire shape Evolution's `messages.upsert` webhook delivers a
   *  single record as — see EvolutionUpsertData in
   *  src/lib/channels/providers/evolution.ts, whose exported
   *  `mapEvolutionMessage` this reuses for the backfill. */
  records: Record<string, unknown>[];
}

/** POST /chat/findMessages/{instance}. `where.key.remoteJid` scopes to
 *  one chat — confirmed live 2026-07-15 (a 141-message chat paginated
 *  at 3 pages). */
export async function findEvolutionMessages(
  args: FindEvolutionMessagesArgs,
): Promise<EvolutionMessagesPage> {
  const { baseUrl, apiKey, instanceName, remoteJid, page = 1 } = args;
  const response = await fetch(`${baseUrl}/chat/findMessages/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ where: { key: { remoteJid } }, page }),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return data.messages as EvolutionMessagesPage;
}

export interface FetchEvolutionGroupInfoArgs extends EvolutionAuth {
  instanceName: string;
  groupJid: string;
}
export interface EvolutionGroupInfo {
  subject: string | null;
  pictureUrl: string | null;
}

/** GET /group/findGroupInfos/{instance}?groupJid=... — the group's
 *  subject (name) and picture. Confirmed live 2026-07-16 (returned
 *  subject + 18 participants). Best-effort: the caller falls back to a
 *  null name rather than blocking ingestion when this fails. */
export async function fetchEvolutionGroupInfo(
  args: FetchEvolutionGroupInfoArgs,
): Promise<EvolutionGroupInfo> {
  const { baseUrl, apiKey, instanceName, groupJid } = args;
  const response = await fetch(
    `${baseUrl}/group/findGroupInfos/${instanceName}?groupJid=${encodeURIComponent(groupJid)}`,
    { method: 'GET', headers: headers(apiKey) },
  );
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return { subject: data.subject ?? null, pictureUrl: data.pictureUrl ?? null };
}

export interface FetchEvolutionProfilePictureArgs extends EvolutionAuth {
  instanceName: string;
  /** Bare number, same convention as sendText's `to` — Evolution builds
   *  the JID server-side. */
  number: string;
}

/** POST /chat/fetchProfilePictureUrl/{instance}. Confirmed live
 *  2026-07-14 against a real contact (returned a real photo URL) and
 *  against a nonexistent/no-photo contact — the latter still returns
 *  HTTP 200 with `profilePictureUrl: null`, not an error, so `null` is
 *  a valid, expected result the caller must handle, not a failure. */
export async function fetchEvolutionProfilePicture(
  args: FetchEvolutionProfilePictureArgs,
): Promise<string | null> {
  const { baseUrl, apiKey, instanceName, number } = args;
  const response = await fetch(`${baseUrl}/chat/fetchProfilePictureUrl/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ number }),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return data.profilePictureUrl ?? null;
}
