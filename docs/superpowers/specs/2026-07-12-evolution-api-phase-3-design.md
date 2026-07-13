# Evolution API — Fase 3: Broadcast Provider-Aware

**Status:** Aprovado (2026-07-12)
**Depende de:** Fase 1 (`docs/superpowers/specs/2026-07-12-evolution-api-channel-design.md`) e Fase 2 (`docs/superpowers/specs/2026-07-12-evolution-api-phase-2-design.md`), ambas mescladas nesta branch — `ChannelProvider`/`getChannelForAccount`/`ChannelSender` (Meta + Evolution) já funcionam ponta a ponta.

## Objetivo

Dar suporte a broadcast em contas Evolution (texto/mídia livre, sem template) no wizard do dashboard (`/broadcasts/new`), e — na mesma mudança — consolidar o caminho legado de broadcast do wizard (`/api/whatsapp/broadcast/route.ts`) pela costura do `ChannelProvider`, resolvendo a dívida técnica sinalizada nas revisões finais das Fases 1 e 2 (essa rota duplicava a lógica de retry de variante de telefone da Meta e nunca passou pela costura).

## Escopo

Só o **wizard do dashboard**. A API pública v1 (`broadcast-core.ts` / `/api/v1/broadcasts`) continua template-only — decisão explícita, não uma omissão. Motivo: o wizard é onde o usuário realmente interage; a API pública fica para uma fase futura se houver demanda de integrações externas.

## Decisões

### 1. Modelo de dados (nova migration)

`broadcasts.template_name`/`template_language` são `NOT NULL` hoje (migration 001) — não há como representar um broadcast sem template. Nova migration adiciona:

- `kind TEXT NOT NULL DEFAULT 'template' CHECK (kind IN ('template', 'freeform'))` — discrimina o tipo de conteúdo. Default `'template'` preserva o comportamento de toda linha existente.
- `provider TEXT NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta', 'evolution'))` — snapshot do provedor **no momento do envio**, não relido de `whatsapp_config` depois. Um broadcast antigo continua mostrando corretamente qual provedor usou mesmo que a conta troque de provedor no futuro.
- `message_text TEXT` — corpo da mensagem livre, com os placeholders `{{name}}` etc. ainda não resolvidos (a resolução por destinatário acontece só no envio, não é persistida).
- `message_media_url TEXT`, `message_media_type TEXT` (`'image'|'video'|'document'|'audio'` — mesmos quatro valores de `OutboundMediaKind` em `src/lib/channels/types.ts`, sem tradução necessária na hora de montar o `SendMediaArgs`) — mídia opcional.
- `template_name`/`template_language` relaxados para `NULL`-áveis.
- `CHECK`: quando `kind='template'`, `template_name IS NOT NULL`; quando `kind='freeform'`, `message_text IS NOT NULL OR message_media_url IS NOT NULL`.

`broadcast_recipients` não muda — `whatsapp_message_id`/`status`/`error_message` já são genéricos o suficiente pra guardar o id retornado por qualquer provedor.

### 2. Wizard — Step 1 (composição), ramificado por provedor

`Step1ChooseTemplate` continua servindo contas Meta, sem alterações. Novo `Step1ComposeMessage` serve contas Evolution:
- Campo de texto livre com hint de sintaxe `{{name}}`
- Anexo de mídia opcional, reaproveitando o mesmo padrão de upload que `headerMediaUrl` já usa hoje pra templates com header de mídia

`NewBroadcastPage` decide qual dos dois renderizar lendo `whatsapp_config.provider` da conta (uma leitura, mesmo padrão que `channel-settings.tsx` já usa) — sem seletor manual na tela, já que é uma propriedade da conta, não uma escolha por broadcast.

### 3. Wizard — Step 3 (mapeamento de variáveis), sintaxe nomeada

