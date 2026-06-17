import type { AppDatabase } from "./database.js";
import type { CryptoBox } from "../lib/crypto.js";
import type { ZaiAccount, ZaiBrowserFingerprint } from "../types/zai.js";

type AccountRow = {
  id: string;
  provider: "zai";
  email: string;
  display_name: string | null;
  encrypted_token: string;
  encrypted_cookies: string;
  encrypted_local_storage: string;
  encrypted_browser_fingerprint: string | null;
  browser_profile_path: string;
  user_agent: string;
  status: "active" | "invalid" | "disabled" | "limited";
  failure_count: number;
  last_error: string | null;
  limited_until: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  last_validated_at: string | null;
};

export type SaveAccountInput = {
  id: string;
  email: string;
  displayName?: string | null;
  token: string;
  cookies: unknown[];
  localStorage: Record<string, string>;
  browserFingerprint?: ZaiBrowserFingerprint | null;
  browserProfilePath: string;
  userAgent: string;
};

export class AccountRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly crypto: CryptoBox
  ) {}

  save(input: SaveAccountInput): ZaiAccount {
    const now = new Date().toISOString();
    const existing = this.getRow(input.id);
    const createdAt = existing?.created_at ?? now;

    this.db
      .prepare(
        `
        INSERT INTO accounts (
          id, provider, email, display_name, encrypted_token,
          encrypted_cookies, encrypted_local_storage, encrypted_browser_fingerprint, browser_profile_path,
          user_agent, status, created_at, updated_at, last_login_at, last_validated_at
        ) VALUES (
          @id, 'zai', @email, @displayName, @encryptedToken,
          @encryptedCookies, @encryptedLocalStorage, @encryptedBrowserFingerprint, @browserProfilePath,
          @userAgent, 'active', @createdAt, @updatedAt, @lastLoginAt, @lastValidatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          display_name = excluded.display_name,
          encrypted_token = excluded.encrypted_token,
          encrypted_cookies = excluded.encrypted_cookies,
          encrypted_local_storage = excluded.encrypted_local_storage,
          encrypted_browser_fingerprint = excluded.encrypted_browser_fingerprint,
          browser_profile_path = excluded.browser_profile_path,
          user_agent = excluded.user_agent,
          status = 'active',
          failure_count = 0,
          last_error = NULL,
          limited_until = NULL,
          updated_at = excluded.updated_at,
          last_login_at = excluded.last_login_at,
          last_validated_at = excluded.last_validated_at
      `
      )
      .run({
        id: input.id,
        email: input.email,
        displayName: input.displayName ?? null,
        encryptedToken: this.crypto.encrypt(input.token),
        encryptedCookies: this.crypto.encrypt(input.cookies),
        encryptedLocalStorage: this.crypto.encrypt(input.localStorage),
        encryptedBrowserFingerprint: input.browserFingerprint ? this.crypto.encrypt(input.browserFingerprint) : null,
        browserProfilePath: input.browserProfilePath,
        userAgent: input.userAgent,
        createdAt,
        updatedAt: now,
        lastLoginAt: now,
        lastValidatedAt: now
      });

    const account = this.getById(input.id);
    if (!account) {
      throw new Error("Account save failed");
    }
    return account;
  }

  getActive(): ZaiAccount | null {
    const row = this.db
      .prepare(
        `
        SELECT * FROM accounts
        WHERE provider = 'zai' AND status = 'active'
        ORDER BY last_validated_at DESC, updated_at DESC
        LIMIT 1
      `
      )
      .get() as AccountRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  listUsable(): ZaiAccount[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `
        SELECT * FROM accounts
        WHERE provider = 'zai'
          AND status = 'active'
          AND email NOT LIKE 'guest-%@guest.com'
          AND (limited_until IS NULL OR limited_until <= @now)
        ORDER BY last_validated_at ASC, updated_at ASC
      `
      )
      .all({ now }) as AccountRow[];
    return rows.map((row) => this.fromRow(row));
  }

  getById(id: string): ZaiAccount | null {
    const row = this.getRow(id);
    return row ? this.fromRow(row) : null;
  }

  list(): ZaiAccount[] {
    const rows = this.db
      .prepare("SELECT * FROM accounts WHERE provider = 'zai' ORDER BY updated_at DESC")
      .all() as AccountRow[];
    return rows.map((row) => this.fromRow(row));
  }

  markValidated(id: string): void {
    this.db
      .prepare(
        `
        UPDATE accounts
        SET status = 'active',
            failure_count = 0,
            last_error = NULL,
            limited_until = NULL,
            last_validated_at = @now,
            updated_at = @now
        WHERE id = @id
      `
      )
      .run({ id, now: new Date().toISOString() });
  }

  markInvalid(id: string, error = "invalid_session"): void {
    this.db
      .prepare(
        `
        UPDATE accounts
        SET status = 'invalid',
            failure_count = failure_count + 1,
            last_error = @error,
            updated_at = @now
        WHERE id = @id
      `
      )
      .run({ id, error, now: new Date().toISOString() });
  }

  markLimited(id: string, error: string, cooldownMs: number): void {
    const now = new Date();
    const limitedUntil = new Date(now.getTime() + cooldownMs).toISOString();
    this.db
      .prepare(
        `
        UPDATE accounts
        SET status = 'limited',
            failure_count = failure_count + 1,
            last_error = @error,
            limited_until = @limitedUntil,
            updated_at = @now
        WHERE id = @id
      `
      )
      .run({ id, error, limitedUntil, now: now.toISOString() });
  }

  reactivateExpiredLimits(): void {
    this.db
      .prepare(
        `
        UPDATE accounts
        SET status = 'active',
            updated_at = @now
        WHERE status = 'limited'
          AND limited_until IS NOT NULL
          AND limited_until <= @now
      `
      )
      .run({ now: new Date().toISOString() });
  }

  private getRow(id: string): AccountRow | null {
    return (
      (this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined) ??
      null
    );
  }

  private fromRow(row: AccountRow): ZaiAccount {
    return {
      id: row.id,
      provider: row.provider,
      email: row.email,
      displayName: row.display_name,
      token: this.crypto.decrypt<string>(row.encrypted_token),
      cookies: this.crypto.decrypt<unknown[]>(row.encrypted_cookies),
      localStorage: this.crypto.decrypt<Record<string, string>>(row.encrypted_local_storage),
      browserFingerprint: row.encrypted_browser_fingerprint
        ? this.crypto.decrypt<ZaiBrowserFingerprint>(row.encrypted_browser_fingerprint)
        : null,
      browserProfilePath: row.browser_profile_path,
      userAgent: row.user_agent,
      status: row.status,
      failureCount: row.failure_count,
      lastError: row.last_error,
      limitedUntil: row.limited_until,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at,
      lastValidatedAt: row.last_validated_at
    };
  }
}
