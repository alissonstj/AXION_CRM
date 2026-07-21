import type { SupabaseClient } from '@supabase/supabase-js'
import { findEvolutionChats, findEvolutionContacts, findEvolutionMessages } from '@/lib/whatsapp/evolution-api'
import { mapEvolutionMessage, type EvolutionUpsertData } from './providers/evolution'
import { findOrCreateContact, findOrCreateConversation, findOrCreateGroupConversation } from './ingest'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

// ============================================================
// One-time retroactive history import — triggered from the webhook
// route's connection.update handler the first time an Evolution
// instance reaches 'connected' (whatsapp_config.evolution_history_
// synced_at is NULL). Deliberately separate from ingestInbound's live
// path: no automation dispatch, no AI auto-reply, no public webhook
// fan-out — historical messages must not look like fresh activity to
// any of those. Reuses findOrCreateContact/findOrCreateConversation
// (ingest.ts) and mapEvolutionMessage (providers/evolution.ts) so
// contact/conversation resolution and wire-format parsing stay
// identical to the live path.
//
// Scope for this pass: text/image/video/audio/document/location
// messages only — reactions and interactive_reply taps are skipped
// (they're state on a message the backfill may not have imported, or
// a menu tap with no lasting value once history-only). Media messages
// import with their metadata (caption, content_type) but `media_url`
// stays null — findEvolutionMessages doesn't return embedded media
// bytes the way the live webhook does (`base64: true` webhook config
// only applies to real-time delivery), and re-downloading years of
// historical media is out of scope for this pass. MediaUnavailable in
// message-bubble.tsx already renders a graceful placeholder for a
// message with no media_url, so this degrades safely.
// ============================================================

export interface HistoryBackfillArgs {
  accountId: string
  configOwnerUserId: string
  db: SupabaseClient
  baseUrl: string
  apiKey: string
  instanceName: string
  /** Messages older than this many days are skipped. */
  cutoffDays?: number
  /** Max times to poll findEvolutionChats waiting for the count to
   *  stabilize before proceeding — see waitForStableChatList. */
  chatListMaxPolls?: number
  /** Delay between those polls, in ms. */
  chatListPollIntervalMs?: number
}

export interface HistoryBackfillResult {
  chatsProcessed: number
  messagesImported: number
}

// The goal is a faithful mirror of the phone's own chat list, same as
// WhatsApp Web — not a recent-activity window. The old 90-day default
// silently dropped real chats with real history: a live account audit
// found 11 of 94 total WhatsApp chats excluded, the oldest dating back
// to 2024-02-02, even though Evolution had synced their full history —
// our own cutoff was the only thing throwing it away
// (investigacao-caixa-entrada-nao-carrega-tudo, 2026-07-17). 3650 days
// (~10 years) is not "no limit" (an unbounded query isn't a real
// safeguard against a corrupt timestamp), but comfortably covers any
// real WhatsApp history Evolution could plausibly have synced.
const DEFAULT_CUTOFF_DAYS = 3650
/** Between findEvolutionMessages page calls — keeps this from hammering
 *  the Evolution instance while it's also serving live traffic. */
const PAGE_DELAY_MS = 250

// investigacao-completude-sync-conversas.md: the webhook fires
// connection.update as soon as the socket opens, but WhatsApp's own
// history sync to Baileys/Evolution is itself asynchronous — the chat
// list can still be growing for a bit after "connected". Calling
// findEvolutionChats immediately risks backfilling from a still-
// incomplete list, permanently (evolution_history_synced_at never
// retries automatically). Default budget: up to ~15s worst case
// (5 gaps x 3s) before giving up and proceeding with whatever the last
// call returned — a background, fire-and-forget pass, so this delay
// doesn't hold up the webhook's ack to Evolution.
const DEFAULT_CHAT_LIST_MAX_POLLS = 6
const DEFAULT_CHAT_LIST_POLL_INTERVAL_MS = 3000

