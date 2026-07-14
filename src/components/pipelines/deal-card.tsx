"use client";

import { useState } from "react";
import type { Deal, PipelineStage } from "@/types";
import { Calendar, Check, X, CalendarClock } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";
import { ScheduleMessageModal } from "@/components/scheduling/schedule-message-modal";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const contactLabel = deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const handleEdit = () => {
    if (isOverlay) return;
    onEdit(deal);
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

        <div className="flex items-start justify-between gap-2">
          <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
            {deal.title}
          </h4>
          {deal.contact_id && !isOverlay && (
            <button
              type="button"
              title={t("scheduleMessage")}
              aria-label={t("scheduleMessage")}
              onClick={(e) => {
                e.stopPropagation();
                setScheduleOpen(true);
              }}
              className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            >
              <CalendarClock className="h-3.5 w-3.5" />
            </button>
          )}
          {deal.status === "won" && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
              <Check className="h-3 w-3" />
              {t("won")}
            </span>
          )}
          {deal.status === "lost" && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
              <X className="h-3 w-3" />
              {t("lost")}
            </span>
          )}
        </div>

        {/* Contact row */}
        <div className="mt-2 flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
            {initials(deal.contact?.name, deal.contact?.phone)}
          </span>
          <span className="truncate text-xs text-muted-foreground">{contactLabel}</span>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <span className="text-sm font-bold text-primary">
            {formatCurrency(deal.value, deal.currency)}
          </span>
          {deal.expected_close_date && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Calendar className="h-3 w-3" />
              {formatDate(deal.expected_close_date)}
            </span>
          )}
        </div>

        {assigneeLabel && (
          <div className="mt-2 flex items-center justify-end">
            <span
              title={assigneeLabel}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
            >
              {initials(assigneeLabel)}
            </span>
          </div>
        )}
      </div>

      {deal.contact_id && (
        <ScheduleMessageModal
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          dealId={deal.id}
        />
      )}
    </>
  );
}
