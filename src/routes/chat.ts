import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { ZaiClient } from "../services/zai-client.js";
import { config } from "../config/env.js";
import { openAIError } from "../lib/openai-error.js";
import { upstreamErrorCode, upstreamErrorType, upstreamStatus } from "../lib/http-status.js";
import { encodeSse, parseSse } from "../lib/sse.js";
import { logger } from "../lib/logger.js";
import type { ChatCompletionRequest, OpenAIUsage } from "../types/openai.js";
import { collectZaiCompletion } from "../services/completion-collector.js";
import {
  cancelActiveRequest,
  createActiveRequest,
  isAbortError,
  type ActiveRequestHandle
} from "../services/request-registry.js";
import {
  formatZaiError,
  normalizeZaiCompletionEvent,
  openAiChunk,
  openAiCompletion,
  openAiUsageChunk
} from "../services/openai-transform.js";
import {
  maybeRunToolBridge,
  streamToolBridge,
  streamToolBridgeResult,
  toolBridgeCompletion,
  usesToolBridge
} from "../services/tool-bridge.js";

const chatRequestSchema = z
  .object({
    model: z.string().default(config.zai.defaultModel),
    messages: z.array(z.record(z.unknown())).min(1),
    stream: z.boolean().optional()
  })
  .passthrough();

const completionRequestSchema = z
  .object({
    model: z.string().default(config.zai.defaultModel),
    prompt: z.union([z.string(), z.array(z.string())]),
    stream: z.boolean().optional()
  })
  .passthrough();

type TextCompletionRequest = {
  model: string;
  prompt: string | string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[] | null;
  user?: string;
  metadata?: Record<string, unknown> | null;
  prompt_cache_key?: string;
  stream_options?: { include_usage?: boolean };
  zai?: ChatCompletionRequest["zai"];
};

export function chatRoutes(zai: ZaiClient): Hono {
  const app = new Hono();

  app.post("/chat/completions", (c) => handleChatCompletion(c, zai));
  app.post("/chat/completations", (c) => handleChatCompletion(c, zai));
  app.post("/completions", (c) => handleTextCompletion(c, zai));
  app.post("/completations", (c) => handleTextCompletion(c, zai));
  app.post("/chat/completions/stop", (c) => cancelCompletionRequest(c, "chat.completion"));
  app.post("/chat/completations/stop", (c) => cancelCompletionRequest(c, "chat.completion"));
  app.post("/chat/completions/:id/cancel", (c) => cancelCompletionRequest(c, "chat.completion"));
  app.post("/chat/completations/:id/cancel", (c) => cancelCompletionRequest(c, "chat.completion"));
  app.post("/completions/stop", (c) => cancelCompletionRequest(c, "completion"));
  app.post("/completations/stop", (c) => cancelCompletionRequest(c, "completion"));
  app.post("/completions/:id/cancel", (c) => cancelCompletionRequest(c, "completion"));
  app.post("/completations/:id/cancel", (c) => cancelCompletionRequest(c, "completion"));

  app.get("/chat/completions/:id", (c) => {
    const error = openAIError(
      `Chat completion ${c.req.param("id")} is not stored by this proxy`,
      404,
      "not_found",
      "invalid_request_error"
    );
    return c.json(error.body, error.status);
  });

  app.delete("/chat/completions/:id", (c) =>
    c.json({
      object: "chat.completion.deleted",
      id: c.req.param("id"),
      deleted: true
    })
  );

  return app;
}

