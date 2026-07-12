# Evolution API como segundo provedor de canal WhatsApp — Design

**Data:** 2026-07-12
**Status:** Aprovado (design), pendente de plano de implementação
**Autor:** brainstorming colaborativo (Claude + mantenedor)

## Contexto e objetivo

O CRM hoje conecta ao WhatsApp exclusivamente pela **Meta Cloud API** (API
oficial). Queremos adicionar um segundo provedor: a **Evolution API** (API
não-oficial), que conecta via **QR Code** — o usuário escaneia com o celular
para vincular o número, direto na tela de Configurações. O usuário escolhe,
ali, qual provedor usar.

Objetivo deste trabalho: introduzir uma camada de "provedor de canal" que
isole Meta vs. Evolution **sem quebrar o que já funciona com a Meta** e sem
duplicar lógica.

## Decisões estruturantes

Tomadas no brainstorming, cada uma molda o design:

1. **Coexistência — um provedor ativo por conta (MVP), schema modelado como
   "canais" para o futuro.** A conta escolhe Meta OU Evolution; conectar um
   substitui/desativa o outro. Mantemos o `UNIQUE(account_id)`. O schema é
   desenhado de forma que suportar múltiplos provedores simultâneos depois
   seja aditivo, não uma reescrita.

2. **Escopo — Evolution é canal de primeira classe (inbox + engines), sem
   templates.** Enviar/receber texto, mídia e mensagens interativas
   (botões/listas); flows, automações e broadcasts funcionam na Evolution. O
   conceito de "template aprovado pela Meta" continua **exclusivo da Meta**.

3. **Infra — um servidor Evolution por deployment (env vars).** O operador
   sobe UM servidor Evolution para a instância toda; `EVOLUTION_API_URL` +
   `EVOLUTION_API_KEY` ficam em variáveis de ambiente (igual aos segredos da
   Meta / Supabase hoje). Cada conta ganha sua própria instância nesse
   servidor. Na tela de Config, o usuário final só escaneia o QR — nenhum
   campo de infra exposto.

4. **Broadcast na Evolution — texto/mídia livre.** Como a Evolution não tem
   templates, o wizard de broadcast troca o passo "escolher template" por um
   editor de texto/mídia livre quando a conta está em Evolution (a Evolution
   não tem janela de 24h nem aprovação). Broadcast funciona nos dois
   provedores, com wizards diferentes por provedor.

## Abordagem escolhida

**Abordagem A — Interface de provedor + adaptadores (Strategy), enxuta.**

Introduz uma interface `ChannelProvider` com duas implementações
(`MetaProvider` embrulhando o código Meta atual, `EvolutionProvider` novo) e
uma factory por conta. Nos caminhos de envio, troca-se apenas a *folha* da
chamada (de `meta-api.ts` direto para `provider.sender.*`), mantendo a
estrutura de cada caminho intacta.

Rejeitadas:
- **B (condicionais `if provider === ...` espalhados):** rápido no dia 1, mas
  espalha ramos por todo lugar e nunca materializa a abstração de canais.
- **C (convergência total dos 4 caminhos de envio num único channel-service):**
  melhor estado final, mas reescreve os caminhos de broadcast/flow/automação
  que já funcionam com a Meta — risco de regressão que queremos evitar. Fica
  como refactor **posterior e opcional**, viabilizado pela costura da
  Abordagem A.

## Estado atual mapeado (ponto de partida)

- **Lógica Meta:** `src/lib/whatsapp/meta-api.ts` é o cliente HTTP puro
  (`fetch` → `graph.facebook.com/v21.0`). Apoio: `encryption.ts`,
  `phone-utils.ts` (variantes E.164 + retry), `webhook-signature.ts`,
  `registration.ts`, `template-*`.
- **Não existe camada de provedor.** `phone_number_id` + `access_token` +
  `graph.facebook.com` estão espalhados.
- **4 caminhos de envio paralelos** chamam `meta-api.ts` direto, cada um
  reimplementando retry de variante de telefone + persistência:
  `send-message.ts` (inbox + API pública), `broadcast-core.ts`,
  `flows/meta-send.ts`, `automations/meta-send.ts`.
