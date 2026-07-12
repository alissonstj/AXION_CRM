import {
  sendEvolutionText,
  sendEvolutionMedia,
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
  /** Instance-scoped token (not the global EVOLUTION_API_KEY) — see the
   *  design doc's "Chaves de API" section for why. */
  apiKey: string;
  instanceName: string;
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

  parseWebhook(_payload: unknown): NormalizedInbound[] {
    throw new Error('not implemented — Task 4');
  }
  async connect(): Promise<ConnectionState> {
    throw new Error('not implemented — Task 5');
  }
  async getConnectionState(): Promise<ConnectionState> {
    throw new Error('not implemented — Task 5');
  }
  async disconnect(): Promise<void> {
    throw new Error('not implemented — Task 5');
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
