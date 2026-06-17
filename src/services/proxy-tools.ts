import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { config } from "../config/env.js";
import type { OpenAIToolCall } from "../types/openai.js";
import type { ToolSpec } from "./tool-schema.js";
import { isRecord } from "./tool-schema.js";

type ToolResult = {
  ok: boolean;
  tool: string;
  data?: unknown;
  error?: string;
};

const DEFAULT_IGNORES = new Set([".git", "node_modules", "dist", "runtime", "data", ".cache"]);
const BLOCKED_DIR_NAMES = new Set([
  ".ssh",
  ".gnupg",
  ".config",
  ".local",
  ".codex",
  "data",
  "runtime"
]);
const BLOCKED_FILE_PATTERNS = [
  /^\.env(?:\.|$)/,
  /^master\.key$/,
  /\.sqlite(?:-\w+)?$/,
  /\.(?:pem|p12|pfx|key)$/
];

const BASE_PROXY_TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_directory",
    description: "List files and directories under the configured project root.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative or root-contained absolute path. Defaults to project root." },
        recursive: { type: "boolean", description: "Whether to descend recursively." },
        max_entries: { type: "integer", minimum: 1, maximum: 500, description: "Maximum entries to return." }
      }
    }
  },
  {
    name: "read_file",
    description: "Read a text file under the configured project root.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 }
      }
    }
  },
  {
    name: "create_directory",
    description: "Create a directory and parent directories under the configured project root.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" }
      }
    }
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file under the configured project root.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: { type: "boolean", description: "Defaults to false; set true to replace an existing file." }
      }
    }
  },
  {
    name: "edit_file",
    description: "Edit a file by replacing exact text. The edit fails if the search text is missing or ambiguous.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "search", "replace"],
      properties: {
        path: { type: "string" },
        search: { type: "string", minLength: 1 },
        replace: { type: "string" },
        replace_all: { type: "boolean", description: "Defaults to false; when false the search must occur exactly once." }
      }
    }
  },
  {
    name: "apply_patch",
    description:
      "Apply structured exact-replacement edits. Every search block must match before any file is written.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["edits"],
      properties: {
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "search", "replace"],
            properties: {
              path: { type: "string" },
              search: { type: "string", minLength: 1 },
              replace: { type: "string" },
              replace_all: { type: "boolean" }
            }
          }
        }
      }
    }
  },
  {
    name: "grep",
    description: "Search text files under the configured project root using a JavaScript regular expression.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string", minLength: 1 },
        path: { type: "string", description: "Directory or file to search. Defaults to project root." },
        max_matches: { type: "integer", minimum: 1, maximum: 200 }
      }
    }
  },
  {
    name: "move_path",
    description: "Move or rename a file/directory inside the configured project root.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        overwrite: { type: "boolean" }
      }
    }
  },
  {
    name: "delete_path",
    description: "Delete a file or, with recursive=true, a directory inside the configured project root.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "Required for deleting directories." }
      }
    }
  },
  {
    name: "stat_path",
    description: "Return metadata for a file or directory under the configured project root.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" }
      }
    }
  },
  {
    name: "run_command",
    description:
      "Run a local command in the configured project root and return stdout, stderr, exit code, and timeout status.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", minLength: 1, description: "Command executable or shell command." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Optional argv list. When provided with shell=false, command is executed without a shell."
        },
        cwd: { type: "string", description: "Working directory under the project root. Defaults to root." },
        shell: { type: "boolean", description: "Defaults to true unless args are provided." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
        max_output_chars: { type: "integer", minimum: 1000, maximum: 60000 }
      }
    }
  }
];

export const PROXY_TOOL_SPECS: ToolSpec[] = config.tools.allowCommands
  ? BASE_PROXY_TOOL_SPECS
  : BASE_PROXY_TOOL_SPECS.filter((tool) => tool.name !== "run_command");

