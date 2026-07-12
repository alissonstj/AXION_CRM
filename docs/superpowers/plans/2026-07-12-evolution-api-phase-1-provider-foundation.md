# Evolution API — Fase 1: Fundação da abstração de provedor (lado Meta)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduzir a camada de "provedor de canal" e rotear todo o lado Meta (envio + recebimento) através dela, sem mudar comportamento — deixando o código pronto para o `EvolutionProvider` da Fase 2.

**Architecture:** Interface `ChannelProvider` (Strategy) em `src/lib/channels/`, com um único adaptador nesta fase — `MetaProvider`, que embrulha o `src/lib/whatsapp/meta-api.ts` existente sem tocar na lógica dele. Uma factory `getChannelForAccount(accountId, db)` resolve o adaptador pela coluna `provider` da `whatsapp_config`. O recebimento passa por um `ingestInbound` compartilhado; os 4 caminhos de envio trocam a chamada-folha do `meta-api` pela `provider.sender.*`. É um refactor **behavior-preserving**: todos os testes atuais continuam verdes.

**Tech Stack:** Next.js 16 (App Router, route handlers), TypeScript, Supabase (Postgres), Vitest. Tokens cifrados via `@/lib/whatsapp/encryption` (AES-256-GCM).

## Global Constraints

- **Behavior-preserving:** nenhum comportamento observável da Meta muda nesta fase. `npm test` e `npm run typecheck` passam ao fim de cada task; as 5 falhas pré-existentes de currency/date (locale da máquina) permanecem e não contam.
- **Um provedor ativo por conta:** o `UNIQUE(account_id)` de `whatsapp_config` é preservado.
- **Templates continuam Meta-only** — a interface `ChannelSender` NÃO tem `sendTemplate`; o envio de template segue no ramo Meta-específico do `send-message.ts`, fora da abstração.
- **A costura é `getChannelForAccount`:** depois desta fase, nenhum caller de envio/recebimento importa `@/lib/whatsapp/meta-api` diretamente (exceto o próprio `MetaProvider` e o ramo de template).
- **Next.js tem breaking changes:** antes de editar qualquer route handler, ler o guia relevante em `node_modules/next/dist/docs/` (instrução do AGENTS.md do repo).
- **Testes co-locados:** `*.test.ts` ao lado do fonte, padrão do repo. Mock de módulo com `vi.mock` (Vitest).
- **Mensagem de commit:** terminar com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

**Criar:**
- `src/lib/channels/types.ts` — tipos + interfaces (`ChannelProvider`, `ChannelSender`, `NormalizedInbound`, `ConnectionState`, `OutboundResult`, args de envio).
- `src/lib/channels/providers/meta.ts` — `MetaProvider` (sender + parseWebhook + lifecycle), embrulha `meta-api.ts`.
- `src/lib/channels/providers/meta.test.ts` — testes do MetaProvider.
- `src/lib/channels/factory.ts` — `getChannelForAccount(accountId, db)`.
- `src/lib/channels/factory.test.ts` — testes da factory.
- `src/lib/channels/ingest.ts` — `ingestInbound(normalized, ctx)` (a cauda provider-agnóstica extraída do webhook).
- `src/lib/channels/ingest.test.ts` — testes do ingest.
- `supabase/migrations/037_channel_provider.sql` — coluna `provider` + colunas Evolution nuláveis.

**Modificar:**
- `src/app/api/whatsapp/webhook/route.ts` — usar `MetaProvider.parseWebhook` + `ingestInbound`.
- `src/lib/whatsapp/send-message.ts` — rotear envio via `getChannelForAccount`.
- `src/lib/whatsapp/broadcast-core.ts` — idem.
- `src/lib/flows/meta-send.ts` — idem.
- `src/lib/automations/meta-send.ts` — idem.

---

## Task 1: Tipos e interfaces do canal

**Files:**
- Create: `src/lib/channels/types.ts`

**Interfaces:**
- Produces: `ChannelProviderId`, `OutboundResult`, `SendTextArgs`, `SendMediaArgs`, `SendInteractiveButtonsArgs`, `SendInteractiveListArgs`, `ChannelSender`, `InboundKind`, `NormalizedInbound`, `ConnectionState`, `ChannelProvider`.

- [ ] **Step 1: Escrever o arquivo de tipos**

Criar `src/lib/channels/types.ts`:

```ts
// Tipos e contratos da camada de provedor de canal.
// Nenhuma lógica aqui — só a costura que Meta e (na Fase 2) Evolution implementam.

export type ChannelProviderId = 'meta' | 'evolution';

/** Resultado de um envio. `workingRecipient` só vem preenchido quando o
 *  provedor corrigiu o número (ex.: retry de variante da Meta) — o caller
 *  persiste de volta no contato quando difere do enviado. */
export interface OutboundResult {
  providerMessageId: string;
  workingRecipient?: string;
}

export interface SendTextArgs {
  to: string;
  text: string;
  contextProviderMessageId?: string;
}

export type OutboundMediaKind = 'image' | 'video' | 'document' | 'audio';

export interface SendMediaArgs {
  to: string;
  kind: OutboundMediaKind;
  link: string;
  caption?: string;
  filename?: string;
  contextProviderMessageId?: string;
}

export interface OutboundButton {
  id: string;
  title: string;
}

export interface SendInteractiveButtonsArgs {
  to: string;
  bodyText: string;
  headerText?: string;
  footerText?: string;
  buttons: OutboundButton[];
  contextProviderMessageId?: string;
}

export interface OutboundListRow {
  id: string;
  title: string;
  description?: string;
}

export interface OutboundListSection {
  title?: string;
  rows: OutboundListRow[];
}

export interface SendInteractiveListArgs {
  to: string;
  bodyText: string;
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  sections: OutboundListSection[];
  contextProviderMessageId?: string;
}

export interface ChannelSender {
  sendText(args: SendTextArgs): Promise<OutboundResult>;
  sendMedia(args: SendMediaArgs): Promise<OutboundResult>;
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<OutboundResult>;
  sendInteractiveList(args: SendInteractiveListArgs): Promise<OutboundResult>;
}

export type InboundKind =
  | 'text' | 'image' | 'video' | 'document' | 'audio'
  | 'location' | 'interactive_reply' | 'reaction';

/** Forma interna comum que o ingest consome, independente de provedor. */
export interface NormalizedInbound {
  from: string;
  contactName?: string;
  providerMessageId: string;
  timestamp: Date;
  kind: InboundKind;
  text?: string | null;
  mediaUrl?: string | null;
  interactiveReplyId?: string | null;
  reaction?: { targetProviderMessageId: string; emoji: string } | null;
  replyToProviderMessageId?: string | null;
}

export interface ConnectionState {
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  /** Data-URL do QR, só durante `connecting` (Evolution). */
  qrCode?: string;
  detail?: string;
}

export interface ChannelProvider {
  readonly id: ChannelProviderId;
  readonly sender: ChannelSender;
  /** Traduz o payload de webhook do provedor para a forma interna. */
  parseWebhook(payload: unknown): NormalizedInbound[];
  connect(): Promise<ConnectionState>;
  getConnectionState(): Promise<ConnectionState>;
  disconnect(): Promise<void>;
}
```

