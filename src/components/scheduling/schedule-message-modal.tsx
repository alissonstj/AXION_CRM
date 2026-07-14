"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Loader2, MessageSquare, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

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
  /** Kanban entry point — pass exactly one of `dealId`/`conversationId`,
   *  never both. */
  dealId?: string;
  /** Inbox entry point. */
  conversationId?: string;
  onScheduled?: () => void;
}

/**
 * "Criar Agendamento" — schedule a one-off message to a specific lead
 * for future delivery. Shared shape across both entry points (Kanban
 * card, Inbox composer): title, content (text / media / quick reply),
 * date + time. Submits to POST /api/scheduled-messages; the actual
 * send happens later, out of band, via the cron sweep in
 * /api/automations/cron.
 */
export function ScheduleMessageModal({
  open,
  onOpenChange,
  dealId,
  conversationId,
  onScheduled,
}: ScheduleMessageModalProps) {
  const t = useTranslations("Scheduling.modal");
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
      toast.error(t("onlyTextQuickReplies"));
      return;
    }
    setContentType("text");
    setText(qr.content_text);
  }, [t]);

  const contentTypeOptions: { value: ScheduledContentType; label: string }[] = useMemo(() => [
    { value: "text", label: t("contentText") },
    { value: "image", label: t("contentImage") },
    { value: "video", label: t("contentVideo") },
    { value: "document", label: t("contentDocument") },
    { value: "audio", label: t("contentAudio") },
  ], [t]);

  const handleFileSelect = useCallback(
    async (kind: Exclude<ScheduledContentType, "text">, file: File | undefined) => {
      if (!file) return;
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        const kindLabel = contentTypeOptions.find((o) => o.value === kind)?.label.toLowerCase() ?? kind;
        toast.error(
          t("fileSizeError", {
            size: (file.size / 1024 / 1024).toFixed(1),
            kind: kindLabel,
            max: Math.round(max / 1024 / 1024),
          }),
        );
        return;
      }
      setUploading(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        setMediaDraft({ url: publicUrl, path, filename: file.name });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setUploading(false);
      }
    },
    [contentTypeOptions, t],
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
      toast.error(t("pickFutureDateTime"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/scheduled-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deal_id: dealId,
          conversation_id: conversationId,
          title: title.trim() || undefined,
          content_type: contentType,
          content_text: contentType === "text" ? text : text.trim() || undefined,
          media_url: mediaDraft?.url,
          scheduled_at: scheduledDate.toISOString(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("scheduleFailed"));
        return;
      }
      toast.success(t("scheduleSuccess"));
      reset();
      onOpenChange(false);
      onScheduled?.();
    } catch {
      toast.error(t("serverUnreachable"));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, scheduledAt, dealId, conversationId, title, contentType, text, mediaDraft, reset, onOpenChange, onScheduled, t]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-title">{t("titleLabel")}</Label>
            <Input
              id="schedule-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("content")}</Label>
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
                <Label htmlFor="schedule-text">{t("message")}</Label>
                <div className="flex items-center gap-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger className="flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                      {t("insertVariable")}
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
                    {t("quickReply")}
                  </Button>
                </div>
              </div>
              <Textarea
                id="schedule-text"
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("textPlaceholder")}
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
                {mediaDraft ? mediaDraft.filename : t("chooseFile")}
              </Button>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("captionPlaceholder")}
                className="min-h-16"
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-datetime">{t("dateTime")}</Label>
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
            {t("cancel")}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("submit")}
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