export async function executeProxyToolCall(call: OpenAIToolCall): Promise<string> {
  const args = parseArguments(call);
  let result: ToolResult;

  try {
    switch (call.function.name) {
      case "list_directory":
        result = listDirectory(args);
        break;
      case "read_file":
        result = readFile(args);
        break;
      case "create_directory":
        result = createDirectory(args);
        break;
      case "write_file":
        result = writeFile(args);
        break;
      case "edit_file":
        result = editFile(args);
        break;
      case "apply_patch":
        result = applyStructuredPatch(args);
        break;
      case "grep":
        result = grepFiles(args);
        break;
      case "move_path":
        result = movePath(args);
        break;
      case "delete_path":
        result = deletePath(args);
        break;
      case "stat_path":
        result = statPath(args);
        break;
      case "run_command":
        if (!config.tools.allowCommands) {
          throw new Error("run_command is disabled. Set PROXY_TOOLS_ALLOW_COMMANDS=true to enable it explicitly.");
        }
        result = await runCommand(args);
        break;
      default:
        result = { ok: false, tool: call.function.name, error: `Unknown proxy tool: ${call.function.name}` };
    }
  } catch (error) {
    result = {
      ok: false,
      tool: call.function.name,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return JSON.stringify(result);
}

export function proxyToolsRoot(): string {
  return realpathSync(config.tools.root);
}

function listDirectory(args: Record<string, unknown>): ToolResult {
  const maxEntries = clampInt(args.max_entries, 1, 500, 120);
  const recursive = args.recursive === true;
  const root = resolveToolPath(stringArg(args.path, "."), "read");
  assertDirectory(root.absolute);

  const entries: Array<Record<string, unknown>> = [];
  walkDirectory(root.absolute, recursive, maxEntries, entries);
  return {
    ok: true,
    tool: "list_directory",
    data: {
      root: root.relative,
      entries,
      truncated: entries.length >= maxEntries
    }
  };
}

function readFile(args: Record<string, unknown>): ToolResult {
  const path = resolveToolPath(requiredString(args.path, "path"), "read");
  assertReadableTextFile(path.absolute);
  const content = readFileSync(path.absolute, "utf8");
  const startLine = clampInt(args.start_line, 1, Number.MAX_SAFE_INTEGER, 1);
  const endLine = clampInt(args.end_line, startLine, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const lines = content.split(/\r?\n/);
  const selected = lines.slice(startLine - 1, endLine).join("\n");
  return {
    ok: true,
    tool: "read_file",
    data: {
      path: path.relative,
      start_line: startLine,
      end_line: Math.min(endLine, lines.length),
      line_count: lines.length,
      content: selected
    }
  };
}

function createDirectory(args: Record<string, unknown>): ToolResult {
  const path = resolveToolPath(requiredString(args.path, "path"), "write");
  mkdirSync(path.absolute, { recursive: true });
  return { ok: true, tool: "create_directory", data: { path: path.relative } };
}

function writeFile(args: Record<string, unknown>): ToolResult {
  const path = resolveToolPath(requiredString(args.path, "path"), "write");
  const content = requiredString(args.content, "content");
  assertWriteSize(content);
  if (existsSync(path.absolute) && args.overwrite !== true) {
    throw new Error(`Refusing to overwrite ${path.relative}; set overwrite=true`);
  }
  mkdirSync(dirname(path.absolute), { recursive: true });
  writeFileSync(path.absolute, content, "utf8");
  return {
    ok: true,
    tool: "write_file",
    data: { path: path.relative, bytes: Buffer.byteLength(content, "utf8") }
  };
}

function editFile(args: Record<string, unknown>): ToolResult {
  const edit = normalizeEdit(args);
  const result = applyEdits([edit]);
  return { ok: true, tool: "edit_file", data: result };
}

function applyStructuredPatch(args: Record<string, unknown>): ToolResult {
  if (!Array.isArray(args.edits)) {
    throw new Error("apply_patch requires edits[]");
  }
  const edits = args.edits.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`edits[${index}] must be an object`);
    }
    return normalizeEdit(item);
  });
  return { ok: true, tool: "apply_patch", data: applyEdits(edits) };
}

