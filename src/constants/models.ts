import type { OpenAIModel } from "../types/openai.js";

export const MODEL_CAPABILITIES = {
  "GLM-5.2": {
    chat: true,
    streaming: true,
    reasoning: true,
    tools: true,
    vision: false,
    web_search: true,
    image_generation: false,
    agentic_tasks: true,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  },
  "GLM-5.1": {
    chat: true,
    streaming: true,
    reasoning: true,
    tools: true,
    vision: false,
    web_search: true,
    image_generation: false,
    agentic_tasks: true,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  },
  "GLM-5-Turbo": {
    chat: true,
    streaming: true,
    reasoning: true,
    tools: true,
    vision: false,
    web_search: true,
    image_generation: false,
    agentic_tasks: true,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  },
  "GLM-5V-Turbo": {
    chat: true,
    streaming: true,
    reasoning: true,
    tools: true,
    vision: true,
    web_search: true,
    image_generation: false,
    agentic_tasks: true,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  },
  "GLM-5": {
    chat: true,
    streaming: true,
    reasoning: true,
    tools: true,
    vision: false,
    web_search: true,
    image_generation: false,
    agentic_tasks: true,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  },
  "GLM-4.7": {
    chat: true,
    streaming: true,
    reasoning: false,
    tools: true,
    vision: false,
    web_search: true,
    image_generation: false,
    agentic_tasks: false,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  },
  "GLM-4.6V": {
    chat: true,
    streaming: true,
    reasoning: false,
    tools: true,
    vision: true,
    web_search: true,
    image_generation: false,
    agentic_tasks: false,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  },
  "GLM-4.5": {
    chat: true,
    streaming: true,
    reasoning: false,
    tools: true,
    vision: false,
    web_search: true,
    image_generation: false,
    agentic_tasks: false,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  },
  "GLM-4.5-Preview": {
    chat: true,
    streaming: true,
    reasoning: false,
    tools: true,
    vision: false,
    web_search: true,
    image_generation: false,
    agentic_tasks: false,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  },
  "GLM-4.5-Air": {
    chat: true,
    streaming: true,
    reasoning: false,
    tools: true,
    vision: false,
    web_search: true,
    image_generation: false,
    agentic_tasks: false,
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  }
} as const;

export const OPENAI_MODELS: OpenAIModel[] = [
  {
    id: "GLM-5.2",
    object: "model",
    created: 1781654400,
    owned_by: "z.ai",
    root: "GLM-5.2",
    parent: null,
    description: "Current flagship model for chat, reasoning, coding, and agentic tasks",
    family: "GLM-5",
    capabilities: MODEL_CAPABILITIES["GLM-5.2"]
  },
  {
    id: "GLM-5.1",
    object: "model",
    created: 1764547200,
    owned_by: "z.ai",
    root: "GLM-5.1",
    parent: null,
    description: "Flagship model for daily chat and agentic tasks",
    family: "GLM-5",
    capabilities: MODEL_CAPABILITIES["GLM-5.1"]
  },
  {
    id: "GLM-5-Turbo",
    object: "model",
    created: 1764547200,
    owned_by: "z.ai",
    root: "GLM-5-Turbo",
    parent: null,
    description: "New model for chat, coding, and agentic tasks",
    family: "GLM-5",
    capabilities: MODEL_CAPABILITIES["GLM-5-Turbo"]
  },
  {
    id: "GLM-5V-Turbo",
    object: "model",
    created: 1764547200,
    owned_by: "z.ai",
    root: "GLM-5V-Turbo",
    parent: null,
    description: "Vision model with evolved intelligence",
    family: "GLM-5",
    capabilities: MODEL_CAPABILITIES["GLM-5V-Turbo"]
  },
  {
    id: "GLM-5",
    object: "model",
    created: 1764547200,
    owned_by: "z.ai",
    root: "GLM-5",
    parent: null,
    description: "Previous flagship model",
    family: "GLM-5",
    capabilities: MODEL_CAPABILITIES["GLM-5"]
  },
  {
    id: "GLM-4.7",
    object: "model",
    created: 1751328000,
    owned_by: "z.ai",
    root: "GLM-4.7",
    parent: null,
    description: "Classic high-performance model",
    family: "GLM-4",
    capabilities: MODEL_CAPABILITIES["GLM-4.7"]
  },
  {
    id: "GLM-4.6V",
    object: "model",
    created: 1748736000,
    owned_by: "z.ai",
    root: "GLM-4.6V",
    parent: null,
    description: "Powerful new-generation visual model",
    family: "GLM-4",
    capabilities: MODEL_CAPABILITIES["GLM-4.6V"]
  },
  {
    id: "GLM-4.5",
    object: "model",
    created: 1735689600,
    owned_by: "z.ai",
    root: "GLM-4.5",
    parent: null,
    description: "General GLM 4.5 model exposed by the current Z.AI frontend",
    family: "GLM-4",
    capabilities: MODEL_CAPABILITIES["GLM-4.5"]
  },
  {
    id: "GLM-4.5-Preview",
    object: "model",
    created: 1735689600,
    owned_by: "z.ai",
    root: "GLM-4.5-Preview",
    parent: null,
    description: "Preview GLM 4.5 model exposed by the current Z.AI frontend",
    family: "GLM-4",
    capabilities: MODEL_CAPABILITIES["GLM-4.5-Preview"]
  },
  {
    id: "GLM-4.5-Air",
    object: "model",
    created: 1743465600,
    owned_by: "z.ai",
    root: "GLM-4.5-Air",
    parent: null,
    description: "Classic lightweight model",
    family: "GLM-4",
    capabilities: MODEL_CAPABILITIES["GLM-4.5-Air"]
  }
];

export const MODEL_ALIASES: Record<string, string> = {
  "glm-5.2": "GLM-5.2",
  "z.ai/glm-5.2": "GLM-5.2",
  "z.ai.glm-5.2": "GLM-5.2",
  "z.ai:glm-5.2": "GLM-5.2",
  "glm-5.1": "GLM-5.1",
  "z.ai/glm-5.1": "GLM-5.1",
  "z.ai.glm-5.1": "GLM-5.1",
  "z.ai:glm-5.1": "GLM-5.1",
  "glm-5-turbo": "GLM-5-Turbo",
  "z.ai/glm-5-turbo": "GLM-5-Turbo",
  "glm-5v-turbo": "GLM-5V-Turbo",
  "glm-5": "GLM-5",
  "z.ai/glm-5": "GLM-5",
  "glm-4.7": "GLM-4.7",
  "glm-4.6v": "GLM-4.6V",
  "z.ai/glm-4.6v": "GLM-4.6V",
  "glm-4.5": "GLM-4.5",
  "glm-4.5-preview": "GLM-4.5-Preview",
  "glm-4.5-air": "GLM-4.5-Air"
};

export function canonicalModelId(input: string): string {
  const decoded = safeDecodeURIComponent(input).trim();
  const withoutProvider = decoded.includes("/")
    ? decoded.split("/").filter(Boolean).at(-1) ?? decoded
    : decoded;
  const stripped = withoutProvider.replace(/^z\.ai[.:]/i, "");
  return MODEL_ALIASES[stripped.toLowerCase()] ?? stripped;
}

export function findModel(models: OpenAIModel[], input: string): OpenAIModel | null {
  const wanted = canonicalModelId(input);
  return (
    models.find((model) => canonicalModelId(model.id) === wanted) ??
    models.find((model) => model.aliases?.some((alias) => canonicalModelId(alias) === wanted)) ??
    null
  );
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