Hoje `Step3Personalize` recebe `template.body`, extrai posições `{{1}}`, `{{2}}` e monta o formulário de mapeamento (campo estático / campo do contato / campo customizado) reaproveitando `resolveVariables`/`VariableMapping` (`src/hooks/use-broadcast-sending.ts`). Para `kind='freeform'`, passa a extrair de `message_text` os nomes `{{name}}`, `{{phone}}`, `{{custom:algum_campo}}` via regex — **sintaxe nomeada, não posicional** (decisão explícita: como não é um header aprovado pela Meta, não precisa seguir a convenção `{{1}}/{{2}}`; é mais legível pra quem está compondo). A UI de mapeamento em si é a mesma para os dois casos — só muda a fonte do parsing e as chaves resultantes (nome em vez de índice numérico).

### 4. Wizard — Step 4 (revisão/envio)

Ramifica só o preview: mostra o texto renderizado com placeholders resolvidos (`kind='template'`) ou o texto composto com os `{{...}}` realçados (`kind='freeform'`), mais a prévia de mídia se houver. `handleSend`/`handleSaveDraft` (`src/app/(dashboard)/broadcasts/new/page.tsx`) passam `kind`/`message_text`/`message_media_url`/`message_media_type` em vez de (ou além de) os campos de template quando `kind==='freeform'`.

### 5. Backend — `/api/whatsapp/broadcast/route.ts`

Resolve `getChannelForAccount(accountId, db)` uma vez por request — se lançar `ChannelConfigError` (conta sem `whatsapp_config`), a rota mantém a resposta 400 "WhatsApp not configured" que já existe hoje, só trocando a origem do fetch manual de config para o erro da factory. Dois ramos:

- **`kind==='template'`**: guarda `if (provider.id !== 'meta') → 400` (mesmo padrão de guard que `automations/meta-send.ts` já usa) e segue chamando `sendTemplateMessage` da Meta diretamente — templates continuam fora do `ChannelSender` por design (decisão da Fase 1: templates são Meta-only).
- **`kind==='freeform'`**: guarda o inverso, `if (provider.id !== 'evolution') → 400`, com mensagem explicando que mensagem livre em campanha viola a política de mensagens iniciadas por negócio da própria Meta (não é uma limitação técnica arbitrária — é por isso que o sistema de templates existe). Para cada destinatário, chama `provider.sender.sendText({ to, text })` (sem mídia) ou `provider.sender.sendMedia({ to, kind: mediaType, link: mediaUrl, caption: text })` (com mídia).

**Correção de precisão:** o loop local de retry de variante de telefone que a rota tem hoje é específico do envio de **template** (`sendTemplateMessage`), e como template nunca passou a fazer parte do `ChannelSender` (decisão da Fase 1), esse loop **continua existindo, sem mudança**, exatamente como em `send-message.ts`/`automations/meta-send.ts` hoje. O ramo **novo** (`freeform`) é que não precisa de loop nenhum — não porque algo foi "removido por duplicação", mas porque `EvolutionProvider.sender` simplesmente não exige esse retry. O ganho real de consolidar pela costura aqui é: a rota deixa de ser a ÚNICA implementação Meta-e-só-Meta do fluxo de broadcast do wizard, e ganha o ramo Evolution de graça reaproveitando `getChannelForAccount`.

`OutboundResult.providerMessageId` grava em `whatsapp_message_id` (coluna já genérica, sem mudança de schema).

### 6. Testes

Fixture-based, reaproveitando o padrão real já usado nas Fases 1/2. Ramo `template`: mantém os casos que já existem hoje (mockando `sendTemplateMessage`). Ramo `freeform`: casos novos mockando `getChannelForAccount` retornando um provider fake, cobrindo texto puro, texto+mídia, e os dois guards de política (tentar template numa conta Evolution, tentar freeform numa conta Meta).

## Fora de escopo

- API pública v1 (`broadcast-core.ts`/`/api/v1/broadcasts`) — continua template-only.
- Ativar o agendamento (`scheduled_at`) de fato para broadcasts freeform — a coluna existe, mas não há indício de um worker consumindo-a hoje; questão pré-existente, não introduzida por esta fase.
- Rotear `src/app/api/whatsapp/react/route.ts` (reações) pela costura — backlog já registrado nas revisões anteriores, sem relação com broadcast.