async function handleChatCompletion(c: Context, zai: ZaiClient) {
    const body = await c.req.json().catch(() => null);
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
      const error = openAIError(parsed.error.message, 400, "invalid_request_error", "invalid_request_error");
      return c.json(error.body, error.status);
    }

    const request = parsed.data as unknown as ChatCompletionRequest;
    const requestId = `msg_${randomUUID()}`;
    const completionId = `chatcmpl-${randomUUID()}`;
    const active = createActiveRequest({
      id: completionId,
      kind: "chat.completion",
      aliases: [requestId, request.previous_response_id],
      parentSignal: c.req.raw.signal,
      onCancel: () => zai.cancelRequestConversation(request)
    });
    logger.info("HTTP", "Chat completion accepted", {
      request_id: requestId,
      response_id: completionId,
      model: request.model,
      stream: Boolean(request.stream),
      tools: Array.isArray(request.tools) ? request.tools.length : 0,
      parallel_tool_calls: request.parallel_tool_calls ?? null,
      prompt_cache_key: request.prompt_cache_key ?? request.zai?.conversation_key ?? null
    });
    try {
      if (request.stream && usesToolBridge(request)) {
        return withResponseId(
          streamToolBridge(zai, request, completionId, active.signal, active.complete),
          completionId
        );
      }

      const toolResult = await maybeRunToolBridge(zai, request, active.signal);
      if (toolResult) {
        if (request.stream) {
          return withResponseId(streamToolBridgeResult(request, toolResult, completionId, active.complete), completionId);
        }
        active.complete();
        return c.json(toolBridgeCompletion(request, toolResult, completionId), 200, responseIdHeaders(completionId));
      }

      const upstream = await zai.createCompletionStream(request, active.signal);
      if (request.stream) {
        return withResponseId(streamOpenAI(request, upstream.body, completionId, active), completionId);
      }

      const completion = await collectCompletion(request, upstream.body, completionId);
      active.complete();
      return c.json(completion, 200, responseIdHeaders(completionId));
    } catch (error) {
      active.complete();
      if (isAbortError(error)) {
        logger.info("HTTP", "Chat completion cancelled", { response_id: completionId });
        return c.json(cancelledChatCompletion(completionId, request.model), 200, responseIdHeaders(completionId));
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error("HTTP", "Chat completion failed", message);
      const status = upstreamStatus(message);
      const response = openAIError(message, status, upstreamErrorCode(status), upstreamErrorType(status));
      return c.json(response.body, response.status);
    }
}

async function handleTextCompletion(c: Context, zai: ZaiClient) {
  const body = await c.req.json().catch(() => null);
  const parsed = completionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const error = openAIError(parsed.error.message, 400, "invalid_request_error", "invalid_request_error");
    return c.json(error.body, error.status);
  }

  const request = parsed.data as unknown as TextCompletionRequest;
  const completionId = `cmpl-${randomUUID()}`;
  const chatRequest = textCompletionToChatRequest(request);
  const active = createActiveRequest({
    id: completionId,
    kind: "completion",
    aliases: [request.prompt_cache_key],
    parentSignal: c.req.raw.signal,
    onCancel: () => zai.cancelRequestConversation(chatRequest)
  });

  try {
    const upstream = await zai.createCompletionStream(chatRequest, active.signal);
    if (request.stream) {
      return withResponseId(streamTextCompletion(request, upstream.body, completionId, active), completionId);
    }
    const { content, usage } = await collectZaiCompletion(upstream.body);
    active.complete();
    return c.json(textCompletionObject(request, completionId, content, usage), 200, responseIdHeaders(completionId));
  } catch (error) {
    active.complete();
    if (isAbortError(error)) {
      logger.info("HTTP", "Text completion cancelled", { response_id: completionId });
      return c.json(cancelledTextCompletion(completionId, request.model), 200, responseIdHeaders(completionId));
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error("HTTP", "Text completion failed", message);
    const status = upstreamStatus(message);
    const response = openAIError(message, status, upstreamErrorCode(status), upstreamErrorType(status));
    return c.json(response.body, response.status);
  }
}