- [ ] **Step 2: Rodar o typecheck (gate deste arquivo de tipos)**

Run: `npm run typecheck`
Expected: PASS (sem erros; arquivo compila).

- [ ] **Step 3: Commit**

```bash
git add src/lib/channels/types.ts
git commit -m "feat(channels): provider interface + normalized inbound types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `MetaProvider` — envio (sender)

**Files:**
- Create: `src/lib/channels/providers/meta.ts`
- Test: `src/lib/channels/providers/meta.test.ts`

**Interfaces:**
- Consumes: de `@/lib/whatsapp/meta-api` — `sendTextMessage`, `sendMediaMessage`, `sendInteractiveButtons`, `sendInteractiveList` (todas `(args) => Promise<{ messageId }>`); de `@/lib/whatsapp/phone-utils` — `phoneVariants(phone) => string[]`, `isRecipientNotAllowedError(msg) => boolean`. Tipos da Task 1.
- Produces: classe `MetaProvider` com `readonly sender: ChannelSender`. Construída com `MetaProviderConfig = { phoneNumberId: string; accessToken: string; wabaId?: string | null }`.

O retry de variante de telefone (hoje espalhado nos callers) migra para dentro do sender do MetaProvider. Cada método tenta as variantes de `to`; quando uma funciona e difere da original, devolve `workingRecipient` para o caller persistir.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/channels/providers/meta.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}));

import {
  sendTextMessage,
  sendMediaMessage,
} from '@/lib/whatsapp/meta-api';
import { MetaProvider } from './meta';

const cfg = { phoneNumberId: 'PNID', accessToken: 'TOKEN', wabaId: 'WABA' };

describe('MetaProvider.sender', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sendText maps args onto meta-api and returns the message id', async () => {
    vi.mocked(sendTextMessage).mockResolvedValue({ messageId: 'wamid.1' });
    const provider = new MetaProvider(cfg);

    const result = await provider.sender.sendText({
      to: '+15551234567',
      text: 'oi',
      contextProviderMessageId: 'wamid.parent',
    });

    expect(sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID',
      accessToken: 'TOKEN',
      to: '+15551234567',
      text: 'oi',
      contextMessageId: 'wamid.parent',
    });
    expect(result).toEqual({ providerMessageId: 'wamid.1' });
  });

  it('sendText retries the next phone variant on "recipient not allowed" and reports workingRecipient', async () => {
    vi.mocked(sendTextMessage)
      .mockRejectedValueOnce(new Error('(#131030) Recipient phone number not in allowed list'))
      .mockResolvedValueOnce({ messageId: 'wamid.2' });
    const provider = new MetaProvider(cfg);

    const result = await provider.sender.sendText({ to: '+5511987654321', text: 'oi' });

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(result.providerMessageId).toBe('wamid.2');
    expect(result.workingRecipient).toBeTruthy();
    expect(result.workingRecipient).not.toBe('+5511987654321');
  });

  it('sendMedia forwards kind/link/caption/filename', async () => {
    vi.mocked(sendMediaMessage).mockResolvedValue({ messageId: 'wamid.3' });
    const provider = new MetaProvider(cfg);

    await provider.sender.sendMedia({
      to: '+15551234567', kind: 'document', link: 'https://x/y.pdf',
      caption: 'nota', filename: 'y.pdf',
    });

    expect(sendMediaMessage).toHaveBeenCalledWith(expect.objectContaining({
      phoneNumberId: 'PNID', accessToken: 'TOKEN', to: '+15551234567',
      kind: 'document', link: 'https://x/y.pdf', caption: 'nota', filename: 'y.pdf',
    }));
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test -- src/lib/channels/providers/meta.test.ts`
Expected: FAIL — `Cannot find module './meta'` / `MetaProvider is not defined`.

- [ ] **Step 3: Implementar o `MetaProvider` (sender)**

Criar `src/lib/channels/providers/meta.ts`:

```ts
import {
  sendTextMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
} from '@/lib/whatsapp/meta-api';
import { phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils';
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

export interface MetaProviderConfig {
  phoneNumberId: string;
  accessToken: string;
  wabaId?: string | null;
}

/**
 * Roda `send` para cada variante de `to` até uma passar. Quando a Meta
 * rejeita com "recipient not allowed", tenta a próxima; qualquer outro
 * erro sobe imediatamente. Devolve o resultado + a variante que funcionou.
 */
async function withPhoneVariantRetry(
  to: string,
  send: (variant: string) => Promise<{ messageId: string }>,
): Promise<OutboundResult> {
  const variants = phoneVariants(to);
  let lastError: unknown = null;
  for (const variant of variants) {
    try {
      const { messageId } = await send(variant);
      return {
        providerMessageId: messageId,
        workingRecipient: variant !== to ? variant : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(message)) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error('Meta send failed for all phone variants');
}

export class MetaProvider implements ChannelProvider {
  readonly id: ChannelProviderId = 'meta';
  readonly sender: ChannelSender;

  constructor(private readonly config: MetaProviderConfig) {
    const { phoneNumberId, accessToken } = config;
    this.sender = {
      sendText: (args: SendTextArgs) =>
        withPhoneVariantRetry(args.to, (to) =>
          sendTextMessage({
            phoneNumberId, accessToken, to, text: args.text,
            contextMessageId: args.contextProviderMessageId,
          }),
        ),
      sendMedia: (args: SendMediaArgs) =>
        withPhoneVariantRetry(args.to, (to) =>
          sendMediaMessage({
            phoneNumberId, accessToken, to, kind: args.kind, link: args.link,
            caption: args.caption, filename: args.filename,
            contextMessageId: args.contextProviderMessageId,
          }),
        ),
      sendInteractiveButtons: (args: SendInteractiveButtonsArgs) =>
        withPhoneVariantRetry(args.to, (to) =>
          sendInteractiveButtons({
            phoneNumberId, accessToken, to, bodyText: args.bodyText,
            headerText: args.headerText, footerText: args.footerText,
            buttons: args.buttons, contextMessageId: args.contextProviderMessageId,
          }),
        ),
      sendInteractiveList: (args: SendInteractiveListArgs) =>
        withPhoneVariantRetry(args.to, (to) =>
          sendInteractiveList({
            phoneNumberId, accessToken, to, bodyText: args.bodyText,
            buttonLabel: args.buttonLabel, headerText: args.headerText,
            footerText: args.footerText, sections: args.sections,
            contextMessageId: args.contextProviderMessageId,
          }),
        ),
    };
  }

  // parseWebhook + lifecycle: implementados nas Tasks 3 e 4.
  parseWebhook(_payload: unknown): NormalizedInbound[] {
    throw new Error('not implemented — Task 3');
  }
  async connect(): Promise<ConnectionState> {
    throw new Error('not implemented — Task 4');
  }
  async getConnectionState(): Promise<ConnectionState> {
    throw new Error('not implemented — Task 4');
  }
  async disconnect(): Promise<void> {
    throw new Error('not implemented — Task 4');
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- src/lib/channels/providers/meta.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/providers/meta.ts src/lib/channels/providers/meta.test.ts
git commit -m "feat(channels): MetaProvider sender wrapping meta-api with variant retry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `MetaProvider.parseWebhook`

**Files:**
- Modify: `src/lib/channels/providers/meta.ts` (substituir o `parseWebhook` stub)
- Test: `src/lib/channels/providers/meta.test.ts` (adicionar describe)

**Interfaces:**
- Produces: `MetaProvider.parseWebhook(payload) => NormalizedInbound[]`. Traduz o shape `entry[].changes[].value.messages[]` da Meta. **Não** faz fetch de mídia (a resolução da URL de mídia continua no webhook via o proxy `/api/whatsapp/media/[id]` — o parser só marca `mediaUrl` com o caminho do proxy quando há `media_id`).

Nota: nesta fase o parser cobre o mapeamento tipo→`InboundKind` + text/interactive/reaction/reply. O comportamento de resolução/validação de mídia com a Meta permanece no `route.ts` (Task 6) para não mudar o fluxo de verificação existente.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar ao `src/lib/channels/providers/meta.test.ts`:

```ts
describe('MetaProvider.parseWebhook', () => {
  const provider = new MetaProvider(cfg);

  it('maps a text message', () => {
    const payload = {
      entry: [{ id: 'e', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'PNID', display_phone_number: '1' },
        contacts: [{ profile: { name: 'Ana' }, wa_id: '15551234567' }],
        messages: [{ id: 'wamid.a', from: '15551234567', timestamp: '1700000000', type: 'text', text: { body: 'oi' } }],
      } }] }],
    };
    const out = provider.parseWebhook(payload);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.a',
      kind: 'text', text: 'oi',
    });
    expect(out[0].timestamp).toBeInstanceOf(Date);
  });

  it('maps an interactive button reply to interactive_reply with the id', () => {
    const payload = { entry: [{ id: 'e', changes: [{ field: 'messages', value: {
      contacts: [{ profile: { name: 'Bo' }, wa_id: '15550000000' }],
      messages: [{ id: 'wamid.b', from: '15550000000', timestamp: '1700000001', type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Sim' } } }],
    } }] }] };
    const out = provider.parseWebhook(payload);
    expect(out[0]).toMatchObject({ kind: 'interactive_reply', interactiveReplyId: 'yes', text: 'Sim' });
  });

  it('maps a reaction with its target', () => {
    const payload = { entry: [{ id: 'e', changes: [{ field: 'messages', value: {
      contacts: [{ profile: { name: 'C' }, wa_id: '15550000001' }],
      messages: [{ id: 'wamid.c', from: '15550000001', timestamp: '1700000002', type: 'reaction',
        reaction: { message_id: 'wamid.target', emoji: '👍' } }],
    } }] }] };
    const out = provider.parseWebhook(payload);
    expect(out[0]).toMatchObject({ kind: 'reaction', reaction: { targetProviderMessageId: 'wamid.target', emoji: '👍' } });
  });

  it('ignores status-only and template change payloads (returns [])', () => {
    const statusPayload = { entry: [{ id: 'e', changes: [{ field: 'messages', value: {
      statuses: [{ id: 'wamid.s', status: 'delivered', timestamp: '1700000003', recipient_id: '1' }],
    } }] }] };
    expect(provider.parseWebhook(statusPayload)).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test -- src/lib/channels/providers/meta.test.ts`
Expected: FAIL — `not implemented — Task 3`.

- [ ] **Step 3: Implementar o `parseWebhook`**

Substituir o método stub `parseWebhook` em `src/lib/channels/providers/meta.ts` por:

```ts
  parseWebhook(payload: unknown): NormalizedInbound[] {
    const body = payload as { entry?: MetaEntry[] } | null;
    if (!body?.entry) return [];
    const out: NormalizedInbound[] = [];
    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        if (!value.messages || !value.contacts) continue; // status/template → ignora
        for (let i = 0; i < value.messages.length; i++) {
          const m = value.messages[i];
          const contact = value.contacts[i] ?? value.contacts[0];
          out.push(mapMetaMessage(m, contact));
        }
      }
    }
    return out;
  }
```

Adicionar, no fim de `src/lib/channels/providers/meta.ts`, os helpers + tipos locais:

```ts
// ---- Shapes de entrada da Meta (subconjunto que usamos) ----
interface MetaContact { profile?: { name?: string }; wa_id: string }
interface MetaMessage {
  id: string; from: string; timestamp: string; type: string;
  text?: { body: string };
  image?: { id: string; caption?: string };
  video?: { id: string; caption?: string };
  document?: { id: string; filename?: string; caption?: string };
  audio?: { id: string };
  sticker?: { id: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { message_id: string; emoji: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  context?: { id: string };
}
interface MetaEntry {
  changes?: Array<{ field: string; value: {
    contacts?: MetaContact[];
    messages?: MetaMessage[];
    statuses?: unknown[];
  } }>;
}

const META_TO_INBOUND_KIND: Record<string, InboundKind> = {
  text: 'text', image: 'image', video: 'video', document: 'document',
  audio: 'audio', sticker: 'image', location: 'location',
  interactive: 'interactive_reply', reaction: 'reaction',
};

/** Marca `mediaUrl` com o caminho do proxy quando há media_id; a
 *  verificação/resolução real acontece no route handler (não muda). */
function mediaProxyPath(id?: string): string | null {
  return id ? `/api/whatsapp/media/${id}` : null;
}

function mapMetaMessage(m: MetaMessage, contact: MetaContact): NormalizedInbound {
  const base = {
    from: m.from,
    contactName: contact.profile?.name,
    providerMessageId: m.id,
    timestamp: new Date(parseInt(m.timestamp, 10) * 1000),
    replyToProviderMessageId: m.context?.id ?? null,
  };
  const kind = META_TO_INBOUND_KIND[m.type] ?? 'text';

  switch (m.type) {
    case 'text':
      return { ...base, kind, text: m.text?.body ?? null };
    case 'image':
      return { ...base, kind, text: m.image?.caption ?? null, mediaUrl: mediaProxyPath(m.image?.id) };
    case 'video':
      return { ...base, kind, text: m.video?.caption ?? null, mediaUrl: mediaProxyPath(m.video?.id) };
    case 'document':
      return { ...base, kind, text: m.document?.caption ?? m.document?.filename ?? null, mediaUrl: mediaProxyPath(m.document?.id) };
    case 'audio':
      return { ...base, kind, mediaUrl: mediaProxyPath(m.audio?.id) };
    case 'sticker':
      return { ...base, kind, mediaUrl: mediaProxyPath(m.sticker?.id) };
    case 'location': {
      const loc = m.location;
      const text = loc ? [loc.name, loc.address, `${loc.latitude},${loc.longitude}`].filter(Boolean).join(' - ') : null;
      return { ...base, kind, text };
    }
    case 'reaction':
      return { ...base, kind, reaction: m.reaction ? { targetProviderMessageId: m.reaction.message_id, emoji: m.reaction.emoji } : null };
    case 'interactive': {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return { ...base, kind, text: reply?.title ?? reply?.id ?? '[Interactive reply]', interactiveReplyId: reply?.id ?? null };
    }
    default:
      return { ...base, kind: 'text', text: `[Unsupported message type: ${m.type}]` };
  }
}
```

Adicionar `InboundKind` ao import de tipos no topo do arquivo (junto de `NormalizedInbound` etc.).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- src/lib/channels/providers/meta.test.ts`
Expected: PASS (todos, incl. os 4 novos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/providers/meta.ts src/lib/channels/providers/meta.test.ts
git commit -m "feat(channels): MetaProvider.parseWebhook maps Meta shape to NormalizedInbound

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `MetaProvider` — ciclo de vida (connect/state/disconnect)

**Files:**
- Modify: `src/lib/channels/providers/meta.ts` (substituir os 3 stubs de lifecycle)
- Test: `src/lib/channels/providers/meta.test.ts`

**Interfaces:**
- Consumes: de `@/lib/whatsapp/meta-api` — `verifyPhoneNumber`, `registerPhoneNumber`, `subscribeWabaToApp`.
- Produces: `connect()` (verifica o número e, se `pin`/`wabaId` disponíveis, registra + subscribe — mas nesta fase o registro segue sendo disparado pela rota de config existente, então `connect()` só faz `verifyPhoneNumber` e devolve `connected`/`error`); `getConnectionState()` (verifica metadata → `connected`/`error`); `disconnect()` (no-op para Meta — o reset de credenciais segue na rota `DELETE /api/whatsapp/config`).

Racional: na Meta a conexão é por credenciais estáticas e o registro já tem seu próprio fluxo (rota `verify-registration`). Para **não duplicar nem mudar** esse fluxo nesta fase, o lifecycle do MetaProvider só reporta estado de conexão; o QR/registro real da Evolution é que vai exercitar esses métodos de verdade na Fase 2.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar ao `meta.test.ts` (estender o `vi.mock` de `meta-api` para incluir `verifyPhoneNumber`):

```ts
// No vi.mock('@/lib/whatsapp/meta-api', ...), adicionar:
//   verifyPhoneNumber: vi.fn(),
// e importar verifyPhoneNumber junto dos demais.

describe('MetaProvider lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getConnectionState returns connected when Meta verifies the number', async () => {
    vi.mocked(verifyPhoneNumber).mockResolvedValue({ id: 'PNID', display_phone_number: '+1 555' });
    const provider = new MetaProvider(cfg);
    const state = await provider.getConnectionState();
    expect(state.status).toBe('connected');
    expect(verifyPhoneNumber).toHaveBeenCalledWith({ phoneNumberId: 'PNID', accessToken: 'TOKEN' });
  });

  it('getConnectionState returns error when Meta rejects', async () => {
    vi.mocked(verifyPhoneNumber).mockRejectedValue(new Error('Invalid OAuth token'));
    const provider = new MetaProvider(cfg);
    const state = await provider.getConnectionState();
    expect(state.status).toBe('error');
    expect(state.detail).toContain('Invalid OAuth token');
  });

  it('disconnect is a no-op for Meta (does not throw)', async () => {
    const provider = new MetaProvider(cfg);
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test -- src/lib/channels/providers/meta.test.ts`
Expected: FAIL — `not implemented — Task 4`.

- [ ] **Step 3: Implementar o lifecycle**

Adicionar `verifyPhoneNumber` ao import de `@/lib/whatsapp/meta-api` no topo de `meta.ts`. Substituir os 3 stubs por:

```ts
  async connect(): Promise<ConnectionState> {
    return this.getConnectionState();
  }

  async getConnectionState(): Promise<ConnectionState> {
    try {
      const info = await verifyPhoneNumber({
        phoneNumberId: this.config.phoneNumberId,
        accessToken: this.config.accessToken,
      });
      return { status: 'connected', detail: info.display_phone_number };
    } catch (err) {
      return { status: 'error', detail: err instanceof Error ? err.message : 'Meta verification failed' };
    }
  }

  async disconnect(): Promise<void> {
    // Meta: sem sessão para encerrar — o reset de credenciais segue na
    // rota DELETE /api/whatsapp/config. No-op intencional.
  }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- src/lib/channels/providers/meta.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/providers/meta.ts src/lib/channels/providers/meta.test.ts
git commit -m "feat(channels): MetaProvider connection-state lifecycle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Migration de schema + factory `getChannelForAccount`

**Files:**
- Create: `supabase/migrations/037_channel_provider.sql`
- Create: `src/lib/channels/factory.ts`
- Test: `src/lib/channels/factory.test.ts`

**Interfaces:**
- Consumes: `MetaProvider` (Task 2). `decrypt` de `@/lib/whatsapp/encryption`.
- Produces: `getChannelForAccount(accountId: string, db: SupabaseClient) => Promise<ChannelProvider>`. Lê `whatsapp_config` por `account_id`, decripta o `access_token`, e devolve o adaptador do `provider` (nesta fase só `'meta'`; `'evolution'` lança `ChannelNotImplementedError` até a Fase 2). Também exporta `ChannelConfigError` (config ausente).

- [ ] **Step 1: Escrever a migration**

Criar `supabase/migrations/037_channel_provider.sql`:

```sql
-- ============================================================
-- whatsapp_config: generalizar para múltiplos provedores de canal.
--
-- MVP: um provedor ativo por conta (UNIQUE(account_id) preservado).
-- Linhas existentes ficam com provider='meta' (default) e leem as
-- mesmas colunas de sempre — zero mudança para o caminho Meta.
--
-- Colunas Evolution ficam nuláveis; usadas só quando provider='evolution'
-- (Fase 2). A base URL + API key global do servidor Evolution NÃO ficam
-- aqui — são env vars (EVOLUTION_API_URL / EVOLUTION_API_KEY).
--
-- Idempotente — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'evolution')),
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS evolution_connection_state TEXT,
  ADD COLUMN IF NOT EXISTS evolution_connected_at TIMESTAMPTZ;

-- O webhook da Evolution resolve a conta pelo nome da instância —
-- espelha como o webhook Meta resolve por phone_number_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_evolution_instance
  ON whatsapp_config (evolution_instance_name)
  WHERE evolution_instance_name IS NOT NULL;
```

- [ ] **Step 2: Escrever o teste que falha (factory)**

Criar `src/lib/channels/factory.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace('enc:', ''),
}));

