# Evolution API — Fase 2: EvolutionProvider + Conexão via QR

**Status:** Aprovado (2026-07-12)
**Depende de:** Fase 1 (`docs/superpowers/specs/2026-07-12-evolution-api-channel-design.md`, `docs/superpowers/plans/2026-07-12-evolution-api-phase-1-provider-foundation.md` — PR #3), que já entregou a costura `ChannelProvider`/`getChannelForAccount`/`ingestInbound`/`ChannelSender` com `MetaProvider` como única implementação real.

## Objetivo

Implementar `EvolutionProvider` (segunda implementação de `ChannelProvider`, ao lado do `MetaProvider`) e a tela de Configurações para conectar um número via QR code, usando a Evolution API (WhatsApp não-oficial, self-hosted). Ao final desta fase, uma conta pode escolher `provider='evolution'`, escanear um QR, e ter mensagens recebidas passando pelo mesmo `ingestInbound` que a Meta já usa — inbox, engines de automação/flows/IA e webhooks de saída funcionam sem saber a diferença entre provedores.

## Validação contra instância real

Diferente da Fase 1 (onde tudo já existia e só precisava ser mapeado), a Fase 2 depende de uma API externa cujos payloads reais não estavam documentados de forma confiável — a documentação em docs.evolutionfoundation.com.br tinha lacunas confirmadas (payload de `messages.upsert` ausente, corpo de `sendMedia` incorreto — dizia `multipart/form-data`, mas o DTO real da fonte é JSON). Por isso, antes de desenhar esta fase, subimos uma instância local da Evolution API v2 (`evoapicloud/evolution-api:latest`, versão 2.3.7) via Docker, conectamos um WhatsApp real via QR, e capturamos payloads reais de webhook (`connection.update`, `qrcode.updated`, `messages.upsert`) e o DTO de envio direto do código-fonte (`EvolutionAPI/evolution-api` no GitHub). As decisões de design abaixo estão fundamentadas nesses dados reais, não em suposição.

Amostras anonimizadas dos payloads capturados (números/nomes substituídos, estrutura real preservada) ficam em `docs/superpowers/specs/fixtures/evolution-messages-upsert-sample.json`, para uso como fixture de teste na fase de implementação.

## Decisões

### 1. Modelo de dados (migration 038)

A migration 037 (Fase 1) já adicionou `provider`, `evolution_instance_name`, `evolution_connection_state`, `evolution_connected_at` em `whatsapp_config`. Faltam:

- `evolution_instance_token TEXT` — token da instância (campo `hash` no retorno de `create-instance`, `token` no `fetchInstances`), criptografado como o `access_token` da Meta. Usado para chamadas por-instância (enviar mensagem) e para validar o `apikey` embutido no corpo do webhook.
- `evolution_qr_code TEXT` — data-URI base64 do QR mais recente. Zerado (`NULL`) assim que `evolution_connection_state` vira `connected` (não há mais QR a mostrar) ou `disconnected` (evita exibir um QR expirado numa próxima tentativa antes do primeiro `qrcode.updated` chegar).
- `evolution_qr_updated_at TIMESTAMPTZ` — quando o QR foi atualizado pela última vez, para a UI decidir se o QR na tela ainda é válido.
- `evolution_last_error TEXT` — detalhe legível da última falha de conexão, populado a partir do `statusReason`/`state` que `connection.update` manda (ex.: confirmado ao vivo — `state:"refused", statusReason:428` e `state:"close", statusReason:401`).

Mapeamento de estado Evolution → `ConnectionState.status` (interface do Task 1 da Fase 1):

| Evolution `state` | `ConnectionState.status` |
|---|---|
| `open` | `connected` |
| `connecting` | `connecting` |
| `close` | `disconnected` |
| qualquer outro (ex. `refused`) | `error`, com `detail` = razão |

### 2. `EvolutionProvider`

**`sender`** — requisições JSON simples (confirmado no DTO real, não multipart):

```
POST /message/sendText/{instance}
{ number: string, text: string, delay?: number, quoted?, linkPreview?, mentioned?: string[] }

POST /message/sendMedia/{instance}
{ number: string, mediatype: 'image'|'video'|'document'|'audio', media: string /* URL ou base64 */,
  mimetype?: string, caption?: string, fileName?: string }
```

`providerMessageId` = `response.key.id` (formato hex, ex. `AC05A11805DEE2830C5C297C4CA5B1CD` — não tem relação com o `wamid.xxx` da Meta). Sem retry de variante de telefone: isso era específico da formatação exigida pela Meta; a Evolution/Baileys resolve o número diretamente. `sendInteractiveButtons`/`sendInteractiveList` — Baileys tem suporte experimental a botões/listas com compatibilidade variável entre clientes WhatsApp; ficam implementados usando o formato documentado, mas sem garantia de entrega visual idêntica à Meta (risco já registrado no design da Fase 1).

**`parseWebhook`** — a partir do `messages.upsert` real capturado:

- Descarta todo evento com `data.key.fromMe === true` (decisão confirmada: cobre tanto eco de mensagens enviadas via CRM quanto mensagens enviadas direto do celular conectado — nenhuma das duas deve reentrar como inbound).
- `from` = `data.key.remoteJid` sem o sufixo `@s.whatsapp.net`, com fallback para `data.key.remoteJidAlt` se o valor não parecer um número de telefone (a Evolution reporta `addressingMode: "lid"` em alguns casos — modo de endereçamento por ID vinculado, ligado a uma feature de privacidade mais nova do WhatsApp; sem contato real usando esse modo para validar o formato exato, fica documentado como limitação conhecida, tratado só com o fallback acima).
- `contactName` = `data.pushName`
- `providerMessageId` = `data.key.id`
- `text` = `data.message.conversation` para texto simples. Os demais tipos (`imageMessage`, `videoMessage`, `documentMessage`, `audioMessage`, `locationMessage`, `<tipo>Message.caption` para legendas) serão mapeados a partir do código-fonte da Baileys durante o plano de implementação — mesma abordagem que corrigiu o DTO de `sendMedia` nesta fase.
- `mediaBase64` = extraído de `data.message.<tipo>Message.base64` quando presente (habilitado via `webhook_base64: true` na configuração do webhook da instância).
- `timestamp` = `new Date(data.messageTimestamp * 1000)`

**Lifecycle** — `connect()` chama `POST /instance/create` (nome determinístico, ver seção 3) seguido de `GET /instance/connect/{instance}` se a instância já existir; grava o QR retornado no cache. `getConnectionState()` **não chama a Evolution** — lê o cache (`evolution_connection_state`/`evolution_qr_code`/`evolution_last_error`) mantido pelo webhook. `disconnect()` chama `DELETE /instance/logout/{instance}` + `DELETE /instance/delete/{instance}`.

**Nome da instância**: determinístico, `axion-{accountId}`. Evita estado extra para rastrear e colisão entre contas no mesmo servidor Evolution compartilhado (decisão da Fase 1: um servidor por deployment).

**Webhook na criação da instância**: `create-instance` recebe o bloco `webhook: { url: "<APP_URL>/api/channels/evolution/webhook", byEvents: false, base64: true, events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"] }` — uma URL única (`byEvents: false`, testado ao vivo) para os três eventos que esta fase consome; `base64: true` é o que faz a mídia chegar decodificável no próprio payload (seção 5).

**Autenticação do webhook**: confirmado nos dados reais — o corpo do POST inclui `"apikey": "<token da instância>"` (não vem em header nenhum; os headers capturados não têm `apikey`). A rota valida esse campo contra `evolution_instance_token` da conta resolvida por `evolution_instance_name = body.instance`.

**Chaves de API**: `EVOLUTION_API_KEY` (env, global do servidor) autentica só ações administrativas (`create-instance`, `delete-instance`). `evolution_instance_token` (por conta, obtido no `create-instance` e persistido) autentica tudo mais — envio de mensagem, consulta de estado sob demanda, e é o mesmo valor validado no webhook. Princípio de menor privilégio: uma conta comprometida não expõe a chave global.

### 3. Rotas

Espelham o padrão que a Meta já usa:

- `POST /api/channels/evolution/connect` — resolve a conta autenticada, chama `EvolutionProvider.connect()`, grava `provider='evolution'`, `evolution_instance_name`, `evolution_instance_token`, `evolution_connection_state='connecting'`, `evolution_qr_code`.
- `GET /api/channels/evolution/state?accountId=...` — só lê o cache em `whatsapp_config` (sem chamar a Evolution); devolve `{status, qrCode, qrUpdatedAt, detail}`. É esta rota que o frontend faz polling.
- `POST /api/channels/evolution/webhook` — pública, sem query string para identificar a conta (o `instance` vem no corpo). Valida `body.apikey` contra o `evolution_instance_token` da conta encontrada por `evolution_instance_name`. Para `connection.update`/`qrcode.updated`, atualiza o cache. Para `messages.upsert`, chama `EvolutionProvider.parseWebhook` + o mesmo `ingestInbound` (`src/lib/channels/ingest.ts`) que a Meta já usa.
- `DELETE /api/channels/evolution/connect` — chama `disconnect()`, marca `evolution_connection_state='disconnected'`. Mantém `provider='evolution'` selecionado — reconectar não exige reescolher o provedor.

### 4. Fluxo de QR na UI

Abordagem escolhida: **cache alimentado pelo webhook, frontend só fala com o próprio backend** (não com a Evolution diretamente — evita expor a `EVOLUTION_API_KEY` e evita que cada poll do frontend gere um QR novo, invalidando um scan em andamento, comportamento confirmado ao vivo durante a validação desta fase). O componente de conexão faz polling em `GET /api/channels/evolution/state` a cada ~3s enquanto o status for `connecting`; para assim que virar `connected`, `error`, ou o componente desmontar.

### 5. Mídia inbound

A Meta usa proxy sob demanda (`/api/whatsapp/media/<id>`, resolvido só quando alguém abre a conversa) — não há isso na Evolution, que já entrega o base64 pronto no próprio webhook. `ingestInbound`/`ingest.ts` decodifica esse base64 e sobe para o mesmo bucket do Supabase Storage que o resto do app usa, gerando uma URL pública gravada em `messages.media_url`. O contrato de `media_url` (uma URL que o frontend carrega direto) continua idêntico para os dois provedores — só o mecanismo por trás muda.

### 6. Tela de Configurações

`whatsapp-config.tsx` (~840 linhas, hoje 100% Meta) vira três componentes:

- **`channel-settings.tsx`** (novo) — lê `whatsapp_config.provider`, seletor Meta/Evolution, renderiza o componente correspondente. Trocar de aba não desconecta o outro provedor automaticamente.
- **`meta-config.tsx`** — o conteúdo atual de `WhatsAppConfig()` **movido, não reescrito** (mesmo princípio de preservação de comportamento da Fase 1).
- **`evolution-connect.tsx`** (novo) — botão conectar, QR a partir do cache, badge de status com `evolution_last_error` quando houver, botão desconectar, polling conforme seção 4.

## Fora de escopo

- Grupos do WhatsApp (a Evolution manda eventos de grupo; o CRM hoje é 1:1)
- Tratamento especial para o modo de endereçamento "LID" além do fallback `remoteJid`/`remoteJidAlt` já descrito — sem um contato real usando esse modo, não há como validar mais a fundo
- Broadcast pela Evolution (Fase 3, já estava fora desde o design da Fase 1)
- Múltiplos servidores Evolution por deployment (continua um só, por env var — decisão da Fase 1)
- Templates via Evolution (decisão da Fase 1: templates continuam Meta-only)

## Riscos remanescentes (dos 3 listados na Fase 1)

- ~~Formato do payload de webhook~~ — **resolvido nesta fase**, validado contra instância real.
- ~~Autenticação do webhook~~ — **resolvido nesta fase**, confirmado: campo `apikey` no corpo, sem header.
- Suporte a mensagens interativas (botões/listas) pela Evolution — **ainda não validado ao vivo** (exigiria testar contra um cliente WhatsApp real recebendo botões); fica como item a validar durante a implementação do `sender.sendInteractiveButtons/List`, sem bloquear o restante da fase.