function streamOpenAI(
  request: ChatCompletionRequest,
  upstream: ReadableStream<Uint8Array> | null,
  id: string,
  active?: ActiveRequestHandle
): Response {
  if (!upstream) {
    const error = openAIError("Z.ai response body is empty", 502, "upstream_error");
    return Response.json(error.body, { status: error.status });
  }

  const model = request.model;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let usage: OpenAIUsage | null = null;
      controller.enqueue(encodeSse(openAiChunk(id, model, { role: "assistant" })));

      try {
        for await (const event of parseSse(upstream)) {
          const parsed = normalizeZaiCompletionEvent(event.data);

          if (parsed.error) {
            throw new Error(formatZaiError(parsed.error));
          }
          if (parsed.usage) {
            usage = parsed.usage;
          }
          if (parsed.delta) {
            if (parsed.isReasoning) {
              if (!shouldIncludeReasoning(request)) {
                continue;
              }
              controller.enqueue(encodeSse(openAiChunk(id, model, { reasoning_content: parsed.delta })));
            } else {
              controller.enqueue(encodeSse(openAiChunk(id, model, { content: parsed.delta })));
            }
          }

          if (parsed.done) {
            break;
          }
        }

        controller.enqueue(
          encodeSse(
            openAiChunk(
              id,
              model,
              {},
              "stop"
            )
          )
        );
        if (request.stream_options?.include_usage) {
          controller.enqueue(encodeSse(openAiUsageChunk(id, model, usage)));
        }
        controller.enqueue(encodeSse("[DONE]"));
        controller.close();
      } catch (error) {
        if (isAbortError(error)) {
          logger.info("STREAM", "Chat completion stream cancelled", { response_id: id });
          closeWithDone(controller);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error("STREAM", "SSE transform failed", message);
        enqueueChatStreamError(controller, id, model, message);
      } finally {
        active?.complete();
      }
    },
    cancel() {
      cancelActiveRequest(id, "client_stream_cancelled");
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...responseIdHeaders(id)
    }
  });
}

function streamTextCompletion(
  request: TextCompletionRequest,
  upstream: ReadableStream<Uint8Array> | null,
  id: string,
  active: ActiveRequestHandle
): Response {
  if (!upstream) {
    const error = openAIError("Z.ai response body is empty", 502, "upstream_error");
    return Response.json(error.body, { status: error.status });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let usage: OpenAIUsage | null = null;
      try {
        for await (const event of parseSse(upstream)) {
          const parsed = normalizeZaiCompletionEvent(event.data);

          if (parsed.error) {
            throw new Error(formatZaiError(parsed.error));
          }
          if (parsed.usage) usage = parsed.usage;

          if (parsed.delta && !parsed.isReasoning) {
            controller.enqueue(encodeSse(textCompletionChunk(request, id, parsed.delta)));
          }

          if (parsed.done) break;
        }

        controller.enqueue(encodeSse(textCompletionChunk(request, id, "", "stop")));
        if (request.stream_options?.include_usage) {
          controller.enqueue(encodeSse({ ...textCompletionChunk(request, id, "", null), choices: [], usage }));
        }
        controller.enqueue(encodeSse("[DONE]"));
        controller.close();
      } catch (error) {
        if (isAbortError(error)) {
          logger.info("STREAM", "Text completion stream cancelled", { response_id: id });
          closeWithDone(controller);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error("STREAM", "Text completion SSE transform failed", message);
        enqueueTextStreamError(controller, request, id, message);
      } finally {
        active.complete();
      }
    },
    cancel() {
      cancelActiveRequest(id, "client_stream_cancelled");
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...responseIdHeaders(id)
    }
  });
}

async function collectCompletion(
  request: ChatCompletionRequest,
  upstream: ReadableStream<Uint8Array> | null,
  id: string
) {
  if (!upstream) {
    throw new Error("Z.ai response body is empty");
  }

  const { content, reasoningContent, usage } = await collectZaiCompletion(upstream);
  return openAiCompletion(request, content, reasoningContent, usage, {
    includeReasoning: shouldIncludeReasoning(request),
    id
  });
}

function shouldIncludeReasoning(request: ChatCompletionRequest): boolean {
  return Boolean(request.zai?.include_reasoning || request.stream_options?.include_reasoning);
}

