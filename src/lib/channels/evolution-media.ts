import type { SupabaseClient } from '@supabase/supabase-js';

// Same bucket + account-scoped path convention as the composer/flows
// uploads (migration 023: chat-media/account-<account_id>/<ts>-<name>).
// This is a server-side counterpart to src/lib/storage/upload-media.ts's
// `uploadAccountMedia` — that helper requires a browser session
// (`supabase.auth.getUser()`), unusable from a webhook route running on
// the service-role client. Service role bypasses RLS entirely, so no
// policy check is needed here — the account-scoped path is kept purely
// for consistency with every other media object in the bucket.
const BUCKET = 'chat-media';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

// Evolution's webhook sends the full Content-Type, parameters and all
// (e.g. 'audio/ogg; codecs=opus' for every voice note — confirmed live
// in Phase 2). Supabase Storage's bucket-level `allowed_mime_types`
// (migration 023) only lists bare types ('audio/ogg'), and rejects an
// upload whose Content-Type doesn't match one of those entries
// EXACTLY — 'audio/ogg; codecs=opus' fails that check even though
// 'audio/ogg' is allowed. Strip params before using the value for
// anything Storage-facing.
function baseMimeType(mimeType: string | null | undefined): string | undefined {
  return mimeType?.split(';')[0].trim() || undefined;
}

function extensionFor(mimeType: string | null | undefined, fileName?: string | null): string {
  if (fileName && /\.[^.]+$/.test(fileName)) return fileName.split('.').pop()!.toLowerCase();
  const base = baseMimeType(mimeType);
  return (base && EXT_BY_MIME[base]) || 'bin';
}

export interface UploadEvolutionMediaArgs {
  accountId: string;
  base64: string;
  mimeType?: string | null;
  fileName?: string | null;
  providerMessageId: string;
}

/**
 * Decode a base64 payload from an Evolution webhook and upload it to the
 * same Storage bucket the inbox composer uses, returning a public URL for
 * `messages.media_url`. Best-effort: a failed upload returns null (logged)
 * rather than throwing — must not drop the whole inbound message just
 * because Storage hiccuped, matching ingestInbound's best-effort DB-write
 * semantics elsewhere.
 */
export async function uploadEvolutionMedia(
  db: SupabaseClient,
  args: UploadEvolutionMediaArgs,
): Promise<string | null> {
  const { accountId, base64, mimeType, fileName, providerMessageId } = args;
  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = extensionFor(mimeType, fileName);
    const path = `account-${accountId}/${Date.now()}-${providerMessageId}.${ext}`;
    const { error } = await db.storage.from(BUCKET).upload(path, buffer, {
      cacheControl: '3600',
      upsert: false,
      contentType: baseMimeType(mimeType) ?? 'application/octet-stream',
    });
    if (error) {
      console.error('[evolution-media] upload failed:', error.message ?? error);
      return null;
    }
    const { data } = db.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error('[evolution-media] upload threw:', err);
    return null;
  }
}
