export type ZaiBrowserFingerprint = {
  version: 1;
  capturedAt: string;
  userAgent: string;
  language: string;
  languages: string[];
  timezone: string;
  timezoneOffset: number;
  cookieEnabled: boolean;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
  };
  viewport: {
    width: number;
    height: number;
  };
  pixelRatio: number;
  isTouch: boolean;
  maxTouchPoints: number;
  platform: string;
  vendor: string;
  browserName: string;
  osName: string;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  sessionStorage: Record<string, string>;
  requestHeaders: Record<string, string>;
};

export type ZaiAccount = {
  id: string;
  provider: "zai";
  email: string;
  displayName: string | null;
  token: string;
  cookies: unknown[];
  localStorage: Record<string, string>;
  browserFingerprint: ZaiBrowserFingerprint | null;
  browserProfilePath: string;
  userAgent: string;
  status: "active" | "invalid" | "disabled" | "limited";
  failureCount: number;
  lastError: string | null;
  limitedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastValidatedAt: string | null;
};

export type ZaiCompletionEvent = {
  type?: string;
  id?: string;
  response_id?: string;
  message_id?: string;
  error?: ZaiCompletionError;
  data?: {
    id?: string;
    response_id?: string;
    message_id?: string;
    data?: {
      id?: string;
      response_id?: string;
      message_id?: string;
      done?: boolean;
      error?: ZaiCompletionError;
    };
    delta_content?: string;
    phase?: "thinking" | "answer" | "other" | "done" | string;
    done?: boolean;
    error?: ZaiCompletionError;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: Record<string, unknown>;
    };
  };
};

export type ZaiCompletionError = {
  code?: string;
  detail?: string;
  message?: string;
  error_code?: string;
  captcha_error_type?: string;
};
