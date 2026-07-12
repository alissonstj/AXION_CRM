import { describe, it, expect, vi } from 'vitest';
import { uploadEvolutionMedia } from './evolution-media';

function dbWithStorage() {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const getPublicUrl = vi.fn().mockReturnValue({ data: { publicUrl: 'https://cdn.local/chat-media/account-acc-1/123-media.jpg' } });
  return {
    storage: { from: () => ({ upload, getPublicUrl }) },
    _upload: upload,
  } as unknown as import('@supabase/supabase-js').SupabaseClient & { _upload: typeof upload };
}

describe('uploadEvolutionMedia', () => {
  it('decodes base64 and uploads to chat-media under the account-scoped path', async () => {
    const db = dbWithStorage();
    const url = await uploadEvolutionMedia(db, {
      accountId: 'acc-1', base64: Buffer.from('hello').toString('base64'),
      mimeType: 'image/jpeg', providerMessageId: 'MSG1',
    });
    expect(url).toBe('https://cdn.local/chat-media/account-acc-1/123-media.jpg');
    const [path, buffer, opts] = db._upload.mock.calls[0];
    expect(path).toMatch(/^account-acc-1\/.*MSG1\.jpg$/);
    expect(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array).toBe(true);
    expect(opts).toMatchObject({ contentType: 'image/jpeg' });
  });

  it('returns null and does not throw when the upload fails', async () => {
    const db = dbWithStorage();
    (db as unknown as { _upload: ReturnType<typeof vi.fn> })._upload.mockResolvedValueOnce({ error: { message: 'quota' } });
    const url = await uploadEvolutionMedia(db, {
      accountId: 'acc-1', base64: Buffer.from('x').toString('base64'),
      mimeType: 'audio/ogg', providerMessageId: 'MSG2',
    });
    expect(url).toBeNull();
  });
});
