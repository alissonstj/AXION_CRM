// Tipos e contratos da camada de provedor de canal.
// Nenhuma lógica aqui — só a costura que Meta e (na Fase 2) Evolution implementam.

export type ChannelProviderId = 'meta' | 'evolution';

/** Resultado de um envio. `workingRecipient` só vem preenchido quando o
 *  provedor corrigiu o número (ex.: retry de variante da Meta) — o caller
 *  persiste de volta no contato quando difere do enviado. */
export interface OutboundResult {
  providerMessageId: string;
  workingRecipient?: string;
}

export interface SendTextArgs {
  /** Já sanitizado pelo caller (ex.: `sanitizePhoneForMeta`) — o
   *  provedor não sanitiza, só tenta variantes de formatação em cima
   *  do valor recebido. */
  to: string;
  text: string;
  contextProviderMessageId?: string;
  /** A mensagem citada (`contextProviderMessageId`) foi originalmente
   *  enviada por nós (agente) ou pelo contato? Mesma necessidade que
   *  `SendReactionArgs.targetFromMe` — a Evolution/Baileys precisa
   *  disso pra montar a chave completa da mensagem citada; a Meta
   *  ignora. Só consumido por `EvolutionProvider.sender.sendText`/
   *  `sendMedia` — `sendInteractiveButtons`/`sendInteractiveList` ainda
   *  não encaminham `contextProviderMessageId` nenhum na Evolution
   *  (gap pré-existente, fora de escopo aqui). */
  contextFromMe?: boolean;
}

export type OutboundMediaKind = 'image' | 'video' | 'document' | 'audio';

export interface SendMediaArgs {
  /** Já sanitizado pelo caller — ver nota em `SendTextArgs.to`. */
  to: string;
  kind: OutboundMediaKind;
  link: string;
  caption?: string;
  filename?: string;
  contextProviderMessageId?: string;
  /** Ver nota em `SendTextArgs.contextFromMe`. */
  contextFromMe?: boolean;
}

export interface OutboundButton {
  id: string;
  title: string;
}

export interface SendInteractiveButtonsArgs {
  /** Já sanitizado pelo caller — ver nota em `SendTextArgs.to`. */
  to: string;
  bodyText: string;
  headerText?: string;
  footerText?: string;
  buttons: OutboundButton[];
  contextProviderMessageId?: string;
}

export interface OutboundListRow {
  id: string;
  title: string;
  description?: string;
}

export interface OutboundListSection {
  title?: string;
  rows: OutboundListRow[];
}

export interface SendInteractiveListArgs {
  /** Já sanitizado pelo caller — ver nota em `SendTextArgs.to`. */
  to: string;
  bodyText: string;
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  sections: OutboundListSection[];
  contextProviderMessageId?: string;
}

export interface MarkAsReadArgs {
  /** Já sanitizado pelo caller — ver nota em `SendTextArgs.to`. */
  to: string;
  /** A mensagem mais recente do contato nesta conversa — o WhatsApp
   *  marca essa e todas as anteriores no mesmo chat como lidas
   *  (semântica padrão de recibo de leitura, não é preciso marcar
   *  mensagem por mensagem). Sempre uma mensagem do contato
   *  (`fromMe: false` implícito) — não faz sentido marcar como lida
   *  uma mensagem que nós mesmos enviamos. */
  providerMessageId: string;
}

export interface SendReactionArgs {
  /** Já sanitizado pelo caller — ver nota em `SendTextArgs.to`. */
  to: string;
  targetProviderMessageId: string;
  /** A mensagem-alvo foi originalmente enviada por nós (agente) ou pelo
   *  contato? A Evolution/Baileys precisa disso para montar a chave
   *  completa da mensagem (`remoteJid` + `fromMe` + `id`) — a Meta
   *  ignora este campo, o `targetProviderMessageId` já basta lá. */
  targetFromMe: boolean;
  /** String vazia remove a reação. */
  emoji: string;
}

/** Contrato: todo `to` chega já sanitizado pelo caller (ex.:
 *  `sanitizePhoneForMeta` antes de chamar a Meta). O provedor não
 *  re-sanitiza — só lida com variantes de formatação/retry. */
export interface ChannelSender {
  sendText(args: SendTextArgs): Promise<OutboundResult>;
  sendMedia(args: SendMediaArgs): Promise<OutboundResult>;
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<OutboundResult>;
  sendInteractiveList(args: SendInteractiveListArgs): Promise<OutboundResult>;
  sendReaction(args: SendReactionArgs): Promise<OutboundResult>;
  /** Sends a read receipt — no new message is created, so there's no
   *  `OutboundResult`/providerMessageId to return. */
  markAsRead(args: MarkAsReadArgs): Promise<void>;
}

export type InboundKind =
  | 'text' | 'image' | 'video' | 'document' | 'audio'
  | 'location' | 'interactive_reply' | 'reaction';

/** Forma interna comum que o ingest consome, independente de provedor. */
export interface NormalizedInbound {
  from: string;
  contactName?: string;
  providerMessageId: string;
  timestamp: Date;
  kind: InboundKind;
  text?: string | null;
  mediaUrl?: string | null;
  /** Raw base64 media bytes, only set by providers that embed media
   *  directly in the webhook (Evolution) rather than referencing it by
   *  id (Meta). The route handler decodes + uploads this to Storage
   *  and sets `mediaUrl` before calling `ingestInbound` — never read
   *  by `ingestInbound` itself. */
  mediaBase64?: string | null;
  mediaMimeType?: string | null;
  mediaFileName?: string | null;
  interactiveReplyId?: string | null;
  reaction?: { targetProviderMessageId: string; emoji: string } | null;
  replyToProviderMessageId?: string | null;
  /** True when the provider's own webhook marked this as sent by our
   *  connected number (Baileys `key.fromMe` on Evolution; Meta's Cloud
   *  API webhook has no such concept and never sets this). By the time
   *  `ingestInbound` sees a `fromMe: true` inbound, the caller has
   *  already ruled out "this is an echo of our own CRM-originated send"
   *  (see sent-by-crm-cache.ts) — so here it unambiguously means a
   *  message sent from the linked phone directly, outside the CRM. */
  fromMe?: boolean;
}

export interface ConnectionState {
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  /** Data-URL do QR, só durante `connecting` (Evolution). */
  qrCode?: string;
  detail?: string;
}

export interface ChannelProvider {
  readonly id: ChannelProviderId;
  readonly sender: ChannelSender;
  /** Traduz o payload de webhook do provedor para a forma interna. */
  parseWebhook(payload: unknown): NormalizedInbound[];
  connect(): Promise<ConnectionState>;
  getConnectionState(): Promise<ConnectionState>;
  disconnect(): Promise<void>;
}
