import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for server-side routes that need to
// bypass RLS (webhooks, admin endpoints). Mirrors the same lazy-init
// pattern used per-domain in src/lib/flows/admin-client.ts,
// src/lib/automations/admin-client.ts, and src/lib/ai/admin-client.ts —
// kept at this shared path (rather than yet another per-domain copy)
// because the Evolution webhook route test mocks this exact module
// specifier to swap in a scripted Supabase stub.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
