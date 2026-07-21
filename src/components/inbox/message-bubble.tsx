"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  Sparkles,
  Download,
  Play,
  Pause,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { useTranslations } from "next-intl";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /** Contact/group avatar — shown next to received voice notes,
   *  matching WhatsApp Web's voice-message layout. */
  contactAvatarUrl?: string | null;
  /** Current agent's own avatar — shown next to voice notes THEY sent,
   *  mirroring `contactAvatarUrl` on the other side of the thread. */
  ownAvatarUrl?: string | null;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

// `<audio controls>`/`<video controls>` get a download affordance for
// free from the browser's native player chrome; a plain `<img>` has
// none. This fetches the file fresh and forces a real "Save As" via a
// same-origin blob + temporary anchor — the `download` attribute is
// silently ignored by browsers on a direct cross-origin URL (Supabase
// Storage) unless the response sets `Content-Disposition: attachment`,
// which it doesn't.
async function downloadImageFile(url: string) {
  const res = await fetch(url);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = url.split("/").pop() || "image";
  a.click();
  URL.revokeObjectURL(blobUrl);
}

function MediaUnavailable({ label, t }: { label: string, t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("unavailable", { label })}</span>
    </div>
  );
}

function MediaImage({ url, alt, downloadLabel }: { url: string; alt: string; downloadLabel: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="group relative inline-block">
      <img
        src={src ?? ""}
        alt={alt}
        className="max-h-64 max-w-60 rounded-lg object-cover"
        onError={() => setError(true)}
      />
      <button
        type="button"
        onClick={() => downloadImageFile(url)}
        title={downloadLabel}
        aria-label={downloadLabel}
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
      >
        <Download className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Bars are laid out with flex-1 (not a fixed width) so they always
// exactly fill the available track width regardless of the bubble's
// avatar/timestamp layout — a fixed px width per bar previously
// overflowed its container and got clipped out of view entirely.
const WAVEFORM_BARS = 32;

// WhatsApp Web renders voice notes as a play button + amplitude
// waveform + running clock, not a native <audio controls> bar. Evolution
// and Meta don't hand us WhatsApp's own waveform sample bytes (see
// evolution.ts's audioMessage mapping — only mimetype is captured), so
// bars are computed client-side by decoding the audio once with the Web
// Audio API. Playback itself still goes through a real (hidden) <audio>
// element — only the visual chrome around it is custom.
function VoiceMessagePlayer({
  url,
  isAgent,
  avatarUrl,
}: {
  url: string;
  isAgent: boolean;
  avatarUrl?: string | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [bars, setBars] = useState<number[] | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function computeWaveform() {
      try {
        const res = await fetch(url);
        const arrayBuffer = await res.arrayBuffer();
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        const channel = decoded.getChannelData(0);
        const blockSize = Math.max(1, Math.floor(channel.length / WAVEFORM_BARS));
        const computed: number[] = [];
        for (let i = 0; i < WAVEFORM_BARS; i++) {
          let max = 0;
          for (let j = 0; j < blockSize; j++) {
            const v = Math.abs(channel[i * blockSize + j] ?? 0);
            if (v > max) max = v;
          }
          computed.push(max);
        }
        const peak = Math.max(...computed, 0.01);
        void ctx.close();
        if (!cancelled) setBars(computed.map((v) => v / peak));
      } catch {
        // Unsupported codec / network hiccup — fall back to a generic
        // waveform shape rather than blocking playback on it.
        if (!cancelled) {
          setBars(Array.from({ length: WAVEFORM_BARS }, (_, i) => 0.35 + 0.5 * Math.abs(Math.sin(i))));
        }
      }
    }

    void computeWaveform();
    return () => {
      cancelled = true;
    };
  }, [url]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      void audio.play();
    }
  };

  const seekTo = (fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = fraction * duration;
  };

  const progress = duration > 0 ? currentTime / duration : 0;
  const displaySeconds = isPlaying || currentTime > 0 ? currentTime : duration;

  return (
    <div className="flex items-center gap-2">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="h-6 w-6 shrink-0 rounded-full bg-muted" />
      )}
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
      />
      <button
        type="button"
        onClick={togglePlay}
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          isAgent
            ? "bg-[color-mix(in_srgb,var(--wa-bubble-sent-fg)_15%,transparent)] text-[var(--wa-bubble-sent-fg)]"
            : "bg-primary/15 text-primary",
        )}
      >
        {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 translate-x-px" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          className="relative flex h-5 w-full cursor-pointer items-center gap-[2px]"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seekTo(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
          }}
        >
          {(bars ?? Array.from({ length: WAVEFORM_BARS }, () => 0.3)).map((height, i) => {
            const played = i / WAVEFORM_BARS < progress;
            return (
              <span
                key={i}
                className={cn(
                  "min-w-[1.5px] flex-1 rounded-full",
                  played
                    ? isAgent
                      ? "bg-[var(--wa-bubble-sent-fg)]"
                      : "bg-primary"
                    : isAgent
                      ? "bg-[color-mix(in_srgb,var(--wa-bubble-sent-fg)_35%,transparent)]"
                      : "bg-muted-foreground/30",
                )}
                style={{ height: `${Math.max(15, height * 100)}%` }}
              />
            );
          })}
          {/* Playhead line — slides across the waveform in sync with
              currentTime, on top of the played/unplayed bar coloring. */}
          <span
            className={cn(
              "pointer-events-none absolute top-1/2 h-full w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left] duration-100 ease-linear",
              isAgent ? "bg-[var(--wa-bubble-sent-fg)]" : "bg-primary",
            )}
            style={{ left: `${Math.min(100, Math.max(0, progress * 100))}%` }}
          />
        </div>
        <span
          className={cn(
            "text-[10px]",
            isAgent ? "text-[color-mix(in_srgb,var(--wa-bubble-sent-fg)_65%,transparent)]" : "text-muted-foreground",
          )}
        >
          {formatDuration(displaySeconds)}
        </span>
      </div>
    </div>
  );
}

