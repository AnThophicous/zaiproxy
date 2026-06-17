import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AccountRepository } from "../db/accounts.js";
import { config } from "../config/env.js";
import { ensureDir } from "../lib/paths.js";
import { decodeJwtPayload } from "../lib/jwt.js";
import { logger } from "../lib/logger.js";
import { isGuestEmail } from "./account-pool.js";
import type { ZaiAccount, ZaiBrowserFingerprint } from "../types/zai.js";

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export type SessionBootstrapOptions = {
  accountName?: string;
  allowGuest?: boolean;
  freshProfile?: boolean;
  reuseProfile?: boolean;
};

export class SessionBootstrap {
  constructor(private readonly accounts: AccountRepository) {}

  async run(options: SessionBootstrapOptions = {}): Promise<void> {
    const profileName = this.selectProfileName(options);
    const profilePath = ensureDir(join(config.runtimeDir, "profiles", profileName));
    const launchOptions = browserLaunchOptions();
    logger.info("AUTH", `Opening browser profile at ${profilePath}`, {
      browser: launchOptions.executablePath ?? launchOptions.channel ?? "playwright-chromium"
    });

    const context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: { width: 1365, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
      ...launchOptions
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const observedHeaders = new Map<string, string>();
      page.on("request", (request) => {
        if (!request.url().startsWith(config.zai.baseUrl)) {
          return;
        }
        for (const [key, value] of Object.entries(request.headers())) {
          if (value) {
            observedHeaders.set(key.toLowerCase(), value);
          }
        }
      });
      await page.goto(config.zai.baseUrl, { waitUntil: "domcontentloaded" });
      logger.info("AUTH", "Waiting for Z.ai login. Complete the login flow in the browser.");

      const token = await waitForRealToken(page, LOGIN_TIMEOUT_MS, Boolean(options.allowGuest));
      const payload = decodeJwtPayload(token);
      const accountId = payload?.id ?? payload?.sub;
      const email = payload?.email;

      if (!accountId || !email) {
        throw new Error("Could not read account id/email from Z.ai token");
      }
      if (!options.allowGuest && isGuestEmail(email)) {
        throw new Error("Refusing to save guest Z.ai session. Sign in with a real account.");
      }

      const cookies = await context.cookies(config.zai.baseUrl);
      const localStorage = await readLocalStorage(page);
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const browserFingerprint = await readBrowserFingerprint(
        page,
        userAgent,
        Object.fromEntries(observedHeaders)
      );

      const account = this.accounts.save({
        id: accountId,
        email,
        displayName: typeof payload?.name === "string" ? payload.name : null,
        token,
        cookies,
        localStorage,
        browserFingerprint,
        browserProfilePath: profilePath,
        userAgent
      });

      logger.success("AUTH", `Saved encrypted session for ${account.email} (${account.id})`);
    } finally {
      await context.close();
    }
  }

  private selectProfileName(options: SessionBootstrapOptions): string {
    if (options.accountName) {
      return sanitizeProfileName(options.accountName);
    }

    if (options.freshProfile) {
      return makeFreshProfileName();
    }

    const defaultProfileName = "default";
    const defaultProfilePath = join(config.runtimeDir, "profiles", defaultProfileName);
    const now = new Date().toISOString();
    const profileAccounts = this.accounts
      .list()
      .filter((account) => account.browserProfilePath === defaultProfilePath);

    if (!options.reuseProfile && profileAccounts.length > 0) {
      const hasUsableSession = profileAccounts.some((account) => isUsableRealAccount(account, now));
      if (!hasUsableSession) {
        const first = profileAccounts[0];
        const reason = first
          ? `${first.email} is ${first.status}${first.limitedUntil ? ` until ${first.limitedUntil}` : ""}`
          : "profile has no usable account";
        const freshProfileName = makeFreshProfileName();
        logger.warn(
          "AUTH",
          `Default login profile is tied to an unusable account (${reason}); opening fresh profile ${freshProfileName}`
        );
        logger.warn("AUTH", "Use --reuse-profile to force the old default profile, or --account <name> for a named profile.");
        return freshProfileName;
      }
    }

    return defaultProfileName;
  }
}

type BrowserLaunchOptions = Pick<
  NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>,
  "channel" | "executablePath"
>;

type NavigatorWithClientHints = Navigator & {
  deviceMemory?: number;
  userAgentData?: {
    brands?: Array<{ brand: string; version: string }>;
    mobile?: boolean;
    platform?: string;
  };
};

