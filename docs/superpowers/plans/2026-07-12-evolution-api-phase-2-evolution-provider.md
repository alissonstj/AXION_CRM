# Evolution API Phase 2 — EvolutionProvider + QR Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `EvolutionProvider` (second `ChannelProvider` implementation, alongside `MetaProvider`) and the Settings UI to connect a WhatsApp number via Evolution API QR code, so an account can choose `provider='evolution'` and have inbound/outbound messages flow through the same `ingestInbound`/`getChannelForAccount` seam Phase 1 built for Meta.

**Architecture:** Mirrors Phase 1's `MetaProvider` structure exactly — a pure HTTP client (`evolution-api.ts`), a `ChannelProvider` implementation (`EvolutionProvider`) wrapping it, wired into the existing `getChannelForAccount` factory. New pieces Meta didn't need: a webhook-fed connection-state cache (QR code, status, last error) on `whatsapp_config`, three new API routes (`connect`/`state`/`webhook`), and a 3-way split of the Settings UI (`channel-settings` container + `meta-config` + `evolution-connect`).

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres + Storage), Vitest, next-intl.

## Global Constraints

- Behavior-preserving for Meta: nothing in this plan touches `MetaProvider`, `meta-api.ts`, or any Meta send/receive path. `whatsapp-config.tsx`'s Meta logic is **moved**, not rewritten (Task 10).
- `evolution_instance_token`, like `access_token`, is encrypted at rest via `encrypt()`/`decrypt()` from `src/lib/whatsapp/encryption.ts` — never store it in plaintext.
- `ChannelSender.sendText/sendMedia/sendInteractiveButtons/sendInteractiveList`'s `to` parameter arrives already sanitized by the caller (established contract from Phase 1 Task 2/7) — `EvolutionProvider.sender` must not attempt to re-sanitize.
- `EvolutionProvider.getConnectionState()` **never calls the Evolution server** — it only reads the cache columns on `whatsapp_config`, kept fresh by the webhook route (Task 7). Only `connect()` (and the admin lifecycle calls inside it) talk to Evolution live.
- Next.js 16 has breaking changes vs. training data — before editing any `route.ts` file (Tasks 7, 8), read the route-handlers section of `node_modules/next/dist/docs/` in this repo.
- Real payloads referenced throughout this plan were captured from a live local Evolution API v2 instance (`evoapicloud/evolution-api`, v2.3.7) — see `docs/superpowers/specs/2026-07-12-evolution-api-phase-2-design.md` and its `fixtures/evolution-messages-upsert-sample.json`. Where a field mapping below is marked "documented, not live-captured" (reactions, interactive replies), treat it as lower-confidence than the rest — a known, already-declared risk (see that design doc's "Riscos remanescentes"), not a plan gap.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Schema + shared type extensions

**Files:**
- Create: `supabase/migrations/038_evolution_connection_cache.sql`
- Modify: `src/lib/channels/types.ts` (add fields to `NormalizedInbound`)
- Modify: `src/types/index.ts` (extend `WhatsAppConfig`)

**Interfaces:**
- Produces: `NormalizedInbound.mediaBase64?: string | null`, `NormalizedInbound.mediaMimeType?: string | null`, `NormalizedInbound.mediaFileName?: string | null` — consumed by Task 7's webhook route (decode + upload before calling `ingestInbound`). Additive/optional; `MetaProvider.parseWebhook` never sets them, so Meta's `NormalizedInbound` objects are unaffected.
- Produces: `whatsapp_config` columns `evolution_instance_token`, `evolution_qr_code`, `evolution_qr_updated_at`, `evolution_last_error` — consumed by Tasks 5, 6, 7, 8, 9.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- whatsapp_config: Evolution connection cache.
--
-- Fase 1 (migration 037) already added provider, evolution_instance_name,
-- evolution_connection_state, evolution_connected_at. This adds what the
-- QR-connect flow needs: the per-instance auth token, the latest QR (fed
-- by the webhook, never fetched live by the UI), and a human-readable
-- last error so a failed connection doesn't just spin forever.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS evolution_qr_code TEXT,
  ADD COLUMN IF NOT EXISTS evolution_qr_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evolution_last_error TEXT;
```

- [ ] **Step 2: Run the migration locally (if a local Supabase is configured) or confirm syntax**

Run: `cat supabase/migrations/038_evolution_connection_cache.sql` and visually confirm it matches migration 037's style (idempotent `ADD COLUMN IF NOT EXISTS`, no destructive statements). If a local Supabase instance is running (`supabase status`), apply it: `supabase db push` (or the project's existing migration-apply command — check `package.json` scripts for one before assuming `supabase db push`). If no local instance is available, skip execution and note this in the report — the migration is additive-only and safe to defer to the next real deploy, matching how migration 037 was handled in Phase 1.

- [ ] **Step 3: Extend `NormalizedInbound` in `src/lib/channels/types.ts`**

Add these three fields to the existing `NormalizedInbound` interface (do not touch any other part of the file):

```ts
export interface NormalizedInbound {
  from: string;
  contactName?: string;
  providerMessageId: string;
  timestamp: Date;
  kind: InboundKind;
  text?: string | null;
  mediaUrl?: string | null;
  /** Raw base64 media bytes, only set by providers that embed media
   *  directly in the webhook (Evolution) rather than referencing it by
   *  id (Meta). The route handler decodes + uploads this to Storage
   *  and sets `mediaUrl` before calling `ingestInbound` — never read
   *  by `ingestInbound` itself. */
  mediaBase64?: string | null;
  mediaMimeType?: string | null;
  mediaFileName?: string | null;
  interactiveReplyId?: string | null;
  reaction?: { targetProviderMessageId: string; emoji: string } | null;
  replyToProviderMessageId?: string | null;
}
```

- [ ] **Step 4: Extend `WhatsAppConfig` in `src/types/index.ts`**

Add these fields to the existing `WhatsAppConfig` interface (do not touch any other part of the file):

```ts
export interface WhatsAppConfig {
  id: string;
  user_id: string;
  phone_number_id: string;
  waba_id?: string;
  access_token: string;
  verify_token?: string;
  status: 'connected' | 'disconnected';
  connected_at?: string;
  registered_at?: string;
  subscribed_apps_at?: string;
  last_registration_error?: string;
  /** 'meta' | 'evolution' — added migration 037. Absent on rows written
   *  before that migration ran, so treat undefined as 'meta'. */
  provider?: 'meta' | 'evolution';
  evolution_instance_name?: string;
  evolution_connection_state?: string;
  evolution_connected_at?: string;
  evolution_qr_code?: string;
  evolution_qr_updated_at?: string;
  evolution_last_error?: string;
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no code references the new fields yet, so nothing can be misusing them).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/038_evolution_connection_cache.sql src/lib/channels/types.ts src/types/index.ts
git commit -m "feat(channels): schema + type foundation for Evolution connection cache

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `evolution-api.ts` — pure HTTP client

**Files:**
- Create: `src/lib/whatsapp/evolution-api.ts`
- Test: `src/lib/whatsapp/evolution-api.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createEvolutionInstance`, `connectEvolutionInstance`, `logoutEvolutionInstance`, `deleteEvolutionInstance`, `sendEvolutionText`, `sendEvolutionMedia` — consumed by Task 3 (`sender`), Task 5 (lifecycle).

This mirrors `src/lib/whatsapp/meta-api.ts`'s pattern exactly: native `fetch`, named-params options objects (no positional args — the file header comment in `meta-api.ts` explains why), one `throwEvolutionError` helper.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createEvolutionInstance,
  connectEvolutionInstance,
  logoutEvolutionInstance,
  deleteEvolutionInstance,
  sendEvolutionText,
  sendEvolutionMedia,
} from './evolution-api';

const BASE = { baseUrl: 'http://evo.local', apiKey: 'k' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEvolutionInstance', () => {
  it('POSTs to /instance/create with the webhook block and returns the token + qr', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        hash: 'tok-123',
        qrcode: { base64: 'data:image/png;base64,AAA', code: 'raw-code' },
      }),
    } as Response);

    const result = await createEvolutionInstance({
      ...BASE,
      instanceName: 'axion-acc1',
      webhookUrl: 'https://app.local/api/channels/evolution/webhook',
    });

    expect(result).toEqual({ token: 'tok-123', qrCode: 'data:image/png;base64,AAA' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/instance/create');
    expect(init?.headers).toMatchObject({ apikey: 'k', 'Content-Type': 'application/json' });
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      instanceName: 'axion-acc1',
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      webhook: {
        url: 'https://app.local/api/channels/evolution/webhook',
        byEvents: false,
        base64: true,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
      },
    });
  });

  it('throws with the server error message on a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Instance already exists' }),
    } as Response);
    await expect(
      createEvolutionInstance({ ...BASE, instanceName: 'x', webhookUrl: 'https://x' }),
    ).rejects.toThrow('Instance already exists');
  });
});

describe('connectEvolutionInstance', () => {
  it('GETs /instance/connect/{name} and returns the qr', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ base64: 'data:image/png;base64,BBB', code: 'raw' }),
    } as Response);
    const result = await connectEvolutionInstance({ ...BASE, instanceName: 'axion-acc1' });
    expect(result).toEqual({ qrCode: 'data:image/png;base64,BBB' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://evo.local/instance/connect/axion-acc1');
  });
});

describe('logoutEvolutionInstance / deleteEvolutionInstance', () => {
  it('logoutEvolutionInstance DELETEs /instance/logout/{name}', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await logoutEvolutionInstance({ ...BASE, instanceName: 'axion-acc1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/instance/logout/axion-acc1');
    expect(init?.method).toBe('DELETE');
  });

  it('deleteEvolutionInstance DELETEs /instance/delete/{name}', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await deleteEvolutionInstance({ ...BASE, instanceName: 'axion-acc1' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://evo.local/instance/delete/axion-acc1');
  });
});

describe('sendEvolutionText', () => {
  it('POSTs a flat body (no nested textMessage) and returns the message id from key.id', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'WA-ID-1' } }),
    } as Response);
    const result = await sendEvolutionText({ ...BASE, instanceName: 'axion-acc1', to: '5511999999999', text: 'oi' });
    expect(result).toEqual({ messageId: 'WA-ID-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local/message/sendText/axion-acc1');
    expect(JSON.parse(init?.body as string)).toEqual({ number: '5511999999999', text: 'oi' });
  });
});

