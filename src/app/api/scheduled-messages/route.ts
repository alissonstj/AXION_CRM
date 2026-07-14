import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { SendMessageError } from '@/lib/whatsapp/send-message'

// GET /api/scheduled-messages?conversation_id=...
// POST /api/scheduled-messages
//
// Manual per-lead follow-ups (see migration 042). Two entry points feed
// POST: a deal's Kanban card (`deal_id`, Fase 2) and an open Inbox
// conversation (`conversation_id` directly, Fase 3) — exactly one of
// the two is required per request.
//
// conversation_id is resolved (find-or-create) here, at creation time,
// not deferred to the cron sweep — see 042's header comment for why.
// The `deal_id` path reuses `resolveConversationByPhone` (src/lib/
// whatsapp/resolve-conversation.ts), the same helper the public send
// API uses to bridge "I have a phone number" to "I have a contact +
// conversation row" — the deal's contact_id resolves to a phone, which
// re-finds the SAME contact (idempotent match by phone) rather than
// creating a second one. The `conversation_id` path is simpler: the
// conversation (and its contact) already exist, no phone resolution
// needed.

const CONTENT_TYPES = ['text', 'image', 'video', 'document', 'audio'] as const
type ScheduledContentType = (typeof CONTENT_TYPES)[number]

function isContentType(v: unknown): v is ScheduledContentType {
  return typeof v === 'string' && (CONTENT_TYPES as readonly string[]).includes(v)
}

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount()
    const { searchParams } = new URL(request.url)
    const conversationId = searchParams.get('conversation_id')
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
    }

    // RLS (scheduled_messages_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('scheduled_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('scheduled_at', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ scheduled_messages: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const dealId = typeof body.deal_id === 'string' ? body.deal_id : null
  const inputConversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null
  if (!dealId && !inputConversationId) {
    return NextResponse.json({ error: 'deal_id or conversation_id is required' }, { status: 400 })
  }

  if (!isContentType(body.content_type)) {
    return NextResponse.json(
      { error: `Unsupported content_type "${body.content_type}"` },
      { status: 400 },
    )
  }
  const contentType = body.content_type
  const contentText = typeof body.content_text === 'string' && body.content_text.trim()
    ? body.content_text
    : null
  const mediaUrl = typeof body.media_url === 'string' ? body.media_url : null

  if (contentType === 'text' && !contentText) {
    return NextResponse.json(
      { error: 'content_text is required for text messages' },
      { status: 400 },
    )
  }
  if (contentType !== 'text' && !mediaUrl) {
    return NextResponse.json(
      { error: `media_url is required for ${contentType} messages` },
      { status: 400 },
    )
  }

  const scheduledAt = typeof body.scheduled_at === 'string' ? new Date(body.scheduled_at) : null
  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
    return NextResponse.json({ error: 'scheduled_at must be a valid date' }, { status: 400 })
  }
  if (scheduledAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: 'scheduled_at must be in the future' }, { status: 400 })
  }

  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null
  const quickReplyId = typeof body.quick_reply_id === 'string' ? body.quick_reply_id : null

  const admin = supabaseAdmin()

  let conversationId: string
  let contactId: string

  if (dealId) {
    const { data: deal, error: dealError } = await admin
      .from('deals')
      .select('id, contact:contacts(id, phone, name)')
      .eq('id', dealId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (dealError) return NextResponse.json({ error: dealError.message }, { status: 500 })
    if (!deal) return NextResponse.json({ error: 'Deal not found' }, { status: 404 })

    const contact = Array.isArray(deal.contact) ? deal.contact[0] : deal.contact
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'This deal has no linked contact to schedule a message for' },
        { status: 400 },
      )
    }

    try {
      const resolved = await resolveConversationByPhone(admin, ctx.accountId, contact.phone, contact.name)
      conversationId = resolved.conversationId
      contactId = resolved.contactId
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }
  } else {
    const { data: conversation, error: convError } = await admin
      .from('conversations')
      .select('id, contact_id')
      .eq('id', inputConversationId as string)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (convError) return NextResponse.json({ error: convError.message }, { status: 500 })
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    conversationId = conversation.id
    contactId = conversation.contact_id
  }

  const { data: scheduled, error: insertError } = await admin
    .from('scheduled_messages')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      contact_id: contactId,
      conversation_id: conversationId,
      deal_id: dealId,
      title,
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      quick_reply_id: quickReplyId,
      scheduled_at: scheduledAt.toISOString(),
    })
    .select()
    .single()

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }
  return NextResponse.json({ scheduled_message: scheduled }, { status: 201 })
}