- **Config:** tabela `whatsapp_config`, `UNIQUE(account_id)` (migration 017),
  toda modelada em conceitos Meta. UI em
  `src/components/settings/whatsapp-config.tsx` (~840 linhas, 100% Meta).
- **Webhook:** `src/app/api/whatsapp/webhook/route.ts` — verifica assinatura
  HMAC, responde 200 rápido, processa em `after()`. Resolve a conta pelo
  `phone_number_id`, depois `findOrCreateContact` → `findOrCreateConversation`
  → `parseMessageContent` → insere em `messages` → dispara engines
  (flows/automations/ai-reply/webhooks-de-saída).
- **Tabelas de dados:** `contacts`, `conversations`, `messages` (com
  `message_id` = wamid da Meta, `content_type`, `sender_type`,
  `interactive_reply_id`), `message_reactions`, `broadcast_recipients`.

## Design

### 1. A costura: interface `ChannelProvider` (nova pasta `src/lib/channels/`)

Três responsabilidades separadas para nenhum adaptador virar monólito:

**Envio (`ChannelSender`):**
```
sendText(args)                 → { providerMessageId }
sendMedia(args)                → { providerMessageId }
sendInteractiveButtons(args)   → { providerMessageId }
sendInteractiveList(args)      → { providerMessageId }
```
Sem `sendTemplate` — templates são exclusivos da Meta e continuam num ramo
Meta-específico fora da interface.

**Ciclo de vida (`ChannelLifecycle`):**
```
connect(accountId)            → ConnectionState   // Meta: verify+register; Evolution: cria instância + devolve QR
getConnectionState(accountId) → ConnectionState   // { status, qrCode?, detail? }
disconnect(accountId)         → void              // Meta: reset; Evolution: logout + delete instance
```

**Entrada (parser):** `parseWebhook(payload) → NormalizedInbound[]` — cada
provedor traduz o *seu* formato de webhook para uma forma interna comum:
```
NormalizedInbound = {
  from, contactName?, providerMessageId, timestamp,
  kind: 'text'|'image'|'video'|'document'|'audio'|'location'|'interactive_reply'|'reaction',
  text?, mediaUrl?, interactiveReplyId?, reaction?, replyToProviderId?
}
```

**Implementações:** `MetaProvider` (embrulha `meta-api.ts` — zero mudança na
lógica Meta; o retry de variante de telefone migra para dentro dele) e
`EvolutionProvider` (novo). Factory `getChannelForAccount(accountId, db)` lê o
canal ativo da conta e devolve o adaptador certo já com credenciais.

**Por que serve ao "sem travar o futuro":** todo caller passa por
`getChannelForAccount` — essa função é a costura. O formato de *armazenamento*
das credenciais pode mudar embaixo dela depois (ex.: normalizar numa tabela de
canais) sem tocar em nenhum caller.

### 2. Modelo de dados

**Generalizar `whatsapp_config` no lugar** (em vez de tabela nova agora):
- Adiciona `provider TEXT NOT NULL DEFAULT 'meta'` + colunas Evolution
  nuláveis (`evolution_instance_name`, `evolution_connection_state`,
  `evolution_connected_at`).
- Mantém `UNIQUE(account_id)` (um canal ativo por conta — o MVP).
- `evolution_instance_name` ganha índice, para o webhook da Evolution resolver
  a conta por nome de instância — espelhando o `phone_number_id` da Meta.
- Base URL + API key global da Evolution ficam em env vars
  (`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`), não no banco.

**Trade-off:** a tabela fica com colunas de dois provedores. Menos "puro" que
uma tabela normalizada, mas **não toca nas ~dezenas de queries Meta que já
funcionam** (quando `provider='meta'`, leem as mesmas colunas de sempre), e a
costura (`getChannelForAccount`) já isola o código do schema — migrar para uma
tabela `channels` normalizada depois é uma migration contida, não uma
reescrita.

### 3. Tela de Configurações