describe('sendEvolutionMedia', () => {
  it('POSTs mediatype + media (url) as plain JSON, not multipart', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: 'WA-ID-2' } }),
    } as Response);
    const result = await sendEvolutionMedia({
      ...BASE, instanceName: 'axion-acc1', to: '5511999999999',
      mediatype: 'image', media: 'https://example.com/a.jpg', caption: 'oi',
    });
    expect(result).toEqual({ messageId: 'WA-ID-2' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      number: '5511999999999', mediatype: 'image', media: 'https://example.com/a.jpg', caption: 'oi',
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/whatsapp/evolution-api.test.ts`
Expected: FAIL — `Cannot find module './evolution-api'`.

- [ ] **Step 3: Implement `evolution-api.ts`**

```ts
/**
 * Evolution API v2 HTTP helpers. Mirrors meta-api.ts's shape: named-param
 * options objects (no positional args — see meta-api.ts's header comment
 * for why), one shared error-throwing helper.
 *
 * Request/response shapes below are grounded in two sources, not the
 * (confirmed incomplete) doc site:
 *   1. The upstream DTOs (EvolutionAPI/evolution-api, src/api/dto/sendMessage.dto.ts)
 *   2. A live local instance — see docs/superpowers/specs/2026-07-12-evolution-api-phase-2-design.md
 */

interface EvolutionErrorResponse {
  message?: string;
  error?: string;
}

async function throwEvolutionError(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as EvolutionErrorResponse;
    if (data.message) message = data.message;
    else if (data.error) message = data.error;
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message);
}

interface EvolutionAuth {
  baseUrl: string;
  apiKey: string;
}

function headers(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', apikey: apiKey };
}

// ============================================================
// Instance lifecycle
// ============================================================

export interface CreateEvolutionInstanceArgs extends EvolutionAuth {
  instanceName: string;
  webhookUrl: string;
}
export interface EvolutionCreateResult {
  token: string;
  /** Data-URI base64 QR, present when the instance isn't already linked. */
  qrCode?: string;
}

/** POST /instance/create. Uses the caller's `apiKey` — Task 6's factory
 *  passes the global EVOLUTION_API_KEY here (admin action). */
export async function createEvolutionInstance(
  args: CreateEvolutionInstanceArgs,
): Promise<EvolutionCreateResult> {
  const { baseUrl, apiKey, instanceName, webhookUrl } = args;
  const response = await fetch(`${baseUrl}/instance/create`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      webhook: {
        url: webhookUrl,
        byEvents: false,
        base64: true,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
      },
    }),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return { token: data.hash, qrCode: data.qrcode?.base64 };
}

export interface ConnectEvolutionInstanceArgs extends EvolutionAuth {
  instanceName: string;
}
export interface EvolutionConnectResult {
  qrCode?: string;
}

