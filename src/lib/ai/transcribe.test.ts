import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio } from './transcribe'
import type { AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    baseUrl: null,
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

const AUDIO_BYTES = new Uint8Array([1, 2, 3])

function audioFetchOk(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => AUDIO_BYTES.buffer,
  } as unknown as Response
}

function transcriptionOk(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ text }),
  } as unknown as Response
}

function httpError(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message: 'nope' } }),
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('transcribeAudio', () => {
  it('returns the transcribed text on success', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(audioFetchOk())
      .mockResolvedValueOnce(transcriptionOk('oi, tudo bem?'))

    const result = await transcribeAudio({
      config: config({ baseUrl: 'https://api.groq.com/openai/v1' }),
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    expect(result).toBe('oi, tudo bem?')
  })

  it('posts multipart/form-data to {baseUrl}/audio/transcriptions with the Groq whisper model', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(audioFetchOk())
      .mockResolvedValueOnce(transcriptionOk('hello'))

    await transcribeAudio({
      config: config({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-123' }),
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(init.headers.Authorization).toBe('Bearer gsk-123')
    expect(init.body).toBeInstanceOf(FormData)
    expect(init.body.get('model')).toBe('whisper-large-v3-turbo')
  })

  it('uses whisper-1 as the model when pointed at real OpenAI (no groq.com baseUrl)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(audioFetchOk())
      .mockResolvedValueOnce(transcriptionOk('hello'))

    await transcribeAudio({
      config: config({ baseUrl: null }),
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(init.body.get('model')).toBe('whisper-1')
  })

  it('returns null without calling fetch when the account is on Anthropic (no transcription endpoint)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>

    const result = await transcribeAudio({
      config: config({ provider: 'anthropic' }),
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when downloading the audio file fails', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValueOnce(httpError(404))

    const result = await transcribeAudio({
      config: config(),
      audioUrl: 'https://storage.example.com/missing.ogg',
    })

    expect(result).toBeNull()
  })

  it('returns null when the Groq/OpenAI transcription call fails', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(audioFetchOk())
      .mockResolvedValueOnce(httpError(500))

    const result = await transcribeAudio({
      config: config(),
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    expect(result).toBeNull()
  })

  it('returns null when fetch throws (network error / timeout)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    const result = await transcribeAudio({
      config: config(),
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    expect(result).toBeNull()
  })

  it('returns null when the response has no usable text', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(audioFetchOk())
      .mockResolvedValueOnce(transcriptionOk('   '))

    const result = await transcribeAudio({
      config: config(),
      audioUrl: 'https://storage.example.com/a.ogg',
    })

    expect(result).toBeNull()
  })
})