const ALLOWED_CONTENT_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video', 'location',
])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll findEvolutionChats until two consecutive calls return the same
 * chat count (the phone's history sync has settled), or `maxPolls` is
 * reached — whichever comes first. Always returns the most recent
 * result, even when it never stabilized within budget: proceeding with
 * an occasionally-imperfect list beats hanging the backfill forever.
 */
async function waitForStableChatList(
  auth: { baseUrl: string; apiKey: string; instanceName: string },
  opts: { maxPolls: number; pollIntervalMs: number },
): Promise<Awaited<ReturnType<typeof findEvolutionChats>>> {
  let previous: Awaited<ReturnType<typeof findEvolutionChats>> | null = null
  for (let attempt = 1; attempt <= opts.maxPolls; attempt++) {
    const current = await findEvolutionChats(auth)
    if (previous && current.length === previous.length) return current
    previous = current
    if (attempt < opts.maxPolls) await sleep(opts.pollIntervalMs)
  }
  return previous ?? []
}

export async function runEvolutionHistoryBackfill(
  args: HistoryBackfillArgs,
): Promise<HistoryBackfillResult> {
  const {
    accountId, configOwnerUserId, db, baseUrl, apiKey, instanceName,
    cutoffDays = DEFAULT_CUTOFF_DAYS,
    chatListMaxPolls = DEFAULT_CHAT_LIST_MAX_POLLS,
    chatListPollIntervalMs = DEFAULT_CHAT_LIST_POLL_INTERVAL_MS,
  } = args
  const cutoffMs = Date.now() - cutoffDays * 86_400_000

  let chats: Awaited<ReturnType<typeof findEvolutionChats>>
  try {
    chats = await waitForStableChatList(
      { baseUrl, apiKey, instanceName },
      { maxPolls: chatListMaxPolls, pollIntervalMs: chatListPollIntervalMs },
    )
  } catch (err) {
    console.error('[history-backfill] findEvolutionChats failed:', err)
    return { chatsProcessed: 0, messagesImported: 0 }
  }

  // Address-book names, keyed by normalized phone. findContacts.pushName
  // holds the name the account owner saved (what WhatsApp Web shows) —
  // the authoritative source, preferred over the weaker per-message
  // pushName. Best-effort: if it fails, we fall back to message pushName
  // and never block the import.
  const addressBook = await buildAddressBook({ baseUrl, apiKey, instanceName })

  let chatsProcessed = 0
  let messagesImported = 0

  for (const chat of chats) {
    // Channels/newsletters (@newsletter) and bots (@bot) are never real
    // conversations — skip. Groups (@g.us) ARE imported (into a group
    // conversation). 1:1 LID chats are kept too: their messages resolve
    // to a real phone via remoteJidAlt where present (mapEvolutionMessage
    // returns null for the ones that don't, dropping them per-message).
    const jid = chat.remoteJid
    if (jid.endsWith('@newsletter') || jid.endsWith('@bot')) continue
    const lastTs = chat.lastMessage?.messageTimestamp
    if (lastTs && lastTs * 1000 < cutoffMs) continue

    chatsProcessed += 1
    try {
      if (jid.endsWith('@g.us')) {
        messagesImported += await backfillGroupChat({
          db, accountId, configOwnerUserId, baseUrl, apiKey, instanceName,
          remoteJid: jid, groupName: chat.pushName ?? null, cutoffMs,
        })
      } else {
        messagesImported += await backfillChat({
          db, accountId, configOwnerUserId, baseUrl, apiKey, instanceName,
          remoteJid: jid, cutoffMs, addressBook,
        })
      }
    } catch (err) {
      console.error('[history-backfill] chat import failed:', chat.remoteJid, err)
    }
  }

  await db
    .from('whatsapp_config')
    .update({ evolution_history_synced_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('evolution_instance_name', instanceName)

  return { chatsProcessed, messagesImported }
}

interface AddressBookEntry {
  name?: string
  avatarUrl?: string
}

/** Fetches findContacts once and indexes the address-book name +
 *  profile picture by normalized phone. Only @s.whatsapp.net entries
 *  with a name that is more than the bare number are kept — a pushName
 *  equal to the phone digits (WhatsApp's placeholder for an unnamed
 *  contact) is not a real name and would just shadow the "format the
 *  number nicely" fallback. `profilePicUrl` needs no such filtering —
 *  reused as-is so the backfill doesn't need a separate
 *  fetchProfilePictureUrl call per contact (confirmed live 2026-07-16:
 *  present on ~2/3 of real contacts in this same response). Best-effort:
 *  a failure yields an empty map, never blocks the import. */
async function buildAddressBook(auth: {
  baseUrl: string; apiKey: string; instanceName: string
}): Promise<Map<string, AddressBookEntry>> {
  const map = new Map<string, AddressBookEntry>()
  try {
    const contacts = await findEvolutionContacts(auth)
    for (const c of contacts) {
      if (!c.remoteJid.endsWith('@s.whatsapp.net')) continue
      const phone = normalizePhone(c.remoteJid.split('@')[0])
      if (!phone) continue
      const rawName = c.pushName?.trim()
      const name = rawName && rawName !== phone ? rawName : undefined
      const avatarUrl = c.profilePicUrl ?? undefined
      if (name || avatarUrl) map.set(phone, { name, avatarUrl })
    }
  } catch (err) {
    console.error('[history-backfill] findEvolutionContacts failed (names/avatars degrade):', err)
  }
  return map
}

async function backfillChat(args: {
  db: SupabaseClient
  accountId: string
  configOwnerUserId: string
  baseUrl: string
  apiKey: string
  instanceName: string
  remoteJid: string
  cutoffMs: number
  addressBook: Map<string, AddressBookEntry>
}): Promise<number> {
  const { db, accountId, configOwnerUserId, baseUrl, apiKey, instanceName, remoteJid, cutoffMs, addressBook } = args

  let page = 1
  let imported = 0
  let conversationId: string | null = null
  let contactPhone: string | null = null
  let haveGoodContactName = false
  let newestTimestampMs = 0
  let newestPreview: string | null = null

  pageLoop: while (true) {
    const result = await findEvolutionMessages({ baseUrl, apiKey, instanceName, remoteJid, page })
    if (result.records.length === 0) break

    for (const record of result.records) {
      const data = record as unknown as EvolutionUpsertData
      const tsMs = data.messageTimestamp * 1000
      // Records arrive newest-first (confirmed live 2026-07-15) — once
      // one crosses the cutoff, everything after it (this page and any
      // later page) is older still, so stop the whole chat here.
      if (tsMs < cutoffMs) break pageLoop

      const inbound = mapEvolutionMessage(data)
      if (!inbound || inbound.kind === 'reaction' || inbound.kind === 'interactive_reply') continue

      if (!conversationId) {
        contactPhone = normalizePhone(inbound.from)
        // Name priority: address book (findContacts) > this message's
        // customer pushName > (blank, later formatted as a number in the
        // caller's `name || phone` fallback).
        const bookEntry = addressBook.get(contactPhone)
        const resolvedName = bookEntry?.name ?? inbound.contactName ?? ''
        const contactOutcome = await findOrCreateContact(
          db, accountId, configOwnerUserId, contactPhone, resolvedName,
          inbound.contactLid ?? undefined,
        )
        if (!contactOutcome) continue
        const resolvedContactId: string = contactOutcome.contact.id
        // Avatar: only on first creation. An existing contact's avatar is
        // the live path's job (webhook onContactCreated / future re-syncs
        // there) — the backfill only fills in a gap it itself just made.
        if (contactOutcome.wasCreated && bookEntry?.avatarUrl) {
          await db.from('contacts').update({ avatar_url: bookEntry.avatarUrl }).eq('id', resolvedContactId)
        }
        const convResult = await findOrCreateConversation(db, accountId, configOwnerUserId, resolvedContactId)
        if (!convResult) continue
        conversationId = convResult.conversation.id
        // If the address book already named this contact, we're done — a
        // later customer pushName must not overwrite the authoritative
        // address-book name.
        haveGoodContactName = !!bookEntry?.name || !!inbound.contactName
      } else if (!haveGoodContactName && inbound.contactName && contactPhone) {
        // The message that first resolved the contact above (the
        // chat's newest, since records arrive newest-first) may have
        // been one we sent — mapEvolutionMessage never returns a
        // pushName for those, so the contact was created with a blank/
        // placeholder name. Keep watching older messages in this same
        // chat for the first genuine customer-sent one and backfill the
        // real name onto the already-created contact once found.
        await findOrCreateContact(
          db, accountId, configOwnerUserId, contactPhone, inbound.contactName,
          inbound.contactLid ?? undefined,
        )
        haveGoodContactName = true
      }

      const { data: existing } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('message_id', inbound.providerMessageId)
        .limit(1)
        .maybeSingle()
      if (existing) continue

      const contentType = ALLOWED_CONTENT_TYPES.has(inbound.kind) ? inbound.kind : 'text'
      const contentText = inbound.text ?? null
      const { error: insertError } = await db.from('messages').insert({
        conversation_id: conversationId,
        sender_type: inbound.fromMe ? 'agent' : 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: null,
        message_id: inbound.providerMessageId,
        status: inbound.fromMe ? 'sent' : 'delivered',
        created_at: inbound.timestamp.toISOString(),
      })
      if (insertError) {
        console.error('[history-backfill] message insert failed:', insertError.message, {
          conversationId, providerMessageId: inbound.providerMessageId,
        })
        continue
      }
      imported += 1

      if (tsMs > newestTimestampMs) {
        newestTimestampMs = tsMs
        newestPreview = contentText || `[${contentType}]`
      }
    }

    if (page >= result.pages) break
    page += 1
    await sleep(PAGE_DELAY_MS)
  }

  if (conversationId && newestTimestampMs > 0) {
    // Only bump last_message_text/at if this backfilled message is
    // newer than what's already on the row — a concurrent live webhook
    // delivery may already have set something fresher.
    const { data: conv } = await db
      .from('conversations')
      .select('last_message_at')
      .eq('id', conversationId)
      .maybeSingle()
    const currentMs = conv?.last_message_at ? new Date(conv.last_message_at as string).getTime() : 0
    if (newestTimestampMs > currentMs) {
      await db
        .from('conversations')
        .update({
          last_message_text: newestPreview,
          last_message_at: new Date(newestTimestampMs).toISOString(),
        })
        .eq('id', conversationId)
    }
  }

  return imported
}

/** Group (@g.us) history import. Parallels backfillChat but resolves ONE
 *  group conversation (by JID, named from findChats) up front and records
 *  each message's participant sender instead of a single contact. Never
 *  creates 1:1 contacts/conversations. */
async function backfillGroupChat(args: {
  db: SupabaseClient
  accountId: string
  configOwnerUserId: string
  baseUrl: string
  apiKey: string
  instanceName: string
  remoteJid: string
  groupName: string | null
  cutoffMs: number
}): Promise<number> {
  const { db, accountId, configOwnerUserId, baseUrl, apiKey, instanceName, remoteJid, groupName, cutoffMs } = args

  const convResult = await findOrCreateGroupConversation(
    db, accountId, configOwnerUserId, remoteJid, groupName,
  )
  if (!convResult) return 0
  const conversationId: string = convResult.conversation.id

  let page = 1
  let imported = 0
  let newestTimestampMs = 0
  let newestPreview: string | null = null

  pageLoop: while (true) {
    const result = await findEvolutionMessages({ baseUrl, apiKey, instanceName, remoteJid, page })
    if (result.records.length === 0) break

    for (const record of result.records) {
      const data = record as unknown as EvolutionUpsertData
      const tsMs = data.messageTimestamp * 1000
      if (tsMs < cutoffMs) break pageLoop

      const inbound = mapEvolutionMessage(data)
      if (!inbound || inbound.kind === 'reaction' || inbound.kind === 'interactive_reply') continue

      const { data: existing } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('message_id', inbound.providerMessageId)
        .limit(1)
        .maybeSingle()
      if (existing) continue

      const contentType = ALLOWED_CONTENT_TYPES.has(inbound.kind) ? inbound.kind : 'text'
      const contentText = inbound.text ?? null
      const senderPhone = inbound.fromMe || !inbound.from ? null : normalizePhone(inbound.from)
      const senderName = inbound.fromMe ? null : (inbound.contactName ?? null)

      const { error: insertError } = await db.from('messages').insert({
        conversation_id: conversationId,
        sender_type: inbound.fromMe ? 'agent' : 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: null,
        message_id: inbound.providerMessageId,
        status: inbound.fromMe ? 'sent' : 'delivered',
        created_at: inbound.timestamp.toISOString(),
        sender_participant_name: senderName,
        sender_participant_phone: senderPhone,
      })
      if (insertError) {
        console.error('[history-backfill] group message insert failed:', insertError.message, {
          conversationId, providerMessageId: inbound.providerMessageId,
        })
        continue
      }
      imported += 1

      if (tsMs > newestTimestampMs) {
        newestTimestampMs = tsMs
        newestPreview = contentText || `[${contentType}]`
      }
    }

    if (page >= result.pages) break
    page += 1
    await sleep(PAGE_DELAY_MS)
  }

  if (newestTimestampMs > 0) {
    const { data: conv } = await db
      .from('conversations')
      .select('last_message_at')
      .eq('id', conversationId)
      .maybeSingle()
    const currentMs = conv?.last_message_at ? new Date(conv.last_message_at as string).getTime() : 0
    if (newestTimestampMs > currentMs) {
      await db
        .from('conversations')
        .update({
          last_message_text: newestPreview,
          last_message_at: new Date(newestTimestampMs).toISOString(),
        })
        .eq('id', conversationId)
    }
  }

  return imported
}