/** GET /instance/connect/{instance}. Uses the instance's own token. */
export async function connectEvolutionInstance(
  args: ConnectEvolutionInstanceArgs,
): Promise<EvolutionConnectResult> {
  const { baseUrl, apiKey, instanceName } = args;
  const response = await fetch(`${baseUrl}/instance/connect/${instanceName}`, {
    headers: headers(apiKey),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return { qrCode: data.base64 };
}

export interface EvolutionInstanceArgs extends EvolutionAuth {
  instanceName: string;
}

/** DELETE /instance/logout/{instance}. Uses the instance's own token. */
export async function logoutEvolutionInstance(args: EvolutionInstanceArgs): Promise<void> {
  const { baseUrl, apiKey, instanceName } = args;
  const response = await fetch(`${baseUrl}/instance/logout/${instanceName}`, {
    method: 'DELETE',
    headers: headers(apiKey),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
}

/** DELETE /instance/delete/{instance}. Uses the global EVOLUTION_API_KEY
 *  (admin action) — the instance's own token stops working once deleted. */
export async function deleteEvolutionInstance(args: EvolutionInstanceArgs): Promise<void> {
  const { baseUrl, apiKey, instanceName } = args;
  const response = await fetch(`${baseUrl}/instance/delete/${instanceName}`, {
    method: 'DELETE',
    headers: headers(apiKey),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
}

// ============================================================
// Sending
// ============================================================

export interface SendEvolutionTextArgs extends EvolutionAuth {
  instanceName: string;
  to: string;
  text: string;
}
export interface EvolutionSendResult {
  messageId: string;
}

/** POST /message/sendText/{instance}. Flat JSON body — NOT the nested
 *  `{textMessage:{text}}` shape the doc site (incorrectly) describes;
 *  confirmed against the upstream DTO (SendTextDto extends Metadata). */
export async function sendEvolutionText(args: SendEvolutionTextArgs): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, to, text } = args;
  const response = await fetch(`${baseUrl}/message/sendText/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ number: to, text }),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return { messageId: data.key?.id };
}

export type EvolutionMediaType = 'image' | 'video' | 'document' | 'audio';

export interface SendEvolutionMediaArgs extends EvolutionAuth {
  instanceName: string;
  to: string;
  mediatype: EvolutionMediaType;
  /** URL or base64 — confirmed via upstream DTO (`media: string`); this
   *  is a plain JSON POST, NOT multipart/form-data as the doc site says. */
  media: string;
  caption?: string;
  fileName?: string;
}

/** POST /message/sendMedia/{instance}. */
export async function sendEvolutionMedia(args: SendEvolutionMediaArgs): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, to, mediatype, media, caption, fileName } = args;
  const body: Record<string, unknown> = { number: to, mediatype, media };
  if (caption) body.caption = caption;
  if (fileName) body.fileName = fileName;
  const response = await fetch(`${baseUrl}/message/sendMedia/${instanceName}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwEvolutionError(response, `Evolution API error: ${response.status}`);
  const data = await response.json();
  return { messageId: data.key?.id };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/whatsapp/evolution-api.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/evolution-api.ts src/lib/whatsapp/evolution-api.test.ts
git commit -m "feat(channels): Evolution API HTTP client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `EvolutionProvider.sender`

**Files:**
- Create: `src/lib/channels/providers/evolution.ts`
- Test: `src/lib/channels/providers/evolution.test.ts`

**Interfaces:**
- Consumes: `evolution-api.ts`'s `sendEvolutionText`/`sendEvolutionMedia` (Task 2); `ChannelProvider`/`ChannelSender`/`OutboundResult`/etc. (`src/lib/channels/types.ts`, Task 1 of Phase 1 + this phase's Task 1 additions).
- Produces: `EvolutionProvider` class with `sender` implemented; `parseWebhook`/`connect`/`getConnectionState`/`disconnect` left throwing `'not implemented — Task 4'` / `'— Task 5'` (same stub pattern `MetaProvider` used in Phase 1 Task 2). `EvolutionProviderConfig { baseUrl: string; apiKey: string; instanceName: string }` — consumed by Task 4, 5, 6.

No phone-variant retry here (unlike `MetaProvider`) — per the approved design, that was Meta-specific formatting handling; Evolution/Baileys resolves the number directly. `sendInteractiveButtons`/`sendInteractiveList` are implemented against the documented Baileys request shape but are a declared, not-yet-live-validated risk (design doc's "Riscos remanescentes") — do not add retry/fallback logic for them beyond what's specified below; that would be scope creep on an unvalidated feature.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import * as evolutionApi from '@/lib/whatsapp/evolution-api';
import { EvolutionProvider } from './evolution';

const config = { baseUrl: 'http://evo.local', apiKey: 'instance-token', instanceName: 'axion-acc1' };

describe('EvolutionProvider.sender', () => {
  it('sendText calls sendEvolutionText with the instance config and args', async () => {
    vi.spyOn(evolutionApi, 'sendEvolutionText').mockResolvedValue({ messageId: 'ID1' });
    const provider = new EvolutionProvider(config);
    const result = await provider.sender.sendText({ to: '5511999999999', text: 'oi' });
    expect(result).toEqual({ providerMessageId: 'ID1' });
    expect(evolutionApi.sendEvolutionText).toHaveBeenCalledWith({
      baseUrl: 'http://evo.local', apiKey: 'instance-token', instanceName: 'axion-acc1',
      to: '5511999999999', text: 'oi',
    });
  });

  it('sendMedia maps kind/link/caption/filename to mediatype/media/caption/fileName', async () => {
    vi.spyOn(evolutionApi, 'sendEvolutionMedia').mockResolvedValue({ messageId: 'ID2' });
    const provider = new EvolutionProvider(config);
    const result = await provider.sender.sendMedia({
      to: '5511999999999', kind: 'document', link: 'https://x/a.pdf', caption: 'cap', filename: 'a.pdf',
    });
    expect(result).toEqual({ providerMessageId: 'ID2' });
    expect(evolutionApi.sendEvolutionMedia).toHaveBeenCalledWith({
      baseUrl: 'http://evo.local', apiKey: 'instance-token', instanceName: 'axion-acc1',
      to: '5511999999999', mediatype: 'document', media: 'https://x/a.pdf', caption: 'cap', fileName: 'a.pdf',
    });
  });

  it('never re-sanitizes `to` — passes it through unchanged', async () => {
    vi.spyOn(evolutionApi, 'sendEvolutionText').mockResolvedValue({ messageId: 'ID3' });
    const provider = new EvolutionProvider(config);
    await provider.sender.sendText({ to: '+1 (555) 123-4567', text: 'x' });
    expect(evolutionApi.sendEvolutionText).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+1 (555) 123-4567' }),
    );
  });

  it('propagates errors from the HTTP layer unchanged (no retry)', async () => {
    vi.spyOn(evolutionApi, 'sendEvolutionText').mockRejectedValue(new Error('boom'));
    const provider = new EvolutionProvider(config);
    await expect(provider.sender.sendText({ to: '5511999999999', text: 'x' })).rejects.toThrow('boom');
  });
});

describe('EvolutionProvider stubs', () => {
  it('parseWebhook/connect/getConnectionState/disconnect throw not-implemented', async () => {
    const provider = new EvolutionProvider(config);
    expect(() => provider.parseWebhook({})).toThrow(/Task 4/);
    await expect(provider.connect()).rejects.toThrow(/Task 5/);
    await expect(provider.getConnectionState()).rejects.toThrow(/Task 5/);
    await expect(provider.disconnect()).rejects.toThrow(/Task 5/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/channels/providers/evolution.test.ts`
Expected: FAIL — `Cannot find module './evolution'`.

- [ ] **Step 3: Implement `evolution.ts`**

```ts
import {
  sendEvolutionText,
  sendEvolutionMedia,
  type EvolutionMediaType,
} from '@/lib/whatsapp/evolution-api';
import type {
  ChannelProvider,
  ChannelProviderId,
  ChannelSender,
  ConnectionState,
  NormalizedInbound,
  OutboundResult,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  SendMediaArgs,
  SendTextArgs,
} from '../types';

export interface EvolutionProviderConfig {
  baseUrl: string;
  /** Instance-scoped token (not the global EVOLUTION_API_KEY) — see the
   *  design doc's "Chaves de API" section for why. */
  apiKey: string;
  instanceName: string;
}

const MEDIA_KIND_TO_EVOLUTION: Record<SendMediaArgs['kind'], EvolutionMediaType> = {
  image: 'image', video: 'video', document: 'document', audio: 'audio',
};

export class EvolutionProvider implements ChannelProvider {
  readonly id: ChannelProviderId = 'evolution';
  readonly sender: ChannelSender;

  constructor(private readonly config: EvolutionProviderConfig) {
    const { baseUrl, apiKey, instanceName } = config;
    this.sender = {
      sendText: async (args: SendTextArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionText({
          baseUrl, apiKey, instanceName, to: args.to, text: args.text,
        });
        return { providerMessageId: messageId };
      },
      sendMedia: async (args: SendMediaArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionMedia({
          baseUrl, apiKey, instanceName, to: args.to,
          mediatype: MEDIA_KIND_TO_EVOLUTION[args.kind],
          media: args.link, caption: args.caption, fileName: args.filename,
        });
        return { providerMessageId: messageId };
      },
      // Baileys button/list support is experimental and unvalidated
      // against a real device in this phase (declared risk — see design
      // doc). Implemented against the documented request shape only.
      sendInteractiveButtons: async (args: SendInteractiveButtonsArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionButtons({
          baseUrl, apiKey, instanceName, to: args.to, bodyText: args.bodyText,
          headerText: args.headerText, footerText: args.footerText, buttons: args.buttons,
        });
        return { providerMessageId: messageId };
      },
      sendInteractiveList: async (args: SendInteractiveListArgs): Promise<OutboundResult> => {
        const { messageId } = await sendEvolutionList({
          baseUrl, apiKey, instanceName, to: args.to, bodyText: args.bodyText,
          buttonLabel: args.buttonLabel, headerText: args.headerText,
          footerText: args.footerText, sections: args.sections,
        });
        return { providerMessageId: messageId };
      },
    };
  }

  parseWebhook(_payload: unknown): NormalizedInbound[] {
    throw new Error('not implemented — Task 4');
  }
  async connect(): Promise<ConnectionState> {
    throw new Error('not implemented — Task 5');
  }
  async getConnectionState(): Promise<ConnectionState> {
    throw new Error('not implemented — Task 5');
  }
  async disconnect(): Promise<void> {
    throw new Error('not implemented — Task 5');
  }
}

// ---- Interactive send helpers (POST /message/sendButtons, /message/sendList) ----
// Kept local to this file (not evolution-api.ts) since they're speculative/
// unvalidated per the design doc's remaining risk — easy to find and revise
// once real interactive-send payloads are validated, without touching the
// HTTP client file Task 2 already tested against real DTOs.

import type { OutboundButton, OutboundListSection } from '../types';

interface EvolutionAuth { baseUrl: string; apiKey: string; instanceName: string }

async function sendEvolutionButtons(
  args: EvolutionAuth & { to: string; bodyText: string; headerText?: string; footerText?: string; buttons: OutboundButton[] },
): Promise<{ messageId: string }> {
  const { baseUrl, apiKey, instanceName, to, bodyText, headerText, footerText, buttons } = args;
  const response = await fetch(`${baseUrl}/message/sendButtons/${instanceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({
      number: to, title: headerText, description: bodyText, footer: footerText,
      buttons: buttons.map((b) => ({ type: 'reply', displayText: b.title, id: b.id })),
    }),
  });
  if (!response.ok) throw new Error(`Evolution API error: ${response.status}`);
  const data = await response.json();
  return { messageId: data.key?.id };
}

async function sendEvolutionList(
  args: EvolutionAuth & {
    to: string; bodyText: string; buttonLabel: string; headerText?: string;
    footerText?: string; sections: OutboundListSection[];
  },
): Promise<{ messageId: string }> {
  const { baseUrl, apiKey, instanceName, to, bodyText, buttonLabel, headerText, footerText, sections } = args;
  const response = await fetch(`${baseUrl}/message/sendList/${instanceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({
      number: to, title: headerText, description: bodyText, footerText, buttonText: buttonLabel,
      sections: sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({ title: r.title, description: r.description, rowId: r.id })),
      })),
    }),
  });
  if (!response.ok) throw new Error(`Evolution API error: ${response.status}`);
  const data = await response.json();
  return { messageId: data.key?.id };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/channels/providers/evolution.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/channels/providers/evolution.ts src/lib/channels/providers/evolution.test.ts
git commit -m "feat(channels): EvolutionProvider.sender

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `EvolutionProvider.parseWebhook`

**Files:**
- Modify: `src/lib/channels/providers/evolution.ts` (implement `parseWebhook`, add mapping types)
- Modify: `src/lib/channels/providers/evolution.test.ts`
- Create: `src/lib/channels/providers/__fixtures__/evolution-webhook-samples.ts`

**Interfaces:**
- Consumes: `NormalizedInbound` (Task 1 additions), the real captured payload shapes below.
- Produces: `EvolutionProvider.parseWebhook(payload: unknown): NormalizedInbound[]` — consumed by Task 7 (webhook route).

Real, captured-live payload shapes this task implements against (do not invent alternate field names — these are ground truth from a live instance, see the design doc):

- **Text**: `messageType: 'conversation'`, `message.conversation: string`.
- **Image/Video/Audio**: `messageType: 'imageMessage'|'videoMessage'|'audioMessage'`, `message.base64: string` (sibling of the type-keyed object, NOT nested inside it), `message.imageMessage.caption?`/`.mimetype`, `message.videoMessage.caption?`/`.mimetype`, `message.audioMessage.mimetype` (no caption field on audio).
- **Document** (mimetype/caption/fileName field names confirmed against the upstream Baileys source, not live-captured — same confidence tier as the sendMedia DTO correction in Task 2): `messageType: 'documentMessage'`, `message.base64`, `message.documentMessage.caption?`, `.fileName?`, `.mimetype`.
- **Location** (documented, not live-captured): `messageType: 'locationMessage'`, `message.locationMessage.degreesLatitude`, `.degreesLongitude`, `.name?`, `.address?` — note the field names are `degreesLatitude`/`degreesLongitude`, **not** `latitude`/`longitude` like Meta's shape.
- **Reaction** (documented, not live-captured): `messageType: 'reactionMessage'`, `message.reactionMessage.key.id` (target), `message.reactionMessage.text` (emoji; empty string = removal, same convention as Meta).
- **Interactive reply** (documented, not live-captured): `messageType: 'buttonsResponseMessage'` → `message.buttonsResponseMessage.selectedButtonId`; `messageType: 'listResponseMessage'` → `message.listResponseMessage.singleSelectReply.selectedRowId`.
- **Group messages**: `data.key.remoteJid` ends in `@g.us` (confirmed live) instead of `@s.whatsapp.net`; the real sender is in `data.key.participant`/`participantAlt`, not `remoteJid`. Out of scope per the design doc — `parseWebhook` must skip these (return no `NormalizedInbound` for them), not misattribute the group as the "contact".
- **Echo/self-sent filter**: `data.key.fromMe === true` is dropped unconditionally (approved design decision — covers both CRM-originated sends and messages sent from the linked phone directly).

- [ ] **Step 1: Write the fixture file**

```ts
// Real payloads captured from a live Evolution API v2 instance (see
// docs/superpowers/specs/2026-07-12-evolution-api-phase-2-design.md).
// Phone numbers/names anonymized; base64 truncated to a short valid
// placeholder (the real captured lengths were in the hundreds of KB —
// not needed to exercise the mapping logic). E2E crypto fields
// (messageSecret, recipientKeyHash) stripped — not read by parseWebhook.

export const TEXT_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000002@s.whatsapp.net',
      remoteJidAlt: '5511900000002@s.whatsapp.net',
      fromMe: false,
      id: 'ANON0000000000000000000000000001',
      participant: '',
      addressingMode: 'lid',
    },
    pushName: 'Test Customer',
    message: { conversation: 'Oiiiii teste' },
    messageType: 'conversation',
    messageTimestamp: 1783887066,
  },
};

export const FROM_ME_ECHO_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000001@s.whatsapp.net',
      fromMe: true,
      id: 'ANON0000000000000000000000000000',
      participant: '',
    },
    pushName: 'Test Agent',
    message: { conversation: 'Teste' },
    messageType: 'conversation',
    messageTimestamp: 1783886962,
  },
};

export const IMAGE_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000002@s.whatsapp.net',
      fromMe: false,
      id: 'ANON00000000000000000000000000AA',
      participant: '',
    },
    pushName: 'Test Customer',
    message: {
      imageMessage: { mimetype: 'image/jpeg', caption: 'olha isso' },
      base64: 'ZmFrZS1pbWFnZS1ieXRlcw==',
    },
    messageType: 'imageMessage',
    messageTimestamp: 1783888781,
  },
};

export const AUDIO_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '5511900000002@s.whatsapp.net',
      fromMe: false,
      id: 'ANON00000000000000000000000000BB',
      participant: '',
    },
    pushName: 'Test Customer',
    message: {
      audioMessage: { mimetype: 'audio/ogg; codecs=opus' },
      base64: 'ZmFrZS1hdWRpby1ieXRlcw==',
    },
    messageType: 'audioMessage',
    messageTimestamp: 1783888774,
  },
};

export const VIDEO_GROUP_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: {
      remoteJid: '120363427655738502@g.us',
      fromMe: false,
      id: 'ANON00000000000000000000000000CC',
      participant: '77193514381384@lid',
      participantAlt: '5511900000003@s.whatsapp.net',
      addressingMode: 'lid',
    },
    pushName: 'Group Member',
    message: {
      videoMessage: { mimetype: 'video/mp4' },
      base64: 'ZmFrZS12aWRlby1ieXRlcw==',
    },
    messageType: 'videoMessage',
    messageTimestamp: 1783888117,
  },
};

export const DOCUMENT_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: { remoteJid: '5511900000002@s.whatsapp.net', fromMe: false, id: 'ANON00000000000000000000000000DD', participant: '' },
    pushName: 'Test Customer',
    message: {
      documentMessage: { mimetype: 'application/pdf', fileName: 'contrato.pdf' },
      base64: 'ZmFrZS1kb2MtYnl0ZXM=',
    },
    messageType: 'documentMessage',
    messageTimestamp: 1783888900,
  },
};

export const LOCATION_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: { remoteJid: '5511900000002@s.whatsapp.net', fromMe: false, id: 'ANON00000000000000000000000000EE', participant: '' },
    pushName: 'Test Customer',
    message: {
      locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63, name: 'Praça da Sé', address: 'São Paulo, SP' },
    },
    messageType: 'locationMessage',
    messageTimestamp: 1783888950,
  },
};

export const REACTION_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: { remoteJid: '5511900000002@s.whatsapp.net', fromMe: false, id: 'ANON00000000000000000000000000FF', participant: '' },
    pushName: 'Test Customer',
    message: {
      reactionMessage: { key: { id: 'ANON0000000000000000000000000001' }, text: '👍' },
    },
    messageType: 'reactionMessage',
    messageTimestamp: 1783889000,
  },
};

export const BUTTON_REPLY_INBOUND_SAMPLE = {
  event: 'messages.upsert',
  instance: 'axion-test',
  data: {
    key: { remoteJid: '5511900000002@s.whatsapp.net', fromMe: false, id: 'ANON00000000000000000000000000GG', participant: '' },
    pushName: 'Test Customer',
    message: { buttonsResponseMessage: { selectedButtonId: 'btn-1', selectedDisplayText: 'Sim' } },
    messageType: 'buttonsResponseMessage',
    messageTimestamp: 1783889100,
  },
};

export const CONNECTION_UPDATE_ERROR_SAMPLE = {
  event: 'connection.update',
  instance: 'axion-test',
  data: { instance: 'axion-test', state: 'refused', statusReason: 428 },
};
```

- [ ] **Step 2: Write the failing tests** (append to `evolution.test.ts`)

```ts
import {
  TEXT_INBOUND_SAMPLE, FROM_ME_ECHO_SAMPLE, IMAGE_INBOUND_SAMPLE, AUDIO_INBOUND_SAMPLE,
  VIDEO_GROUP_SAMPLE, DOCUMENT_INBOUND_SAMPLE, LOCATION_INBOUND_SAMPLE, REACTION_INBOUND_SAMPLE,
  BUTTON_REPLY_INBOUND_SAMPLE, CONNECTION_UPDATE_ERROR_SAMPLE,
} from './__fixtures__/evolution-webhook-samples';

describe('EvolutionProvider.parseWebhook', () => {
  const provider = new EvolutionProvider(config);

  it('maps a text inbound', () => {
    const [inbound] = provider.parseWebhook(TEXT_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      from: '5511900000002', contactName: 'Test Customer',
      providerMessageId: 'ANON0000000000000000000000000001',
      kind: 'text', text: 'Oiiiii teste',
    });
    expect(inbound.timestamp).toEqual(new Date(1783887066 * 1000));
  });

  it('drops fromMe echoes entirely', () => {
    expect(provider.parseWebhook(FROM_ME_ECHO_SAMPLE)).toEqual([]);
  });

  it('drops group messages entirely', () => {
    expect(provider.parseWebhook(VIDEO_GROUP_SAMPLE)).toEqual([]);
  });

  it('maps an image inbound with base64 + mimetype + caption', () => {
    const [inbound] = provider.parseWebhook(IMAGE_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'image', text: 'olha isso',
      mediaBase64: 'ZmFrZS1pbWFnZS1ieXRlcw==', mediaMimeType: 'image/jpeg',
    });
  });

  it('maps an audio inbound with no caption', () => {
    const [inbound] = provider.parseWebhook(AUDIO_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'audio', text: null,
      mediaBase64: 'ZmFrZS1hdWRpby1ieXRlcw==', mediaMimeType: 'audio/ogg; codecs=opus',
    });
  });

  it('maps a document inbound with fileName fallback for text', () => {
    const [inbound] = provider.parseWebhook(DOCUMENT_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'document', text: 'contrato.pdf',
      mediaBase64: 'ZmFrZS1kb2MtYnl0ZXM=', mediaMimeType: 'application/pdf',
      mediaFileName: 'contrato.pdf',
    });
  });

  it('maps a location inbound to a human-readable text summary', () => {
    const [inbound] = provider.parseWebhook(LOCATION_INBOUND_SAMPLE);
    expect(inbound.kind).toBe('location');
    expect(inbound.text).toBe('Praça da Sé - São Paulo, SP - -23.55,-46.63');
  });

  it('maps a reaction inbound', () => {
    const [inbound] = provider.parseWebhook(REACTION_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({
      kind: 'reaction',
      reaction: { targetProviderMessageId: 'ANON0000000000000000000000000001', emoji: '👍' },
    });
  });

  it('maps a button-reply inbound', () => {
    const [inbound] = provider.parseWebhook(BUTTON_REPLY_INBOUND_SAMPLE);
    expect(inbound).toMatchObject({ kind: 'interactive_reply', interactiveReplyId: 'btn-1', text: 'Sim' });
  });

  it('returns [] for non-message events (connection.update, qrcode.updated)', () => {
    expect(provider.parseWebhook(CONNECTION_UPDATE_ERROR_SAMPLE)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/channels/providers/evolution.test.ts`
Expected: FAIL — `parseWebhook` still throws `'not implemented — Task 4'`.

- [ ] **Step 4: Implement `parseWebhook`**

Replace the stub `parseWebhook` method and add these types/helpers to `src/lib/channels/providers/evolution.ts`:

```ts
  parseWebhook(payload: unknown): NormalizedInbound[] {
    const body = payload as EvolutionWebhookBody | null;
    if (!body || body.event !== 'messages.upsert' || !body.data) return [];
    const data = body.data;

    // Never re-ingest our own sends, whether they came through this CRM
    // or were sent directly from the linked phone (approved design
    // decision — see design doc section 2, "parseWebhook").
    if (data.key.fromMe) return [];

    // Groups: remoteJid ends in @g.us and the real sender lives in
    // participant/participantAlt, not remoteJid — out of scope (design
    // doc, "Fora de escopo"). Skip rather than misattribute the group
    // as if it were a 1:1 contact.
    if (data.key.remoteJid.endsWith('@g.us')) return [];

    const inbound = mapEvolutionMessage(data);
    return inbound ? [inbound] : [];
  }
```

```ts
// ---- Shapes of Evolution's inbound webhook (subset we use) ----

interface EvolutionMessageKey {
  remoteJid: string;
  remoteJidAlt?: string;
  fromMe: boolean;
  id: string;
  participant?: string;
  participantAlt?: string;
}

interface EvolutionMessageContent {
  conversation?: string;
  imageMessage?: { caption?: string; mimetype?: string };
  videoMessage?: { caption?: string; mimetype?: string };
  audioMessage?: { mimetype?: string };
  documentMessage?: { caption?: string; fileName?: string; mimetype?: string };
  locationMessage?: { degreesLatitude: number; degreesLongitude: number; name?: string; address?: string };
  reactionMessage?: { key: { id: string }; text: string };
  buttonsResponseMessage?: { selectedButtonId: string; selectedDisplayText?: string };
  listResponseMessage?: { singleSelectReply?: { selectedRowId: string }; title?: string };
  /** Sibling of the type-keyed object above, not nested inside it —
   *  confirmed live for image/video/audio. Present only when the
   *  instance's webhook was created with `base64: true` (Task 5). */
  base64?: string;
}

interface EvolutionUpsertData {
  key: EvolutionMessageKey;
  pushName?: string;
  message: EvolutionMessageContent;
  messageType: string;
  messageTimestamp: number;
}

interface EvolutionWebhookBody {
  event: string;
  instance: string;
  data: EvolutionUpsertData;
}

/** Strips the @s.whatsapp.net / @lid suffix. Falls back to
 *  `remoteJidAlt` when `remoteJid` doesn't look like a phone number —
 *  covers the "LID" privacy addressing mode (documented limitation,
 *  see design doc). */
function extractPhone(key: EvolutionMessageKey): string {
  const raw = key.remoteJid.split('@')[0];
  if (/^\d+$/.test(raw)) return raw;
  const alt = key.remoteJidAlt?.split('@')[0];
  return alt && /^\d+$/.test(alt) ? alt : raw;
}

function mapEvolutionMessage(data: EvolutionUpsertData): NormalizedInbound | null {
  const base = {
    from: extractPhone(data.key),
    contactName: data.pushName,
    providerMessageId: data.key.id,
    timestamp: new Date(data.messageTimestamp * 1000),
  };
  const m = data.message;

  switch (data.messageType) {
    case 'conversation':
      return { ...base, kind: 'text', text: m.conversation ?? null };
    case 'imageMessage':
      return {
        ...base, kind: 'image', text: m.imageMessage?.caption ?? null,
        mediaBase64: m.base64 ?? null, mediaMimeType: m.imageMessage?.mimetype ?? null,
      };
    case 'videoMessage':
      return {
        ...base, kind: 'video', text: m.videoMessage?.caption ?? null,
        mediaBase64: m.base64 ?? null, mediaMimeType: m.videoMessage?.mimetype ?? null,
      };
    case 'audioMessage':
      return {
        ...base, kind: 'audio', text: null,
        mediaBase64: m.base64 ?? null, mediaMimeType: m.audioMessage?.mimetype ?? null,
      };
    case 'documentMessage':
      return {
        ...base, kind: 'document',
        text: m.documentMessage?.caption ?? m.documentMessage?.fileName ?? null,
        mediaBase64: m.base64 ?? null, mediaMimeType: m.documentMessage?.mimetype ?? null,
        mediaFileName: m.documentMessage?.fileName ?? null,
      };
    case 'locationMessage': {
      const loc = m.locationMessage;
      const text = loc
        ? [loc.name, loc.address, `${loc.degreesLatitude},${loc.degreesLongitude}`].filter(Boolean).join(' - ')
        : null;
      return { ...base, kind: 'location', text };
    }
    case 'reactionMessage': {
      const r = m.reactionMessage;
      return {
        ...base, kind: 'reaction',
        reaction: r ? { targetProviderMessageId: r.key.id, emoji: r.text } : null,
      };
    }
    case 'buttonsResponseMessage': {
      const r = m.buttonsResponseMessage;
      return { ...base, kind: 'interactive_reply', interactiveReplyId: r?.selectedButtonId ?? null, text: r?.selectedDisplayText ?? null };
    }
    case 'listResponseMessage': {
      const r = m.listResponseMessage;
      return { ...base, kind: 'interactive_reply', interactiveReplyId: r?.singleSelectReply?.selectedRowId ?? null, text: r?.title ?? null };
    }
    default:
      return { ...base, kind: 'text', text: `[Unsupported message type: ${data.messageType}]` };
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/channels/providers/evolution.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/channels/providers/evolution.ts src/lib/channels/providers/evolution.test.ts src/lib/channels/providers/__fixtures__/evolution-webhook-samples.ts
git commit -m "feat(channels): EvolutionProvider.parseWebhook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `EvolutionProvider` lifecycle

**Files:**
- Modify: `src/lib/channels/providers/evolution.ts` (implement `connect`/`getConnectionState`/`disconnect`)
- Modify: `src/lib/channels/providers/evolution.test.ts`

**Interfaces:**
- Consumes: `createEvolutionInstance`/`connectEvolutionInstance`/`logoutEvolutionInstance`/`deleteEvolutionInstance` (Task 2); `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` env vars (global server + admin key, per the Phase 1 design doc's "Evolution: um servidor por deployment" decision).
- Produces: working `connect()`/`getConnectionState()`/`disconnect()` — consumed by Task 8's routes.

Per the approved design, `getConnectionState()` **reads the cache only** — the constructor already carries an instance-scoped `apiKey`/`baseUrl`/`instanceName`, but no live Evolution call happens here; the cache is passed in directly (this provider doesn't hold a DB handle — Task 8's route reads the cache columns and constructs the `ConnectionState` itself, calling this method only for its type signature / interface conformance during `connect()`'s return value, not as an ongoing poll target). `connect()` is the only method that talks to Evolution live: it creates the instance if needed, then calls connect to get the QR.

- [ ] **Step 1: Write the failing tests** (append to `evolution.test.ts`)

```ts
import * as evolutionApi from '@/lib/whatsapp/evolution-api';

describe('EvolutionProvider lifecycle', () => {
  it('connect() creates the instance (global key) then connects (instance token) and returns the QR', async () => {
    vi.spyOn(evolutionApi, 'createEvolutionInstance').mockResolvedValue({
      token: 'new-instance-token', qrCode: 'data:image/png;base64,AAA',
    });
    const provider = new EvolutionProvider({ ...config, isNewInstance: true });
    const state = await provider.connect();
    expect(state).toEqual({ status: 'connecting', qrCode: 'data:image/png;base64,AAA' });
    expect(evolutionApi.createEvolutionInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: 'axion-acc1' }),
    );
  });

  it('connect() on an existing instance calls connectEvolutionInstance, not createEvolutionInstance', async () => {
    vi.spyOn(evolutionApi, 'connectEvolutionInstance').mockResolvedValue({ qrCode: 'data:image/png;base64,BBB' });
    const createSpy = vi.spyOn(evolutionApi, 'createEvolutionInstance');
    const provider = new EvolutionProvider({ ...config, isNewInstance: false });
    const state = await provider.connect();
    expect(state).toEqual({ status: 'connecting', qrCode: 'data:image/png;base64,BBB' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('getConnectionState() returns disconnected without calling Evolution (no cache passed)', async () => {
    const provider = new EvolutionProvider(config);
    const state = await provider.getConnectionState();
    expect(state).toEqual({ status: 'disconnected' });
    expect(evolutionApi.connectEvolutionInstance).not.toHaveBeenCalled();
  });

  it('disconnect() calls logout then delete', async () => {
    const logoutSpy = vi.spyOn(evolutionApi, 'logoutEvolutionInstance').mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(evolutionApi, 'deleteEvolutionInstance').mockResolvedValue(undefined);
    const provider = new EvolutionProvider(config);
    await provider.disconnect();
    expect(logoutSpy).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'axion-acc1' }));
    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'axion-acc1' }));
  });
});
```

Update the earlier stub test (`'EvolutionProvider stubs'` from Task 3) — remove the `parseWebhook`/lifecycle assertions there since those are no longer stubs (Task 4 already removed the `parseWebhook` one; now remove `connect`/`getConnectionState`/`disconnect` too, or delete that whole `describe` block since nothing is a stub anymore).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/channels/providers/evolution.test.ts`
Expected: FAIL — lifecycle methods still throw `'not implemented — Task 5'`.

- [ ] **Step 3: Implement the lifecycle methods**

Extend `EvolutionProviderConfig` and replace the three stub methods:

```ts
export interface EvolutionProviderConfig {
  baseUrl: string;
  /** Instance-scoped token for send/connect/logout calls. */
  apiKey: string;
  instanceName: string;
  /** Global EVOLUTION_API_KEY — only used by connect() when creating a
   *  brand-new instance (admin action). Optional because most methods
   *  never need it (see design doc "Chaves de API"). */
  adminApiKey?: string;
  /** True when this account has never connected before (no
   *  evolution_instance_token saved yet) — connect() must create the
   *  instance first. False means the instance already exists and
   *  connect() should just re-fetch a QR. */
  isNewInstance?: boolean;
  /** Where the Evolution server should POST webhook events — passed
   *  straight through to createEvolutionInstance. */
  webhookUrl?: string;
}
```

```ts
  async connect(): Promise<ConnectionState> {
    const { baseUrl, apiKey, instanceName, adminApiKey, isNewInstance, webhookUrl } = this.config;
    if (isNewInstance) {
      const result = await createEvolutionInstance({
        baseUrl, apiKey: adminApiKey ?? apiKey, instanceName, webhookUrl: webhookUrl ?? '',
      });
      return { status: 'connecting', qrCode: result.qrCode };
    }
    const result = await connectEvolutionInstance({ baseUrl, apiKey, instanceName });
    return { status: 'connecting', qrCode: result.qrCode };
  }

  // Deliberately does not call Evolution — the webhook-fed cache (Task 7)
  // is the source of truth for connection state, per the approved design
  // ("cache alimentado pelo webhook"). Any caller wanting the *cached*
  // state should read whatsapp_config directly (Task 8's routes do this);
  // this method exists only to satisfy the ChannelProvider interface and
  // returns a conservative default.
  async getConnectionState(): Promise<ConnectionState> {
    return { status: 'disconnected' };
  }

  async disconnect(): Promise<void> {
    const { baseUrl, apiKey, instanceName } = this.config;
    await logoutEvolutionInstance({ baseUrl, apiKey, instanceName });
    await deleteEvolutionInstance({ baseUrl, apiKey, instanceName });
  }
```

Add the new imports at the top of the file:

```ts
import {
  sendEvolutionText,
  sendEvolutionMedia,
  createEvolutionInstance,
  connectEvolutionInstance,
  logoutEvolutionInstance,
  deleteEvolutionInstance,
  type EvolutionMediaType,
} from '@/lib/whatsapp/evolution-api';
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/channels/providers/evolution.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/channels/providers/evolution.ts src/lib/channels/providers/evolution.test.ts
git commit -m "feat(channels): EvolutionProvider lifecycle (connect/disconnect)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire `EvolutionProvider` into `getChannelForAccount`

**Files:**
- Modify: `src/lib/channels/factory.ts`
- Modify: `src/lib/channels/factory.test.ts`

**Interfaces:**
- Consumes: `EvolutionProvider`/`EvolutionProviderConfig` (Task 5); `decrypt` (`src/lib/whatsapp/encryption.ts`); `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` env vars.
- Produces: `getChannelForAccount` returns a real `EvolutionProvider` for `provider='evolution'` rows instead of throwing `ChannelNotImplementedError`.

- [ ] **Step 1: Write the failing test** (append to `factory.test.ts`)

```ts
import { EvolutionProvider } from './providers/evolution';

describe('getChannelForAccount — evolution', () => {
  it('returns an EvolutionProvider for a provider=evolution row', async () => {
    const db = dbReturning({
      provider: 'evolution', evolution_instance_name: 'axion-acc1',
      evolution_instance_token: 'enc:TOKEN',
    });
    const provider = await getChannelForAccount('acc-1', db);
    expect(provider).toBeInstanceOf(EvolutionProvider);
    expect(provider.id).toBe('evolution');
  });

  it('throws ChannelConfigError when provider=evolution but no instance token was ever saved', async () => {
    const db = dbReturning({ provider: 'evolution', evolution_instance_name: 'axion-acc1', evolution_instance_token: null });
    await expect(getChannelForAccount('acc-1', db)).rejects.toBeInstanceOf(ChannelConfigError);
  });
});
```

Note: `ChannelConfigError` is already imported in this test file (Task 5 of Phase 1) — just add this describe block, don't duplicate the import.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/channels/factory.test.ts`
Expected: FAIL — still throws `ChannelNotImplementedError`.

- [ ] **Step 3: Implement**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { MetaProvider } from './providers/meta';
import { EvolutionProvider } from './providers/evolution';
import type { ChannelProvider } from './types';

// ... ChannelConfigError / ChannelNotImplementedError / ChannelLookupError unchanged ...

export async function getChannelForAccount(
  accountId: string,
  db: SupabaseClient,
): Promise<ChannelProvider> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) throw new ChannelLookupError(accountId, error);
  if (!config) throw new ChannelConfigError(accountId);

  const provider = (config.provider as string) ?? 'meta';
  if (provider === 'meta') {
    return new MetaProvider({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      wabaId: config.waba_id ?? null,
    });
  }
  if (provider === 'evolution') {
    if (!config.evolution_instance_token) throw new ChannelConfigError(accountId);
    return new EvolutionProvider({
      baseUrl: process.env.EVOLUTION_API_URL!,
      apiKey: decrypt(config.evolution_instance_token),
      instanceName: config.evolution_instance_name,
    });
  }
  throw new ChannelNotImplementedError(provider);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/channels/factory.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/channels/factory.ts src/lib/channels/factory.test.ts
git commit -m "feat(channels): route provider='evolution' through getChannelForAccount

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Evolution webhook route

**Files:**
- Create: `src/app/api/channels/evolution/webhook/route.ts`
- Create: `src/app/api/channels/evolution/webhook/route.test.ts`
- Create: `src/lib/channels/evolution-media.ts` (server-side base64 → Storage upload)
- Create: `src/lib/channels/evolution-media.test.ts`

**Interfaces:**
- Consumes: `EvolutionProvider.parseWebhook` (Task 4); `ingestInbound` (`src/lib/channels/ingest.ts`, unchanged from Phase 1); `decrypt` (encryption.ts).
- Produces: `POST /api/channels/evolution/webhook` — the account-resolution + auth + cache-update + media-upload + ingest glue, mirroring `src/app/api/whatsapp/webhook/route.ts`'s structure for Meta.

**Before editing the route handler:** read the route-handlers section of `node_modules/next/dist/docs/` (Global Constraint).

- [ ] **Step 1: Write the failing test for `evolution-media.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { uploadEvolutionMedia } from './evolution-media';

function dbWithStorage() {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const getPublicUrl = vi.fn().mockReturnValue({ data: { publicUrl: 'https://cdn.local/chat-media/account-acc-1/123-media.jpg' } });
  return {
    storage: { from: () => ({ upload, getPublicUrl }) },
    _upload: upload,
  } as unknown as import('@supabase/supabase-js').SupabaseClient & { _upload: typeof upload };
}

describe('uploadEvolutionMedia', () => {
  it('decodes base64 and uploads to chat-media under the account-scoped path', async () => {
    const db = dbWithStorage();
    const url = await uploadEvolutionMedia(db, {
      accountId: 'acc-1', base64: Buffer.from('hello').toString('base64'),
      mimeType: 'image/jpeg', providerMessageId: 'MSG1',
    });
    expect(url).toBe('https://cdn.local/chat-media/account-acc-1/123-media.jpg');
    const [path, buffer, opts] = db._upload.mock.calls[0];
    expect(path).toMatch(/^account-acc-1\/.*MSG1\.jpg$/);
    expect(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array).toBe(true);
    expect(opts).toMatchObject({ contentType: 'image/jpeg' });
  });

  it('returns null and does not throw when the upload fails', async () => {
    const db = dbWithStorage();
    (db as unknown as { _upload: ReturnType<typeof vi.fn> })._upload.mockResolvedValueOnce({ error: { message: 'quota' } });
    const url = await uploadEvolutionMedia(db, {
      accountId: 'acc-1', base64: Buffer.from('x').toString('base64'),
      mimeType: 'audio/ogg', providerMessageId: 'MSG2',
    });
    expect(url).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/channels/evolution-media.test.ts`
Expected: FAIL — `Cannot find module './evolution-media'`.

- [ ] **Step 3: Implement `evolution-media.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

// Same bucket + account-scoped path convention as the composer/flows
// uploads (migration 023: chat-media/account-<account_id>/<ts>-<name>).
// This is a server-side counterpart to src/lib/storage/upload-media.ts's
// `uploadAccountMedia` — that helper requires a browser session
// (`supabase.auth.getUser()`), unusable from a webhook route running on
// the service-role client. Service role bypasses RLS entirely, so no
// policy check is needed here — the account-scoped path is kept purely
// for consistency with every other media object in the bucket.
const BUCKET = 'chat-media';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

function extensionFor(mimeType: string | null | undefined, fileName?: string | null): string {
  if (fileName && /\.[^.]+$/.test(fileName)) return fileName.split('.').pop()!.toLowerCase();
  const base = mimeType?.split(';')[0].trim();
  return (base && EXT_BY_MIME[base]) || 'bin';
}

export interface UploadEvolutionMediaArgs {
  accountId: string;
  base64: string;
  mimeType?: string | null;
  fileName?: string | null;
  providerMessageId: string;
}

/**
 * Decode a base64 payload from an Evolution webhook and upload it to the
 * same Storage bucket the inbox composer uses, returning a public URL for
 * `messages.media_url`. Best-effort: a failed upload returns null (logged)
 * rather than throwing — must not drop the whole inbound message just
 * because Storage hiccuped, matching ingestInbound's best-effort DB-write
 * semantics elsewhere.
 */
export async function uploadEvolutionMedia(
  db: SupabaseClient,
  args: UploadEvolutionMediaArgs,
): Promise<string | null> {
  const { accountId, base64, mimeType, fileName, providerMessageId } = args;
  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = extensionFor(mimeType, fileName);
    const path = `account-${accountId}/${Date.now()}-${providerMessageId}.${ext}`;
    const { error } = await db.storage.from(BUCKET).upload(path, buffer, {
      cacheControl: '3600',
      upsert: false,
      contentType: mimeType ?? 'application/octet-stream',
    });
    if (error) {
      console.error('[evolution-media] upload failed:', error.message ?? error);
      return null;
    }
    const { data } = db.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error('[evolution-media] upload threw:', err);
    return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/channels/evolution-media.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for the webhook route**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIngestInbound = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/channels/ingest', () => ({ ingestInbound: mockIngestInbound }));
vi.mock('@/lib/channels/evolution-media', () => ({
  uploadEvolutionMedia: vi.fn().mockResolvedValue('https://cdn.local/chat-media/x.jpg'),
}));

function dbReturning(config: Record<string, unknown> | null) {
  const chain = {
    select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: config, error: null }),
    update: () => ({ eq: async () => ({ error: null }) }),
  };
  return { from: () => chain } as never;
}

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => dbReturning(mockConfigRow) }));

let mockConfigRow: Record<string, unknown> | null;

beforeEach(() => {
  mockIngestInbound.mockClear();
  mockConfigRow = {
    account_id: 'acc-1', user_id: 'user-1',
    evolution_instance_name: 'axion-acc1', evolution_instance_token: 'enc:tok',
  };
});

// decrypt('enc:tok') must resolve to a plain token for the apikey check —
// mock it deterministically rather than pulling in real AES.
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace('enc:', '') }));

import { POST } from './route';
import { TEXT_INBOUND_SAMPLE } from '@/lib/channels/providers/__fixtures__/evolution-webhook-samples';

function req(body: unknown) {
  return new Request('http://localhost/api/channels/evolution/webhook', {
    method: 'POST', body: JSON.stringify(body),
  });
}

describe('POST /api/channels/evolution/webhook', () => {
  it('rejects a request whose body apikey does not match the instance token', async () => {
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'wrong' }));
    expect(res.status).toBe(401);
    expect(mockIngestInbound).not.toHaveBeenCalled();
  });

  it('ingests a valid messages.upsert with matching apikey', async () => {
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'text', text: 'Oiiiii teste' }),
      expect.objectContaining({ accountId: 'acc-1', configOwnerUserId: 'user-1' }),
    );
  });

  it('returns 200 without ingesting when no config matches the instance name', async () => {
    mockConfigRow = null;
    const res = await POST(req({ ...TEXT_INBOUND_SAMPLE, apikey: 'tok' }));
    expect(res.status).toBe(200);
    expect(mockIngestInbound).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/app/api/channels/evolution/webhook/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 7: Implement the route**

```ts
import { NextResponse } from 'next/server';
import { decrypt } from '@/lib/whatsapp/encryption';
import { EvolutionProvider } from '@/lib/channels/providers/evolution';
import { ingestInbound } from '@/lib/channels/ingest';
import { uploadEvolutionMedia } from '@/lib/channels/evolution-media';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    const { createClient } = require('@supabase/supabase-js');
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  apikey?: string;
  data?: {
    state?: string;
    statusReason?: number;
    base64?: string;
  };
}

export async function POST(request: Request) {
  let body: EvolutionWebhookPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: config } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('evolution_instance_name', body.instance)
    .maybeSingle();

  // No config for this instance name — ack 200 anyway so Evolution
  // doesn't treat it as a delivery failure and retry forever (mirrors
  // the Meta webhook's best-effort ack semantics).
  if (!config) return NextResponse.json({ status: 'no config' }, { status: 200 });

  // Auth: the webhook body carries the instance's own token in `apikey`
  // (confirmed live — no header is sent). Reject a mismatch outright.
  const expectedToken = config.evolution_instance_token ? decrypt(config.evolution_instance_token) : null;
  if (!expectedToken || body.apikey !== expectedToken) {
    console.warn('[evolution webhook] apikey mismatch for instance', body.instance);
    return NextResponse.json({ error: 'Invalid apikey' }, { status: 401 });
  }

  if (body.event === 'qrcode.updated') {
    await db.from('whatsapp_config').update({
      evolution_qr_code: body.data?.base64 ?? null,
      evolution_qr_updated_at: new Date().toISOString(),
    }).eq('id', config.id);
    return NextResponse.json({ status: 'received' }, { status: 200 });
  }

  if (body.event === 'connection.update') {
    const state = body.data?.state;
    const mapped = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : state === 'close' ? 'disconnected' : 'error';
    const update: Record<string, unknown> = { evolution_connection_state: mapped };
    if (mapped === 'connected') {
      update.evolution_connected_at = new Date().toISOString();
      update.evolution_qr_code = null;
      update.evolution_last_error = null;
    } else if (mapped === 'disconnected') {
      update.evolution_qr_code = null;
    } else if (mapped === 'error') {
      update.evolution_last_error = `state=${state} reason=${body.data?.statusReason ?? 'unknown'}`;
    }
    await db.from('whatsapp_config').update(update).eq('id', config.id);
    return NextResponse.json({ status: 'received' }, { status: 200 });
  }

  if (body.event === 'messages.upsert') {
    const provider = new EvolutionProvider({
      baseUrl: process.env.EVOLUTION_API_URL!,
      apiKey: expectedToken,
      instanceName: body.instance,
    });
    const inbounds = provider.parseWebhook(body);

    for (const inbound of inbounds) {
      // Media resolution stays here — provider-specific, mirrors how
      // the Meta webhook route verifies media before calling
      // ingestInbound (see src/app/api/whatsapp/webhook/route.ts).
      if (inbound.mediaBase64) {
        const url = await uploadEvolutionMedia(db, {
          accountId: config.account_id,
          base64: inbound.mediaBase64,
          mimeType: inbound.mediaMimeType,
          fileName: inbound.mediaFileName,
          providerMessageId: inbound.providerMessageId,
        });
        inbound.mediaUrl = url;
        inbound.mediaBase64 = null;
      }

      await ingestInbound(inbound, {
        accountId: config.account_id,
        configOwnerUserId: config.user_id,
        db,
      });
    }
  }

  return NextResponse.json({ status: 'received' }, { status: 200 });
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/app/api/channels/evolution/webhook/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Run the full suite + typecheck**

Run: `npm test`
Expected: green except the 5 pre-existing unrelated currency/date failures.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/app/api/channels/evolution/webhook/route.ts src/app/api/channels/evolution/webhook/route.test.ts src/lib/channels/evolution-media.ts src/lib/channels/evolution-media.test.ts
git commit -m "feat(channels): Evolution webhook route (auth, cache updates, media upload, ingest)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Connect / state / disconnect routes

**Files:**
- Create: `src/app/api/channels/evolution/connect/route.ts`
- Create: `src/app/api/channels/evolution/connect/route.test.ts`
- Create: `src/app/api/channels/evolution/state/route.ts`
- Create: `src/app/api/channels/evolution/state/route.test.ts`

**Interfaces:**
- Consumes: `createEvolutionInstance`/`connectEvolutionInstance` (Task 2, used directly by `POST` — see design note below); `EvolutionProvider` (Task 5, used by `DELETE` for `disconnect()`); `encrypt`/`decrypt` (encryption.ts); the session-auth pattern from `src/app/api/whatsapp/config/route.ts` (`createClient` from `@/lib/supabase/server`, `resolveAccountId` via `profiles`).
- Produces: `POST/DELETE /api/channels/evolution/connect`, `GET /api/channels/evolution/state` — consumed by Task 9's `evolution-connect.tsx`.

**Before editing these route handlers:** read the route-handlers section of `node_modules/next/dist/docs/` (Global Constraint) if not already done in Task 7.

**Design note:** `EvolutionProvider.connect()` (Task 5) returns a `ConnectionState`, which has no `token` field — it can't be the source of the freshly-created instance token this route needs to persist. So this route calls `evolution-api.ts`'s `createEvolutionInstance`/`connectEvolutionInstance` **directly** for the connect step (not through `EvolutionProvider`), and only constructs an `EvolutionProvider` for `DELETE`'s `disconnect()`. This keeps Task 5's `EvolutionProvider.connect()` signature stable and matches the existing codebase pattern (`send-message.ts` etc. import provider-specific HTTP clients directly at the API-route layer, not only through the `ChannelSender` seam).

- [ ] **Step 1: Write the failing tests for the connect route**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUser = { id: 'user-1' };
let mockProfile: { account_id: string } | null = { account_id: 'acc-1' };
let mockConfig: Record<string, unknown> | null = null;
let lastUpsert: Record<string, unknown> | null = null;

function makeSupabase() {
  let lastTable = '';
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => {
      if (lastTable === 'profiles') return { data: mockProfile, error: null };
      return { data: mockConfig, error: null };
    },
    upsert: (row: Record<string, unknown>) => {
      lastUpsert = row;
      return { select: () => ({ single: async () => ({ data: { ...row, id: 'cfg-1' }, error: null }) }) };
    },
    update: () => ({ eq: async () => ({ error: null }) }),
  };
  return {
    auth: { getUser: async () => ({ data: { user: mockUser }, error: null }) },
    from: (t: string) => { lastTable = t; return chain; },
  } as never;
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeSupabase() }));
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace('enc:', '') }));
vi.mock('@/lib/whatsapp/evolution-api', () => ({
  createEvolutionInstance: vi.fn(),
  connectEvolutionInstance: vi.fn(),
}));

