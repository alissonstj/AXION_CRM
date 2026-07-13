# Evolution API Phase 3 — Broadcast Provider-Aware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Evolution-connected accounts send freeform (text/media, no template) broadcasts from the dashboard wizard, and consolidate the wizard's legacy send route through the `ChannelProvider` seam in the same change.

**Architecture:** A new `kind` discriminator on `broadcasts` (`'template'|'freeform'`) drives a branch through the wizard's 4 steps and the send route. Step 1 renders `Step1ChooseTemplate` (unchanged) or a new `Step1ComposeMessage` depending on the account's `whatsapp_config.provider`. Steps 3/4 and the send route accept a shared `BroadcastComposeContent` discriminated union instead of a bare `MessageTemplate`. The send route resolves `getChannelForAccount` once and either calls `sendTemplateMessage` directly (Meta-only, guarded — unchanged, including its existing local phone-variant retry loop, since templates were never part of `ChannelSender`) or `provider.sender.sendText/sendMedia` (Evolution-only, guarded — genuinely no local retry code needed, since `EvolutionProvider.sender` doesn't require one).

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase, Vitest, next-intl.

## Global Constraints

- Templates stay Meta-only; freeform stays Evolution-only. Both directions are guarded server-side with a plain `throw new Error(...)`, mirroring the existing pattern in `src/lib/automations/meta-send.ts:148-152` (`if (provider.id !== 'meta') throw new Error(...)`) — not a custom error class.
- Scope is the dashboard wizard only (`/broadcasts/new` and its support files). The public v1 API (`src/lib/whatsapp/broadcast-core.ts`, `src/app/api/v1/broadcasts/route.ts`) is untouched by this plan.
- `message_media_type` values are exactly `'image'|'video'|'document'|'audio'` — the same four values as `OutboundMediaKind` in `src/lib/channels/types.ts`, so no translation is needed when building a `SendMediaArgs`.
- Variable syntax for freeform is **named** (`{{name}}`, `{{phone}}`, `{{custom:field_id}}`), not positional (`{{1}}`) — templates keep positional syntax unchanged.
- `messages/pt-BR.json` does not exist on this branch (confirmed independently in Phase 2, Tasks 9 and 10) — new translation keys go only in `messages/en.json`.
- Next.js 16 has breaking changes vs. training data — before editing `src/app/api/whatsapp/broadcast/route.ts` (Task 6), read the route-handlers section of `node_modules/next/dist/docs/`.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Migration + shared `BroadcastComposeContent` type

**Files:**
- Create: `supabase/migrations/039_broadcast_freeform.sql`
- Modify: `src/types/index.ts` (add `BroadcastComposeContent`)

**Interfaces:**
- Produces: `broadcasts` columns `kind`, `provider`, `message_text`, `message_media_url`, `message_media_type`; `BroadcastComposeContent` type — consumed by Tasks 2-6.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- broadcasts: freeform (non-template) content for Evolution
-- accounts, plus a provider snapshot.
--
-- template_name/template_language were NOT NULL (migration 001) —
-- relaxed here since a freeform broadcast has neither. `kind` drives
-- which set of columns is populated; the CHECK enforces the pairing
-- so a row can't end up with neither template nor freeform content.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcasts
  ALTER COLUMN template_name DROP NOT NULL,
  ALTER COLUMN template_language DROP NOT NULL;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'template'
    CHECK (kind IN ('template', 'freeform')),
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'evolution')),
  ADD COLUMN IF NOT EXISTS message_text TEXT,
  ADD COLUMN IF NOT EXISTS message_media_url TEXT,
  ADD COLUMN IF NOT EXISTS message_media_type TEXT
    CHECK (message_media_type IS NULL OR message_media_type IN ('image', 'video', 'document', 'audio'));

ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_kind_content_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_kind_content_check CHECK (
    (kind = 'template' AND template_name IS NOT NULL)
    OR (kind = 'freeform' AND (message_text IS NOT NULL OR message_media_url IS NOT NULL))
  );
```

- [ ] **Step 2: Run the migration locally (if a local Supabase is configured) or confirm syntax**

Run: `cat supabase/migrations/039_broadcast_freeform.sql` and visually confirm it matches migration 038's style. If a local Supabase instance is running (`supabase status`), apply it: `supabase db push`. If no local instance is available, skip execution and note this in the report — same fallback Phase 2's Task 1 used.

- [ ] **Step 3: Add `BroadcastComposeContent` to `src/types/index.ts`**

Add this type near the existing `MessageTemplate` interface (do not touch `MessageTemplate` itself or any other part of the file):

```ts
export type BroadcastMediaType = 'image' | 'video' | 'document' | 'audio';

/** What Step 1 of the broadcast wizard produced, passed through Steps
 *  3-4 and the send route. `kind` drives which fields are read —
 *  mirrors the `broadcasts.kind` column (migration 039). */
export type BroadcastComposeContent =
  | { kind: 'template'; template: MessageTemplate }
  | {
      kind: 'freeform';
      text: string;
      mediaUrl: string;
      mediaType: BroadcastMediaType | null;
    };
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (nothing references the new type/columns yet).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/039_broadcast_freeform.sql src/types/index.ts
git commit -m "feat(broadcasts): schema + type foundation for freeform broadcasts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `Step1ComposeMessage` + wizard provider branch

**Files:**
- Create: `src/components/broadcasts/step1-compose-message.tsx`
- Modify: `src/app/(dashboard)/broadcasts/new/page.tsx`
- Modify: `messages/en.json` (add `Broadcasts.wizard.composeMessage.*`)

