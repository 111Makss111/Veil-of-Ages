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
}

export function requirePool(): pg.Pool {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}
