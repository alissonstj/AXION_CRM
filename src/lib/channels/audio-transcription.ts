import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '../ai/config'
import { transcribeAudio } from '../ai/transcribe'

// ============================================================
// Fase 1 (investigacao-transcricao-audio-ia.md): transcribe an inbound
// voice note and save it as the message's `content_text`, so the human
// agent sees a caption under the audio player. Deliberately NOT wired
// into the AI auto-reply / automations dispatch yet (Fase 2) — this is
// the isolated, one-purpose Fase 1 slice only.
//
// Only handles a directly-fetchable http(s) audio URL (Evolution's
// Supabase Storage links). Meta's media_url is an authenticated proxy
// route (`/api/whatsapp/media/{id}`) a server-side call can't use —
// out of scope until Fase 3.
// ============================================================

/** Returns the transcribed text on success, `null` on any ineligible
 *  account/config, failure, or error — so the caller can feed it into
 *  the same downstream dispatch (automations/AI) that plain text
 *  messages already go through (Fase 2). */
export async function maybeTranscribeAudioMessage(
  db: SupabaseClient,
  args: { accountId: string; messageId: string; audioUrl: string },
): Promise<string | null> {
  const { accountId, messageId, audioUrl } = args
  if (!/^https?:\/\//.test(audioUrl)) return null

  try {
    const config = await loadAiConfig(db, accountId)
    if (!config) return null

    const text = await transcribeAudio({ config, audioUrl })
    if (!text) return null

    const { error } = await db
      .from('messages')
      .update({ content_text: text })
      .eq('id', messageId)
    if (error) {
      console.error('[audio-transcription] failed to save transcript:', error.message)
      return null
    }
    return text
  } catch (err) {
    console.error('[audio-transcription] threw:', err instanceof Error ? err.message : err)
    return null
  }
}
