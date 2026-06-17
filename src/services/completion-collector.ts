import { parseSse } from "../lib/sse.js";
import type { OpenAIUsage } from "../types/openai.js";
import { formatZaiError, normalizeZaiCompletionEvent } from "./openai-transform.js";

export { normalizeUsage } from "./openai-transform.js";

export type CollectedCompletion = {
  content: string;
  reasoningContent: string;
  usage: OpenAIUsage | null;
};

export type CollectZaiCompletionOptions = {
  returnPartialOnError?: boolean;
  onContentDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
};

export async function collectZaiCompletion(
  upstream: ReadableStream<Uint8Array> | null,
  options: CollectZaiCompletionOptions = {}
): Promise<CollectedCompletion> {
  if (!upstream) {
    throw new Error("Z.ai response body is empty");
  }

  let content = "";
  let reasoningContent = "";
  let usage: OpenAIUsage | null = null;

  for await (const event of parseSse(upstream)) {
    const parsed = normalizeZaiCompletionEvent(event.data);

    if (parsed.error) {
      if (options.returnPartialOnError && (content || reasoningContent || usage)) {
        break;
      }
      throw new Error(formatZaiError(parsed.error));
    }
    if (parsed.usage) {
      usage = parsed.usage;
    }
    if (parsed.delta) {
      if (parsed.isReasoning) {
        reasoningContent += parsed.delta;
        options.onReasoningDelta?.(parsed.delta);
      } else {
        content += parsed.delta;
        options.onContentDelta?.(parsed.delta);
      }
    }
    if (parsed.done) {
      break;
    }
  }

  return { content, reasoningContent, usage };
}

export function addUsage(left: OpenAIUsage | null, right: OpenAIUsage | null): OpenAIUsage | null {
  if (!left) return right;
  if (!right) return left;
  return {
    prompt_tokens: left.prompt_tokens + right.prompt_tokens,
    completion_tokens: left.completion_tokens + right.completion_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    ...(left.prompt_tokens_details || right.prompt_tokens_details
      ? { prompt_tokens_details: { ...left.prompt_tokens_details, ...right.prompt_tokens_details } }
      : {}),
    ...(left.completion_tokens_details || right.completion_tokens_details
      ? {
          completion_tokens_details: {
            ...left.completion_tokens_details,
            ...right.completion_tokens_details
          }
        }
      : {})
  };
}
