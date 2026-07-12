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

/** Contrato: todo `to` chega já sanitizado pelo caller (ex.:
 *  `sanitizePhoneForMeta` antes de chamar a Meta). O provedor não
 *  re-sanitiza — só lida com variantes de formatação/retry. */
export interface ChannelSender {
  sendText(args: SendTextArgs): Promise<OutboundResult>;
  sendMedia(args: SendMediaArgs): Promise<OutboundResult>;
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<OutboundResult>;
  sendInteractiveList(args: SendInteractiveListArgs): Promise<OutboundResult>;
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