function grepFiles(args: Record<string, unknown>): ToolResult {
  const pattern = requiredString(args.pattern, "pattern");
  const regexp = new RegExp(pattern, "u");
  const root = resolveToolPath(stringArg(args.path, "."), "read");
  const maxMatches = clampInt(args.max_matches, 1, 200, 80);
  const matches: Array<Record<string, unknown>> = [];
  const files = lstatSync(root.absolute).isDirectory() ? collectFiles(root.absolute, 1000) : [root.absolute];

  for (const file of files) {
    if (matches.length >= maxMatches) break;
    if (!isTextFileCandidate(file)) continue;
    const stat = statSync(file);
    if (stat.size > config.tools.maxFileBytes) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (matches.length < maxMatches && regexp.test(line)) {
        matches.push({
          path: relative(proxyToolsRoot(), file),
          line: index + 1,
          text: line.slice(0, 500)
        });
      }
    });
  }

  return { ok: true, tool: "grep", data: { matches, truncated: matches.length >= maxMatches } };
}

function movePath(args: Record<string, unknown>): ToolResult {
  const from = resolveToolPath(requiredString(args.from, "from"), "write");
  const to = resolveToolPath(requiredString(args.to, "to"), "write");
  if (!existsSync(from.absolute)) {
    throw new Error(`Source path does not exist: ${from.relative}`);
  }
  if (existsSync(to.absolute) && args.overwrite !== true) {
    throw new Error(`Destination exists: ${to.relative}; set overwrite=true`);
  }
  mkdirSync(dirname(to.absolute), { recursive: true });
  renameSync(from.absolute, to.absolute);
  return { ok: true, tool: "move_path", data: { from: from.relative, to: to.relative } };
}

function deletePath(args: Record<string, unknown>): ToolResult {
  const path = resolveToolPath(requiredString(args.path, "path"), "write");
  if (path.relative === ".") {
    throw new Error("Refusing to delete the proxy tool root");
  }
  if (!existsSync(path.absolute)) {
    throw new Error(`Path does not exist: ${path.relative}`);
  }
  const stat = lstatSync(path.absolute);
  if (stat.isDirectory() && args.recursive !== true) {
    throw new Error(`${path.relative} is a directory; set recursive=true`);
  }
  rmSync(path.absolute, { recursive: stat.isDirectory(), force: false });
  return { ok: true, tool: "delete_path", data: { path: path.relative, type: stat.isDirectory() ? "directory" : "file" } };
}

function statPath(args: Record<string, unknown>): ToolResult {
  const path = resolveToolPath(requiredString(args.path, "path"), "read");
  const stat = lstatSync(path.absolute);
  return {
    ok: true,
    tool: "stat_path",
    data: {
      path: path.relative,
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      bytes: stat.size,
      modified_at: stat.mtime.toISOString()
    }
  };
}

async function runCommand(args: Record<string, unknown>): Promise<ToolResult> {
  const command = requiredString(args.command, "command");
  assertCommandAllowed(command);
  const cwd = resolveToolPath(stringArg(args.cwd, "."), "read");
  assertDirectory(cwd.absolute);
  const commandArgs = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
  const shell = typeof args.shell === "boolean" ? args.shell : commandArgs.length === 0;
  const timeoutMs = clampInt(args.timeout_ms, 1000, 120000, 30000);
  const maxOutputChars = clampInt(args.max_output_chars, 1000, 60000, 20000);
  const started = Date.now();

  return await new Promise<ToolResult>((resolveResult) => {
    const child = spawn(command, commandArgs, {
      cwd: cwd.absolute,
      shell,
      windowsHide: true,
      env: commandEnvironment()
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1000).unref();
    }, timeoutMs);
    timer.unref();

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") {
        stdout = trimOutput(stdout + text, maxOutputChars);
      } else {
        stderr = trimOutput(stderr + text, maxOutputChars);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({
        ok: false,
        tool: "run_command",
        error: error.message,
        data: { command, cwd: cwd.relative, ms: Date.now() - started }
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        ok: !timedOut && code === 0,
        tool: "run_command",
        data: {
          command,
          args: commandArgs,
          cwd: cwd.relative,
          exit_code: code,
          signal,
          timed_out: timedOut,
          ms: Date.now() - started,
          stdout: redactSensitiveOutput(stdout),
          stderr: redactSensitiveOutput(stderr)
        },
        ...(timedOut ? { error: `Command timed out after ${timeoutMs}ms` } : code === 0 ? {} : { error: `Command exited with ${code}` })
      });
    });
  });
}

