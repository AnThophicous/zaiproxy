import { randomUUID } from "node:crypto";
import type { ChatCompletionRequest, OpenAIMessage, OpenAIUsage } from "../types/openai.js";
import type { ZaiCompletionError, ZaiCompletionEvent } from "../types/zai.js";

export type NormalizedZaiCompletionEvent = {
  raw: ZaiCompletionEvent | null;
  delta: string;
  phase: string | null;
  usage: OpenAIUsage | null;
  error: ZaiCompletionError | null;
  done: boolean;
  isReasoning: boolean;
};

export function flattenMessageContent(message: OpenAIMessage): string {
  if (typeof message.content === "string") {
    return message.content || formatToolCalls(message);
  }
  if (!message.content) {
    return formatToolCalls(message);
  }
  return message.content
    .map((part) => {
      if (part.type === "text" || part.type === "input_text") {
        return part.text;
      }
      if (part.type === "image_url") {
        return `![image](${part.image_url.url})`;
      }
      if (part.type === "input_image") {
        if (part.image_url) {
          return `![image](${part.image_url})`;
        }
        if (part.file_id) {
          return `[image_file: ${part.file_id}]`;
        }
      }
      return "";
    })
    .filter(Boolean)
    .join("\n") || formatToolCalls(message);
}

export function latestUserPrompt(messages: OpenAIMessage[]): string {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  return latest ? flattenMessageContent(latest).trim() : "";
}

export function normalizeMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  return messages.flatMap((message) => {
    const role = normalizeZaiRole(message.role);
    const content = normalizeZaiContent(message);
    if (!content && role !== "assistant") {
      return [];
    }
    return { role, content };
  });
}

function normalizeZaiRole(role: OpenAIMessage["role"]): "system" | "user" | "assistant" {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  return "user";
}

function normalizeZaiContent(message: OpenAIMessage): string {
  const content = flattenMessageContent(message);
  if (message.role !== "tool") {
    return content;
  }
  const label = message.tool_call_id ? `Tool result ${message.tool_call_id}` : "Tool result";
  return `${label}:\n${content}`;
}

function formatToolCalls(message: OpenAIMessage): string {
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    return "";
  }
  return `Assistant requested tool calls:\n${JSON.stringify(message.tool_calls)}`;
}

export function openAiChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: OpenAIUsage | null
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ],
    ...(usage ? { usage } : {})
  };
}

export function openAiUsageChunk(id: string, model: string, usage: OpenAIUsage | null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [],
    usage
  };
}

export function openAiCompletion(
  request: ChatCompletionRequest,
  content: string,
  reasoningContent: string,
  usage: OpenAIUsage | null,
  options: { includeReasoning?: boolean; id?: string } = {}
) {
  const id = options.id ?? `chatcmpl-${randomUUID()}`;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    response_id: id,
    previous_response_id: request.previous_response_id ?? null,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        logprobs: null,
        message: {
          role: "assistant",
          content,
          refusal: null,
          ...(options.includeReasoning && reasoningContent ? { reasoning_content: reasoningContent } : {})
        },
        finish_reason: "stop"
      }
    ],
    usage
  };
}

export function parseZaiEvent(data: string): ZaiCompletionEvent | null {
  if (data === "[DONE]") {
    return null;
  }
  try {
    return JSON.parse(data) as ZaiCompletionEvent;
  } catch {
    return null;
  }
}

export function normalizeZaiCompletionEvent(data: string): NormalizedZaiCompletionEvent {
  const parsed = parseZaiEvent(data);
  const root = isRecord(parsed) ? (parsed as Record<string, unknown>) : null;
  const payload = isRecord(root?.data) ? root.data : null;
  const nestedPayload = isRecord(payload?.data) ? payload.data : null;
  const phase = firstString(payload?.phase, nestedPayload?.phase, root?.type);
  const delta = firstString(
    payload?.delta_content,
    payload?.delta,
    payload?.content,
    nestedPayload?.delta_content,
    nestedPayload?.delta,
    nestedPayload?.content
  ) ?? "";
  const usage = normalizeUsage(payload?.usage ?? nestedPayload?.usage ?? root?.usage);
  const error = getZaiError(parsed);
  const done =
    data === "[DONE]" ||
    booleanValue(payload?.done) ||
    booleanValue(nestedPayload?.done) ||
    phase === "done" ||
    phase === "chat:done" ||
    phase === "response.done";

  return {
    raw: parsed,
    delta,
    phase,
    usage,
    error,
    done,
    isReasoning: phase === "thinking" || phase === "reasoning" || phase === "think" || phase === "analysis"
  };
}

export function getZaiError(event: ZaiCompletionEvent | null): ZaiCompletionError | null {
  if (!event) {
    return null;
  }
  const root = event as unknown as Record<string, unknown>;
  const payload = isRecord(root.data) ? root.data : null;
  const nestedPayload = isRecord(payload?.data) ? payload.data : null;
  const explicitError = event.error ?? event.data?.error ?? event.data?.data?.error;
  if (explicitError) {
    return explicitError;
  }
  if (root.type === "error" || payload?.type === "error") {
    const message = firstString(root.message, root.detail, payload?.message, payload?.detail);
    const code = firstString(root.code, root.error_code, payload?.code, payload?.error_code) ?? "upstream_error";
    return message ? { code, message } : { code };
  }
  if (nestedPayload?.type === "error") {
    const message = firstString(nestedPayload.message, nestedPayload.detail);
    const code = firstString(nestedPayload.code, nestedPayload.error_code) ?? "upstream_error";
    return message ? { code, message } : { code };
  }
  return null;
}

export function formatZaiError(error: ZaiCompletionError): string {
  const code = error.code ?? error.error_code;
  const detail = error.detail ?? error.message;
  if (code && detail) {
    return `${code}: ${detail}`;
  }
  return detail ?? code ?? "Z.ai upstream error";
}

export function normalizeUsage(value: unknown): OpenAIUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const promptTokens = numberValue(value.prompt_tokens);
  const completionTokens = numberValue(value.completion_tokens);
  const totalTokens = numberValue(value.total_tokens);
  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }
  return {
    prompt_tokens: promptTokens ?? 0,
    completion_tokens: completionTokens ?? 0,
    total_tokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
    ...(isRecord(value.prompt_tokens_details) ? { prompt_tokens_details: value.prompt_tokens_details } : {}),
    ...(isRecord(value.completion_tokens_details)
      ? { completion_tokens_details: value.completion_tokens_details }
      : {})
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
