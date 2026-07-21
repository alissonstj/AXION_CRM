# Redesign visual do Inbox — estilo WhatsApp Web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the CRM's visual layer (sidebar, Inbox conversation list, chat area, composer, details panel) to feel like WhatsApp Web with a discrete CRM "second track" of icons — no change to business logic, data, or provider (Meta/Evolution) behavior.

**Architecture:** Pure component-level CSS/layout changes (Tailwind classes + minor JSX restructuring for responsive behavior). No new dependencies, no new API routes, no schema changes. This repo does not unit-test React components (verified: no `.test.tsx` files exist for `sidebar.tsx`, `deal-card.tsx`, `message-composer.tsx`) — verification per phase is `tsc --noEmit` + `vitest run` (regression check on existing lib/route tests) + manual visual check in the running dev server, not new component tests.

**Tech Stack:** Next.js 16 (Turbopack), Tailwind, lucide-react icons, next-intl.

## Global Constraints

- Reskin only — no changes to providers (Meta/Evolution), automations, broadcasts, or scheduled-messages logic.
- One phase at a time. Stop after each phase for the user's visual confirmation before starting the next.
- Execution order: **Fase 1 → Fase 5 → Fase 2 → Fase 3 → Fase 4** (not file order — risk order).
- Every phase ends with: `npx tsc --noEmit` clean, `npx vitest run` no new failures, and a written summary of what changed for the user to check visually.
- Out of scope for this whole package: audio transcription UI, any provider/automation/broadcast/scheduling logic.

---

## Fase 1 — Sidebar de ícones (trilha dupla, estilo WhatsApp)

**Files:**
- Modify: `src/components/layout/sidebar.tsx`

**Approach:**
- Desktop (`lg:` breakpoint) only: collapse `aside` from `lg:w-60` to `lg:w-[76px]` icon-rail. Mobile drawer (`w-64`, opened via hamburger) keeps full text labels — it's an overlay, not persistent screen real estate, so collapsing it has no space payoff and only hurts usability.
- Hide nav item label text, "Beta" chip, and account-name strip at `lg:` via `lg:hidden` on those spans/divs — mobile keeps them as today.
- Nav icon wrapped in a `relative` span so the unread dot (Inbox) / notification count badge (Notifications) can render as a small absolute-positioned overlay on the icon at `lg:`, replacing their current inline-after-label position (which only makes sense with visible labels).
- Tooltip: native `title={t(item.labelKey)}` on each `<Link>` — repo already uses native `title` for this exact purpose elsewhere (e.g. `deal-card.tsx` schedule buttons), no new dependency needed.
- Logo row: hide the "AXION CRM PRO" text span at `lg:`, keep the icon mark; row switches to `lg:justify-center`.
- User section (bottom): hide the name/email block at `lg:`, keep avatar centered; dropdown popup itself (already a portal) is unaffected by the narrower trigger.

- [ ] Restructure nav item `<Link>` rows (main + bottom nav) for icon-only desktop layout with overlay badges
- [ ] Collapse `aside` width at `lg:`, hide logo text, hide account strip, hide user name/email block at `lg:`
- [ ] `npx tsc --noEmit` — must be clean
- [ ] `npx vitest run` — no new failures vs. baseline
- [ ] Manual check in dev server: desktop shows icon rail with tooltips + active highlight + badges; mobile drawer unchanged (full labels)
- [ ] Report diff summary to user, wait for visual confirmation before Fase 5

---

## Fase 5 — Composer com atalhos visíveis

**Files:**
- Modify: `src/components/inbox/message-composer.tsx`

**Approach:**
- Promote "Agendar mensagem" out of the `+` dropdown into its own icon button next to `+` (reuse the same `CalendarClock` icon + handler already wired to `setScheduleOpen(true)`).
- "Mensagens agendadas" (view) stays in the `+` menu (or gets its own icon too — decide by available width during implementation; default to keeping it in `+` unless it clearly fits).
- Microphone/recording icon: unchanged.
- Emoji, attachment (`+`), AI draft shortcut: kept, only reflowed to sit closer to the WhatsApp Web icon order (emoji → attachment/+ → schedule → mic → send).

- [ ] Move schedule-message trigger to a standalone icon button
- [ ] Reflow remaining icons in composer toolbar
- [ ] `npx tsc --noEmit` — must be clean
- [ ] `npx vitest run` — no new failures
- [ ] Manual check: all composer actions (attach, emoji, interactive, quick reply, schedule, view scheduled, AI draft, mic, send) still open/fire correctly
- [ ] Report diff summary to user, wait for visual confirmation before Fase 2

---

## Fase 2 — Lista de conversas: filtros + visual WhatsApp

**Files:**
- Modify: `src/components/inbox/conversation-list.tsx`

**Approach:**
- Pill filter bar above the list, mapped to the existing Aberta/Fechada (and any other existing) filter state — relabeled as pills, not a new filter dimension.
- Redesign each row: larger circular avatar left, name + last-message preview + timestamp right, green unread-count bubble.
- Rounded WhatsApp-style search input with a leading search icon.

- [ ] Implement pill filter bar wired to existing filter state
- [ ] Redesign conversation row layout
- [ ] Restyle search input
- [ ] `npx tsc --noEmit` — must be clean
- [ ] `npx vitest run` — no new failures
- [ ] Manual check with long contact names / long last-message previews — layout must not break
- [ ] Report diff summary to user, wait for visual confirmation before Fase 3

---

## Fase 3 — Área de chat: bolhas, wallpaper, cores

**Files:**
- Modify: `src/components/inbox/message-bubble.tsx`
- Modify: `src/components/inbox/message-thread.tsx`

**Approach:**
- Sent bubbles green, received bubbles dark-gray (dark mode) / white (light mode), asymmetric rounded corners ("tail" corner).
- Chat background: existing `inbox-doodle.svg` pattern, tinted per theme.
- Conversation header: avatar + name + status.
- Date separators ("Hoje"/"Ontem") as centered pills.
- Verify every existing message type still renders correctly in the new bubble style: text, audio (with player), image, media, reactions, quoted reply, stickers, link preview.

- [ ] Restyle bubble component (colors, corners)
- [ ] Apply chat background pattern
- [ ] Restyle conversation header + date separators
- [ ] `npx tsc --noEmit` — must be clean
- [ ] `npx vitest run` — no new failures
- [ ] Manual check: every message type listed above still legible/functional
- [ ] Report diff summary to user, wait for visual confirmation before Fase 4

---

## Fase 4 — Painel de detalhes colapsável

**Files:**
- Modify: `src/components/inbox/contact-sidebar.tsx`
- Modify: `src/app/(dashboard)/inbox/page.tsx` (or wherever the panel's open/closed state is owned)

**Approach:**
- Panel closed by default, opens on click of contact name/avatar in the chat header.
- Chat area expands to fill the freed width when closed.
- Small tag badge + active-deal icon next to the contact name in the header as a substitute for the always-visible panel.
- If low-effort: persist the open/closed preference per user (localStorage is enough — no schema change).

- [ ] Wire panel open/closed state + trigger on header click
- [ ] Add discrete tag/deal indicators to the chat header
- [ ] (If low-effort) persist open/closed preference
- [ ] `npx tsc --noEmit` — must be clean
- [ ] `npx vitest run` — no new failures
- [ ] Manual check: panel opens/closes, chat area reflows, indicators show correct tag/deal state
- [ ] Report diff summary to user — this is the last phase, confirm package complete
