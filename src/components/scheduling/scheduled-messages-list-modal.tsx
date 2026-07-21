"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ScheduledMessage {
  id: string;
  title: string | null;
  content_type: string;
  content_text: string | null;
  scheduled_at: string;
}

function formatScheduledAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export interface ScheduledMessagesListModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kanban entry point — pass exactly one of `dealId`/`conversationId`,
   *  never both (mirrors ScheduleMessageModal's own props). */
  dealId?: string;
  /** Inbox entry point. */
  conversationId?: string;
}

/**
 * Lists this lead's pending scheduled follow-ups, with a cancel action
 * per row. Scoped to one deal/conversation only — not a cross-account
 * admin view (see the closed plan's explicit scope decision).
 */
export function ScheduledMessagesListModal({
  open,
  onOpenChange,
  dealId,
  conversationId,
}: ScheduledMessagesListModalProps) {
  // Parent namespace, not just "Scheduling.list" — the content-type
  // preview label below reuses ScheduleMessageModal's "modal.content*"
  // keys rather than duplicating the same four words under a second key.
  const t = useTranslations("Scheduling");
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const contentTypeLabel = useCallback((type: string): string => {
    switch (type) {
      case "image": return t("modal.contentImage");
      case "video": return t("modal.contentVideo");
      case "document": return t("modal.contentDocument");
      case "audio": return t("modal.contentAudio");
      default: return t("modal.contentText");
    }
  }, [t]);

  const previewText = useCallback((item: ScheduledMessage): string => {
    if (item.content_text) return item.content_text;
    return `[${contentTypeLabel(item.content_type)}]`;
  }, [contentTypeLabel]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = conversationId
        ? `conversation_id=${encodeURIComponent(conversationId)}`
        : `deal_id=${encodeURIComponent(dealId as string)}`;
      const res = await fetch(`/api/scheduled-messages?${query}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.scheduled_messages as ScheduledMessage[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, [dealId, conversationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleCancel = useCallback(async (id: string) => {
    setCancellingId(id);
    try {
      const res = await fetch(`/api/scheduled-messages/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("list.cancelFailed"));
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
      toast.success(t("list.cancelSuccess"));
    } catch {
      toast.error(t("list.serverUnreachable"));
    } finally {
      setCancellingId(null);
    }
  }, [t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("list.title")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("list.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5"
                >
                  <div className="min-w-0 flex-1">
                    {item.title && (
                      <span className="block truncate text-sm font-medium text-foreground">
                        {item.title}
                      </span>
                    )}
                    <span className="block truncate text-xs text-muted-foreground">
                      {previewText(item)}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {formatScheduledAt(item.scheduled_at)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-red-400"
                    title={t("list.cancelTooltip")}
                    onClick={() => void handleCancel(item.id)}
                    disabled={cancellingId === item.id}
                  >
                    {cancellingId === item.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
