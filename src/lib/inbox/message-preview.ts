import {
  MessageSquare,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  MapPin,
  LayoutTemplate,
  MessageSquareDashed,
} from "lucide-react";
import type { ComponentType } from "react";

// `conversations.last_message_text` only carries a bracketed
// placeholder like `[image]` when the message had no caption — see
// ingest.ts / send-message.ts / automations/cron's route, which all
// write `contentText || `[${kind}]``. A captioned media message stores
// the caption instead, which this can't distinguish from plain text —
// same best-effort tradeoff the denormalized field itself already
// makes everywhere else it's written.
const BRACKET_KIND = /^\[(\w+)\]$/;

const KIND_ICON: Record<string, ComponentType<{ className?: string }>> = {
  image: ImageIcon,
  video: Video,
  document: FileText,
  audio: Mic,
  location: MapPin,
  template: LayoutTemplate,
  interactive: MessageSquareDashed,
  interactive_reply: MessageSquareDashed,
};

const KIND_LABEL_KEY: Record<string, string> = {
  image: "photo",
  video: "video",
  document: "document",
  audio: "audio",
  location: "location",
  template: "template",
  interactive: "interactiveReply",
  interactive_reply: "interactiveReply",
};

export interface MessagePreview {
  Icon: ComponentType<{ className?: string }>;
  text: string;
}

/**
 * Formats a conversation's `last_message_text` into a one-line preview
 * with a leading content-type icon — shared by the Inbox conversation
 * list and the Kanban deal card so both read the denormalized field
 * the same way. Pass `t` scoped to the `MessagePreview` namespace.
 */
export function formatMessagePreview(
  lastMessageText: string | null | undefined,
  t: (key: string) => string,
): MessagePreview {
  if (!lastMessageText) {
    return { Icon: MessageSquare, text: t("noMessagesYet") };
  }
  const match = BRACKET_KIND.exec(lastMessageText);
  const kind = match?.[1];
  if (kind && KIND_ICON[kind]) {
    return { Icon: KIND_ICON[kind], text: t(KIND_LABEL_KEY[kind]) };
  }
  return { Icon: MessageSquare, text: lastMessageText };
}