import { getChannelForAccount, ChannelConfigError } from './factory';
import { MetaProvider } from './providers/meta';

function dbReturning(row: unknown) {
  // Stub mínimo do query-builder do supabase-js usado pela factory:
  // db.from(...).select(...).eq(...).maybeSingle() => { data, error }
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => chain } as never;
}

describe('getChannelForAccount', () => {
  it('returns a MetaProvider for a provider=meta row', async () => {
    const db = dbReturning({
      provider: 'meta', phone_number_id: 'PNID',
      access_token: 'enc:TOKEN', waba_id: 'WABA',
    });
    const provider = await getChannelForAccount('acc-1', db);
    expect(provider).toBeInstanceOf(MetaProvider);
    expect(provider.id).toBe('meta');
  });

  it('throws ChannelConfigError when no config row exists', async () => {
    const db = dbReturning(null);
    await expect(getChannelForAccount('acc-x', db)).rejects.toBeInstanceOf(ChannelConfigError);
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npm test -- src/lib/channels/factory.test.ts`
Expected: FAIL — `Cannot find module './factory'`.

- [ ] **Step 4: Implementar a factory**

Criar `src/lib/channels/factory.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { MetaProvider } from './providers/meta';
import type { ChannelProvider } from './types';

/** Config de canal ausente para a conta. */
export class ChannelConfigError extends Error {
  constructor(accountId: string) {
    super(`No channel config for account ${accountId}`);
    this.name = 'ChannelConfigError';
  }
}

/** Provedor ainda não implementado nesta fase (Evolution → Fase 2). */
export class ChannelNotImplementedError extends Error {
  constructor(provider: string) {
    super(`Channel provider "${provider}" is not implemented yet`);
    this.name = 'ChannelNotImplementedError';
  }
}

/**
 * Resolve o provedor de canal ativo da conta. Costura única entre os
 * callers e a implementação de provedor — o formato de armazenamento
 * pode mudar aqui embaixo sem tocar em nenhum caller.
 */
export async function getChannelForAccount(
  accountId: string,
  db: SupabaseClient,
): Promise<ChannelProvider> {
  const { data: config } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!config) throw new ChannelConfigError(accountId);

  const provider = (config.provider as string) ?? 'meta';
  if (provider === 'meta') {
    return new MetaProvider({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      wabaId: config.waba_id ?? null,
    });
  }
  throw new ChannelNotImplementedError(provider);
}
```

- [ ] **Step 5: Rodar, confirmar que passa, e aplicar a migration localmente**

Run: `npm test -- src/lib/channels/factory.test.ts`
Expected: PASS (2 testes).

Aplicar a migration no Supabase local/dev (a forma como o repo aplica migrations — via o SQL editor do Supabase ou a CLI configurada pelo operador). Confirmar que a coluna existe:
Run (psql/SQL editor): `SELECT provider FROM whatsapp_config LIMIT 1;`
Expected: coluna existe, linhas retornam `meta`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/037_channel_provider.sql src/lib/channels/factory.ts src/lib/channels/factory.test.ts
git commit -m "feat(channels): provider column + getChannelForAccount factory

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Extrair `ingestInbound` e rotear o webhook Meta por ele

**Files:**
- Create: `src/lib/channels/ingest.ts`
- Test: `src/lib/channels/ingest.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`

**Interfaces:**
- Consumes: `NormalizedInbound` (Task 1). Os mesmos helpers que o `processMessage` usa hoje (find-or-create de contato/conversa, dispatch de engines) — movidos, não reescritos.
- Produces: `ingestInbound(inbound: NormalizedInbound, ctx: IngestContext) => Promise<void>`, onde `IngestContext = { accountId: string; configOwnerUserId: string; db: SupabaseClient }`.

Esta é a extração provider-agnóstica. **É um move behavior-preserving** — a lógica de persistência + dispatch sai do `processMessage` e vira `ingestInbound`; o `route.ts` passa a montar `NormalizedInbound` via `MetaProvider.parseWebhook` e chamar `ingestInbound`. A resolução de mídia com a Meta (verify + proxy) permanece no `route.ts` antes de chamar o ingest (ver Step 3).

**Antes de editar o route handler:** ler `node_modules/next/dist/docs/` na parte de route handlers (constraint global).

- [ ] **Step 1: Escrever o teste que falha (ingest)**

Criar `src/lib/channels/ingest.test.ts`. Testa que, dado um `NormalizedInbound` de texto e uma conta, o ingest insere um contato, uma conversa e uma mensagem. Usa um fake do supabase-admin client que registra os inserts. (O padrão exato de fake segue os testes de webhook atuais em `src/app/api/whatsapp/webhook/` — reusar o mesmo estilo de stub que já existe no repo.)

```ts
import { describe, it, expect, vi } from 'vitest';

// Os engines são fire-and-forget; mocká-los para no-op mantém o teste
// focado na persistência.
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn().mockResolvedValue({ consumed: false }) }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn().mockResolvedValue(null),
  isUniqueViolation: () => false,
}));

