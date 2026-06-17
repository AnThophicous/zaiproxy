import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { config } from "../config/env.js";
import { ensureDir } from "../lib/paths.js";
import { logger } from "../lib/logger.js";
import type { ZaiAccount } from "../types/zai.js";

const CAPTCHA_SCRIPT_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

type CaptchaSession = {
  accountId: string;
  context: BrowserContext;
  page: Page;
  preparedAt: number;
  headless: boolean;
};

export class CaptchaSolver {
  private readonly solveQueues = new Map<string, Promise<void>>();
  private session: CaptchaSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  async solve(account: ZaiAccount): Promise<string> {
    const previous = this.solveQueues.get(account.id) ?? Promise.resolve();
    const solve = previous.catch(() => undefined).then(() => this.solveWithFallback(account));
    const queueTail = solve.then(
      () => undefined,
      () => undefined
    );

    this.solveQueues.set(account.id, queueTail);
    try {
      return await solve;
    } finally {
      if (this.solveQueues.get(account.id) === queueTail) {
        this.solveQueues.delete(account.id);
      }
    }
  }

  private async solveWithFallback(account: ZaiAccount): Promise<string> {
    try {
      return await this.solveFresh(account, config.captcha.headless);
    } catch (error) {
      if (!config.captcha.headless || !isCaptchaTimeoutError(error)) {
        throw error;
      }
      logger.warn("AUTH", "Headless Z.ai captcha timed out; opening visible Chromium for manual verification");
      await this.closeSession();
      return await this.solveFresh(account, false);
    }
  }

