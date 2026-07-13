import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { EvolutionProvider } from '@/lib/channels/providers/evolution';
import { createEvolutionInstance, connectEvolutionInstance } from '@/lib/whatsapp/evolution-api';

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
      const result = await createEvolutionInstance({
        baseUrl, apiKey: process.env.EVOLUTION_API_KEY!, instanceName, webhookUrl,
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

  await supabase
    .from('whatsapp_config')
    .update({ evolution_connection_state: 'disconnected', evolution_qr_code: null })
    .eq('account_id', accountId);

  return NextResponse.json({ status: 'disconnected' }, { status: 200 });
}