function browserLaunchOptions(): BrowserLaunchOptions {
  if (config.browser.executablePath) {
    if (!existsSync(config.browser.executablePath)) {
      throw new Error(`BROWSER_EXECUTABLE_PATH does not exist: ${config.browser.executablePath}`);
    }
    return { executablePath: config.browser.executablePath };
  }

  if (config.browser.channel) {
    return { channel: config.browser.channel };
  }

  for (const executablePath of systemBrowserCandidates()) {
    if (existsSync(executablePath)) {
      return { executablePath };
    }
  }

  return {};
}

function systemBrowserCandidates(): string[] {
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter((value): value is string => Boolean(value));
    return roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe")
    ]);
  }

  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    ];
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium"
  ];
}

async function waitForRealToken(page: Page, timeoutMs: number, allowGuest: boolean): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = page.url();
  let sawGuest = false;

  while (Date.now() < deadline) {
    if (page.url() !== lastUrl) {
      lastUrl = page.url();
      logger.info("AUTH", `Browser navigated to ${safeBrowserLocation(lastUrl)}`);
    }

    const token = await safeReadToken(page);
    if (token) {
      const payload = decodeJwtPayload(token);
      const email = typeof payload?.email === "string" ? payload.email : "";
      if (allowGuest || (email && !isGuestEmail(email))) {
        return token;
      }

      if (!sawGuest) {
        sawGuest = true;
        logger.warn("AUTH", "Guest session detected; waiting for a real account login.");
        await page.goto(`${config.zai.baseUrl}/auth?redirect=/`, { waitUntil: "domcontentloaded" });
      }
    }
    await page.waitForTimeout(1500);
  }

  throw new Error("Timed out waiting for Z.ai login token");
}

function safeBrowserLocation(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "unknown";
  }
}

function sanitizeProfileName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function makeFreshProfileName(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `login-${stamp}`;
}

function isUsableRealAccount(account: ZaiAccount, now: string): boolean {
  return (
    account.status === "active" &&
    !isGuestEmail(account.email) &&
    (!account.limitedUntil || account.limitedUntil <= now)
  );
}

async function safeReadToken(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => localStorage.getItem("token"));
  } catch {
    return null;
  }
}

async function readLocalStorage(page: Page): Promise<Record<string, string>> {
  try {
    return await page.evaluate(() => {
      const values: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key) {
          values[key] = localStorage.getItem(key) ?? "";
        }
      }
      return values;
    });
  } catch {
    return {};
  }
}

