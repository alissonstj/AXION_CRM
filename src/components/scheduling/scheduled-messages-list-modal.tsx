"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

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

function previewText(item: ScheduledMessage): string {
  if (item.content_text) return item.content_text;
  return `[${item.content_type}]`;
}

export interface ScheduledMessagesListModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}

/**
 * Lists this conversation's pending scheduled follow-ups, with a
 * cancel action per row. Scoped to one conversation only — not a
 * cross-account admin view (see the closed plan's explicit scope
 * decision).
 */
export function ScheduledMessagesListModal({
  open,
  onOpenChange,
  conversationId,
}: ScheduledMessagesListModalProps) {
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/scheduled-messages?conversation_id=${encodeURIComponent(conversationId)}`,
        { cache: "no-store" },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.scheduled_messages as ScheduledMessage[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleCancel = useCallback(async (id: string) => {
    setCancellingId(id);
    try {
      const res = await fetch(`/api/scheduled-messages/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Could not cancel the scheduled message.");
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
      toast.success("Scheduled message cancelled.");
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setCancellingId(null);
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Scheduled messages</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing scheduled for this conversation yet.
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
                    title="Cancel"
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
