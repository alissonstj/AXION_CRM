import { describe, it, expect, vi, beforeEach } from 'vitest'
import { maybeTranscribeAudioMessage } from './audio-transcription'
import * as transcribeModule from '../ai/transcribe'
import * as configModule from '../ai/config'
import type { AiConfig } from '../ai/types'

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    baseUrl: 'https://api.groq.com/openai/v1',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    replyDelaySeconds: 4,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function fakeDb(updateSpy: (...args: unknown[]) => void) {
  return {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (col: string, val: string) => {
          updateSpy(patch, col, val)
          return Promise.resolve({ error: null })
        },
      }),
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('maybeTranscribeAudioMessage', () => {
  it('transcribes and writes the result into content_text', async () => {
    vi.spyOn(configModule, 'loadAiConfig').mockResolvedValue(aiConfig())
    vi.spyOn(transcribeModule, 'transcribeAudio').mockResolvedValue('oi, tudo bem?')
    const updateSpy = vi.fn()
    const db = fakeDb(updateSpy)

    const result = await maybeTranscribeAudioMessage(db, {
      accountId: 'acct-1',
      messageId: 'msg-1',
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    expect(updateSpy).toHaveBeenCalledWith(
      { content_text: 'oi, tudo bem?' },
      'id',
      'msg-1',
    )
    expect(result).toBe('oi, tudo bem?')
  })

  it('is a no-op when the audio URL is not a direct http(s) URL (e.g. an authenticated proxy path)', async () => {
    const loadSpy = vi.spyOn(configModule, 'loadAiConfig')
    const updateSpy = vi.fn()
    const db = fakeDb(updateSpy)

    const result = await maybeTranscribeAudioMessage(db, {
      accountId: 'acct-1',
      messageId: 'msg-1',
      audioUrl: '/api/whatsapp/media/123',
    })

    expect(loadSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('is a no-op when the account has no usable AI config', async () => {
    vi.spyOn(configModule, 'loadAiConfig').mockResolvedValue(null)
    const transcribeSpy = vi.spyOn(transcribeModule, 'transcribeAudio')
    const updateSpy = vi.fn()
    const db = fakeDb(updateSpy)

    const result = await maybeTranscribeAudioMessage(db, {
      accountId: 'acct-1',
      messageId: 'msg-1',
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    expect(transcribeSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('is a no-op when transcription fails (returns null)', async () => {
    vi.spyOn(configModule, 'loadAiConfig').mockResolvedValue(aiConfig())
    vi.spyOn(transcribeModule, 'transcribeAudio').mockResolvedValue(null)
    const updateSpy = vi.fn()
    const db = fakeDb(updateSpy)

    const result = await maybeTranscribeAudioMessage(db, {
      accountId: 'acct-1',
      messageId: 'msg-1',
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    expect(updateSpy).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('never throws, even when loadAiConfig itself throws', async () => {
    vi.spyOn(configModule, 'loadAiConfig').mockRejectedValue(new Error('db down'))
    const updateSpy = vi.fn()
    const db = fakeDb(updateSpy)

    await expect(
      maybeTranscribeAudioMessage(db, {
        accountId: 'acct-1',
        messageId: 'msg-1',
        audioUrl: 'https://storage.example.com/a.ogg',
      }),
    ).resolves.toBeNull()
  })
})