async function readBrowserFingerprint(
  page: Page,
  userAgent: string,
  observedHeaders: Record<string, string>
): Promise<ZaiBrowserFingerprint> {
  try {
    return await page.evaluate(
      ({ fallbackUserAgent, headers }) => {
        const nav = navigator as NavigatorWithClientHints;
        const hints = nav.userAgentData;
        const finalUserAgent = fallbackUserAgent || nav.userAgent || "";
        const rawLanguages = nav.languages?.length ? Array.from(nav.languages) : [nav.language];
        const languages: string[] = [];
        for (const value of rawLanguages) {
          if (typeof value === "string" && value) {
            languages.push(value);
          }
        }
        const platform = hints?.platform || nav.platform || "";

        let browserName = "Unknown";
        if (hints?.brands) {
          for (const item of hints.brands) {
            if (!/Not|Chromium/i.test(item.brand)) {
              browserName = item.brand;
              break;
            }
          }
        }
        if (browserName === "Unknown") {
          if (/Edg\//.test(finalUserAgent)) browserName = "Edge";
          else if (/OPR\//.test(finalUserAgent)) browserName = "Opera";
          else if (/Chrome\//.test(finalUserAgent)) browserName = "Chrome";
          else if (/Firefox\//.test(finalUserAgent)) browserName = "Firefox";
          else if (/Safari\//.test(finalUserAgent)) browserName = "Safari";
        }

        const osValue = `${platform} ${finalUserAgent}`;
        let osName = platform || "Unknown";
        if (/Windows/i.test(osValue)) osName = "Windows";
        else if (/Android/i.test(osValue)) osName = "Android";
        else if (/iPhone|iPad|iOS/i.test(osValue)) osName = "iOS";
        else if (/Mac/i.test(osValue)) osName = "macOS";
        else if (/Linux/i.test(osValue)) osName = "Linux";

        const requestHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
          if (typeof value === "string" && value.trim()) {
            requestHeaders[key.trim().toLowerCase()] = value.trim();
          }
        }

        const secChUaParts: string[] = [];
        if (hints?.brands) {
          for (const item of hints.brands) {
            secChUaParts.push(`"${item.brand}";v="${item.version}"`);
          }
        }
        const secChUa = secChUaParts.join(", ");
        const secChUaPlatform = platform ? `"${platform}"` : "";
        requestHeaders["user-agent"] ??= finalUserAgent;
        requestHeaders["accept-language"] ??= languages.length ? languages.join(",") : "en-US";
        requestHeaders["accept-encoding"] ??= "gzip, deflate, br, zstd";
        requestHeaders["sec-fetch-dest"] = "empty";
        requestHeaders["sec-fetch-mode"] = "cors";
        requestHeaders["sec-fetch-site"] = "same-origin";
        requestHeaders.origin ??= window.location.origin;
        requestHeaders.host ??= window.location.host;
        if (secChUa) requestHeaders["sec-ch-ua"] ??= secChUa;
        requestHeaders["sec-ch-ua-mobile"] ??= hints?.mobile ? "?1" : "?0";
        if (secChUaPlatform) requestHeaders["sec-ch-ua-platform"] ??= secChUaPlatform;

        const sessionValues: Record<string, string> = {};
        try {
          for (let index = 0; index < sessionStorage.length; index += 1) {
            const key = sessionStorage.key(index);
            if (key) {
              sessionValues[key] = sessionStorage.getItem(key) ?? "";
            }
          }
        } catch {
          // Some browser privacy modes can block sessionStorage access.
        }

        return {
          version: 1,
          capturedAt: new Date().toISOString(),
          userAgent: finalUserAgent,
          language: nav.language || languages[0] || "en-US",
          languages: languages.length ? languages : ["en-US"],
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          timezoneOffset: new Date().getTimezoneOffset(),
          cookieEnabled: Boolean(nav.cookieEnabled),
          screen: {
            width: Number(window.screen.width) || 0,
            height: Number(window.screen.height) || 0,
            availWidth: Number(window.screen.availWidth) || 0,
            availHeight: Number(window.screen.availHeight) || 0,
            colorDepth: Number(window.screen.colorDepth) || 24,
            pixelDepth: Number(window.screen.pixelDepth) || 24
          },
          viewport: {
            width: Number(window.innerWidth) || 0,
            height: Number(window.innerHeight) || 0
          },
          pixelRatio: Number(window.devicePixelRatio) || 1,
          isTouch: "ontouchstart" in window,
          maxTouchPoints: Number(nav.maxTouchPoints) || 0,
          platform,
          vendor: nav.vendor || "",
          browserName,
          osName,
          hardwareConcurrency:
            typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
          deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
          sessionStorage: sessionValues,
          requestHeaders
        } satisfies ZaiBrowserFingerprint;
      },
      { fallbackUserAgent: userAgent, headers: observedHeaders }
    );
  } catch (error) {
    logger.warn("AUTH", "Could not capture browser fingerprint; saving fallback snapshot", error);
    return fallbackBrowserFingerprint(userAgent, observedHeaders);
  }
}

function fallbackBrowserFingerprint(
  userAgent: string,
  observedHeaders: Record<string, string>
): ZaiBrowserFingerprint {
  const requestHeaders = normalizeObservedHeaders(observedHeaders);
  requestHeaders["user-agent"] ??= userAgent;
  requestHeaders["accept-language"] ??= config.zai.acceptLanguage;
  requestHeaders["accept-encoding"] ??= "gzip, deflate, br, zstd";
  requestHeaders["sec-fetch-dest"] = "empty";
  requestHeaders["sec-fetch-mode"] = "cors";
  requestHeaders["sec-fetch-site"] = "same-origin";
  requestHeaders.origin ??= config.zai.baseUrl;

  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    userAgent,
    language: config.zai.language,
    languages: [config.zai.language, "pt", "en-US", "en"],
    timezone: config.zai.timezone,
    timezoneOffset: 180,
    cookieEnabled: true,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1080,
      colorDepth: 24,
      pixelDepth: 24
    },
    viewport: {
      width: 1365,
      height: 900
    },
    pixelRatio: 1,
    isTouch: false,
    maxTouchPoints: 0,
    platform: process.platform,
    vendor: "",
    browserName: inferBrowserName(userAgent),
    osName: inferOsName(userAgent),
    hardwareConcurrency: null,
    deviceMemory: null,
    sessionStorage: {},
    requestHeaders
  };
}

function normalizeObservedHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.trim() && value.trim()) {
      normalized[key.trim().toLowerCase()] = value.trim();
    }
  }
  return normalized;
}

function inferBrowserName(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Unknown";
}

function inferOsName(userAgent: string): string {
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Android/i.test(userAgent)) return "Android";
  if (/iPhone|iPad|iOS/i.test(userAgent)) return "iOS";
  if (/Mac/i.test(userAgent)) return "macOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return process.platform;
}
