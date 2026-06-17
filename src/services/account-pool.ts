import type { AccountRepository } from "../db/accounts.js";
import { logger } from "../lib/logger.js";
import type { ZaiAccount } from "../types/zai.js";

const LIMIT_COOLDOWN_MS = 60 * 1000;

export class AccountPool {
  constructor(private readonly accounts: AccountRepository) {}

  next(): ZaiAccount {
    this.accounts.reactivateExpiredLimits();
    const usable = this.accounts.listUsable();
    if (usable.length === 0) {
      throw new Error(noUsableAccountMessage(this.accounts.list()));
    }

    const account = usable[0];
    if (!account) {
      throw new Error(noUsableAccountMessage(this.accounts.list()));
    }
    logger.info("AUTH", `Selected account ${maskEmail(account.email)} (${usable.length} usable)`);
    return account;
  }

  candidates(): ZaiAccount[] {
    this.accounts.reactivateExpiredLimits();
    return this.accounts.listUsable();
  }

  reportSuccess(account: ZaiAccount): void {
    this.accounts.markValidated(account.id);
  }

  reportFailure(account: ZaiAccount, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);

    if (isAuthError(message)) {
      logger.warn("AUTH", `Marking ${maskEmail(account.email)} invalid`, message);
      this.accounts.markInvalid(account.id, message);
      return;
    }

    if (isLimitError(message)) {
      logger.warn("AUTH", `Marking ${maskEmail(account.email)} limited for 1 minute`, message);
      this.accounts.markLimited(account.id, message, LIMIT_COOLDOWN_MS);
      return;
    }

    logger.warn("AUTH", `Keeping ${maskEmail(account.email)} active after upstream failure`, message);
  }
}

export function isGuestEmail(email: string): boolean {
  return email.startsWith("guest-") && email.endsWith("@guest.com");
}

export function noUsableAccountMessage(accounts: ZaiAccount[]): string {
  const now = new Date().toISOString();
  const realAccounts = accounts.filter((account) => !isGuestEmail(account.email));
  const cooldownAccounts = realAccounts.filter((account) => account.limitedUntil && account.limitedUntil > now);

  if (realAccounts.length > 0 && cooldownAccounts.length === realAccounts.length) {
    const nextReady = cooldownAccounts
      .map((account) => account.limitedUntil)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    return `No Z.ai account is usable right now; saved real accounts are in short retry cooldown${nextReady ? ` until ${nextReady}` : ""}. Try again soon or run npm run login to add another account.`;
  }

  if (realAccounts.length > 0) {
    return "No usable non-guest Z.ai account right now. Saved real accounts may be invalid, disabled, or in short retry cooldown. Run npm run login to add another account.";
  }

  return "No usable non-guest Z.ai account. Run npm run login and sign in with a real account.";
}

function isAuthError(message: string): boolean {
  return /401|unauthorized|invalid token|token expired|login|auth/i.test(message);
}

function isLimitError(message: string): boolean {
  return /429|rate.?limit|limit reached|too many|usage exceeds|quota|current usage exceeds/i.test(message);
}

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!name || !domain) {
    return email;
  }
  const visible = name.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(2, name.length - 2))}@${domain}`;
}
