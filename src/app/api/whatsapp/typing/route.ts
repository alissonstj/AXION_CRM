import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getChannelForAccount, ChannelConfigError } from '@/lib/channels/factory';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// How long the "digitando…" indicator stays up per ping — the composer
// re-triggers this (throttled) while the agent keeps typing, so the
// indicator effectively persists until ~this long after the last
// keystroke, same as a real WhatsApp client.
const TYPING_DURATION_MS = 5_500;

/**
 * POST /api/whatsapp/typing
 *
 * Body: { conversation_id: <UUID> }
 *
 * Fired (throttled) from the composer while the agent is typing a
 * reply. Unlike mark-read, this is NOT awaited before responding —
 * `sender.sendTyping` resolves only after `TYPING_DURATION_MS` (see
 * SendTypingArgs' contract in types.ts), and holding the HTTP response
 * open that long on every keystroke burst would be a poor composer UX
 * for no benefit. Best-effort throughout, same reasoning as mark-read:
 * a missed typing indicator has no consequence worth surfacing as an
 * error.
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

    const limit = checkRateLimit(`typing:${user.id}`, RATE_LIMITS.typing);
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

    if (!contact?.phone) {
      return NextResponse.json({ status: 'noop' });
    }

    // Only needed by the Meta provider (Evolution's presence update is
    // chat-scoped) — `sender.sendTyping` no-ops on its own when this is
    // absent, same as mark-read's "nothing to mark" case.
    const { data: lastCustomerMessage } = await supabase
      .from('messages')
      .select('message_id')
      .eq('conversation_id', conversation_id)
      .eq('sender_type', 'customer')
      .not('message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let provider;
    try {
      provider = await getChannelForAccount(accountId, supabase);
    } catch (err) {
      if (err instanceof ChannelConfigError) {
        return NextResponse.json({ status: 'noop' });
      }
      throw err;
    }

    // Fire-and-forget — see the route's doc comment for why this isn't
    // awaited.
    void provider.sender
      .sendTyping({
        to: sanitizePhoneForMeta(contact.phone),
        contextProviderMessageId: lastCustomerMessage?.message_id ?? undefined,
        durationMs: TYPING_DURATION_MS,
      })
      .catch((err) => {
        console.warn(
          '[whatsapp/typing] provider call failed (non-fatal):',
          err instanceof Error ? err.message : err,
        );
      });

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Error in WhatsApp typing POST:', error);
    return NextResponse.json({ error: 'Failed to send typing indicator' }, { status: 500 });
  }
}
