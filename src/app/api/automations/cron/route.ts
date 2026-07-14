import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { getChannelForAccount, ChannelConfigError } from '@/lib/channels/factory'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { substituteMessageVariables } from '@/lib/whatsapp/message-variables'
import type { OutboundMediaKind } from '@/lib/channels/types'

/**
 * Drain due `automation_pending_executions` rows (an automation's
 * internal `wait`-step resume queue).
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
async function drainAutomationPendingExecutions(admin: SupabaseClient): Promise<number> {
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error || !due || due.length === 0) return 0

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return processed
}

interface ScheduledMessageRow {
  id: string
  account_id: string
  conversation_id: string
  content_type: string
  content_text: string | null
  media_url: string | null
  contact: { id: string; phone: string; name: string | null } | null
}

/**
 * Drain due `scheduled_messages` rows (manual per-lead follow-ups —
 * see migration 042). Same claim-then-process shape as the automation
 * queue above: a two-step UPDATE-by-id (pending -> sending) is the
 * lock, so an overlapping sweep can't double-send.
 *
 * Provider (Meta vs Evolution) is resolved per account via
 * `getChannelForAccount` — the same seam every other send path in
 * this codebase goes through, so this needs no provider-specific
 * logic of its own. Variable tokens (#primeiroNome/#nomeCompleto) are
 * substituted here, against the contact's CURRENT name, not whatever
 * it was when the message was scheduled.
 */
async function drainScheduledMessages(admin: SupabaseClient): Promise<number> {
  const { data: due, error } = await admin
    .from('scheduled_messages')
    .select('id, account_id, conversation_id, content_type, content_text, media_url, contact:contacts(id, phone, name)')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(50)

  if (error || !due || due.length === 0) return 0

  let processed = 0
  for (const raw of due) {
    const row = raw as unknown as ScheduledMessageRow
    const { data: claim } = await admin
      .from('scheduled_messages')
      .update({ status: 'sending' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    processed++

    if (!row.contact?.phone) {
      await admin.from('scheduled_messages').update({
        status: 'failed', error_message: 'Contact has no phone number',
      }).eq('id', row.id)
      continue
    }

    try {
      const provider = await getChannelForAccount(row.account_id, admin)
      const to = sanitizePhoneForMeta(row.contact.phone)
      const text = row.content_text
        ? substituteMessageVariables(row.content_text, row.contact)
        : null

      const result =
        row.content_type === 'text'
          ? await provider.sender.sendText({ to, text: text ?? '' })
          : await provider.sender.sendMedia({
              to,
              kind: row.content_type as OutboundMediaKind,
              link: row.media_url!,
              caption: text ?? undefined,
            })

      const { data: message, error: msgError } = await admin
        .from('messages')
        .insert({
          conversation_id: row.conversation_id,
          sender_type: 'agent',
          content_type: row.content_type,
          content_text: text,
          media_url: row.media_url,
          message_id: result.providerMessageId,
          status: 'sent',
        })
        .select('id')
        .single()
      if (msgError) throw new Error(`sent but DB insert failed: ${msgError.message}`)

      await admin
        .from('conversations')
        .update({
          last_message_text: text || `[${row.content_type}]`,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.conversation_id)

      await admin.from('scheduled_messages').update({
        status: 'sent', sent_message_id: message.id,
      }).eq('id', row.id)
    } catch (err) {
      const message = err instanceof ChannelConfigError
        ? 'WhatsApp not configured for this account'
        : err instanceof Error ? err.message : 'Unknown send error'
      console.error('[scheduled-messages cron] send failed:', message)
      await admin.from('scheduled_messages').update({
        status: 'failed', error_message: message,
      }).eq('id', row.id)
    }
  }

  return processed
}

/**
 * Drains all due background work behind a single pinger URL: an
 * automation's `wait`-step queue, and manually scheduled per-lead
 * follow-ups. Meant to be hit on a schedule (Vercel Cron / external
 * pinger) — requires a shared secret via the `x-cron-secret` header to
 * match `AUTOMATION_CRON_SECRET`.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const automationsProcessed = await drainAutomationPendingExecutions(admin)
  const scheduledMessagesProcessed = await drainScheduledMessages(admin)

  return NextResponse.json({
    processed: automationsProcessed + scheduledMessagesProcessed,
    automation_pending_executions: automationsProcessed,
    scheduled_messages: scheduledMessagesProcessed,
  })
}