import { ingestInbound } from './ingest';

// fakeDb: grava inserts numa lista e devolve linhas com id. Seguir o
// padrão real do repo — stub Supabase encadeável, scriptado por tabela —
// como em src/lib/whatsapp/resolve-conversation.test.ts (função
// `makeDb(script)` naquele arquivo). Não existe teste em
// src/app/api/whatsapp/webhook/ hoje (só route.ts) — não procurar um
// stub reexportável de lá.

describe('ingestInbound', () => {
  it('creates contact + conversation + message for a text inbound', async () => {
    const inserts: Record<string, unknown[]> = { contacts: [], conversations: [], messages: [] };
    const db = makeFakeDb(inserts); // helper local do teste (ver nota acima)
    await ingestInbound(
      { from: '15551234567', contactName: 'Ana', providerMessageId: 'wamid.a',
        timestamp: new Date(), kind: 'text', text: 'oi' },
      { accountId: 'acc-1', configOwnerUserId: 'user-1', db },
    );
    expect(inserts.messages).toHaveLength(1);
    expect(inserts.messages[0]).toMatchObject({ content_type: 'text', content_text: 'oi', sender_type: 'customer' });
  });
});
```

Nota para o implementador: `makeFakeDb` é um helper local deste arquivo de teste (o repo não tem um util de teste compartilhado — cada arquivo escreve o seu). Copiar a forma de `makeDb(script)` em `src/lib/whatsapp/resolve-conversation.test.ts`: builder encadeável (`select/insert/update/eq/order/limit` retornam o próprio builder) que resolve nos métodos terminais (`maybeSingle`/`single`/`limit`) conforme um `script` por tabela passado no teste.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm test -- src/lib/channels/ingest.test.ts`
Expected: FAIL — `Cannot find module './ingest'`.