type NormalizedEdit = {
  path: ReturnType<typeof resolveToolPath>;
  search: string;
  replace: string;
  replaceAll: boolean;
};

function normalizeEdit(args: Record<string, unknown>): NormalizedEdit {
  return {
    path: resolveToolPath(requiredString(args.path, "path"), "write"),
    search: requiredString(args.search, "search"),
    replace: requiredString(args.replace, "replace"),
    replaceAll: args.replace_all === true
  };
}

function applyEdits(edits: NormalizedEdit[]) {
  const originals = new Map<string, string>();
  const nextByPath = new Map<string, string>();
  const results: Array<Record<string, unknown>> = [];

  for (const edit of edits) {
    assertReadableTextFile(edit.path.absolute);
    const current = nextByPath.get(edit.path.absolute) ?? readOriginal(edit.path.absolute, originals);
    const occurrences = countOccurrences(current, edit.search);
    if (occurrences === 0) {
      throw new Error(`${edit.path.relative}: search block was not found`);
    }
    if (!edit.replaceAll && occurrences !== 1) {
      throw new Error(`${edit.path.relative}: search block matched ${occurrences} times; set replace_all=true`);
    }
    const next = edit.replaceAll ? current.split(edit.search).join(edit.replace) : current.replace(edit.search, edit.replace);
    assertWriteSize(next);
    nextByPath.set(edit.path.absolute, next);
    results.push({
      path: edit.path.relative,
      replacements: edit.replaceAll ? occurrences : 1
    });
  }

  for (const [absolute, content] of nextByPath) {
    writeFileSync(absolute, content, "utf8");
  }

  return { files_changed: nextByPath.size, edits: results };
}

function readOriginal(path: string, originals: Map<string, string>): string {
  const existing = originals.get(path);
  if (existing !== undefined) return existing;
  const content = readFileSync(path, "utf8");
  originals.set(path, content);
  return content;
}

function walkDirectory(
  absolute: string,
  recursive: boolean,
  maxEntries: number,
  entries: Array<Record<string, unknown>>
): void {
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entries.length >= maxEntries) return;
    if (DEFAULT_IGNORES.has(entry.name)) continue;
    const fullPath = resolve(absolute, entry.name);
    if (isBlockedPath(fullPath)) continue;
    const stat = lstatSync(fullPath);
    entries.push({
      path: relative(proxyToolsRoot(), fullPath),
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      bytes: stat.isFile() ? stat.size : undefined
    });
    if (recursive && stat.isDirectory()) {
      walkDirectory(fullPath, true, maxEntries, entries);
    }
  }
}

function collectFiles(absolute: string, maxFiles: number): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    if (files.length >= maxFiles) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (DEFAULT_IGNORES.has(entry.name)) continue;
      const fullPath = resolve(path, entry.name);
      if (isBlockedPath(fullPath)) continue;
      if (entry.isDirectory()) visit(fullPath);
      if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(absolute);
  return files;
}