function MessageContent({
  message,
  t,
  isAgent,
  avatarUrl,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  isAgent: boolean;
  avatarUrl?: string | null;
}) {
  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Shared image" downloadLabel={t("downloadImage")} />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <video
              src={message.media_url}
              controls
              className="max-h-64 max-w-60 rounded-lg"
            />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div className="w-[240px] max-w-full">
          {message.media_url ? (
            <VoiceMessagePlayer url={message.media_url} isAgent={isAgent} avatarUrl={avatarUrl} />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
          {/* Whisper transcript (Fase 1 — investigacao-transcricao-audio-ia.md),
              saved into content_text same as an image/video caption. */}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return (
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {message.content_text || t("document")}
          </span>
        </a>
      );

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            {t("template")}
          </span>
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("unsupported")}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  contactAvatarUrl,
  ownAvatarUrl,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");
  const avatarUrl = isAgent ? ownAvatarUrl : contactAvatarUrl;

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          // Fixed WhatsApp bubble colors (globals.css --wa-bubble-* tokens),
          // not `bg-primary`/`bg-muted` — these are WhatsApp's own sent/
          // received identity colors, not the user's chosen accent theme
          // or the app's generic neutral surface. Mode-aware via the
          // `[data-mode]`-scoped CSS vars, NOT Tailwind's `dark:` variant
          // (this app doesn't use a `.dark` class — see globals.css).
          isAgent
            ? "rounded-br-md bg-[var(--wa-bubble-sent-bg)] text-[var(--wa-bubble-sent-fg)]"
            : "rounded-bl-md bg-[var(--wa-bubble-received-bg)] text-foreground",
        )}
      >
        {/* Group sender label — WhatsApp shows who in the group sent an
            incoming message above its bubble. Only for participant
            (non-agent) messages that carry a participant name. */}
        {!isAgent && message.sender_participant_name && (
          <div className="mb-0.5 text-xs font-semibold text-primary">
            {message.sender_participant_name}
          </div>
        )}
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent message={message} t={t} isAgent={isAgent} avatarUrl={avatarUrl} />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--wa-bubble-sent-fg)_15%,transparent)] px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-[var(--wa-bubble-sent-fg)]"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the fixed WhatsApp green fill, so
              // the timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast. Inbound
              // bubbles use the muted surface.
              isAgent
                ? "text-[color-mix(in_srgb,var(--wa-bubble-sent-fg)_65%,transparent)]"
                : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
