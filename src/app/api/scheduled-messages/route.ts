import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { SendMessageError } from '@/lib/whatsapp/send-message'

// POST /api/scheduled-messages
//
// Creates a manual per-lead follow-up (see migration 042). Fase 2
// scope: only the Kanban entry point (`deal_id`) — the Inbox entry
// point (`conversation_id` directly, no deal) lands in Fase 3.
//
// conversation_id is resolved (find-or-create) here, at creation time,
// not deferred to the cron sweep — see 042's header comment for why.
// Reuses `resolveConversationByPhone` (src/lib/whatsapp/resolve-
// conversation.ts), the same helper the public send API uses to bridge
// "I have a phone number" to "I have a contact + conversation row" —
// the deal's contact_id resolves to a phone, which re-finds the SAME
// contact (idempotent match by phone) rather than creating a second one.

const CONTENT_TYPES = ['text', 'image', 'video', 'document', 'audio'] as const
type ScheduledContentType = (typeof CONTENT_TYPES)[number]

function isContentType(v: unknown): v is ScheduledContentType {
  return typeof v === 'string' && (CONTENT_TYPES as readonly string[]).includes(v)
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
  if (!dealId) {
    return NextResponse.json({ error: 'deal_id is required' }, { status: 400 })
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

  let conversationId: string
  let contactId: string
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
