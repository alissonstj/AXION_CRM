/**
 * Real-Postgres schema test — every other *.test.ts in this repo mocks
 * the Supabase JS client, which is why the Evolution connect route's
 * `whatsapp_config` upsert shipped for a while missing `user_id` (NOT
 * NULL, migration 001) and, once that was fixed, still violated
 * `phone_number_id`/`access_token` (also NOT NULL, migration 001, never
 * relaxed for provider='evolution' until migration 040) — no mock ever
 * enforces a real constraint, so both bugs were invisible to the suite
 * and only surfaced against a live Supabase project. This file applies
 * every real migration in supabase/migrations/ to a throwaway Postgres
 * container and inserts the exact row shapes the app's routes send, so
 * a future change that drops a required column or reintroduces a NOT
 * NULL/CHECK mismatch fails here instead of in production.
 *
 * Requires a local Docker daemon. Skips automatically (with a console
 * notice) if `docker version` fails — this is an opt-in integration
 * test, not part of the mocked-client suite every environment can run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const CONTAINER_NAME = `axion-schema-test-${randomUUID().slice(0, 8)}`;
const HOST_PORT_MARKER = '5432/tcp';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Minimal stand-ins for what a real Supabase project provisions
// out of the box (auth/storage schemas, roles, realtime publication)
// that the migrations assume already exist. Order matters: roles and
// extensions before anything that references them.
const SUPABASE_STUBS = `
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb DEFAULT '{}'::jsonb
  );
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
    SELECT NULL::uuid
  $$ LANGUAGE sql STABLE;
  CREATE PUBLICATION supabase_realtime;

  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (
    id text PRIMARY KEY,
    name text NOT NULL,
    public boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  CREATE TABLE storage.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id text REFERENCES storage.buckets(id),
    name text,
    owner uuid,
    metadata jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION storage.foldername(name text)
  RETURNS text[] AS $$
    SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$ LANGUAGE sql IMMUTABLE;
`;

const skip = !dockerAvailable();
if (skip) {
  console.warn('[whatsapp-config-schema.test] Docker not available — skipping real-Postgres schema tests.');
}

describe.skipIf(skip)('whatsapp_config real schema constraints', () => {
  let client: Client;
  let hostPort: number;

  beforeAll(async () => {
    // pgvector/pgvector:pg15, not plain postgres:15 — migration 030
    // creates a `vector` column and the plain image doesn't ship the
    // extension.
    execFileSync('docker', [
      'run', '-d', '--rm',
      '--name', CONTAINER_NAME,
      '-p', HOST_PORT_MARKER,
      '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=postgres',
      'pgvector/pgvector:pg15',
    ]);

    const portOutput = execFileSync('docker', ['port', CONTAINER_NAME, '5432/tcp']).toString().trim();
    hostPort = Number(portOutput.split(':').pop());

    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        execFileSync('docker', ['exec', CONTAINER_NAME, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    client = new Client({ host: 'localhost', port: hostPort, user: 'postgres', password: 'postgres', database: 'postgres' });
    await client.connect();
    await client.query(SUPABASE_STUBS);

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query(sql);
      } catch (err) {
        throw new Error(`Migration ${file} failed against real Postgres: ${(err as Error).message}`);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    try {
      execFileSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
    } catch {
      // best-effort cleanup
    }
  });

  async function makeAccount(label: string): Promise<{ userId: string; accountId: string }> {
    const userId = randomUUID();
    await client.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [userId, `${label}@test.local`]);
    // on_auth_user_created (migration 017) auto-creates the account row.
    const { rows } = await client.query('SELECT id FROM accounts WHERE owner_user_id = $1', [userId]);
    return { userId, accountId: rows[0].id };
  }

  it('accepts the exact row shape the Evolution connect route upserts', async () => {
    const { userId, accountId } = await makeAccount('evolution-connect');
    await expect(
      client.query(
        `INSERT INTO whatsapp_config
           (account_id, user_id, provider, evolution_instance_name, evolution_instance_token,
            evolution_connection_state, evolution_qr_code, evolution_qr_updated_at, evolution_last_error)
         VALUES ($1, $2, 'evolution', $3, 'encrypted-token', 'connecting', 'data:image/png;base64,AAA', now(), NULL)`,
        [accountId, userId, `axion-${accountId}`],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('rejects a provider=meta row missing phone_number_id/access_token', async () => {
    const { userId, accountId } = await makeAccount('meta-incomplete');
    await expect(
      client.query(`INSERT INTO whatsapp_config (account_id, user_id, provider) VALUES ($1, $2, 'meta')`, [
        accountId,
        userId,
      ]),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  it('still accepts a complete provider=meta row (no regression from relaxing NOT NULL)', async () => {
    const { userId, accountId } = await makeAccount('meta-complete');
    await expect(
      client.query(
        `INSERT INTO whatsapp_config (account_id, user_id, provider, phone_number_id, access_token)
         VALUES ($1, $2, 'meta', 'pnid-1', 'token-1')`,
        [accountId, userId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('rejects an Evolution row missing user_id (pins the bug this file exists to catch)', async () => {
    const { accountId } = await makeAccount('evolution-no-user');
    await expect(
      client.query(
        `INSERT INTO whatsapp_config (account_id, provider, evolution_instance_name) VALUES ($1, 'evolution', $2)`,
        [accountId, `axion-${accountId}`],
      ),
    ).rejects.toMatchObject({ code: '23502' }); // not_null_violation
  });
});
