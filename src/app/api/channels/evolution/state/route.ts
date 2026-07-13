import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase.from('profiles').select('account_id').eq('user_id', userId).maybeSingle();
  return (data?.account_id as string) ?? null;
}

/** GET — read-only cache lookup, never calls the Evolution server
 *  (approved design: "frontend só fala com o próprio backend"). */
export async function GET(_request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) return NextResponse.json({ error: 'No account' }, { status: 400 });

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('evolution_connection_state, evolution_qr_code, evolution_qr_updated_at, evolution_last_error')
    .eq('account_id', accountId)
    .maybeSingle();

  return NextResponse.json({
    status: config?.evolution_connection_state ?? 'disconnected',
    qrCode: config?.evolution_qr_code ?? null,
    qrUpdatedAt: config?.evolution_qr_updated_at ?? null,
    detail: config?.evolution_connection_state === 'error' ? (config?.evolution_last_error ?? null) : null,
  });
}