Reorganização (também melhora um arquivo já grande demais):
- **`channel-settings.tsx`** (pai) — segmented control no topo: "Meta Cloud
  API" | "Evolution API (QR Code)" — e abaixo um dos dois painéis.
- **`meta-config.tsx`** — o formulário atual, extraído sem mudança de lógica.
- **`evolution-connect.tsx`** (novo) — fluxo de QR:
  1. Botão "Conectar" → `POST /api/channels/evolution/connect` → cria a
     instância no servidor Evolution (via env vars) e devolve o QR como data URL.
  2. Renderiza o `<img>` do QR + polling de `GET /api/channels/evolution/state`
     a cada ~3s.
  3. Estado vira `connected` → troca o QR pelo número conectado + botão
     "Desconectar" (logout + delete instance).
  4. QR expira/rotaciona → botão "Gerar novo QR" re-chama o connect.

Como é **um provedor ativo por conta**, trocar o segmented control quando já há
um conectado mostra aviso ("Conectar a Evolution vai desconectar a Meta desta
conta"). A troca só efetiva no connect/save, não no clique do toggle.

No rail de Settings (`settings-sections.ts`), a seção `whatsapp` vira `channel`
(ou mantém o slug e troca rótulo/ícone) — detalhe de i18n a acertar na
implementação.

### 4. Entrada de mensagens (webhook + ingest compartilhado)

Hoje o `processMessage` do webhook Meta mistura **parsing do formato Meta** com
**persistência + dispatch dos engines**. Separar:

- Extrair a cauda provider-agnóstica para
  **`ingestInbound(normalized, accountId, configOwnerUserId, db)`** em
  `src/lib/channels/ingest.ts`: `findOrCreateContact` →
  `findOrCreateConversation` → insere em `messages` → dispara
  flows/automations/ai-reply/webhooks-de-saída. **Zero mudança de
  comportamento** — é um *move*, coberto pelos testes atuais.
- **Webhook Meta** (`/api/whatsapp/webhook`): mantém verificação de assinatura
  HMAC + parsing do shape Meta, mas monta `NormalizedInbound[]` (via
  `MetaProvider.parseWebhook`) e chama `ingestInbound`.
- **Novo webhook Evolution** (`/api/channels/evolution/webhook`): valida a
  autenticação da Evolution (header de apikey nos eventos), resolve a conta
  pelo **nome da instância**, normaliza os eventos `messages.upsert` via
  `EvolutionProvider.parseWebhook`, e chama **o mesmo `ingestInbound`**. Um
  `set-webhook` aponta a instância para essa URL no connect.

**Diferenças de provedor absorvidas pelo parser (sem vazar pro ingest):**
- **Mídia:** Meta manda `media_id` (exige fetch autenticado — proxy
  `/api/whatsapp/media/[id]`). Evolution manda base64/URL no payload → o
  `EvolutionProvider` baixa e sobe pro bucket `chat-media` (reusa o helper de
  upload existente), devolvendo uma URL normal.
- **Status/acks:** Meta manda `statuses[]`; Evolution manda `messages.update`.
  Ambos normalizam pro mesmo status ladder (`sent→delivered→read→replied`) que
  o `handleStatusUpdate` já implementa.
- **Reações e replies:** cada parser mapeia pro mesmo
  `NormalizedInbound.reaction` / `replyToProviderId`.

**Ganho colateral:** o webhook Meta fica menor e mais claro; a persistência
passa a ter dono único e testável — sem reescrever o que funciona.

### 5. Roteamento de saída (os 4 caminhos)

Cada caminho (`send-message.ts`, `broadcast-core.ts`, `flows/meta-send.ts`,
`automations/meta-send.ts`) faz a mesma troca cirúrgica: onde chama
`sendTextMessage`/`sendMediaMessage`/`sendInteractive*` do `meta-api.ts`
direto, passa a resolver `getChannelForAccount(accountId)` e chamar
`provider.sender.sendText/media/interactiveButtons/interactiveList(...)`. A
persistência em `messages`, o dispatch de engines e a pausa de flow ficam
**idênticos** — muda só a folha. O retry de variante de telefone sai dos
callers e vira detalhe interno do `MetaProvider.sendText`; a Evolution não o
executa. A janela de 24h da Meta também fica dentro do MetaProvider/ramo de
template — o caller não precisa saber.

### 6. Broadcast provider-aware

O wizard de broadcast passa a ramificar por provedor:
- **Meta:** passo "escolher template" (como hoje).
- **Evolution:** passo trocado por editor de texto/mídia livre.
- `broadcast-core.ts` ganha um caminho de envio não-template (texto/mídia) além
  do envio de template existente. O envio efetivo passa pela mesma interface
  `provider.sender.*`.

### 7. Templates e interativo — comportamento por provedor

- **Templates continuam Meta-only.** O template picker (inbox e
  contato-detail) fica oculto quando a conta está em Evolution. Automações têm
  step `send_template`: se rodar numa conta Evolution, o adaptador retorna um
  `SendMessageError` limpo ("templates exigem o provedor Meta"), registrado no
  log da execução, sem derrubar o resto do flow.
- **Interativo (botões/listas) na Evolution é risco conhecido.** A API
  não-oficial (base Baileys) tem suporte instável/depreciado a botões/listas
  nativos no WhatsApp atual. O `EvolutionProvider.sendInteractive*` encapsula:
  tenta o formato nativo e, se não suportado, faz **degradação graciosa** para
  texto numerado ("1) Opção A / 2) Opção B"), mantendo o `interactiveReplyId`
  mapeado pela resposta textual. Detalhe interno do adaptador; flows/automações
  não mudam. **A validar contra a versão de Evolution usada.**

## Tratamento de erro

- **Desconexão da Evolution** (celular sem internet, sessão deslogada): polling
  de estado detecta; a tela de Config mostra banner "Evolution desconectada —
  reescaneie o QR". Envios falham com erro claro.
- **Provider mismatch** (template em Evolution): erro tipado, não exceção solta.
- **Servidor Evolution fora do ar** (env erradas / servidor caiu):
  `connect`/`send` retornam erro claro apontando o operador para checar
  `EVOLUTION_API_URL`.

## Testes

- Unit test de cada adaptador com HTTP mockado. `MetaProvider` reusa os testes
  de `meta-api.ts` (mesmo código embrulhado) — continuam verdes.
- `ingestInbound` testado uma vez, provider-agnóstico (os testes de webhook
  atuais migram praticamente inalterados).
- `getChannelForAccount` testado: resolve o adaptador certo por `provider`.
- Normalização: payload de exemplo da Evolution → `NormalizedInbound` esperado.

## Fora do escopo deste MVP (explícito)

- Templates na Evolution (equivalente de aprovação).
- Dois provedores ativos simultaneamente na mesma conta.
- Convergência total dos 4 caminhos de envio (Abordagem C) — refactor posterior.

## Riscos conhecidos

1. **Suporte a interativo na Evolution** — pode exigir a degradação para texto
   numerado como caminho padrão, não fallback. Validar cedo na implementação.
2. **Formato de webhook da Evolution** — os eventos `messages.upsert` /
   `messages.update` e o campo de mídia (base64 vs. URL) variam entre versões
   da Evolution API. Fixar a versão-alvo e escrever o parser contra ela.
3. **Autenticação do webhook da Evolution** — confirmar como a Evolution
   assina/autentica os POSTs de entrada (apikey header) para não aceitar
   eventos forjados.

## Resumo do que muda

- Nova pasta `src/lib/channels/` (interface + 2 adaptadores + factory +
  `ingestInbound`).
- `whatsapp_config` generalizada com coluna `provider` + colunas Evolution.
- Tela de Config reorganizada: `channel-settings` + `meta-config` +
  `evolution-connect`.
- Novo webhook Evolution + refactor do webhook Meta para usar `ingestInbound`.
- Wizard de broadcast provider-aware + caminho não-template em
  `broadcast-core.ts`.
- Troca cirúrgica de folha nos 4 caminhos de envio.
- **Sem reescrever a lógica Meta que já funciona.**
