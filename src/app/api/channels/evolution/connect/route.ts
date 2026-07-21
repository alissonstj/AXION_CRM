import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { EvolutionProvider } from '@/lib/channels/providers/evolution';
import { createEvolutionInstance, connectEvolutionInstance, setEvolutionWebhook } from '@/lib/whatsapp/evolution-api';

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase.from('profiles').select('account_id').eq('user_id', userId).maybeSingle();
  return (data?.account_id as string) ?? null;
}

function instanceNameFor(accountId: string): string {
  return `axion-${accountId}`;
}

/** POST — start (or restart) a QR connect flow for the caller's account. */
export async function POST(_request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) return NextResponse.json({ error: 'No account' }, { status: 400 });

  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('evolution_instance_token')
    .eq('account_id', accountId)
    .maybeSingle();

  const instanceName = instanceNameFor(accountId);
  const isNewInstance = !existing?.evolution_instance_token;
  const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/channels/evolution/webhook`;
  const baseUrl = process.env.EVOLUTION_API_URL!;

  let instanceToken: string;
  let qrCode: string | undefined;

  try {
    if (isNewInstance) {
      // No webhook block here — see createEvolutionInstance's own doc
      // comment. /instance/create starts the Baileys channel
      // synchronously and can fire qrcode.updated before this call's
      // response even returns, i.e. before the token below has been
      // saved anywhere the webhook route could look it up. Confirmed
      // live 2026-07-15: registering the webhook at creation time 401'd
      // on that very first delivery every single time, and each 401
      // spiraled into a full channel restart loop.
      const result = await createEvolutionInstance({
        baseUrl, apiKey: process.env.EVOLUTION_API_KEY!, instanceName,
      });
      instanceToken = result.token;
      qrCode = result.qrCode;
    } else {
      instanceToken = decrypt(existing!.evolution_instance_token as string);
      const result = await connectEvolutionInstance({ baseUrl, apiKey: instanceToken, instanceName });
      qrCode = result.qrCode;
    }
  } catch (err) {
    console.error('[evolution connect] failed:', err);
    return NextResponse.json({ error: 'Failed to connect to Evolution API' }, { status: 502 });
  }

  const update = {
    account_id: accountId,
    // `user_id` is NOT NULL on whatsapp_config (migration 001) and was
    // never relaxed when account_id became the tenancy key (migration
    // 017) — every insert must supply it, same convention as
    // src/app/api/whatsapp/config/route.ts's insert branch. Upsert
    // resends it on every call, which is a harmless no-op write on the
    // update path (same value already stored).
    user_id: user.id,
    provider: 'evolution' as const,
    evolution_instance_name: instanceName,
    evolution_instance_token: encrypt(instanceToken),
    evolution_connection_state: 'connecting',
    evolution_qr_code: qrCode ?? null,
    evolution_qr_updated_at: new Date().toISOString(),
    evolution_last_error: null,
  };

  const { error: upsertError } = await supabase.from('whatsapp_config').upsert(update, { onConflict: 'account_id' }).select().single();

  if (upsertError) {
    console.error('[evolution connect] failed to save config:', upsertError);
    return NextResponse.json({ error: 'Failed to save connection state' }, { status: 500 });
  }

  // Only now — token durably saved — is it safe to let Evolution start
  // delivering events for this instance. Best-effort: a failure here
  // must not block the QR the user is waiting to scan; the
  // connection.update handler re-arms nothing on its own, so a failed
  // enable here does mean the instance won't sync until the user
  // retries connect (surfaced as a console error, not a user-facing
  // one — same ack-and-log posture as the rest of this integration).
  try {
    await setEvolutionWebhook({ baseUrl, apiKey: instanceToken, instanceName, webhookUrl });
  } catch (err) {
    console.error('[evolution connect] failed to enable webhook:', err);
  }

  return NextResponse.json({ status: 'connecting', qrCode: qrCode ?? null }, { status: 200 });
}

/** DELETE — disconnect the caller's account's Evolution instance. */
export async function DELETE(_request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) return NextResponse.json({ error: 'No account' }, { status: 400 });

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('evolution_instance_name, evolution_instance_token')
    .eq('account_id', accountId)
    .maybeSingle();

  if (config?.evolution_instance_token) {
    const provider = new EvolutionProvider({
      baseUrl: process.env.EVOLUTION_API_URL!,
      apiKey: decrypt(config.evolution_instance_token as string),
      // deleteEvolutionInstance (called inside disconnect()) is an admin
      // action per the design doc's "Chaves de API" section — must use
      // the global key, not the instance token, or the delete call gets
      // rejected server-side and the instance is orphaned. Task 5's
      // disconnect() falls back to `apiKey` when this is absent, so it
      // must be passed explicitly here.
      adminApiKey: process.env.EVOLUTION_API_KEY!,
      instanceName: config.evolution_instance_name as string,
    });
    try {
      await provider.disconnect();
    } catch (err) {
      console.error('[evolution disconnect] failed (continuing to clear local state):', err);
    }
  }

  // Clear the token along with the state — disconnect() just deleted the
  // instance in Evolution itself, so leaving the old token in place would
  // make the next POST's `isNewInstance = !existing?.evolution_instance_token`
  // wrongly read "still exists" and call connectEvolutionInstance against
  // an instance Evolution no longer has, failing with "instance does not
  // exist" (reproduced live 2026-07-17). Clearing it here is what makes
  // the next connect attempt correctly create a fresh one instead.
  await supabase
    .from('whatsapp_config')
    .update({
      evolution_connection_state: 'disconnected',
      evolution_qr_code: null,
      evolution_instance_token: null,
    })
    .eq('account_id', accountId);

  return NextResponse.json({ status: 'disconnected' }, { status: 200 });
}