function resolveToolPath(input: string, mode: "read" | "write") {
  const root = proxyToolsRoot();
  const absolute = resolve(root, input);
  const existingPath = existingAncestor(absolute);
  const realExisting = realpathSync(existingPath);
  assertInsideRoot(root, realExisting);
  if (existsSync(absolute)) {
    if (lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`${mode} denied for symbolic link: ${relative(root, absolute)}`);
    }
    assertInsideRoot(root, realpathSync(absolute));
  } else {
    assertInsideRoot(root, resolve(realExisting, relative(existingPath, absolute)));
  }
  if (isBlockedPath(absolute)) {
    throw new Error(`${mode} denied for protected path: ${relative(root, absolute)}`);
  }
  return { absolute, relative: relative(root, absolute) || "." };
}

function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`No existing ancestor for ${path}`);
    }
    current = parent;
  }
  return current;
}

function assertInsideRoot(root: string, path: string): void {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(normalizedRoot)) {
    throw new Error(`Path escapes proxy tool root: ${path}`);
  }
}

function isBlockedPath(path: string): boolean {
  const parts = path.split(/[\\/]+/);
  if (parts.some((part) => BLOCKED_DIR_NAMES.has(part))) return true;
  const basename = parts.at(-1) ?? "";
  return BLOCKED_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

function assertDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) {
    throw new Error(`${path} is not a directory`);
  }
}

function assertReadableTextFile(path: string): void {
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`${path} is not a file`);
  }
  if (stat.size > config.tools.maxFileBytes) {
    throw new Error(`${path} exceeds max readable size ${config.tools.maxFileBytes}`);
  }
  if (!isTextFileCandidate(path)) {
    throw new Error(`${path} does not look like a text file`);
  }
}

function isTextFileCandidate(path: string): boolean {
  const basename = path.split(/[\\/]+/).at(-1) ?? "";
  if (isBlockedPath(path)) return false;
  return !/\.(?:png|jpg|jpeg|gif|webp|bmp|ico|mp4|mov|zip|gz|tar|rar|7z|pdf|sqlite)$/i.test(basename);
}

function parseArguments(call: OpenAIToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Handled below.
  }
  throw new Error(`${call.function.name}: arguments must be a JSON object`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length ? value : fallback;
}

function assertWriteSize(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > config.tools.maxWriteBytes) {
    throw new Error(`Write payload exceeds ${config.tools.maxWriteBytes} bytes`);
  }
}

function assertCommandAllowed(command: string): void {
  const normalized = command.trim();
  if (!normalized) {
    throw new Error("command must be a non-empty string");
  }
  if (/\b(?:sudo|su)\b/.test(normalized)) {
    throw new Error("Refusing to run privilege escalation commands");
  }
  if (/\b(?:mkfs|fdisk|parted|shutdown|reboot|poweroff)\b/.test(normalized)) {
    throw new Error("Refusing to run destructive system commands");
  }
  if (/(?:^|\s)rm\s+-[^;&|]*r[^;&|]*f[^;&|]*(?:\/|\*)/.test(normalized)) {
    throw new Error("Refusing to run broad recursive deletion");
  }
  if (/\b(?:env|printenv|set)\b/.test(normalized)) {
    throw new Error("Refusing to dump process environment");
  }
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"]) {
    const value = process.env[key];
    if (value) {
      allowed[key] = value;
    }
  }
  allowed.ZAI_PROXY_TOOL_ROOT = proxyToolsRoot();
  return allowed;
}

function redactSensitiveOutput(value: string): string {
  let redacted = value;
  const explicitSecrets = [
    config.proxyApiKey,
    config.envMasterKey,
    process.env.PROXY_API_KEY,
    process.env.GLM_PROXY_MASTER_KEY
  ].filter((item): item is string => Boolean(item && item.length >= 6));

  for (const secret of explicitSecrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }

  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^\s]+)/gi, "$1=[redacted]");
}

function trimOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n[truncated ${omitted} chars]`;
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let index = content.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(search, index + search.length);
  }
  return count;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