function textCompletionToChatRequest(request: TextCompletionRequest): ChatCompletionRequest {
  const prompt = Array.isArray(request.prompt) ? request.prompt.join("\n") : request.prompt;
  const chatRequest: ChatCompletionRequest = {
    model: request.model || config.zai.defaultModel,
    messages: [{ role: "user", content: prompt }],
    stream: true
  };
  if (typeof request.temperature === "number") chatRequest.temperature = request.temperature;
  if (typeof request.top_p === "number") chatRequest.top_p = request.top_p;
  if (typeof request.max_tokens === "number") chatRequest.max_tokens = request.max_tokens;
  if (request.stop !== undefined) chatRequest.stop = request.stop;
  if (typeof request.user === "string") chatRequest.user = request.user;
  if (request.metadata !== undefined) chatRequest.metadata = request.metadata;
  if (typeof request.prompt_cache_key === "string") chatRequest.prompt_cache_key = request.prompt_cache_key;
  if (request.stream_options !== undefined) chatRequest.stream_options = request.stream_options;
  if (request.zai !== undefined) chatRequest.zai = request.zai;
  return chatRequest;
}

function textCompletionObject(
  request: TextCompletionRequest,
  id: string,
  text: string,
  usage: OpenAIUsage | null
) {
  return {
    id,
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ text, index: 0, logprobs: null, finish_reason: "stop" }],
    usage
  };
}

function textCompletionChunk(
  request: TextCompletionRequest,
  id: string,
  text: string,
  finishReason: string | null = null
) {
  return {
    id,
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ text, index: 0, logprobs: null, finish_reason: finishReason }]
  };
}

function cancelledChatCompletion(id: string, model: string) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    cancelled: true,
    choices: [
      {
        index: 0,
        logprobs: null,
        message: { role: "assistant", content: "", refusal: null },
        finish_reason: "stop"
      }
    ],
    usage: null
  };
}

function cancelledTextCompletion(id: string, model: string) {
  return {
    id,
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model,
    cancelled: true,
    choices: [{ text: "", index: 0, logprobs: null, finish_reason: "stop" }],
    usage: null
  };
}

async function cancelCompletionRequest(
  c: Context,
  kind: "chat.completion" | "completion"
) {
  const body = await c.req.json().catch(() => ({}));
  const id = c.req.param("id") || requestIdFromBody(body);
  if (!id) {
    const error = openAIError("response_id is required", 400, "missing_required_parameter", "invalid_request_error");
    return c.json(error.body, error.status);
  }
  const result = cancelActiveRequest(id, "client_requested_cancel");
  const payload =
    kind === "chat.completion"
      ? cancelledChatCompletion(result.ok ? result.id : id, "unknown")
      : cancelledTextCompletion(result.ok ? result.id : id, "unknown");
  return c.json(payload, result.ok ? 200 : 404);
}

function requestIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["response_id", "completion_id", "request_id", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function closeWithDone(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.enqueue(encodeSse("[DONE]"));
  } catch {
    // The client may already have closed the socket.
  }
  try {
    controller.close();
  } catch {
    // Already closed.
  }
}

function enqueueChatStreamError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  id: string,
  model: string,
  message: string
): void {
  try {
    controller.enqueue(encodeSse(openAiChunk(id, model, {}, "stop")));
    controller.enqueue(encodeSse({ ...openAIError(message, 502, "upstream_error").body, id }));
  } catch {
    // The client may already have closed the socket.
  }
  closeWithDone(controller);
}

function enqueueTextStreamError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  request: TextCompletionRequest,
  id: string,
  message: string
): void {
  try {
    controller.enqueue(encodeSse(textCompletionChunk(request, id, "", "stop")));
    controller.enqueue(encodeSse({ ...openAIError(message, 502, "upstream_error").body, id }));
  } catch {
    // The client may already have closed the socket.
  }
  closeWithDone(controller);
}

function responseIdHeaders(id: string): Record<string, string> {
  return {
    "X-Request-Id": id,
    "X-Proxy-Response-Id": id
  };
}

function withResponseId(response: Response, id: string): Response {
  for (const [key, value] of Object.entries(responseIdHeaders(id))) {
    response.headers.set(key, value);
  }
  return response;
}
