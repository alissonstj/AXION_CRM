import {
  sendTextMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
} from '@/lib/whatsapp/meta-api';
import { phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils';
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
  parseWebhook(_payload: unknown): NormalizedInbound[] {
    throw new Error('not implemented — Task 3');
  }
  async connect(): Promise<ConnectionState> {
    throw new Error('not implemented — Task 4');
  }
  async getConnectionState(): Promise<ConnectionState> {
    throw new Error('not implemented — Task 4');
  }
  async disconnect(): Promise<void> {
    throw new Error('not implemented — Task 4');
  }
}
