import type { SupabaseClient } from '@supabase/supabase-js'

import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import type { NormalizedInbound } from './types'

// ============================================================
// Provider-agnostic tail of inbound-message processing.
//
// This is a behavior-preserving move out of
// src/app/api/whatsapp/webhook/route.ts's old `processMessage` — the
// find-or-create-contact, find-or-create-conversation, reaction
// handling, and engine-dispatch logic now live here, reading from the
// normalized `NormalizedInbound` shape instead of the raw Meta
// payload. Provider-specific work (webhook signature verification,
// Meta media_id verification, status-update mirroring, template
// events) stays in the route handler.
// ============================================================

export interface IngestContext {
  accountId: string
  configOwnerUserId: string
  db: SupabaseClient
  /** Fired once, right after a brand-new contact row is created — never
   *  for an existing contact matched by phone. Best-effort, provider-
   *  specific hook: this file stays provider-agnostic (no opinion on
   *  what a provider does here), so it's the caller's job to decide
   *  whether to do anything at all. Currently only the Evolution
   *  webhook route supplies one, to kick off a one-time avatar sync —
   *  Meta's Cloud API has no endpoint for a customer's profile
   *  picture, so its route passes none. Errors thrown by the hook are
   *  swallowed here, matching this function's own best-effort
   *  semantics elsewhere. */
  onContactCreated?: (contact: { id: string; phone: string }) => void
}

/**
 * Persist one normalized inbound message (or reaction) and fan it out
 * to the flow runner, automations, AI auto-reply, and public webhooks.
 *
 * Called once per `NormalizedInbound` produced by a provider's
 * `parseWebhook`. Never throws on expected DB/engine failures — errors
 * are logged and the function returns early, mirroring the original
 * webhook route's best-effort semantics (a bad message must not break
 * the rest of the batch or the caller's 200 ack).
 */
export async function ingestInbound(
  inbound: NormalizedInbound,
  ctx: IngestContext,
): Promise<void> {
  const { accountId, configOwnerUserId, db } = ctx

  const senderPhone = normalizePhone(inbound.from)
  const contactName = inbound.contactName ?? ''
  // See NormalizedInbound.fromMe's doc comment: by the time an inbound
  // reaches here, `fromMe: true` unambiguously means "sent from the
  // linked phone directly, outside the CRM" — CRM-originated echoes were
  // already filtered out by the caller (sent-by-crm-cache.ts).
  const isFromMe = inbound.fromMe === true

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    db,
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  if (contactOutcome.wasCreated) {
    try {
      ctx.onContactCreated?.(contactRecord)
    } catch (err) {
      console.error('[ingest] onContactCreated hook threw:', err)
    }
  }

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    db,
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  if (inbound.kind === 'reaction') {
    await handleReaction(db, inbound, conversation.id, contactRecord.id, isFromMe ? configOwnerUserId : null)
    return
  }

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (inbound.replyToProviderMessageId) {
    replyToInternalId = await lookupInternalIdByMetaId(
      db,
      inbound.replyToProviderMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[ingest] reply context parent not found:',
        inbound.replyToProviderMessageId
      )
    }
  }

  const contentText = inbound.text ?? null
  const mediaUrl = inbound.mediaUrl ?? null
  const interactiveReplyId = inbound.interactiveReplyId ?? null

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map the normalized `kind` to the closest allowed value so the INSERT
  // doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const mappedType = inbound.kind === 'interactive_reply' ? 'interactive' : inbound.kind
  const contentType = ALLOWED_CONTENT_TYPES.has(mappedType) ? mappedType : 'text'

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    // A phone-sent message (isFromMe) is ours, same as a CRM send —
    // record it as 'agent'/'sent', matching send-message.ts's own insert
    // shape, not as a customer message.
    sender_type: isFromMe ? 'agent' : 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: inbound.providerMessageId,
    status: isFromMe ? 'sent' : 'delivered',
    created_at: inbound.timestamp.toISOString(),
    reply_to_message_id: replyToInternalId,
    // Only populated for content_type='interactive'. Migration 010 added
    // the column; null for every other content_type so existing inserts
    // behave identically.
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Update conversation
  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${inbound.kind}]`,
      last_message_at: new Date().toISOString(),
      // A phone-sent message doesn't need to notify us of itself.
      unread_count: isFromMe ? (conversation.unread_count || 0) : (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // Everything below this point (broadcast-reply flagging, the flow
  // runner, automations, AI auto-reply, and the message.received public
  // webhook) reacts to something a CUSTOMER sent us. A phone-sent
  // message is our own outbound content arriving via a side channel —
  // it still needs to land in the inbox (done above), but must not
  // trigger any of the customer-facing dispatch logic.
  if (isFromMe) return

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(db, accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: inbound.providerMessageId,
          }
        : {
            kind: 'text',
            text: contentText ?? '',
            meta_message_id: inbound.providerMessageId,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside the route's `after()`
  // (same reason as the webhook dispatch below); `dispatchInboundToAiReply`
  // owns its eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
      triggeringProviderMessageId: inbound.providerMessageId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: inbound.providerMessageId,
    content_type: contentType,
    text: contentText,
  })
}

/**
 * Resolve a provider-side message id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  db: SupabaseClient,
  providerMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[ingest] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to the provider.
 *
 * `phoneActorUserId` is set only for a reaction added from the linked
 * phone directly (isFromMe in the caller) — there's no real CRM user to
 * attribute it to (any teammate could be holding that phone), so we
 * fall back to the whatsapp_config owner as a stable actor id, the same
 * convention findOrCreateContact uses for auto-created contacts.
 */
async function handleReaction(
  db: SupabaseClient,
  inbound: NormalizedInbound,
  conversationId: string,
  contactId: string,
  phoneActorUserId: string | null
) {
  const reaction = inbound.reaction
  if (!reaction?.targetProviderMessageId) return

  const targetInternalId = await lookupInternalIdByMetaId(
    db,
    reaction.targetProviderMessageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[ingest] reaction target message not found; skipping',
      reaction.targetProviderMessageId
    )
    return
  }

  const actorType = phoneActorUserId ? 'agent' : 'customer'
  const actorId = phoneActorUserId ?? contactId

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', actorType)
      .eq('actor_id', actorId)
    if (delError) {
      console.error('[ingest] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await db
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: actorType,
        actor_id: actorId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[ingest] reaction upsert failed:', upsertError.message)
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string
) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in ingestInbound. */
  wasCreated: boolean
}

async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
