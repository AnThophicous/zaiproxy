import Database from "better-sqlite3";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";

export type AppDatabase = Database.Database;

export function openDatabase(): AppDatabase {
  const db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  logger.success("DB", `SQLite ready at ${config.databasePath}`);
  return db;
}

function migrate(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'zai',
      email TEXT NOT NULL,
      display_name TEXT,
      encrypted_token TEXT NOT NULL,
      encrypted_cookies TEXT NOT NULL,
      encrypted_local_storage TEXT NOT NULL,
      encrypted_browser_fingerprint TEXT,
      browser_profile_path TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      limited_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      last_validated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_status
      ON accounts(status, updated_at);

    CREATE TABLE IF NOT EXISTS runtime_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      model TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      current_message_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
      ON conversations(updated_at);

    CREATE TABLE IF NOT EXISTS response_records (
      response_id TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_response_records_updated_at
      ON response_records(updated_at);
  `);

  addColumnIfMissing(db, "accounts", "failure_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "accounts", "last_error", "TEXT");
  addColumnIfMissing(db, "accounts", "limited_until", "TEXT");
  addColumnIfMissing(db, "accounts", "encrypted_browser_fingerprint", "TEXT");
}

function addColumnIfMissing(
  db: AppDatabase,
  table: string,
  column: string,
  definition: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
