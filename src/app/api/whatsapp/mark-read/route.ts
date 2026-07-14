import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getChannelForAccount, ChannelConfigError } from '@/lib/channels/factory';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/mark-read
 *
 * Body: { conversation_id: <UUID> }
 *
 * Fired when the agent opens a conversation. Marks the contact's most
 * recent message as read via the account's channel provider — WhatsApp
 * treats this as covering every earlier message in the same chat too,
 * so there's no need to mark one by one. Best-effort throughout: a
 * missing contact/config/provider call failure never surfaces as an
 * error, since a missed read receipt has no user-visible consequence
 * worth interrupting the inbox for.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = checkRateLimit(`mark-read:${user.id}`, RATE_LIMITS.markRead);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { conversation_id } = body as { conversation_id?: string };

    if (!conversation_id) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 });
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, contact:contacts(phone)')
      .eq('id', conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;

    // No phone, or no customer message ever landed with a provider id
    // (e.g. an agent-initiated conversation with no reply yet) — both
    // are "nothing to mark," not errors.
    if (!contact?.phone) {
      return NextResponse.json({ status: 'noop' });
    }

    const { data: lastCustomerMessage } = await supabase
      .from('messages')
      .select('message_id')
      .eq('conversation_id', conversation_id)
      .eq('sender_type', 'customer')
      .not('message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastCustomerMessage?.message_id) {
      return NextResponse.json({ status: 'noop' });
    }

    let provider;
    try {
      provider = await getChannelForAccount(accountId, supabase);
    } catch (err) {
      if (err instanceof ChannelConfigError) {
        return NextResponse.json({ status: 'noop' });
      }
      throw err;
    }

    try {
      await provider.sender.markAsRead({
        to: sanitizePhoneForMeta(contact.phone),
        providerMessageId: lastCustomerMessage.message_id,
      });
    } catch (err) {
      console.warn(
        '[whatsapp/mark-read] provider call failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Error in WhatsApp mark-read POST:', error);
    return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 });
  }
}
