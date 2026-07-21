import type { AiConfig } from './types'

// ============================================================
// Voice-note transcription (Whisper via Groq/OpenAI's shared
// /audio/transcriptions endpoint). Best-effort, provider-agnostic tail
// of inbound audio ingestion — see investigacao-transcricao-audio-ia.md.
//
// Anthropic exposes no transcription endpoint, so this only runs for
// accounts on the 'openai' provider slot — which is also how Groq's
// free-tier, OpenAI-compatible host is configured elsewhere in this
// codebase (see providers/openai.ts). Never throws: a failed/slow
// transcription must not affect message receipt, matching the
// best-effort convention already used by retrieveKnowledge/logAiUsage.
// ============================================================

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const TRANSCRIPTION_TIMEOUT_MS = 15_000

interface TranscriptionResponse {
  text?: string
}

/** Groq's fast Whisper variant when pointed at Groq; OpenAI's own
 *  transcription model otherwise. Independent of `config.model` — that
 *  field names the *chat* model, not a transcription one. */
function transcriptionModelFor(baseUrl: string | null): string {
  return baseUrl?.includes('groq.com') ? 'whisper-large-v3-turbo' : 'whisper-1'
}

export async function transcribeAudio(args: {
  config: AiConfig
  audioUrl: string
}): Promise<string | null> {
  const { config, audioUrl } = args

  // No Whisper-compatible endpoint on this account's configured provider.
  if (config.provider !== 'openai') return null

  try {
    const audioRes = await fetch(audioUrl, {
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    })
    if (!audioRes.ok) {
      console.error(`[transcribe] failed to download audio (${audioRes.status}): ${audioUrl}`)
      return null
    }
    const audioBuffer = await audioRes.arrayBuffer()

    const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '') || null
    const url = `${baseUrl || DEFAULT_OPENAI_BASE_URL}/audio/transcriptions`

    const form = new FormData()
    form.set('file', new Blob([audioBuffer]), 'audio.ogg')
    form.set('model', transcriptionModelFor(baseUrl))

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[transcribe] provider returned ${res.status} for ${url}`)
      return null
    }

    const data = (await res.json().catch(() => null)) as TranscriptionResponse | null
    const text = data?.text?.trim()
    return text ? text : null
  } catch (err) {
    console.error('[transcribe] threw:', err instanceof Error ? err.message : err)
    return null
  }
}
