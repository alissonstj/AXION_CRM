"use client";

import { useEffect, useState } from "react";

/**
 * Whether `typingUntil` (conversations.typing_until — migration 049) is
 * still in the future. Time-boxed rather than a plain boolean on the
 * server, so a missed "stopped typing" presence event can't leave the
 * indicator stuck on forever; this hook schedules one re-render for the
 * moment it expires (no polling) so the UI drops it on time even
 * without a follow-up realtime event.
 */
export function useIsTyping(typingUntil?: string | null): boolean {
  const typingUntilMs = typingUntil ? new Date(typingUntil).getTime() : 0;
  const [, forceRecheck] = useState(0);

  useEffect(() => {
    if (!typingUntilMs) return;
    const remainingMs = typingUntilMs - Date.now();
    if (remainingMs <= 0) return;
    const timer = setTimeout(() => forceRecheck((n) => n + 1), remainingMs + 100);
    return () => clearTimeout(timer);
  }, [typingUntilMs]);

  return typingUntilMs > Date.now();
}
