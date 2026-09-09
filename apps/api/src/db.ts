import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = config.DATABASE_URL
  ? new Pool({
      connectionString: config.DATABASE_URL,
      ssl: config.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
      max: 5,
      connectionTimeoutMillis: 6000,
      query_timeout: 6000
    })
  : null;

export async function migrate(): Promise<void> {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS studio_owner (
      id INTEGER PRIMARY KEY CHECK (id=1), google_sub TEXT,
      totp_encrypted TEXT, last_step BIGINT NOT NULL DEFAULT -1,
      recovery_hashes JSONB NOT NULL DEFAULT '[]',
      failures INTEGER NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ
    );
    INSERT INTO studio_owner(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS studio_sessions (
      token_hash TEXT PRIMARY KEY, google_sub TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      enrollment_encrypted TEXT, expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_login_states (
      state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL,
      verifier_encrypted TEXT NOT NULL, nonce TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS youtube_uploads (
      file_hash TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('uploading', 'complete', 'uncertain')),
      video_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS youtube_oauth_states (
      state_hash TEXT PRIMARY KEY,
      browser_hash TEXT NOT NULL,
      verifier_encrypted TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS youtube_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      refresh_token_encrypted TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS telegram_links (
      id UUID PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'expired')),
      telegram_user_id BIGINT,
      telegram_chat_id BIGINT,
      telegram_username TEXT,
      telegram_first_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      connected_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS telegram_links_expires_at_idx
      ON telegram_links (expires_at);
  `);
  const { songsMigration, seedSongs } = await import('./songs-store.js');
  await pool.query(songsMigration);
  await seedSongs(pool);
}

export function requirePool(): pg.Pool {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}