const mockDisconnect = vi.fn();
vi.mock('@/lib/channels/providers/evolution', () => ({
  EvolutionProvider: vi.fn().mockImplementation(() => ({ disconnect: mockDisconnect })),
}));

beforeEach(() => {
  mockProfile = { account_id: 'acc-1' };
  mockConfig = null;
  lastUpsert = null;
  mockDisconnect.mockReset().mockResolvedValue(undefined);
});

import { POST, DELETE } from './route';
import { createEvolutionInstance, connectEvolutionInstance } from '@/lib/whatsapp/evolution-api';

describe('POST /api/channels/evolution/connect', () => {
  it('creates a new instance (global key), encrypts + persists the returned token, and returns the QR', async () => {
    vi.mocked(createEvolutionInstance).mockResolvedValue({ token: 'fresh-token', qrCode: 'data:image/png;base64,AAA' });
    const res = await POST(new Request('http://localhost/api/channels/evolution/connect', { method: 'POST' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'connecting', qrCode: 'data:image/png;base64,AAA' });
    expect(lastUpsert).toMatchObject({
      account_id: 'acc-1', provider: 'evolution',
      evolution_instance_token: 'enc:fresh-token',
      evolution_qr_code: 'data:image/png;base64,AAA',
    });
  });

  it('reconnects an existing instance (instance token) without calling createEvolutionInstance', async () => {
    mockConfig = { evolution_instance_token: 'enc:existing-token' };
    vi.mocked(connectEvolutionInstance).mockResolvedValue({ qrCode: 'data:image/png;base64,BBB' });
    const res = await POST(new Request('http://localhost/api/channels/evolution/connect', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(createEvolutionInstance).not.toHaveBeenCalled();
    expect(connectEvolutionInstance).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'existing-token' }));
    expect(lastUpsert).toMatchObject({ evolution_instance_token: 'enc:existing-token', evolution_qr_code: 'data:image/png;base64,BBB' });
  });

  it('401s when unauthenticated', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
    }));
    vi.resetModules();
    const { POST: freshPost } = await import('./route');
    const res = await freshPost(new Request('http://localhost/api/channels/evolution/connect', { method: 'POST' }));
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/channels/evolution/connect', () => {
  it('calls disconnect and marks the row disconnected', async () => {
    mockConfig = { id: 'cfg-1', account_id: 'acc-1', evolution_instance_name: 'axion-acc1', evolution_instance_token: 'enc:tok' };
    const res = await DELETE(new Request('http://localhost/api/channels/evolution/connect', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/channels/evolution/connect/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement the connect route**

```ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { EvolutionProvider } from '@/lib/channels/providers/evolution';
import { createEvolutionInstance, connectEvolutionInstance } from '@/lib/whatsapp/evolution-api';

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase.from('profiles').select('account_id').eq('user_id', userId).maybeSingle();
  return (data?.account_id as string) ?? null;
}

function instanceNameFor(accountId: string): string {
  return `axion-${accountId}`;
}

/** POST — start (or restart) a QR connect flow for the caller's account. */
export async function POST(_request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) return NextResponse.json({ error: 'No account' }, { status: 400 });

  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('evolution_instance_token')
    .eq('account_id', accountId)
    .maybeSingle();

  const instanceName = instanceNameFor(accountId);
  const isNewInstance = !existing?.evolution_instance_token;
  const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/channels/evolution/webhook`;
  const baseUrl = process.env.EVOLUTION_API_URL!;

  let instanceToken: string;
  let qrCode: string | undefined;

  try {
    if (isNewInstance) {
      const result = await createEvolutionInstance({
        baseUrl, apiKey: process.env.EVOLUTION_API_KEY!, instanceName, webhookUrl,
      });
      instanceToken = result.token;
      qrCode = result.qrCode;
    } else {
      instanceToken = decrypt(existing!.evolution_instance_token as string);
      const result = await connectEvolutionInstance({ baseUrl, apiKey: instanceToken, instanceName });
      qrCode = result.qrCode;
    }
  } catch (err) {
    console.error('[evolution connect] failed:', err);
    return NextResponse.json({ error: 'Failed to connect to Evolution API' }, { status: 502 });
  }

  const update = {
    account_id: accountId,
    provider: 'evolution' as const,
    evolution_instance_name: instanceName,
    evolution_instance_token: encrypt(instanceToken),
    evolution_connection_state: 'connecting',
    evolution_qr_code: qrCode ?? null,
    evolution_qr_updated_at: new Date().toISOString(),
    evolution_last_error: null,
  };

  await supabase.from('whatsapp_config').upsert(update, { onConflict: 'account_id' }).select().single();

  return NextResponse.json({ status: 'connecting', qrCode: qrCode ?? null }, { status: 200 });
}

/** DELETE — disconnect the caller's account's Evolution instance. */
export async function DELETE(_request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) return NextResponse.json({ error: 'No account' }, { status: 400 });

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('evolution_instance_name, evolution_instance_token')
    .eq('account_id', accountId)
    .maybeSingle();

  if (config?.evolution_instance_token) {
    const provider = new EvolutionProvider({
      baseUrl: process.env.EVOLUTION_API_URL!,
      apiKey: decrypt(config.evolution_instance_token as string),
      instanceName: config.evolution_instance_name as string,
    });
    try {
      await provider.disconnect();
    } catch (err) {
      console.error('[evolution disconnect] failed (continuing to clear local state):', err);
    }
  }

  await supabase
    .from('whatsapp_config')
    .update({ evolution_connection_state: 'disconnected', evolution_qr_code: null })
    .eq('account_id', accountId);

  return NextResponse.json({ status: 'disconnected' }, { status: 200 });
}
```

- [ ] **Step 4: Write the failing test for the state route**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockConfig: Record<string, unknown> | null = null;
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (t: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: t === 'profiles' ? { account_id: 'acc-1' } : mockConfig,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

beforeEach(() => { mockConfig = null; });

import { GET } from './route';

describe('GET /api/channels/evolution/state', () => {
  it('returns disconnected with no qr when no config row exists', async () => {
    const res = await GET(new Request('http://localhost/api/channels/evolution/state'));
    const json = await res.json();
    expect(json).toEqual({ status: 'disconnected', qrCode: null, qrUpdatedAt: null, detail: null });
  });

  it('returns the cached connecting state + qr', async () => {
    mockConfig = {
      evolution_connection_state: 'connecting',
      evolution_qr_code: 'data:image/png;base64,AAA',
      evolution_qr_updated_at: '2026-07-12T20:00:00.000Z',
      evolution_last_error: null,
    };
    const res = await GET(new Request('http://localhost/api/channels/evolution/state'));
    const json = await res.json();
    expect(json).toEqual({
      status: 'connecting', qrCode: 'data:image/png;base64,AAA',
      qrUpdatedAt: '2026-07-12T20:00:00.000Z', detail: null,
    });
  });

  it('surfaces evolution_last_error as detail when status is error', async () => {
    mockConfig = { evolution_connection_state: 'error', evolution_qr_code: null, evolution_qr_updated_at: null, evolution_last_error: 'state=refused reason=428' };
    const res = await GET(new Request('http://localhost/api/channels/evolution/state'));
    const json = await res.json();
    expect(json).toMatchObject({ status: 'error', detail: 'state=refused reason=428' });
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run src/app/api/channels/evolution/state/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 6: Implement the state route**

```ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase.from('profiles').select('account_id').eq('user_id', userId).maybeSingle();
  return (data?.account_id as string) ?? null;
}

/** GET — read-only cache lookup, never calls the Evolution server
 *  (approved design: "frontend só fala com o próprio backend"). */
export async function GET(_request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) return NextResponse.json({ error: 'No account' }, { status: 400 });

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('evolution_connection_state, evolution_qr_code, evolution_qr_updated_at, evolution_last_error')
    .eq('account_id', accountId)
    .maybeSingle();

  return NextResponse.json({
    status: config?.evolution_connection_state ?? 'disconnected',
    qrCode: config?.evolution_qr_code ?? null,
    qrUpdatedAt: config?.evolution_qr_updated_at ?? null,
    detail: config?.evolution_connection_state === 'error' ? (config?.evolution_last_error ?? null) : null,
  });
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run src/app/api/channels/evolution/connect/route.test.ts src/app/api/channels/evolution/state/route.test.ts`
Expected: PASS (state route: 3/3; connect route: 4/4).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/channels/evolution/connect/route.ts src/app/api/channels/evolution/connect/route.test.ts src/app/api/channels/evolution/state/route.ts src/app/api/channels/evolution/state/route.test.ts
git commit -m "feat(channels): connect/disconnect/state routes for Evolution QR flow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: `evolution-connect.tsx` component

**Files:**
- Create: `src/components/settings/evolution-connect.tsx`
- Modify: `messages/en.json`, `messages/pt-BR.json` (new `Settings.whatsapp.evolution.*` keys)

**Interfaces:**
- Consumes: `GET /api/channels/evolution/state`, `POST` / `DELETE /api/channels/evolution/connect` (Task 8).
- Produces: `EvolutionConnect` component — consumed by Task 10's `channel-settings.tsx`.

- [ ] **Step 1: Add translation keys**

In `messages/en.json`, inside the existing `"Settings"` → `"whatsapp"` object (find it via `grep -n '"whatsapp": {' messages/en.json`), add a sibling `"evolution"` key:

```json
"evolution": {
  "title": "WhatsApp connection (Evolution API)",
  "description": "Connect a number by scanning a QR code — no Meta Business account needed.",
  "connect": "Connect",
  "connecting": "Connecting…",
  "disconnect": "Disconnect",
  "disconnecting": "Disconnecting…",
  "statusConnected": "Connected",
  "statusConnecting": "Waiting for QR scan",
  "statusDisconnected": "Not connected",
  "statusError": "Connection failed",
  "scanHint": "Open WhatsApp on your phone → Linked devices → Link a device, then scan this code.",
  "qrExpiredHint": "This QR expired — generating a new one…"
}
```

In `messages/pt-BR.json`, same location, same key names:

```json
"evolution": {
  "title": "Conexão WhatsApp (Evolution API)",
  "description": "Conecte um número escaneando um QR code — sem precisar de conta Meta Business.",
  "connect": "Conectar",
  "connecting": "Conectando…",
  "disconnect": "Desconectar",
  "disconnecting": "Desconectando…",
  "statusConnected": "Conectado",
  "statusConnecting": "Aguardando leitura do QR",
  "statusDisconnected": "Não conectado",
  "statusError": "Falha na conexão",
  "scanHint": "Abra o WhatsApp no celular → Aparelhos conectados → Conectar um aparelho, e escaneie este código.",
  "qrExpiredHint": "Esse QR expirou — gerando um novo…"
}
```

- [ ] **Step 2: Implement `evolution-connect.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, XCircle, QrCode } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type Status = 'connected' | 'connecting' | 'disconnected' | 'error';
interface StateResponse {
  status: Status;
  qrCode: string | null;
  qrUpdatedAt: string | null;
  detail: string | null;
}