- [ ] **Step 3: Implementar `ingestInbound` movendo a cauda do `processMessage`**

Criar `src/lib/channels/ingest.ts` movendo — **sem reescrever** — de `src/app/api/whatsapp/webhook/route.ts` os blocos: `findOrCreateContact`, `findOrCreateConversation`, `handleReaction`, `lookupInternalIdByMetaId`, `flagBroadcastReplyIfAny`, o mapeamento de `content_type` (`ALLOWED_CONTENT_TYPES`), o insert em `messages`, o update de `conversations`, e o dispatch (`dispatchInboundToFlows`, `runAutomationsForTrigger`, `dispatchInboundToAiReply`, `dispatchWebhookEvent`). A assinatura vira:

```ts
export interface IngestContext {
  accountId: string;
  configOwnerUserId: string;
  db: SupabaseClient;
}

export async function ingestInbound(inbound: NormalizedInbound, ctx: IngestContext): Promise<void> {
  // ... corpo movido do processMessage, mas lendo de `inbound.*`
  // (inbound.from, inbound.kind, inbound.text, inbound.mediaUrl,
  //  inbound.interactiveReplyId, inbound.reaction, inbound.replyToProviderMessageId,
  //  inbound.providerMessageId, inbound.timestamp) em vez do shape cru da Meta.
}
```