  private async getSession(account: ZaiAccount, headless: boolean): Promise<CaptchaSession> {
    this.clearIdleTimer();
    if (this.session?.accountId === account.id && this.session.headless === headless && !this.session.page.isClosed()) {
      return this.session;
    }

    await this.closeSession();
    const { chromium } = await import("playwright");
    const profileName = `${sanitizeProfileSegment(account.id)}${headless ? "" : "-visible"}`;
    const profilePath = ensureDir(join(config.runtimeDir, "captcha-profiles", profileName));
    logger.warn("AUTH", `Z.ai captcha required; starting ${headless ? "headless" : "visible"} Chromium at ${profilePath}`);

    const context = await chromium.launchPersistentContext(profilePath, {
      headless,
      viewport: { width: 1365, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding"
      ]
    });
    await context
      .route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "font" || type === "media") {
          return route.abort();
        }
        return route.continue();
      })
      .catch(() => {});

    context.on("close", () => {
      if (this.session?.context === context) {
        this.session = null;
      }
    });

    const page = context.pages()[0] ?? (await context.newPage());
    this.session = { accountId: account.id, context, page, preparedAt: 0, headless };
    return this.session;
  }

  private async closeSession(): Promise<void> {
    this.clearIdleTimer();
    const session = this.session;
    this.session = null;
    if (session) {
      await session.context.close().catch(() => {});
    }
  }

  private async preparePage(session: CaptchaSession, account: ZaiAccount): Promise<Page> {
    const page = session.page.isClosed() ? await session.context.newPage() : session.page;
    if (page !== session.page) {
      this.session = { ...session, page, preparedAt: 0 };
    }

    if (this.session?.accountId === account.id && Date.now() - this.session.preparedAt < 5 * 60 * 1000) {
      return page;
    }

    await session.context.addCookies(account.cookies as Parameters<typeof session.context.addCookies>[0]).catch(() => {});
    await page.goto(config.zai.baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      ({ localStorageValues, token }) => {
        for (const [key, value] of Object.entries(localStorageValues)) {
          window.localStorage.setItem(key, value);
        }
        window.localStorage.setItem("token", token);
      },
      { localStorageValues: account.localStorage, token: account.token }
    );

    await page.goto(config.zai.baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
    if (this.session?.accountId === account.id) {
      this.session.preparedAt = Date.now();
    }
    return page;
  }

  private async solveFresh(account: ZaiAccount, headless: boolean): Promise<string> {
    const session = await this.getSession(account, headless);

    try {
      const page = await this.preparePage(session, account);
      if (!headless) {
        await page.bringToFront().catch(() => {});
      }
      const timeoutMs = headless ? Math.min(config.captcha.timeoutMs, 45_000) : config.captcha.timeoutMs;
      const captcha = await page.evaluate(
        ({ language, scriptUrl, timeoutMs, visible }) =>
          new Promise<string>((resolve, reject) => {
            const elementId = "chat-captcha-element";
            const buttonId = "chat-captcha-trigger";
            const overlayId = "chat-captcha-overlay";
            let instance: { refresh?: () => void } | null = null;
            let settled = false;
            const timer = window.setTimeout(() => fail("captcha timed out"), timeoutMs);

            const removeCaptchaNodes = () => {
              document.getElementById(overlayId)?.remove();
              document.getElementById(elementId)?.remove();
              document.getElementById(buttonId)?.remove();
            };

            const cleanupAfterAttempt = () => {
              if (visible) {
                document.getElementById(overlayId)?.remove();
              }
            };

            const finish = (value: unknown) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              cleanupAfterAttempt();
              try {
                instance?.refresh?.();
              } catch {
                // Best effort; the same hidden browser can be reused for the next captcha.
              }
              if (typeof value === "string") {
                resolve(value);
                return;
              }
              if (value && typeof value === "object") {
                const record = value as Record<string, unknown>;
                const nested =
                  record.captcha_verify_param ??
                  record.captchaVerifyParam ??
                  record.verifyParam ??
                  record.token;
                if (typeof nested === "string") {
                  resolve(nested);
                  return;
                }
              }
              resolve(JSON.stringify(value));
            };

            const fail = (message: string) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              cleanupAfterAttempt();
              reject(new Error(message));
            };

            const createHiddenNodes = () => {
              removeCaptchaNodes();
              const element = document.createElement("div");
              element.id = elementId;
              element.style.cssText =
                "position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;overflow:hidden;";
              const button = document.createElement("button");
              button.id = buttonId;
              button.type = "button";
              button.setAttribute("aria-hidden", "true");
              button.tabIndex = -1;
              button.style.cssText =
                "position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;overflow:hidden;";
              document.body.appendChild(element);
              document.body.appendChild(button);
              return button;
            };

            const createVisibleNodes = () => {
              removeCaptchaNodes();
              const overlay = document.createElement("div");
              overlay.id = overlayId;
              overlay.style.cssText =
                "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.76);";

              const panel = document.createElement("div");
              panel.style.cssText =
                "width:380px;max-width:calc(100vw - 32px);padding:22px;border-radius:12px;background:#fff;box-shadow:0 20px 70px rgba(15,23,42,0.24);font-family:Arial,sans-serif;color:#111827;";

              const title = document.createElement("div");
              title.textContent = "Z.ai security verification";
              title.style.cssText = "font-size:16px;font-weight:700;margin-bottom:8px;";

              const hint = document.createElement("div");
              hint.textContent = "Complete the challenge to continue the proxy request.";
              hint.style.cssText = "font-size:13px;line-height:1.45;color:#4b5563;margin-bottom:16px;";

              const element = document.createElement("div");
              element.id = elementId;
              element.style.cssText = "min-height:48px;margin-bottom:14px;";

              const button = document.createElement("button");
              button.id = buttonId;
              button.type = "button";
              button.textContent = "Start verification";
              button.style.cssText =
                "width:100%;height:40px;border:1px solid #d1d5db;border-radius:8px;background:#111827;color:#fff;font-size:14px;font-weight:600;cursor:pointer;";

              panel.append(title, hint, element, button);
              overlay.appendChild(panel);
              document.body.appendChild(overlay);
              return button;
            };

            const loadScript = () =>
              new Promise<void>((scriptResolve, scriptReject) => {
                window.AliyunCaptchaConfig = { region: "sgp", prefix: "no8xfe" };
                if (window.initAliyunCaptcha) {
                  scriptResolve();
                  return;
                }
                document.querySelector<HTMLScriptElement>(`script[src="${scriptUrl}"]`)?.remove();
                const script = document.createElement("script");
                script.src = scriptUrl;
                script.onload = () => scriptResolve();
                script.onerror = () => scriptReject(new Error("captcha script load failed"));
                document.head.appendChild(script);
              });

            const clickTrigger = (button: HTMLButtonElement) => {
              if (settled) return;
              try {
                button.click();
              } catch (error) {
                fail(error instanceof Error ? error.message : String(error));
              }
            };

            const messages = {
              cn: {
                START_VERIFY: "点击开始验证",
                POPUP_TITLE: "请完成安全验证",
                SLIDE_TIP: "请按住滑块，拖动到最右边",
                CHECK_BOX_TIP: "确认您不是机器人",
                PUZZLE_TIP: "请拖动滑块完成拼图",
                INPAINTING_TIP: "请拖动滑块还原完整图片",
                VERIFYING: "验证中...",
                SUCCESS: "滑动成功!",
                SLIDE_FAIL: "验证失败，请刷新重试",
                CAPTCHA_FAIL: "验证失败，请重试!",
                CONGESTION: "前方拥堵，请刷新重试",
                CAPTCHA_COMPLETED: "滑动完成",
                FINISH_CAPTCHA: "请先完成验证！"
              },
              en: {
                START_VERIFY: "Click to start verification",
                POPUP_TITLE: "Please complete security verification",
                SLIDE_TIP: "Please drag slider right",
                CHECK_BOX_TIP: "Confirm you are not a robot",
                PUZZLE_TIP: "Please drag the slider to complete the puzzle",
                INPAINTING_TIP: "Please drag the slider to restore the complete image",
                VERIFYING: "Verifying...",
                SUCCESS: "Slide successful!",
                SLIDE_FAIL: "Verification failed, please refresh and try again",
                CAPTCHA_FAIL: "Verification failed, please try again!",
                CONGESTION: "Network congestion, please refresh and try again",
                CAPTCHA_COMPLETED: "Slide completed",
                FINISH_CAPTCHA: "Please complete verification first!"
              }
            };

            loadScript()
              .then(() => {
                const button = visible ? createVisibleNodes() : createHiddenNodes();
                if (!window.initAliyunCaptcha) {
                  fail("initAliyunCaptcha missing");
                  return;
                }
                window.initAliyunCaptcha({
                  SceneId: window.location.hostname === "chat.z.ai" ? "didk33e0" : "xswyjefn",
                  mode: "popup",
                  element: `#${elementId}`,
                  button: `#${buttonId}`,
                  captchaLogoImg: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
                  upLang: messages,
                  language: language === "en-US" ? "en" : "cn",
                  timeout: 10000,
                  delayBeforeSuccess: false,
                  success: (value: unknown) => finish(value),
                  fail: () => window.setTimeout(() => clickTrigger(button), 250),
                  onError: (error: unknown) => fail(`captcha service error: ${String(error)}`),
                  onClose: () => fail("captcha cancelled by user"),
                  getInstance: (value: { refresh?: () => void }) => {
                    instance = value;
                    window.setTimeout(() => clickTrigger(button), 250);
                  }
                });
              })
              .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
          }),
        {
          language: config.zai.acceptLanguage,
          scriptUrl: CAPTCHA_SCRIPT_URL,
          timeoutMs,
          visible: !headless
        }
      );

      logger.success("AUTH", "Z.ai captcha verification completed", captchaTokenSummary(captcha));
      return captcha;
    } finally {
      if (!config.captcha.keepBrowserOpen) {
        await this.closeSession();
      } else {
        this.scheduleIdleClose();
      }
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.closeSession();
    }, config.captcha.idleTtlMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

function sanitizeProfileSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function isCaptchaTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("captcha timed out");
}

function captchaTokenSummary(token: string): Record<string, unknown> {
  const summary: Record<string, unknown> = { length: token.length };
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    summary.decoded_length = decoded.length;
    summary.decoded_keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).sort()
      : [];
  } catch {
    summary.decoded_keys = [];
  }
  return summary;
}

declare global {
  interface Window {
    AliyunCaptchaConfig?: { region: string; prefix: string };
    initAliyunCaptcha?: (options: Record<string, unknown>) => void;
  }
}
