"use client";

import { useCallback, useRef, useState } from "react";
import { Loader2, MessageSquare, Paperclip } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { QuickReplyPicker } from "@/components/inbox/quick-reply-picker";
import type { QuickReply } from "@/types";

const CHAT_MEDIA_BUCKET = "chat-media";

type ScheduledContentType = "text" | "image" | "video" | "document" | "audio";

const CONTENT_TYPE_ACCEPT: Record<Exclude<ScheduledContentType, "text">, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
  audio: "audio/mpeg,audio/ogg,audio/mp4,audio/wav",
};

interface MediaDraft {
  url: string;
  path: string;
  filename: string;
}

export interface ScheduleMessageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kanban entry point — Fase 2 scope. The Inbox entry point (Fase 3)
   *  will add a `conversationId` variant of this component's props. */
  dealId: string;
  onScheduled?: () => void;
}

/**
 * "Criar Agendamento" — schedule a one-off message to a specific lead
 * for future delivery. Shared shape across both entry points (Kanban
 * now, Inbox in Fase 3): title, content (text / media / quick reply),
 * date + time. Submits to POST /api/scheduled-messages; the actual
 * send happens later, out of band, via the cron sweep in
 * /api/automations/cron.
 */
export function ScheduleMessageModal({
  open,
  onOpenChange,
  dealId,
  onScheduled,
}: ScheduleMessageModalProps) {
  const [title, setTitle] = useState("");
  const [contentType, setContentType] = useState<ScheduledContentType>("text");
  const [text, setText] = useState("");
  const [mediaDraft, setMediaDraft] = useState<MediaDraft | null>(null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setTitle("");
    setContentType("text");
    setText("");
    setMediaDraft(null);
    setScheduledAt("");
  }, []);

  const insertVariable = useCallback((token: string) => {
    const el = textareaRef.current;
    if (!el) {
      setText((prev) => prev + token);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }, []);

  const handlePickQuickReply = useCallback((qr: QuickReply) => {
    setQuickReplyOpen(false);
    if (qr.kind !== "text" || !qr.content_text) {
      toast.error("Only text quick replies can be used here.");
      return;
    }
    setContentType("text");
    setText(qr.content_text);
  }, []);

  const handleFileSelect = useCallback(
    async (kind: Exclude<ScheduledContentType, "text">, file: File | undefined) => {
      if (!file) return;
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(
            max / 1024 / 1024,
          )} MB.`,
        );
        return;
      }
      setUploading(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        setMediaDraft({ url: publicUrl, path, filename: file.name });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const handleContentTypeChange = useCallback((next: ScheduledContentType) => {
    setContentType(next);
    setMediaDraft(null);
  }, []);

  const canSubmit =
    scheduledAt.trim() !== "" &&
    (contentType === "text" ? text.trim() !== "" : mediaDraft !== null) &&
    !uploading &&
    !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    const scheduledDate = new Date(scheduledAt);
    if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      toast.error("Pick a date and time in the future.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/scheduled-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deal_id: dealId,
          title: title.trim() || undefined,
          content_type: contentType,
          content_text: contentType === "text" ? text : text.trim() || undefined,
          media_url: mediaDraft?.url,
          scheduled_at: scheduledDate.toISOString(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Could not schedule the message.");
        return;
      }
      toast.success("Message scheduled.");
      reset();
      onOpenChange(false);
      onScheduled?.();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, scheduledAt, dealId, title, contentType, text, mediaDraft, reset, onOpenChange, onScheduled]);

  const contentTypeOptions: { value: ScheduledContentType; label: string }[] = [
    { value: "text", label: "Text" },
    { value: "image", label: "Image" },
    { value: "video", label: "Video" },
    { value: "document", label: "Document" },
    { value: "audio", label: "Audio" },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Schedule message</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-title">Title (optional)</Label>
            <Input
              id="schedule-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. 20-day follow-up"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Content</Label>
            <div className="flex flex-wrap gap-1.5">
              {contentTypeOptions.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  size="sm"
                  variant={contentType === opt.value ? "default" : "outline"}
                  onClick={() => handleContentTypeChange(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>

          {contentType === "text" ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="schedule-text">Message</Label>
                <div className="flex items-center gap-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger className="flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                      Insert variable
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => insertVariable("#primeiroNome")}>
                        #primeiroNome
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => insertVariable("#nomeCompleto")}>
                        #nomeCompleto
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setQuickReplyOpen(true)}
                  >
                    <MessageSquare className="mr-1 h-3.5 w-3.5" />
                    Quick reply
                  </Button>
                </div>
              </div>
              <Textarea
                id="schedule-text"
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Oi #primeiroNome, tudo bem?"
                className="min-h-24"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept={CONTENT_TYPE_ACCEPT[contentType]}
                onChange={(e) => {
                  void handleFileSelect(contentType, e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="mr-2 h-4 w-4" />
                )}
                {mediaDraft ? mediaDraft.filename : "Choose file"}
              </Button>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Caption (optional)"
                className="min-h-16"
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-datetime">Date and time</Label>
            <Input
              id="schedule-datetime"
              type="datetime-local"
              value={scheduledAt}
              min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>

      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={handlePickQuickReply}
      />
    </Dialog>
  );
}