Mapeamentos ao mover:
- `message.type === 'reaction'` → `inbound.kind === 'reaction'` (usa `inbound.reaction`).
- `interactiveReplyId` → `inbound.interactiveReplyId`.
- `message.id` (wamid) → `inbound.providerMessageId`.
- `contentText`/`mediaUrl` → `inbound.text`/`inbound.mediaUrl`.
- `message.context?.id` (reply) → `inbound.replyToProviderMessageId`.
- `new Date(parseInt(message.timestamp)*1000)` → `inbound.timestamp`.
- O `content_type` gravado: reusar o `ALLOWED_CONTENT_TYPES` já existente, mapeando `inbound.kind` (`interactive_reply` → `'interactive'`, os demais 1:1).

- [ ] **Step 4: Refatorar o `route.ts` para usar parseWebhook + ingestInbound**

Em `src/app/api/whatsapp/webhook/route.ts`, dentro do `processWebhook`, substituir a chamada a `processMessage(...)` por: construir a lista via `new MetaProvider({ phoneNumberId, accessToken: decryptedAccessToken }).parseWebhook(body)` **filtrada para esta config** e, para cada `NormalizedInbound`, resolver a mídia Meta (o passo `verifyAndBuildUrl` atual, que valida o `media_id` e mantém `/api/whatsapp/media/<id>`) e chamar `ingestInbound(inbound, { accountId: config.account_id, configOwnerUserId: config.user_id, db: supabaseAdmin() })`. Manter intactos: verificação de assinatura HMAC (GET + POST), o `handleStatusUpdate` (status ladder) e o roteamento de eventos de template (`isTemplateWebhookField`). Remover do `route.ts` as funções movidas para o `ingest.ts` (importá-las de lá se ainda referenciadas, ou apagá-las).

Nota: como o `route.ts` já resolve UMA config por `phone_number_id`, e o `parseWebhook` mapeia todas as mensagens do payload, filtrar por `change.value.metadata.phone_number_id === config.phone_number_id` ao montar a lista mantém o roteamento por número idêntico ao de hoje.

- [ ] **Step 5: Rodar TODA a suíte e confirmar verde**

Run: `npm test`
Expected: o novo `ingest.test.ts` PASS + toda a suíte (não há testes dedicados a `src/app/api/whatsapp/webhook/route.ts` hoje — nada a preservar nesse arquivo além do typecheck e do teste manual do Step 6). As 5 falhas pré-existentes de currency/date permanecem (não relacionadas).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Verificação de runtime (behavior-preserving)**

Com o dev server rodando e uma config Meta válida, enviar uma mensagem de teste para o número e confirmar no inbox que ela aparece igual a antes (contato/conversa/mensagem criados). Se não houver ambiente Meta real disponível, registrar isso explicitamente e confiar na suíte de testes de webhook migrada.

- [ ] **Step 7: Commit**

```bash
git add src/lib/channels/ingest.ts src/lib/channels/ingest.test.ts "src/app/api/whatsapp/webhook/route.ts"
git commit -m "refactor(channels): extract ingestInbound; route Meta webhook through it

Behavior-preserving: persistence + engine dispatch moved out of the
webhook route into a provider-agnostic ingestInbound; the Meta webhook
now builds NormalizedInbound via MetaProvider.parseWebhook and calls it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Rotear os 4 caminhos de envio pela costura

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts`
- Modify: `src/lib/whatsapp/broadcast-core.ts`
- Modify: `src/lib/flows/meta-send.ts`
- Modify: `src/lib/automations/meta-send.ts`

**Interfaces:**
- Consumes: `getChannelForAccount(accountId, db)` (Task 5) → `provider.sender.{sendText,sendMedia,sendInteractiveButtons,sendInteractiveList}` (Tasks 1–2). `OutboundResult.workingRecipient` para persistir o número corrigido.

Em cada arquivo, a troca é a mesma: onde hoje chama `sendTextMessage/sendMediaMessage/sendInteractive*` do `meta-api` (dentro do loop de `phoneVariants`), passar a resolver o provider uma vez e chamar `provider.sender.*` — que **já faz o retry de variante internamente** e devolve `workingRecipient`. Remover o loop de variante local (agora dono do provider). O envio de **template** em `send-message.ts` permanece chamando `sendTemplateMessage` do `meta-api` diretamente (templates são Meta-only, fora da interface).

**Behavior-preserving:** a persistência em `messages`, updates de conversa e pausa de flow ficam idênticos.

- [ ] **Step 1: `send-message.ts` — rotear texto/mídia/interativo pelo provider**

Em `src/lib/whatsapp/send-message.ts`, dentro de `sendMessageToConversation`, substituir o bloco `attempt(phone)` + o loop `for (const variant of variants)` por: resolver `const provider = await getChannelForAccount(accountId, db)` e chamar o método certo do `provider.sender` conforme `messageType`, **exceto** `template` (que continua no `attempt` chamando `sendTemplateMessage`). Capturar `workingRecipient` do `OutboundResult`; se presente e diferente de `sanitizedPhone`, fazer o mesmo update de `contacts.phone` que já existe. Manter todo o resto (validação, carregamento de conversa/contato/config, insert em `messages`, update de `conversations`, pausa de flow) intacto.

Import a adicionar: `import { getChannelForAccount } from '@/lib/channels/factory'`. Remover imports de `meta-api` que ficarem sem uso (manter `sendTemplateMessage`).

- [ ] **Step 2: Rodar os testes de send-message**

