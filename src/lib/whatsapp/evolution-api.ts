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
