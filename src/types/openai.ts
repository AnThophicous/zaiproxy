export type OpenAIRole = "system" | "developer" | "user" | "assistant" | "tool";

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: string };

export type OpenAIMessage = {
  role: OpenAIRole;
  content?: string | OpenAIContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[] | unknown[];
};

export type OpenAIFunctionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
};

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
};

export type ChatCompletionRequest = {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  n?: number;
  seed?: number;
  stop?: string | string[] | null;
  tools?: OpenAIFunctionTool[] | unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  prompt_cache_key?: string;
  previous_response_id?: string;
  metadata?: Record<string, unknown> | null;
  store?: boolean;
  user?: string;
  stream_options?: { include_usage?: boolean; include_reasoning?: boolean };
  zai?: {
    enable_thinking?: boolean;
    web_search?: boolean;
    auto_web_search?: boolean;
    captcha_verify_param?: string;
    include_reasoning?: boolean;
    conversation_key?: string;
    force_new_chat?: boolean;
    fresh_chat_retry?: boolean;
    proxy_tools?: boolean;
    vision?: boolean;
    reasoning_effort?: string;
    flags?: string[];
    mcp_servers?: unknown[];
    frontend_captcha?: boolean;
    agent_mode?: boolean;
  };
};

export type OpenAIModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  root?: string;
  parent?: string | null;
  description?: string;
  family?: string;
  capabilities?: Record<string, boolean>;
  aliases?: string[];
  upstream_id?: string;
  context_length?: number;
  max_tokens?: number;
  source?: "local" | "upstream" | "experimental";
  experimental?: boolean;
};

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: Record<string, unknown>;
  completion_tokens_details?: Record<string, unknown>;
};