**Interfaces:**
- Consumes: `BroadcastMediaType` (Task 1).
- Produces: `Step1ComposeMessage` component; `NewBroadcastPage`'s new state (`messageText`, `messageMediaUrl`, `messageMediaType`, `provider`) and a `content: BroadcastComposeContent` value — consumed by Tasks 3-5.

- [ ] **Step 1: Add translation keys**

In `messages/en.json`, inside `Broadcasts.wizard` (find via `grep -n '"wizard": {' messages/en.json`), add a sibling `composeMessage` key next to `chooseTemplate`:

```json
"composeMessage": {
  "title": "Compose Message",
  "subtitle": "Write a free-form message — no template needed on Evolution.",
  "textLabel": "Message",
  "textPlaceholder": "Hi {{name}}, ...",
  "textHint": "Use {{name}}, {{phone}}, {{email}}, {{company}}, or {{custom:field}} — you'll map each one to a real value on the next step.",
  "mediaLabel": "Attach media (optional)",
  "mediaTypeLabel": "Media type",
  "mediaUrlPlaceholder": "https://...",
  "errorEmpty": "Write a message or attach media before continuing."
}
```

- [ ] **Step 2: Implement `step1-compose-message.tsx`**

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { BroadcastMediaType } from '@/types';

interface Step1ComposeProps {
  text: string;
  onTextChange: (text: string) => void;
  mediaUrl: string;
  onMediaUrlChange: (url: string) => void;
  mediaType: BroadcastMediaType | null;
  onMediaTypeChange: (type: BroadcastMediaType | null) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_TYPES: BroadcastMediaType[] = ['image', 'video', 'document', 'audio'];

export function Step1ComposeMessage({
  text,
  onTextChange,
  mediaUrl,
  onMediaUrlChange,
  mediaType,
  onMediaTypeChange,
  onNext,
  onBack,
}: Step1ComposeProps) {
  const t = useTranslations('Broadcasts.wizard');
  const canProceed = text.trim().length > 0 || mediaUrl.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('composeMessage.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('composeMessage.subtitle')}</p>
      </div>

      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <label className="block text-sm font-medium text-foreground">
          {t('composeMessage.textLabel')}
        </label>
        <Textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t('composeMessage.textPlaceholder')}
          rows={5}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
        <p className="text-xs text-muted-foreground">{t('composeMessage.textHint')}</p>
      </div>

      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <label className="block text-sm font-medium text-foreground">
          {t('composeMessage.mediaLabel')}
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
          <Select
            value={mediaType ?? undefined}
            onValueChange={(val) => onMediaTypeChange((val || null) as BroadcastMediaType | null)}
          >
            <SelectTrigger className="w-full border-border bg-muted text-foreground">
              <SelectValue placeholder={t('composeMessage.mediaTypeLabel')} />
            </SelectTrigger>
            <SelectContent className="border-border bg-popover">
              {MEDIA_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="url"
            value={mediaUrl}
            onChange={(e) => {
              const url = e.target.value;
              onMediaUrlChange(url);
              if (url.trim() && !mediaType) onMediaTypeChange('image');
              if (!url.trim()) onMediaTypeChange(null);
            }}
            placeholder={t('composeMessage.mediaUrlPlaceholder')}
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {!canProceed && (
        <p className="text-xs text-amber-300">{t('composeMessage.errorEmpty')}</p>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!canProceed}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
```

Note for the implementer: confirm `@/components/ui/textarea` exists (`ls src/components/ui/textarea.tsx`). If it doesn't, check how `Input` (`src/components/ui/input.tsx`) is structured and add a `Textarea` primitive following the same shadcn/ui vendoring pattern — same fallback approach Phase 2's Task 10 used for the `Tabs` primitive. Report which path you took.

- [ ] **Step 3: Wire provider detection + new state into `NewBroadcastPage`**

Modify `src/app/(dashboard)/broadcasts/new/page.tsx`. Add these imports:

```tsx
import { Step1ComposeMessage } from '@/components/broadcasts/step1-compose-message';
import type { BroadcastComposeContent, BroadcastMediaType } from '@/types';
```

Add this state (alongside the existing `template`/`audience`/`variables` state):

```tsx
  const [provider, setProvider] = useState<'meta' | 'evolution'>('meta');
  const [providerLoaded, setProviderLoaded] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [messageMediaUrl, setMessageMediaUrl] = useState('');
  const [messageMediaType, setMessageMediaType] = useState<BroadcastMediaType | null>(null);
```

Add this effect (alongside existing hooks, after the `accountId` destructure):

```tsx
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    supabase
      .from('whatsapp_config')
      .select('provider')
      .eq('account_id', accountId)
      .maybeSingle()
      .then(({ data }) => {
        setProvider((data?.provider as 'meta' | 'evolution') ?? 'meta');
        setProviderLoaded(true);
      });
  }, [accountId]);
```

Add `useEffect` to the imports from `'react'` at the top of the file if not already present (`import { useState, useEffect } from 'react';`).

Build the `content: BroadcastComposeContent | null` value right before the JSX `return`:

```tsx
  const content: BroadcastComposeContent | null =
    provider === 'evolution'
      ? { kind: 'freeform', text: messageText, mediaUrl: messageMediaUrl, mediaType: messageMediaType }
      : template
        ? { kind: 'template', template }
        : null;
```

Replace the `currentStep === 0` block with a provider branch:

```tsx
          {currentStep === 0 && providerLoaded && provider === 'meta' && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 0 && providerLoaded && provider === 'evolution' && (
            <Step1ComposeMessage
              text={messageText}
              onTextChange={setMessageText}
              mediaUrl={messageMediaUrl}
              onMediaUrlChange={setMessageMediaUrl}
              mediaType={messageMediaType}
              onMediaTypeChange={setMessageMediaType}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
```

(Steps 2-3's JSX changes are covered in Tasks 3-4 — do not modify the `currentStep === 2`/`currentStep === 3` blocks in this task.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — Steps 3/4 of the wizard (`Step3Personalize`/`Step4ScheduleSend`) still expect a `template` prop, and `content` isn't wired into them yet (Tasks 3-4). This is expected; confirm the *only* errors are in the `currentStep === 2`/`currentStep === 3` JSX blocks referencing `template`, not anywhere in `step1-compose-message.tsx` or the new state/effect you just added.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcasts/step1-compose-message.tsx src/app/\(dashboard\)/broadcasts/new/page.tsx messages/en.json
git commit -m "feat(broadcasts): Step1ComposeMessage + provider-aware wizard branch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `Step3Personalize` — named-variable branch for freeform

**Files:**
- Modify: `src/components/broadcasts/step3-personalize.tsx`
- Modify: `src/app/(dashboard)/broadcasts/new/page.tsx` (wire `content` into Step 3)
- Modify: `messages/en.json` (add 2 keys for the freeform-empty-state message)

**Interfaces:**
- Consumes: `BroadcastComposeContent` (Task 1).
- Produces: `Step3Personalize` now takes `content: BroadcastComposeContent` instead of `template: MessageTemplate` — consumed by Task 4/page.tsx wiring (this task) and unaffected by Task 6 (the send route reads `variables`/`content` from `page.tsx` state, not from this component directly).

This is a **behavior-preserving branch**, not a rewrite of the template path — every line of `step3-personalize.tsx`'s existing template-handling logic (media header block, positional-placeholder extraction, preview rendering, unmapped-key gating) stays exactly as it is today, just reached via `content.kind === 'template'` instead of unconditionally. Read the current file in full before editing (already reproduced in the design/plan context below) so the diff is additive, not a restructure.

- [ ] **Step 1: Add translation keys**

In `messages/en.json`, inside `Broadcasts.wizard.personalize` (find via `grep -n '"personalize": {' messages/en.json`), add two sibling keys:

```json
"noVariablesFreeform": "No variables to map — this message has no {{...}} placeholders.",
"previewFreeform": "Preview"
```

- [ ] **Step 2: Modify `step3-personalize.tsx`**

Change the props interface:

```tsx
interface Step3Props {
  content: BroadcastComposeContent;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  /** Media URL for a Meta template's IMAGE/VIDEO/DOCUMENT header. Not
   *  read/shown for freeform content — Step 1 already captured any
   *  freeform media. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}
```

Add the import (alongside the existing `Contact, CustomField, MessageTemplate` import from `@/types`):

```tsx
import type { BroadcastComposeContent } from '@/types';
```

Change the function signature's destructured props to `content` instead of `template`:

```tsx
export function Step3Personalize({
  content,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
```

Replace the `placeholders` memo (currently reads `template.body_text` with a positional regex) with a branch that reads the right source text and the right regex per `content.kind`:

```tsx
  const bodyText = content.kind === 'template' ? content.template.body_text : content.text;

  const placeholders = useMemo(() => {
    const pattern = content.kind === 'template' ? /\{\{(\d+)\}\}/g : /\{\{([a-zA-Z_][\w:]*)\}\}/g;
    const matches = bodyText.match(pattern);
    if (!matches) return [];
    return [...new Set(matches)].sort();
  }, [bodyText, content.kind]);
```

Replace every remaining `template.body_text` reference in the file with `bodyText` (there is one more, inside `previewText`'s `let text = template.body_text;` line — change it to `let text = bodyText;`).

Replace every remaining `template.header_type`/`template.header_media_url` reference (the `mediaHeaderType` memo and the seed-effect) with a guard that only runs for template content:

```tsx
  const mediaHeaderType =
    content.kind === 'template' && isMediaHeaderType(content.template.header_type)
      ? content.template.header_type
      : null;

  useEffect(() => {
    if (content.kind === 'template' && mediaHeaderType && !headerMediaUrl && content.template.header_media_url) {
      onHeaderMediaUrlChange(content.template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, mediaHeaderType]);
```

Add named-variable defaulting to `updateVariable`'s companion — when a placeholder key is first encountered for freeform content, seed a sensible default (known contact field → `field`; `custom:X` → `custom_field`; anything else → empty `static`) instead of always defaulting to empty `static`. Change the `mapping` lookup inside the placeholder-rendering `.map()` block (the one building the Type/Value selector rows) from:

```tsx
            const mapping = variables[key] ?? { type: 'static', value: '' };
```

to:

```tsx
            const mapping = variables[key] ?? defaultMappingFor(key);
```

Add this helper function above the component (module scope, not inside it):

```tsx
const KNOWN_CONTACT_FIELDS = new Set(['name', 'phone', 'email', 'company']);

function defaultMappingFor(key: string): { type: 'static' | 'field' | 'custom_field'; value: string } {
  if (KNOWN_CONTACT_FIELDS.has(key)) return { type: 'field', value: key };
  if (key.startsWith('custom:')) return { type: 'custom_field', value: key.slice('custom:'.length) };
  return { type: 'static', value: '' };
}
```

The other two spots that look up a placeholder's mapping also need `defaultMappingFor` instead of treating an absent mapping as always-empty. Note: this only changes the *default* shown/used — the gates below still require `mapping.value?.trim()` to be non-empty, so a `custom:` key whose target custom field doesn't exist, or an unrecognized key defaulting to empty `static`, still blocks Next exactly as before; only recognized contact-field names (`name`/`phone`/`email`/`company`) get pre-filled with a non-empty value and can proceed without the user touching that row.

Replace the `unmappedKeys` memo:

```tsx
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key] ?? defaultMappingFor(key);
      if (!mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);
```

Replace the `previewText` memo's body (the `let text = bodyText; for (const placeholder of placeholders) { ... }` loop) — the `if (mapping)` wrapper is removed since `mapping` is now always defined:

```tsx
  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = bodyText;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key] ?? defaultMappingFor(key);
      let replacement = placeholder;

      if (mapping.type === 'static' && mapping.value) {
        replacement = mapping.value;
      } else if (mapping.type === 'field' && mapping.value) {
        const fieldMap: Record<string, string | undefined> = {
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          company: contact.company,
        };
        replacement = fieldMap[mapping.value] ?? placeholder;
      } else if (mapping.type === 'custom_field' && mapping.value) {
        replacement = customValues.get(mapping.value) || placeholder;
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    bodyText,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);
```

Wrap the existing media-header JSX block (the one starting `{mediaHeaderType && (`) — no change needed here, since `mediaHeaderType` is already `null` for freeform content per the change above, so the block naturally doesn't render.

Change the "no placeholders" empty-state condition (currently `placeholders.length === 0 && !mediaHeaderType`) to branch its copy by content kind:

```tsx
      {placeholders.length === 0 && !mediaHeaderType ? (
        <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {content.kind === 'freeform' ? t('personalize.noVariablesFreeform') : t('personalize.noPreview')}
          </p>
        </div>
      ) : placeholders.length === 0 ? null : (
```

Everything else in the file (the JSX for the Type/Value selector grid, the live-preview bubble, the unmapped-keys warning banner, the Back/Next footer) stays exactly as-is — those all already operate on `placeholders`/`variables`/`previewText`, which are now content-agnostic after the changes above.

- [ ] **Step 3: Wire `content` into Step 3 in `page.tsx`**

Replace the `currentStep === 2` block:

```tsx
          {currentStep === 2 && content && (
            <Step3Personalize
              content={content}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS for `step3-personalize.tsx` and the `currentStep === 2` block. The `currentStep === 3` block (Step 4) still references the old `template` prop on `Step4ScheduleSend` — that's Task 4, not yet done; confirm remaining errors are scoped there only.

- [ ] **Step 5: Manual verification**

Since this changes real, working UI logic (not just adding a new branch), run the dev server and click through the existing Meta template flow end-to-end (Step 1 → choose a template → Step 2 → Step 3, confirm the placeholder mapping UI and live preview still render and behave identically to before your change) — this is the regression check. If no Meta template exists to test with in this environment, note that limitation explicitly in the report and rely on the diff review instead (Task 3's reviewer will independently verify the template path is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/components/broadcasts/step3-personalize.tsx src/app/\(dashboard\)/broadcasts/new/page.tsx messages/en.json
git commit -m "feat(broadcasts): Step3Personalize named-variable branch for freeform content

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `Step4ScheduleSend` — preview branch + `page.tsx` send wiring

**Files:**
- Modify: `src/components/broadcasts/step4-schedule-send.tsx`
- Modify: `src/app/(dashboard)/broadcasts/new/page.tsx`
- Modify: `messages/en.json` (add 2 keys)

**Interfaces:**
- Consumes: `BroadcastComposeContent` (Task 1).
- Produces: `Step4ScheduleSend` now takes `content: BroadcastComposeContent` instead of `template: MessageTemplate`; `page.tsx`'s `handleSend`/`handleSaveDraft` now branch on `content.kind` — consumed by Task 5 (the sending hook itself).

- [ ] **Step 1: Add translation keys**

In `messages/en.json`, inside `Broadcasts.wizard.scheduleSend` (find via `grep -n '"scheduleSend": {' messages/en.json`), add:

```json
"messagePreview": "Message",
"confirmFreeform": "You are about to send this broadcast to {count} contacts as a free-text message."
```

(`{count}` is a next-intl interpolation placeholder, consistent with other keys like `Broadcasts.detail.recipientsHeader`'s `{filtered}`/`{total}` usage — read that key for the exact interpolation call-site convention if unsure.)

- [ ] **Step 2: Modify `step4-schedule-send.tsx`**

Change the props interface and import:

```tsx
import type { BroadcastComposeContent } from '@/types';

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  content: BroadcastComposeContent;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}
```

Change the function signature to destructure `content` instead of `template`:

```tsx
export function Step4ScheduleSend({
  name,
  onNameChange,
  content,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
```

Replace the Summary Card's "Template"/"Language" grid cells:

```tsx
          <div>
            <p className="text-xs text-muted-foreground">
              {content.kind === 'template' ? t('scheduleSend.template') : t('scheduleSend.messagePreview')}
            </p>
            <p className="text-foreground line-clamp-2">
              {content.kind === 'template' ? content.template.name : content.text || '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          {content.kind === 'template' && (
            <div>
              <p className="text-xs text-muted-foreground">Language</p>
              <p className="text-foreground">{content.template.language ?? 'en_US'}</p>
            </div>
          )}
```

Replace the confirmation dialog's description:

```tsx
              <DialogDescription className="text-muted-foreground">
                {content.kind === 'template' ? (
                  <>
                    You are about to send this broadcast to{' '}
                    <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                    contacts using the{' '}
                    <span className="font-medium text-popover-foreground">{content.template.name}</span> template.
                    This action cannot be undone.
                  </>
                ) : (
                  <>
                    {t('scheduleSend.confirmFreeform', { count: estimatedReach.toLocaleString() })} This action
                    cannot be undone.
                  </>
                )}
              </DialogDescription>
```

- [ ] **Step 3: Wire `content` into Step 4 and update `handleSend`/`handleSaveDraft` in `page.tsx`**

Replace the `currentStep === 3` block:

```tsx
          {currentStep === 3 && content && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              content={content}
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
```

Replace `handleSend`:

```tsx
  async function handleSend() {
    if (!content) return;

    try {
      const broadcastId = await createAndSendBroadcast({
        name,
        content,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
        headerMediaUrl,
      });
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }
```

Replace `handleSaveDraft`'s body (the `if (!template || ...)` guard and the `.insert({...})` call) — keep the function signature and everything before/after unchanged:

```tsx
  async function handleSaveDraft() {
    if (!content || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      kind: content.kind,
      provider,
      template_name: content.kind === 'template' ? content.template.name : null,
      template_language: content.kind === 'template' ? (content.template.language ?? 'en_US') : null,
      template_variables: variables,
      message_text: content.kind === 'freeform' ? content.text : null,
      message_media_url: content.kind === 'freeform' ? content.mediaUrl || null : null,
      message_media_type: content.kind === 'freeform' ? content.mediaType : null,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — `createAndSendBroadcast`'s payload type (`use-broadcast-sending.ts`) still expects `template: MessageTemplate`, not `content`. This is Task 5. Confirm the only remaining errors are inside `handleSend`'s call to `createAndSendBroadcast` and inside `use-broadcast-sending.ts` itself — nothing in `step4-schedule-send.tsx` or the rest of `page.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/components/broadcasts/step4-schedule-send.tsx src/app/\(dashboard\)/broadcasts/new/page.tsx messages/en.json
git commit -m "feat(broadcasts): Step4ScheduleSend preview branch + page.tsx send wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `use-broadcast-sending.ts` — freeform payload support

**Files:**
- Modify: `src/hooks/use-broadcast-sending.ts`

**Interfaces:**
- Consumes: `BroadcastComposeContent` (Task 1); `provider` (read from `page.tsx`'s state, passed in as part of the payload — see below).
- Produces: `createAndSendBroadcast` accepts `content: BroadcastComposeContent` instead of `template: MessageTemplate`; the request body it POSTs to `/api/whatsapp/broadcast` now includes `kind`, and, for freeform, `message_text`/`message_media_url`/`message_media_type` instead of `template_name`/`template_language` — consumed by Task 6 (the route reads this new shape).

This task only changes the parts of the hook that reference `payload.template` or build the request to `/api/whatsapp/broadcast` — the audience-resolution helpers (`resolveAudience`, `upsertCsvContacts`, `resolveCustomFieldAudience`, `fetchCustomValueIndex`) and `resolveVariables` are untouched (they're already content-agnostic, operating on `Contact`/`variables`, not on `template`).

- [ ] **Step 1: Update `BroadcastPayload` and the DB insert in `createAndSendBroadcast`**

Change the interface (near the top of the file):

```tsx
import type { BroadcastComposeContent } from '@/types';

interface BroadcastPayload {
  name: string;
  content: BroadcastComposeContent;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /** Media URL for a Meta template's IMAGE/VIDEO/DOCUMENT header.
   *  Ignored for freeform content — that media lives in `content`. */
  headerMediaUrl?: string;
}
```

In `createAndSendBroadcast`, replace the `broadcasts` insert (Step 2 of the function, currently keyed on `payload.template.name`/`payload.template.language`):

```tsx
      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      const { content } = payload;
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          kind: content.kind,
          template_name: content.kind === 'template' ? content.template.name : null,
          template_language: content.kind === 'template' ? (content.template.language ?? 'en_US') : null,
          template_variables: payload.variables,
          message_text: content.kind === 'freeform' ? content.text : null,
          message_media_url: content.kind === 'freeform' ? content.mediaUrl || null : null,
          message_media_type: content.kind === 'freeform' ? content.mediaType : null,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();
```

Note: `broadcasts.provider` (migration 039) is `NOT NULL DEFAULT 'meta'` — this insert deliberately does not set it explicitly, relying on the default for `kind='template'` rows (always Meta, per the guard in Task 6) to stay correct with zero change here. For `kind='freeform'` rows this default would be wrong (they're always Evolution, per the same guard) — Task 6's route-side insert-adjacent logic doesn't touch this row (it's already inserted by the time the route runs), so **add `provider: content.kind === 'freeform' ? 'evolution' : 'meta'` to the insert object above** rather than relying on the column default for both cases.

- [ ] **Step 2: Update the media-header logic and the per-batch send request**

Replace the media-header block (currently reads `payload.template.header_type`/`payload.headerMediaUrl`) — this block only applies to `kind==='template'`:

```tsx
      // Media-header templates (image/video/document) require a media
      // URL on every send; freeform media (if any) is already resolved
      // in `content` and doesn't need this per-send lookup.
      const headerType = content.kind === 'template' ? content.template.header_type : undefined;
      const isMediaHeader =
        headerType === 'image' || headerType === 'video' || headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        content.kind === 'template' && isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;
```

Replace the per-batch `fetch('/api/whatsapp/broadcast', ...)` body (currently `{ recipients: apiRecipients, template_name, template_language }`):

```tsx
        try {
          const requestBody =
            content.kind === 'template'
              ? {
                  kind: 'template' as const,
                  recipients: apiRecipients,
                  template_name: content.template.name,
                  template_language: content.template.language ?? 'en_US',
                }
              : {
                  kind: 'freeform' as const,
                  recipients: apiRecipients,
                  message_text: content.text,
                  message_media_url: content.mediaUrl || undefined,
                  message_media_type: content.mediaType ?? undefined,
                };

          const res = await fetch('/api/whatsapp/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          });
```

Everything after this (`const data = await res.json(); ... for (const recipient of batch) { ... }`) stays unchanged — it reads `data.results`/`result.status`/`result.whatsapp_message_id` regardless of which branch built the request, and Task 6's route response shape stays identical for both kinds (see Task 6).

**Important — freeform recipients still need personalization applied to the text, not just a template.** For `kind==='freeform'`, each recipient needs its `{{name}}`-style placeholders substituted before sending — but do NOT do this by pairing two independently-sorted key lists positionally (a `resolveVariables(...)`-returned array zipped against a separately-`.sort()`-ed key list). `resolveVariables` sorts its keys with a numeric-aware comparator that falls back to `localeCompare` for non-numeric keys (see its existing implementation, a few dozen lines above in this same file); a plain `Object.keys(...).sort()` elsewhere uses default UTF-16 code-unit ordering, which can disagree with `localeCompare` on real inputs (e.g. mixed case, accented characters) — if the two orderings ever diverge, a recipient would silently get the WRONG value substituted into a placeholder (`{{name}}` receiving `{{phone}}`'s value). Resolve **by key directly** instead, with no positional coupling at all.

First, extract the per-key resolution logic already inside `resolveVariables` into a standalone helper, and have `resolveVariables` call it — a pure refactor, zero behavior change to the existing (tested, template-path) function. Find `resolveVariables`'s current body (it has a single `keys.map((key) => { ... })` callback containing the `static`/`field`/`custom_field` branches) and replace the whole function with:

```tsx
function resolveSingleVariable(
  mapping: VariableMapping,
  contact: Contact,
  customValues?: Map<string, string>,
): string {
  if (mapping.type === 'static') return mapping.value;

  if (mapping.type === 'field') {
    const fieldMap: Record<string, string | undefined> = {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      company: contact.company,
    };
    return fieldMap[mapping.value] ?? '';
  }

  // custom_field
  return customValues?.get(mapping.value) ?? '';
}

export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => resolveSingleVariable(variables[key], contact, customValues));
}
```

Then change the `apiRecipients` construction (a few lines above the per-batch fetch, inside the same `for (let i = 0; i < recipients.length; ...)` loop) to resolve freeform text by key directly, via `resolveSingleVariable`, never touching `resolveVariables`'s positional array for this branch:

```tsx
        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => {
            if (content.kind === 'freeform' && r.contact) {
              const customVals = customValueIndex.get(r.contact.id);
              let resolvedText = content.text;
              for (const [key, mapping] of Object.entries(payload.variables)) {
                resolvedText = resolvedText.replaceAll(
                  `{{${key}}}`,
                  resolveSingleVariable(mapping, r.contact, customVals),
                );
              }
              return { phone: r.contact.phone as string, resolvedText };
            }
            const resolvedValues = r.contact
              ? resolveVariables(payload.variables, r.contact, customValueIndex.get(r.contact.id))
              : [];
            return {
              phone: r.contact!.phone as string,
              params: resolvedValues,
              ...(messageParams ? { messageParams } : {}),
            };
          });
```

And update the freeform branch of `requestBody` above to send `resolvedText` per recipient instead of a single shared `message_text` — replace the freeform `requestBody` object with:

```tsx
              : {
                  kind: 'freeform' as const,
                  recipients: apiRecipients.map((r) => ({
                    phone: r.phone,
                    text: (r as { resolvedText: string }).resolvedText,
                  })),
                  message_media_url: content.mediaUrl || undefined,
                  message_media_type: content.mediaType ?? undefined,
                };
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: FAIL only in `src/app/api/whatsapp/broadcast/route.ts` (Task 6 not done yet — it still expects the old request shape). Confirm zero errors in `use-broadcast-sending.ts` or `page.tsx` at this point.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-broadcast-sending.ts
git commit -m "feat(broadcasts): freeform payload + per-recipient text resolution in the sending hook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `/api/whatsapp/broadcast/route.ts` — route through the seam

**Files:**
- Modify: `src/app/api/whatsapp/broadcast/route.ts`
- Create: `src/app/api/whatsapp/broadcast/route.test.ts`

**Interfaces:**
- Consumes: `getChannelForAccount` (`src/lib/channels/factory.ts`); `ChannelConfigError` (same file); the freeform request shape Task 5 now sends (`{ kind: 'freeform', recipients: [{phone, text}], message_media_url?, message_media_type? }`) and the unchanged template shape (`{ kind: 'template', recipients: [{phone, params}], template_name, template_language }`).
- Produces: `POST /api/whatsapp/broadcast` — same response shape as today (`{ success, total, sent, failed, results }`) for both kinds, so Task 5's response-handling code (already committed, unchanged by this task) keeps working without modification.

**Before editing this route handler:** read the route-handlers section of `node_modules/next/dist/docs/` (Global Constraint) if not already done earlier in this plan.

**Correction to the design doc's framing, established here as what actually governs implementation:** the design doc says the route's local phone-variant retry loop "is removed" by routing through the seam. That's only true for the **freeform** path — `EvolutionProvider.sender` has no retry loop at all (Evolution doesn't need one), so freeform genuinely needs zero local retry code. It is **not** true for the **template** path: templates were never part of `ChannelSender` (Phase 1's explicit, unchanged decision — `sendTemplateMessage` is called directly, the same as `send-message.ts` and `automations/meta-send.ts` already do for their own template branches), so there is no `MetaProvider`-wrapped retry to lean on for templates. The template branch below **keeps its own `phoneVariants`/`isRecipientNotAllowedError` retry loop exactly as it exists today** — nothing to remove there. Only the new freeform branch has no retry loop, and only because Evolution doesn't require one, not because something got deduplicated.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (t: string) => {
      if (t === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_id: 'acc-1' } }) }) }) };
      }
      throw new Error(`unexpected table in test: ${t}`);
    },
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { broadcast: {} },
}));