Run: `npm test -- src/lib/whatsapp/send-message.test.ts src/app/api/whatsapp/send/route.test.ts`
Expected: PASS (comportamento inalterado). Ajustar apenas mocks que referenciavam `meta-api` diretamente para agora mockar `@/lib/channels/factory` retornando um provider fake — sem mudar as asserções de comportamento.

- [ ] **Step 3: Commit**

```bash
git add src/lib/whatsapp/send-message.ts src/lib/whatsapp/send-message.test.ts
git commit -m "refactor(channels): route send-message.ts through the channel provider

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: `broadcast-core.ts` — mesma troca de folha**

Em `src/lib/whatsapp/broadcast-core.ts`, trocar a chamada direta ao `meta-api` (o envio de cada destinatário) por `provider.sender.*` via `getChannelForAccount`, resolvendo o provider uma vez por broadcast. Broadcast hoje é sempre template (Meta) — o envio de template permanece direto no `meta-api` (fora da interface); apenas texto/mídia (se houver) roteia pelo provider. Persistência de `broadcast_recipients` inalterada.

Run: `npm test -- src/lib/whatsapp/broadcast-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/broadcast-core.ts src/lib/whatsapp/broadcast-core.test.ts
git commit -m "refactor(channels): route broadcast-core.ts non-template sends through the provider

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: `flows/meta-send.ts` — rotear texto/mídia/interativo**

Em `src/lib/flows/meta-send.ts`, substituir as chamadas ao `meta-api` (`sendTextMessage`, `sendMediaMessage`, `sendInteractiveButtons`, `sendInteractiveList`) por `provider.sender.*` via `getChannelForAccount(accountId, supabaseAdmin())`, removendo o loop de `phoneVariants` local (agora no provider). Persistência da mensagem + retorno inalterados. Renomear/mover não é necessário — só a folha.

Run: `npm test -- src/lib/flows/meta-send.test.ts` (se existir; senão, `npm test -- src/lib/flows`)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/meta-send.ts
git commit -m "refactor(channels): route flows send path through the provider

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 8: `automations/meta-send.ts` — rotear texto (template continua Meta-only)**

Em `src/lib/automations/meta-send.ts`, trocar `sendTextMessage` por `provider.sender.sendText` via `getChannelForAccount`. As chamadas interativas já delegam a `flows/meta-send.ts` (Step 6), então herdam a troca. O `send_template` (`sendTemplateMessage`) permanece direto no `meta-api` — templates são Meta-only; adicionar, no caminho de template, uma checagem: se `provider.id !== 'meta'`, lançar um erro claro ("templates exigem o provedor Meta") registrado no log da execução (comportamento definido no spec; exercitado de verdade só quando Evolution existir, mas o guard entra agora).

Run: `npm test -- src/lib/automations/meta-send.test.ts` (ou `npm test -- src/lib/automations`)
Expected: PASS.

- [ ] **Step 9: Rodar a suíte completa + typecheck (gate final da fase)**

Run: `npm test`
Expected: verde, exceto as 5 falhas pré-existentes de currency/date.

Run: `npm run typecheck`
Expected: PASS.

Confirmar a constraint global: `grep -rn "from '@/lib/whatsapp/meta-api'" src/lib src/app` não deve retornar nenhum caller de envio/recebimento além de `src/lib/channels/providers/meta.ts`, o ramo de template em `send-message.ts`/`automations/meta-send.ts`, e as rotas de config/templates (que não são caminhos de mensagem).

- [ ] **Step 10: Commit**

```bash
git add src/lib/automations/meta-send.ts
git commit -m "refactor(channels): route automations send path through the provider; guard template on non-Meta

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (do plano contra o spec)

- **Cobertura do spec (Fase 1):** interface `ChannelProvider` (Task 1) ✓; `MetaProvider` embrulhando `meta-api` sem mudar lógica (Tasks 2–4) ✓; retry de variante migrado para dentro do MetaProvider (Task 2) ✓; modelo de dados `provider` + colunas Evolution + índice de instância (Task 5) ✓; factory `getChannelForAccount` como costura (Task 5) ✓; `ingestInbound` extraído + webhook Meta roteado por ele (Task 6) ✓; 4 caminhos de envio pela costura, template Meta-only preservado (Task 7) ✓; behavior-preserving verificado por `npm test` a cada task ✓. **Fora desta fase (por design):** `EvolutionProvider`, rotas connect/state/webhook Evolution, tela de Config com QR, broadcast provider-aware — Planos 2 e 3.
- **Placeholders:** nenhum "TBD/TODO"; os stubs `not implemented — Task N` são intencionais e substituídos dentro do mesmo plano (Tasks 3 e 4).
- **Consistência de tipos:** `OutboundResult.workingRecipient` (Task 1) é produzido pelo sender (Task 2) e consumido no roteamento (Task 7); `NormalizedInbound` (Task 1) é produzido por `parseWebhook` (Task 3) e consumido por `ingestInbound` (Task 6); `getChannelForAccount` (Task 5) é consumido nas Tasks 6–7. Nomes batem.

## Roadmap das próximas fases (planos a escrever depois)

- **Plano 2 — EvolutionProvider + conexão + tela com QR.** Requer fixar a versão-alvo da Evolution API e validar os payloads reais de `messages.upsert`/`messages.update`, o formato de mídia (base64 vs URL) e a autenticação do webhook (riscos 2 e 3 do spec). Entrega: `EvolutionProvider` (sender + parseWebhook + lifecycle com create-instance/connect/QR/state/logout), rotas `POST /api/channels/evolution/connect`, `GET /api/channels/evolution/state`, `POST /api/channels/evolution/webhook`, e a reorganização da tela (`channel-settings` + `meta-config` + `evolution-connect`). Env vars `EVOLUTION_API_URL`/`EVOLUTION_API_KEY`.
- **Plano 3 — Broadcast provider-aware.** Wizard ramifica por provedor (template na Meta, texto/mídia livre na Evolution) e `broadcast-core.ts` ganha o caminho não-template completo.
