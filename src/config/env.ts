import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ensureDir, ensureParentDir, projectPath } from "../lib/paths.js";

const booleanEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") {
      return defaultValue;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean());

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  PROXY_API_KEY: z.string().optional().default(""),
  PROXY_REQUIRE_API_KEY: booleanEnv(false),
  ZAI_BASE_URL: z.string().url().default("https://chat.z.ai"),
  ZAI_FE_VERSION: z.string().default("prod-fe-1.1.52"),
  ZAI_REGION: z.string().default("overseas"),
  ZAI_LANGUAGE: z.string().default("pt-BR"),
  ZAI_ACCEPT_LANGUAGE: z.string().default("en-US"),
  ZAI_TIMEZONE: z.string().default("America/Sao_Paulo"),
  ZAI_DEFAULT_MODEL: z.string().default("GLM-5.2"),
  ZAI_ALLOW_UNLISTED_MODELS: booleanEnv(false),
  ZAI_EXPERIMENTAL_MODELS: z.string().optional().default(""),
  ZAI_MAX_INLINE_IMAGE_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  ZAI_HEALTH_CACHE_TTL_MS: z.coerce.number().int().positive().default(30000),
  ZAI_MODELS_CACHE_TTL_MS: z.coerce.number().int().positive().default(300000),
  ZAI_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DATA_DIR: z.string().default("./data"),
  RUNTIME_DIR: z.string().default("./runtime"),
  FILE_STORE_DIR: z.string().default("./data/files"),
  DATABASE_PATH: z.string().default("./data/proxy.sqlite"),
  MASTER_KEY_PATH: z.string().default("./data/master.key"),
  CAPTCHA_HEADLESS: booleanEnv(true),
  CAPTCHA_KEEP_BROWSER_OPEN: booleanEnv(true),
  CAPTCHA_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
  CAPTCHA_IDLE_TTL_MS: z.coerce.number().int().positive().default(600000),
  BROWSER_EXECUTABLE_PATH: z.string().optional().default(""),
  BROWSER_CHANNEL: z.string().optional().default(""),
  PROXY_NATIVE_TOOLS: booleanEnv(true),
  PROXY_NATIVE_TOOLS_AUTO: booleanEnv(false),
  PROXY_TOOLS_ALLOW_COMMANDS: booleanEnv(false),
  PROXY_TOOLS_ROOT: z.string().default("."),
  PROXY_TOOLS_MAX_FILE_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  PROXY_TOOLS_MAX_WRITE_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  PROXY_TOOLS_MAX_ROUNDS: z.coerce.number().int().positive().default(6),
  GLM_PROXY_MASTER_KEY: z.string().optional()
});

const parsed = envSchema.parse(process.env);

function resolvePath(path: string): string {
  return path.startsWith("/") ? path : projectPath(path);
}

export const config = {
  version: readPackageVersion(),
  host: parsed.HOST,
  port: parsed.PORT,
  proxyApiKey: parsed.PROXY_API_KEY,
  proxyRequireApiKey: parsed.PROXY_REQUIRE_API_KEY,
  zai: {
    baseUrl: parsed.ZAI_BASE_URL.replace(/\/$/, ""),
    feVersion: parsed.ZAI_FE_VERSION,
    region: parsed.ZAI_REGION,
    language: parsed.ZAI_LANGUAGE,
    acceptLanguage: parsed.ZAI_ACCEPT_LANGUAGE,
    timezone: parsed.ZAI_TIMEZONE,
    defaultModel: parsed.ZAI_DEFAULT_MODEL,
    allowUnlistedModels: parsed.ZAI_ALLOW_UNLISTED_MODELS,
    experimentalModels: parseCsv(parsed.ZAI_EXPERIMENTAL_MODELS),
    maxInlineImageBytes: parsed.ZAI_MAX_INLINE_IMAGE_BYTES,
    healthCacheTtlMs: parsed.ZAI_HEALTH_CACHE_TTL_MS,
    modelsCacheTtlMs: parsed.ZAI_MODELS_CACHE_TTL_MS,
    fetchTimeoutMs: parsed.ZAI_FETCH_TIMEOUT_MS
  },
  dataDir: ensureDir(resolvePath(parsed.DATA_DIR)),
  runtimeDir: ensureDir(resolvePath(parsed.RUNTIME_DIR)),
  fileStoreDir: ensureDir(resolvePath(parsed.FILE_STORE_DIR)),
  databasePath: ensureParentDir(resolvePath(parsed.DATABASE_PATH)),
  masterKeyPath: ensureParentDir(resolvePath(parsed.MASTER_KEY_PATH)),
  captcha: {
    headless: parsed.CAPTCHA_HEADLESS,
    keepBrowserOpen: parsed.CAPTCHA_KEEP_BROWSER_OPEN,
    timeoutMs: parsed.CAPTCHA_TIMEOUT_MS,
    idleTtlMs: parsed.CAPTCHA_IDLE_TTL_MS
  },
  browser: {
    executablePath: parsed.BROWSER_EXECUTABLE_PATH.trim(),
    channel: parsed.BROWSER_CHANNEL.trim()
  },
  tools: {
    nativeEnabled: parsed.PROXY_NATIVE_TOOLS,
    nativeAuto: parsed.PROXY_NATIVE_TOOLS_AUTO,
    allowCommands: parsed.PROXY_TOOLS_ALLOW_COMMANDS,
    root: ensureDir(resolvePath(parsed.PROXY_TOOLS_ROOT)),
    maxFileBytes: parsed.PROXY_TOOLS_MAX_FILE_BYTES,
    maxWriteBytes: parsed.PROXY_TOOLS_MAX_WRITE_BYTES,
    maxRounds: parsed.PROXY_TOOLS_MAX_ROUNDS
  },
  envMasterKey: parsed.GLM_PROXY_MASTER_KEY
} as const;

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(projectPath("package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadOrCreateMasterSecret(): string {
  if (config.envMasterKey?.trim()) {
    return config.envMasterKey.trim();
  }

  if (existsSync(config.masterKeyPath)) {
    return readFileSync(config.masterKeyPath, "utf8").trim();
  }

  const secret = randomBytes(32).toString("base64");
  writeFileSync(config.masterKeyPath, `${secret}\n`, { mode: 0o600 });
  try {
    chmodSync(config.masterKeyPath, 0o600);
  } catch {
    // chmod can fail on non-POSIX filesystems; the key is still usable.
  }
  return secret;
}
