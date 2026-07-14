import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

/**
 * DELETE /api/scheduled-messages/[id]
 *
 * Cancels a pending follow-up (status -> 'cancelled'). Only a `pending`
 * row can be cancelled — one already claimed/sent/failed by the cron
 * sweep (see /api/automations/cron) is left alone; the conditional
 * `.eq('status', 'pending')` on the UPDATE makes that atomic against a
 * sweep that might claim the same row concurrently.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const admin = supabaseAdmin()

  const { data, error } = await admin
    .from('scheduled_messages')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) {
    return NextResponse.json(
      { error: 'Scheduled message not found, or already sent/cancelled' },
      { status: 404 },
    )
  }
  return NextResponse.json({ status: 'cancelled' })
}