const mockSendText = vi.fn();
const mockSendMedia = vi.fn();
const mockSendTemplateMessage = vi.fn();
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage: mockSendTemplateMessage }));

let mockProviderId = 'evolution';
vi.mock('@/lib/channels/factory', () => ({
  getChannelForAccount: vi.fn(async () => ({
    id: mockProviderId,
    sender: { sendText: mockSendText, sendMedia: mockSendMedia },
  })),
  ChannelConfigError: class ChannelConfigError extends Error {},
}));

import { POST } from './route';

function req(body: unknown) {
  return new Request('http://localhost/api/whatsapp/broadcast', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockProviderId = 'evolution';
  mockSendText.mockReset().mockResolvedValue({ providerMessageId: 'EVO-1' });
  mockSendMedia.mockReset().mockResolvedValue({ providerMessageId: 'EVO-2' });
  mockSendTemplateMessage.mockReset().mockResolvedValue({ messageId: 'WA-1' });
});

describe('POST /api/whatsapp/broadcast — freeform', () => {
  it('sends text via provider.sender.sendText for an evolution account', async () => {
    const res = await POST(req({
      kind: 'freeform',
      recipients: [{ phone: '+15551234567', text: 'oi joao' }],
      message_media_url: undefined,
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sent).toBe(1);
    expect(mockSendText).toHaveBeenCalledWith(expect.objectContaining({ to: '+15551234567', text: 'oi joao' }));
  });

  it('sends media via provider.sender.sendMedia when message_media_url is present', async () => {
    const res = await POST(req({
      kind: 'freeform',
      recipients: [{ phone: '+15551234567', text: 'legenda' }],
      message_media_url: 'https://x/a.jpg',
      message_media_type: 'image',
    }));
    expect(res.status).toBe(200);
    expect(mockSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+15551234567', kind: 'image', link: 'https://x/a.jpg', caption: 'legenda' }),
    );
  });

  it('rejects freeform for a meta account', async () => {
    mockProviderId = 'meta';
    const res = await POST(req({
      kind: 'freeform',
      recipients: [{ phone: '+15551234567', text: 'oi' }],
    }));
    expect(res.status).toBe(400);
    expect(mockSendText).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/broadcast — template', () => {
  it('sends via sendTemplateMessage for a meta account (unchanged path)', async () => {
    mockProviderId = 'meta';
    const res = await POST(req({
      kind: 'template',
      recipients: [{ phone: '+15551234567', params: ['x'] }],
      template_name: 'hello_world',
      template_language: 'en_US',
    }));
    expect(res.status).toBe(200);
    expect(mockSendTemplateMessage).toHaveBeenCalled();
  });

  it('rejects template for an evolution account', async () => {
    const res = await POST(req({
      kind: 'template',
      recipients: [{ phone: '+15551234567', params: [] }],
      template_name: 'hello_world',
    }));
    expect(res.status).toBe(400);
    expect(mockSendTemplateMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/broadcast/route.test.ts`
Expected: FAIL — `route.ts` doesn't read `kind` yet.

- [ ] **Step 3: Implement the route**

Read the current `src/app/api/whatsapp/broadcast/route.ts` in full first (already reproduced earlier in this plan's design work — it's ~260 lines). Make these changes, keeping the auth/rate-limit/profile-resolution prologue (everything up through resolving `accountId`) exactly as-is:

Add imports:

```ts
import { getChannelForAccount, ChannelConfigError } from '@/lib/channels/factory'
```

Keep the existing `phoneVariants`, `isRecipientNotAllowedError` imports from `@/lib/whatsapp/phone-utils` — the template branch below still uses them, unchanged. Do not remove any existing import.

Right after the existing `const body = await request.json()` line, insert the `kind` detection and both provider guards — do not touch or remove anything below this insertion yet (the existing `const { recipients: newRecipients, phone_numbers, template_name, template_language, template_params } = body` destructure and everything after it stays exactly where it is, for now):

```ts
    const kind: 'template' | 'freeform' = body.kind === 'freeform' ? 'freeform' : 'template'

    let provider
    try {
      provider = await getChannelForAccount(accountId, supabase)
    } catch (err) {
      if (err instanceof ChannelConfigError) {
        return NextResponse.json(
          { error: 'WhatsApp not configured. Please set up your WhatsApp integration first.' },
          { status: 400 },
        )
      }
      throw err
    }

    if (kind === 'template' && provider.id !== 'meta') {
      return NextResponse.json(
        { error: `Templates require the Meta provider (account is configured for "${provider.id}")` },
        { status: 400 },
      )
    }
    if (kind === 'freeform' && provider.id !== 'evolution') {
      return NextResponse.json(
        {
          error:
            'Free-form broadcast messages require the Evolution provider — Meta requires an approved template for business-initiated messages outside an active conversation.',
        },
        { status: 400 },
      )
    }

    if (kind === 'freeform') {
      return handleFreeformBroadcast(body, provider)
    }
```

That last `if` block is the only structural change to the existing template flow: everything from `const { recipients: newRecipients, ... } = body` through the function's final `return NextResponse.json({ success: true, total, sent, failed, results })` stays **completely unchanged, in place, not wrapped in anything** — it simply never runs for a freeform request, because the `if (kind === 'freeform') return handleFreeformBroadcast(...)` above it already returned. This is the least invasive way to add the branch without touching a single line of the working template path (including its `phoneVariants` retry loop, which is untouched).

Add the new `handleFreeformBroadcast` function — place it after the `POST` function, at module scope:

```ts
async function handleFreeformBroadcast(
  body: { recipients?: unknown; message_media_url?: string; message_media_type?: string },
  provider: Awaited<ReturnType<typeof getChannelForAccount>>,
): Promise<Response> {
    interface FreeformRecipient { phone: string; text: string }
    const recipients: FreeformRecipient[] = Array.isArray(body.recipients) ? (body.recipients as FreeformRecipient[]) : []
    if (recipients.length === 0) {
      return NextResponse.json({ error: 'recipients must be a non-empty array of { phone, text }' }, { status: 400 })
    }

    const mediaUrl: string | undefined = body.message_media_url || undefined
    const mediaType: 'image' | 'video' | 'document' | 'audio' | undefined = body.message_media_type || undefined

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)
      if (!isValidE164(sanitized)) {
        results.push({ phone: recipient.phone, status: 'failed', error: 'Invalid phone number format' })
        failedCount++
        continue
      }

      try {
        const result = mediaUrl
          ? await provider.sender.sendMedia({
              to: sanitized,
              kind: mediaType ?? 'image',
              link: mediaUrl,
              caption: recipient.text || undefined,
            })
          : await provider.sender.sendText({ to: sanitized, text: recipient.text })

        results.push({ phone: recipient.phone, status: 'sent', whatsapp_message_id: result.providerMessageId })
        sentCount++
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error(`Failed to send freeform broadcast to ${recipient.phone}:`, errorMessage)
        results.push({ phone: recipient.phone, status: 'failed', error: errorMessage })
        failedCount++
      }
    }

    return NextResponse.json({ success: true, total: recipients.length, sent: sentCount, failed: failedCount, results })
}
```

`handleFreeformBroadcast` is a standalone `async function` (not a route export) — it exists purely so the freeform branch reads as a self-contained unit instead of a long inline block sitting awkwardly above the untouched template code. It receives `provider` (already resolved once by `POST`, not re-resolved) and the parsed `body`.

Note: the template path's existing config/template-row fetch (further down in `POST`, still untouched) uses `supabase.from('whatsapp_config')...` directly rather than `getChannelForAccount`'s return value — leave that as-is; it's the same config row `getChannelForAccount` already validated exists (via the `ChannelConfigError` check earlier in `POST`), just fetched a second time for Meta-specific fields (`phone_number_id`/`access_token`) that `getChannelForAccount`'s return value doesn't expose. This mirrors the same double-fetch tradeoff already accepted in `send-message.ts`/`automations/meta-send.ts` during Phase 1 — not a new pattern introduced here.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/broadcast/route.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite + typecheck (final gate for this plan)**

Run: `npm test`
Expected: green except the 5 pre-existing currency/date failures.

Run: `npm run typecheck`
Expected: PASS — this should now also resolve the Task 4/5 typecheck gaps that were expected-FAIL at the time, since `use-broadcast-sending.ts`'s request shape now matches what this route reads.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/broadcast/route.ts src/app/api/whatsapp/broadcast/route.test.ts
git commit -m "refactor(broadcasts): route /api/whatsapp/broadcast through the ChannelProvider seam

Templates stay Meta-only (unchanged sendTemplateMessage path, its own
phone-variant retry loop untouched -- templates were never part of
ChannelSender). Freeform is new and Evolution-only, via
provider.sender.sendText/sendMedia -- no local retry loop needed there,
since EvolutionProvider.sender doesn't require one. Both directions
guarded so the wrong content kind can't reach the wrong provider.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (plan against the design doc)

- **Spec coverage:** §1 Modelo de dados ✓ (Task 1); §2 Step 1 ramificado ✓ (Task 2); §3 Step 3 sintaxe nomeada ✓ (Task 3); §4 Step 4 preview ramificado ✓ (Task 4); §5 Backend ramificado + guards ✓ (Task 6, with the design doc's "retry loop removed" claim corrected to apply only to the freeform path — see Task 6's framing note and the design doc's own correction, both fixed during this plan's self-review); §6 Testes ✓ (Task 6's fixture-based tests cover both kinds + both guards). Fora de escopo (API pública v1, agendamento, `react/route.ts`) — none touched by any task.
- **Self-review catch (fixed during this pass, not deferred to a task reviewer):** an earlier draft of Task 5's freeform variable substitution paired two independently-sorted key lists positionally (`resolveVariables`'s internal sort vs. a separate `Object.keys().sort()`), which could silently substitute the wrong value into the wrong placeholder if the two orderings ever disagreed. Fixed by resolving each named placeholder by key directly (`resolveSingleVariable`, extracted from `resolveVariables`'s existing body as a pure refactor) instead of relying on positional alignment. A related draft of Task 6 told the implementer to both remove the `phoneVariants` retry-loop imports and keep the template branch "completely unchanged" — directly contradictory, and would have broken the template send path if followed literally; fixed by keeping those imports and restructuring the freeform branch as an early-return before the untouched template code, rather than wrapping the template code in a new block.
- **Placeholders:** none of the "TBD/implement later" kind.
- **Type consistency:** `BroadcastComposeContent` (Task 1) is produced by `page.tsx`'s new `content` value (Task 2), consumed by `Step3Personalize` (Task 3), `Step4ScheduleSend` (Task 4), and `use-broadcast-sending.ts`'s `BroadcastPayload` (Task 5) — same shape, same field names (`kind`/`template`/`text`/`mediaUrl`/`mediaType`) throughout. `BroadcastMediaType` (Task 1) matches `OutboundMediaKind` (`src/lib/channels/types.ts`, prior phase) value-for-value, confirmed in Global Constraints. The route's freeform request shape introduced in Task 5 (`{ phone, text }` per recipient, `message_media_url`/`message_media_type` shared) matches exactly what Task 6's route reads.

## Roadmap (out of scope, deferred)

- Freeform broadcast support on the public v1 API (`broadcast-core.ts`) — explicit design decision, not an oversight.
- Activating `scheduled_at` for freeform broadcasts (or at all — no worker consuming it was found during design).
- Routing `src/app/api/whatsapp/react/route.ts` (reactions) through the seam — unrelated backlog item from Phase 1/2's reviews.
