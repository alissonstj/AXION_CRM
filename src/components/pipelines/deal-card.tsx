"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Deal, PipelineStage } from "@/types";
import { CalendarClock, CalendarDays, DollarSign, MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { formatMessagePreview } from "@/lib/inbox/message-preview";
import { ScheduleMessageModal } from "@/components/scheduling/schedule-message-modal";
import { ScheduledMessagesListModal } from "@/components/scheduling/scheduled-messages-list-modal";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function initials(name?: string | null, fallback?: string | null) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const tPreview = useTranslations("MessagePreview");
  const router = useRouter();
  const contactLabel = deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledListOpen, setScheduledListOpen] = useState(false);

  // Last-message preview + the conversation's own id (for the WhatsApp
  // shortcut below), Inbox-list style — see message-preview.ts. `null`
  // = still loading. Looked up by `contact_id` (always present, NOT
  // NULL on deals) rather than `deal.conversation_id`, which is
  // nullable and left unset by the automation-created-deal path
  // (create_deal in automations/engine.ts) — contact_id resolves to
  // the same canonical conversation either way (see
  // findOrCreateConversation in ingest.ts), so this also covers
  // automation-created deals `deal.conversation_id` alone would miss.
  const [conversation, setConversation] = useState<
    { id: string; last_message_text: string | null } | null | undefined
  >(null);
  useEffect(() => {
    if (!deal.contact_id) {
      setConversation(undefined);
      return;
    }
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("id, last_message_text")
        .eq("contact_id", deal.contact_id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!cancelled) setConversation(data ?? undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [deal.contact_id]);

  const preview =
    conversation === null
      ? null
      : formatMessagePreview(conversation?.last_message_text, tPreview);
  const conversationId = deal.conversation_id || conversation?.id || null;

  const handleEdit = () => {
    if (isOverlay) return;
    onEdit(deal);
  };

  const handleOpenConversation = () => {
    if (!conversationId) return;
    router.push(`/inbox?c=${conversationId}`);
  };

  return (
    <>
      {/*
        A <div role="button"> rather than a native <button>: the
        schedule icon below needs its own clickable target inside the
        card, and HTML doesn't allow a <button> nested inside another
        <button>. onKeyDown reproduces the native Enter/Space
        activation a real button gets for free.
      */}
      <div
        role="button"
        tabIndex={isOverlay ? -1 : 0}
        onClick={(e) => {
          // Still fires after a non-drag tap because the PointerSensor
          // requires 5px movement before it counts as a drag.
          e.stopPropagation();
          handleEdit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleEdit();
          }
        }}
        className={`group relative w-full cursor-pointer rounded-xl border border-border/50 bg-muted/70 pl-4 pr-3 py-3 text-left shadow-sm transition-all ${
          isOverlay
            ? "shadow-xl"
            : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
        }`}
      >
        {/* 4px left accent bar using stage color */}
        <span
          aria-hidden
          className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
          style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
        />

        {/* Row 1 — contact avatar + contact name (Inbox-list style,
            not the deal's own title — the title/value still show when
            the deal editor opens). Assignee avatar sits top-right,
            discreet: no label, just initials + a tooltip. */}
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
            {initials(deal.contact?.name, deal.contact?.phone)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {contactLabel}
          </span>
          {assigneeLabel && (
            <span
              title={assigneeLabel}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-semibold text-primary"
            >
              {initials(assigneeLabel)}
            </span>
          )}
        </div>

        {/* Row 2 — last-message preview, same icon+text formatting as
            the Inbox conversation list (message-preview.ts), aligned
            under the contact name (pl-8 matches avatar width + gap). */}
        <div className="mt-1 flex items-center gap-1 pl-8 text-xs text-muted-foreground">
          {preview && (
            <>
              <preview.Icon className="h-3 w-3 shrink-0" />
              <span className="truncate">{preview.text}</span>
            </>
          )}
        </div>

        {/* Row 3 — footer quick-action icons, compact and aligned under
            the contact name. Same stopPropagation-inside-role="button"
            pattern as before — no provider indicator (no discriminant
            value while accounts are single-channel). */}
        {deal.contact_id && !isOverlay && (
          <div className="mt-1 flex items-center gap-0.5 pl-8">
            <button
              type="button"
              title={t("scheduleMessage")}
              aria-label={t("scheduleMessage")}
              onClick={(e) => {
                e.stopPropagation();
                setScheduleOpen(true);
              }}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            >
              <CalendarClock className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={t("scheduledMessages")}
              aria-label={t("scheduledMessages")}
              onClick={(e) => {
                e.stopPropagation();
                setScheduledListOpen(true);
              }}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            >
              <CalendarDays className="h-3.5 w-3.5" />
            </button>
            {/* Value — no dedicated value-only view exists, so this
                opens the same full deal editor the card body itself
                opens (handleEdit); the button is here purely so the
                value is one click away without occupying its own line
                in the card body (see the earlier value-removal pass). */}
            <button
              type="button"
              title={t("editValue")}
              aria-label={t("editValue")}
              onClick={(e) => {
                e.stopPropagation();
                handleEdit();
              }}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            >
              <DollarSign className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={conversationId ? t("openConversation") : t("noConversationYet")}
              aria-label={conversationId ? t("openConversation") : t("noConversationYet")}
              disabled={!conversationId}
              onClick={(e) => {
                e.stopPropagation();
                handleOpenConversation();
              }}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              <MessageCircle className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {deal.contact_id && (
        <>
          <ScheduleMessageModal
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
            dealId={deal.id}
          />
          <ScheduledMessagesListModal
            open={scheduledListOpen}
            onOpenChange={setScheduledListOpen}
            dealId={deal.id}
          />
        </>
      )}
    </>
  );
}
