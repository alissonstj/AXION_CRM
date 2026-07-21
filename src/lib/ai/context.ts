import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text-bearing messages of a conversation and map them
 * to the provider-neutral chat shape. Customer messages become `user`;
 * agent and bot messages become `assistant`. Content types with no text
 * to model (image, document, video, template, interactive) are
 * excluded; 'audio' is included because a transcribed voice note has
 * its transcript saved into `content_text` (Fase 1,
 * investigacao-transcricao-audio-ia.md) — an untranscribed one just has
 * a null/empty content_text and is dropped by the filter below like any
 * other empty message.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    // 'audio' is included alongside 'text' so a transcribed voice note
    // (Fase 1, investigacao-transcricao-audio-ia.md — the transcript is
    // saved into content_text same as a caption) is visible to the
    // model too, not just plain text turns.
    .in('content_type', ['text', 'audio'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}