const POLL_INTERVAL_MS = 3000;

export function EvolutionConnect() {
  const t = useTranslations('Settings.whatsapp.evolution');
  const [state, setState] = useState<StateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/channels/evolution/state');
      const data = (await res.json()) as StateResponse;
      setState(data);
      return data;
    } catch (err) {
      console.error('Failed to fetch Evolution state:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const data = await fetchState();
      // Stop as soon as we leave the connecting state — matches the
      // approved design ("para assim que virar connected, error, ou o
      // componente desmontar").
      if (data && data.status !== 'connecting') stopPolling();
    }, POLL_INTERVAL_MS);
  }, [fetchState, stopPolling]);

  useEffect(() => {
    fetchState().then((data) => {
      if (data?.status === 'connecting') startPolling();
    });
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect() {
    setConnecting(true);
    try {
      const res = await fetch('/api/channels/evolution/connect', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to start connection');
        return;
      }
      await fetchState();
      startPolling();
    } catch (err) {
      console.error('Connect failed:', err);
      toast.error('Failed to start connection');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/channels/evolution/connect', { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Failed to disconnect');
        return;
      }
      stopPolling();
      await fetchState();
      toast.success(t('disconnect'));
    } catch (err) {
      console.error('Disconnect failed:', err);
      toast.error('Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const status = state?.status ?? 'disconnected';

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-6">
      <Alert className="bg-card border-border">
        <div className="flex items-center gap-2">
          {status === 'connected' ? (
            <CheckCircle2 className="size-4 text-primary" />
          ) : status === 'error' ? (
            <XCircle className="size-4 text-red-500" />
          ) : (
            <QrCode className="size-4 text-muted-foreground" />
          )}
          <AlertTitle className="text-foreground mb-0">
            {status === 'connected' ? t('statusConnected')
              : status === 'connecting' ? t('statusConnecting')
              : status === 'error' ? t('statusError')
              : t('statusDisconnected')}
          </AlertTitle>
        </div>
        {status === 'error' && state?.detail && (
          <AlertDescription className="text-muted-foreground">{state.detail}</AlertDescription>
        )}
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('title')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'connecting' && state?.qrCode && (
            <div className="flex flex-col items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={state.qrCode} alt="QR code" className="size-64 rounded border border-border" />
              <p className="text-sm text-muted-foreground text-center max-w-xs">{t('scanHint')}</p>
            </div>
          )}

          <div className="flex gap-3">
            {status !== 'connected' && (
              <Button onClick={handleConnect} disabled={connecting || status === 'connecting'}>
                {connecting || status === 'connecting' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('connecting')}
                  </>
                ) : (
                  t('connect')
                )}
              </Button>
            )}
            {status === 'connected' && (
              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {disconnecting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('disconnecting')}
                  </>
                ) : (
                  t('disconnect')
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual verification (behavior, not unit-testable without a browser)**

This component has no automated test in this task — it's UI wiring over routes already covered by Task 8's tests. Per the `run` skill's guidance, actually launch the dev server and click through it once Task 10 wires it into the Settings page (deferred to Task 10's manual-verification step, since this component isn't reachable on its own route yet).

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/evolution-connect.tsx messages/en.json messages/pt-BR.json
git commit -m "feat(channels): evolution-connect QR UI component

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Split `whatsapp-config.tsx` into channel-settings + meta-config, wire Evolution in

**Files:**
- Create: `src/components/settings/channel-settings.tsx`
- Create: `src/components/settings/meta-config.tsx` (moved content of `whatsapp-config.tsx`)
- Delete: `src/components/settings/whatsapp-config.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`
- Modify: `messages/en.json`, `messages/pt-BR.json` (add `Settings.whatsapp.channelSelector.*`)

**Interfaces:**
- Consumes: `EvolutionConnect` (Task 9); the existing `WhatsAppConfig` component body (moved, not rewritten).
- Produces: `ChannelSettings` — consumed by `settings/page.tsx`.

This is a **move**, not a rewrite, for the Meta portion (Global Constraint) — copy `whatsapp-config.tsx`'s full body into `meta-config.tsx` verbatim except the export name (`WhatsAppConfig` → `MetaConfig`) and the wrapping `<section>`/`<SettingsPanelHead>` (the container now owns the page-level heading; `MetaConfig` renders just its own content, matching how `EvolutionConnect` (Task 9) doesn't render its own top-level `SettingsPanelHead` either).

- [ ] **Step 1: Add the channel-selector translation keys**

In `messages/en.json`, inside `Settings.whatsapp`, add:

```json
"channelSelector": {
  "meta": "Meta Cloud API",
  "evolution": "Evolution API (QR code)"
}
```

In `messages/pt-BR.json`, same location:

```json
"channelSelector": {
  "meta": "Meta Cloud API",
  "evolution": "Evolution API (QR code)"
}
```

- [ ] **Step 2: Create `meta-config.tsx`**

Copy the full current content of `src/components/settings/whatsapp-config.tsx` into a new file `src/components/settings/meta-config.tsx`, then make exactly these two changes:

1. Rename the export: `export function WhatsAppConfig()` → `export function MetaConfig()`.
2. Remove the outer `<SettingsPanelHead title={t("title")} description={t("description")} />` block and its now-unused `import { SettingsPanelHead } from './settings-panel-head';` — the container (`channel-settings.tsx`, Step 3) owns the page-level heading now. The `<section className="animate-in fade-in-50 duration-200">` wrapper and the `{loading}` early-return should keep their own `<div className="flex items-center justify-center py-12">` spinner, just without the `SettingsPanelHead` line above it.

Everything else — every hook, handler, state variable, JSX field, and the `t('...')` calls (still against the `Settings.whatsapp` namespace, unchanged) — stays byte-for-byte identical. Do not "clean up" or restructure anything else in this file; that would violate the Global Constraint that this is a move, not a rewrite.

- [ ] **Step 3: Create `channel-settings.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { SettingsPanelHead } from './settings-panel-head';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { MetaConfig } from './meta-config';
import { EvolutionConnect } from './evolution-connect';

type Provider = 'meta' | 'evolution';

export function ChannelSettings() {
  const t = useTranslations('Settings.whatsapp');
  const { accountId, loading: authLoading, profileLoading } = useAuth();
  const supabase = createClient();
  const [provider, setProvider] = useState<Provider>('meta');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (authLoading || profileLoading || !accountId || loaded) return;
    supabase
      .from('whatsapp_config')
      .select('provider')
      .eq('account_id', accountId)
      .maybeSingle()
      .then(({ data }) => {
        // Rows written before migration 037 have no `provider` column
        // value cached client-side yet — default to 'meta', matching
        // the migration's own DEFAULT 'meta'.
        setProvider((data?.provider as Provider) ?? 'meta');
        setLoaded(true);
      });
  }, [authLoading, profileLoading, accountId, loaded, supabase]);

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Tabs value={provider} onValueChange={(v) => setProvider(v as Provider)} className="mt-6">
        <TabsList>
          <TabsTrigger value="meta">{t('channelSelector.meta')}</TabsTrigger>
          <TabsTrigger value="evolution">{t('channelSelector.evolution')}</TabsTrigger>
        </TabsList>
        <TabsContent value="meta">
          <MetaConfig />
        </TabsContent>
        <TabsContent value="evolution">
          <EvolutionConnect />
        </TabsContent>
      </Tabs>
    </section>
  );
}
```

Note for the implementer: this plan assumes a `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` component set already exists at `@/components/ui/tabs` (a standard shadcn/ui primitive). Run `ls src/components/ui/tabs.tsx` first to confirm — if it doesn't exist, check whether another shadcn/ui primitive is already vendored the same way as `@/components/ui/accordion` (imported in the current `whatsapp-config.tsx`) and either add `tabs.tsx` following that same vendoring pattern, or substitute a simpler already-available pattern (e.g. two buttons toggling which panel renders) rather than introducing a new UI library. Flag which path you took in the task report.

- [ ] **Step 4: Delete the old file and update `settings/page.tsx`**

```bash
git rm src/components/settings/whatsapp-config.tsx
```

In `src/app/(dashboard)/settings/page.tsx`, change:

```tsx
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
```
to:
```tsx
import { ChannelSettings } from '@/components/settings/channel-settings';
```

and change:
```tsx
whatsapp: <WhatsAppConfig />,
```
to:
```tsx
whatsapp: <ChannelSettings />,
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: green except the 5 pre-existing unrelated currency/date failures.

- [ ] **Step 7: Manual runtime verification**

Start the dev server (`npm run dev`) and:
1. Open Settings → WhatsApp. Confirm the Meta tab renders identically to before (same fields, same save/test/reset behavior) — this is the regression check for the move in Step 2.
2. Switch to the Evolution tab. Confirm the "Connect" button appears, and clicking it either shows a QR (if `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` are configured in this environment) or a clear error toast (if not) — either is acceptable for this check; the goal is confirming the tab renders and the button doesn't crash the page.
3. If a real Evolution server is reachable in this environment, scan the QR and confirm the status badge transitions to "Connected" within a few polling cycles (~3-9s).

If no Evolution server is reachable in this environment, note that explicitly in the task report and rely on Task 8's route tests instead — same fallback pattern Phase 1 used for its own unreachable-live-service manual-check steps.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/channel-settings.tsx src/components/settings/meta-config.tsx src/app/\(dashboard\)/settings/page.tsx messages/en.json messages/pt-BR.json
git commit -m "refactor(settings): split WhatsApp config into channel-settings + meta-config + evolution-connect

Behavior-preserving for Meta: meta-config.tsx is whatsapp-config.tsx's
content moved verbatim (rename + drop the now-container-owned page
heading only). channel-settings.tsx adds the Meta/Evolution tab
selector; evolution-connect.tsx (Task 9) is wired in as the new tab.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (plan against the design doc)

- **Spec coverage:** §1 Modelo de dados ✓ (Task 1); §2 EvolutionProvider — sender ✓ (Task 3), parseWebhook ✓ (Task 4, all listed field mappings including the group/`fromMe` filters), lifecycle ✓ (Task 5), nome da instância ✓ (Task 8's `instanceNameFor`), webhook na criação ✓ (Task 2's `createEvolutionInstance`), auth do webhook ✓ (Task 7), chaves de API (global vs. instância) ✓ (Tasks 5/6/8 split); §3 Rotas — connect/state/webhook/disconnect ✓ (Tasks 7, 8); §4 Fluxo de QR (cache + polling, para ao sair de connecting) ✓ (Task 9); §5 Mídia inbound (decode + upload pro chat-media bucket) ✓ (Task 7's `evolution-media.ts`); §6 Tela de Configurações (3-way split) ✓ (Tasks 9, 10). Fora de escopo (grupos, LID, broadcast, multi-servidor, templates) — grupos explicitly handled as a skip in Task 4; the rest correctly untouched by any task.
- **Placeholders:** none of the "TBD/implement later" kind. A first draft of Task 8 left the create-instance-token-persistence question unresolved (a TODO-shaped comment); caught in this self-review and fixed inline — the connect route now calls `evolution-api.ts`'s `createEvolutionInstance`/`connectEvolutionInstance` directly (bypassing `EvolutionProvider` for that one step) so the freshly-created token can actually be encrypted and persisted, with a real test proving it.
- **Type consistency:** `NormalizedInbound.mediaBase64/mediaMimeType/mediaFileName` (Task 1) are produced by `EvolutionProvider.parseWebhook` (Task 4) and consumed by the webhook route (Task 7) — names match throughout. `EvolutionProviderConfig` fields introduced across Tasks 3/5 (`baseUrl`, `apiKey`, `instanceName`, then `adminApiKey`/`isNewInstance`/`webhookUrl`) are used consistently by Task 6 (factory) and Task 8 (routes). `ChannelSender`'s ago-established sanitized-`to` contract (Phase 1) is respected — Task 3 never re-sanitizes.

- **Seam payoff confirmed:** Phase 1 Task 7 already routes all 4 outbound send paths (`send-message.ts`, `flows/meta-send.ts`, `automations/meta-send.ts`, and by extension `broadcast-core.ts` once it needs one) through `getChannelForAccount(...).sender.*`, generically, with no `if (provider === 'meta')` branching in those files. Once Task 6 of this plan lands, outbound sending for `provider='evolution'` accounts works with **zero additional changes** to those 4 files — this plan only had to teach the factory to construct an `EvolutionProvider`. Likewise, `automations/meta-send.ts`'s `provider.id !== 'meta'` template guard (built in Phase 1 specifically anticipating this phase) now becomes live and meaningful for the first time. No task in this plan needed to touch any of those files.

## Roadmap (out of scope, deferred)

- Broadcast provider-awareness (Phase 3, per the Phase 1 design doc's roadmap).
- Routing the pre-existing legacy `src/app/api/whatsapp/broadcast/route.ts` and `src/app/api/whatsapp/react/route.ts` through the seam (surfaced during Phase 1's Task 7 review as a known gap, still open).
- Live validation of interactive buttons/lists on Evolution (this plan's Task 3/4 implement the documented shape but do not add a real-device test — declared risk, carried over from the design doc).
