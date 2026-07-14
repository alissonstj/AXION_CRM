import { describe, it, expect, vi, beforeEach } from 'vitest'

// engineSendText's happy path (contact lookup → provider send → DB
// persistence) has no prior test coverage in this repo — this file is
// scoped to the new sendTyping-before-sendText behavior only, not a
// full backfill of engineSendText's pre-existing paths.
const { mockSendText, mockSendTyping, mockGetChannelForAccount } = vi.hoisted(() => ({
  mockSendText: vi.fn(),
  mockSendTyping: vi.fn(),
  mockGetChannelForAccount: vi.fn(),
}))

vi.mock('@/lib/channels/factory', () => ({
  getChannelForAccount: mockGetChannelForAccount,
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { id: 'contact-1', phone: '+15551234567' }, error: null }) }),
            }),
          }),
        }
      }
      if (table === 'messages') {
        return { insert: () => Promise.resolve({ error: null }) }
      }
      if (table === 'conversations') {
        return { update: () => ({ eq: async () => ({ error: null }) }) }
      }
      throw new Error(`unexpected table in this test: ${table}`)
    },
  }),
}))

import { engineSendText } from './meta-send'

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  text: 'Hello!',
}

beforeEach(() => {
  mockSendText.mockReset().mockResolvedValue({ providerMessageId: 'wamid.1' })
  mockSendTyping.mockReset().mockResolvedValue(undefined)
  mockGetChannelForAccount.mockReset().mockResolvedValue({
    sender: { sendText: mockSendText, sendTyping: mockSendTyping },
  })
})

describe('engineSendText — typing-indicator opt-in', () => {
  it('does not call sendTyping when simulateTypingMs is absent (Flow sends are unaffected)', async () => {
    await engineSendText(ARGS)
    expect(mockSendTyping).not.toHaveBeenCalled()
    expect(mockSendText).toHaveBeenCalled()
  })

  it('calls sendTyping with the sanitized recipient + duration before sendText, when simulateTypingMs is set', async () => {
    const order: string[] = []
    mockSendTyping.mockImplementation(async () => { order.push('sendTyping') })
    mockSendText.mockImplementation(async () => { order.push('sendText'); return { providerMessageId: 'wamid.2' } })

    await engineSendText({ ...ARGS, simulateTypingMs: 4500, contextProviderMessageId: 'wamid.trigger' })

    expect(mockSendTyping).toHaveBeenCalledWith({
      to: '15551234567', contextProviderMessageId: 'wamid.trigger', durationMs: 4500,
    })
    expect(order).toEqual(['sendTyping', 'sendText'])
  })
})
