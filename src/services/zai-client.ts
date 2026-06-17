import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import type { AccountRepository } from "../db/accounts.js";
import type { ConversationRepository } from "../db/conversations.js";
import { canonicalModelId, findModel, OPENAI_MODELS } from "../constants/models.js";
import { logger, timing } from "../lib/logger.js";
import { parseSse } from "../lib/sse.js";
import { computeZaiSignature, sortedSignaturePayload } from "../lib/zai-signature.js";
import type { ChatCompletionRequest, OpenAIMessage } from "../types/openai.js";
import type { ZaiAccount, ZaiBrowserFingerprint } from "../types/zai.js";
import { AccountPool, noUsableAccountMessage } from "./account-pool.js";
import { CaptchaSolver } from "./captcha-solver.js";
import { formatZaiError, getZaiError, latestUserPrompt, normalizeMessages, parseZaiEvent } from "./openai-transform.js";

type CookieLike = {
  name?: string;
  value?: string;
};

type CreatedChat = {
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  parentMessageId: string | null;
  conversationKey: string;
};

type CachedConversation = {
  accountId: string;
  model: string;
  chatId: string;
  currentMessageId: string | null;
  updatedAt: number;
};

type ActiveUpstreamTask = {
  account: ZaiAccount;
  model: string;
  chatId: string;
  messageId: string;
  conversationKey: string;
};

type HealthResult = { ok: boolean; account: string | null; upstream: string; cached?: boolean };
type ModelList = typeof OPENAI_MODELS;

const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000;

export class ZaiClient {
  private readonly pool: AccountPool;
  private readonly captcha = new CaptchaSolver();
  private readonly conversations = new Map<string, CachedConversation>();
  private readonly conversationLocks = new Map<string, Promise<void>>();
  private readonly activeUpstreamTasks = new Map<string, ActiveUpstreamTask>();
  private healthCache: { value: HealthResult; expiresAt: number } | null = null;
  private healthRefresh: Promise<void> | null = null;
  private modelsCache: { value: ModelList; expiresAt: number } | null = null;
  private modelsRefresh: Promise<void> | null = null;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly conversationStore?: ConversationRepository
  ) {
    this.pool = new AccountPool(accounts);
  }

  async getActiveAccount(): Promise<ZaiAccount> {
    return this.pool.next();
  }

  async health(): Promise<HealthResult> {
    const account = this.pool.candidates()[0] ?? null;
    if (!account) {
      return { ok: false, account: null, upstream: "missing_session" };
    }

    const now = Date.now();
    if (this.healthCache && this.healthCache.expiresAt > now) {
      return { ...this.healthCache.value, cached: true };
    }

    this.refreshHealth(account);
    return this.healthCache?.value ?? { ok: true, account: account.email, upstream: "session_loaded" };
  }

  private refreshHealth(account: ZaiAccount): void {
    if (this.healthRefresh) {
      return;
    }

    this.healthRefresh = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void this.loadHealth(account).finally(resolve);
      }, 0);
      timer.unref();
    }).finally(() => {
      this.healthRefresh = null;
    });
  }

  private async loadHealth(account: ZaiAccount): Promise<void> {
    const value = await this.probeHealth(account);
    this.healthCache = { value, expiresAt: Date.now() + config.zai.healthCacheTtlMs };
  }

  private async probeHealth(account: ZaiAccount): Promise<HealthResult> {
    try {
      await this.fetchUpstream(account, "/api/models", {
        method: "GET",
        signal: AbortSignal.timeout(config.zai.fetchTimeoutMs)
      });
      this.pool.reportSuccess(account);
      return { ok: true, account: account.email, upstream: "ok" };
    } catch (error) {
      logger.warn("HEALTH", "Active account validation failed", error);
      return { ok: false, account: account.email, upstream: "unreachable" };
    }
  }

  async listModels(): Promise<ModelList> {
    const now = Date.now();
    if (this.modelsCache && this.modelsCache.expiresAt > now) {
      return this.modelsCache.value;
    }

    this.refreshModels();
    return this.modelsCache?.value ?? OPENAI_MODELS;
  }

  private async normalizeAndValidateRequest(request: ChatCompletionRequest): Promise<ChatCompletionRequest> {
    const requestedModel = request.model || config.zai.defaultModel;
    const modelId = normalizeModelId(requestedModel);
    const model = findModel(await this.listModels(), modelId);
    if (!model) {
      throw new Error(`MODEL_NOT_FOUND: Model '${requestedModel}' is not available from Z.ai`);
    }

    const capabilities = model.capabilities ?? {};
    const hasImages = requestContainsImages(request.messages);
    const hasFileImageRefs = requestContainsImageFileRefs(request.messages);
    const wantsVision = hasImages || request.zai?.vision === true;
    const wantsWebSearch = request.zai?.web_search === true || request.zai?.auto_web_search === true;
    const wantsTools = (Array.isArray(request.tools) && request.tools.length > 0) || request.zai?.proxy_tools === true;
    const explicitThinking = request.zai?.enable_thinking;

    if (hasFileImageRefs) {
      throw new Error("UNSUPPORTED_PARAMETER: input_image.file_id is not supported yet; use image_url instead");
    }
    if (wantsVision && !capabilities.vision) {
      throw new Error(`UNSUPPORTED_MODEL_FEATURE: Model '${model.id}' does not support vision input`);
    }
    if (wantsWebSearch && !capabilities.web_search) {
      throw new Error(`UNSUPPORTED_MODEL_FEATURE: Model '${model.id}' does not support web_search`);
    }
    if (wantsTools && !capabilities.tools) {
      throw new Error(`UNSUPPORTED_MODEL_FEATURE: Model '${model.id}' does not support tool calls`);
    }
    if (explicitThinking === true && !capabilities.reasoning) {
      throw new Error(`UNSUPPORTED_MODEL_FEATURE: Model '${model.id}' does not support thinking/reasoning`);
    }

    return {
      ...request,
      model: model.id,
      zai: {
        ...request.zai,
        enable_thinking: explicitThinking ?? Boolean(capabilities.reasoning),
        vision: request.zai?.vision ?? hasImages
      }
    };
  }

  private refreshModels(): void {
    if (this.modelsRefresh) {
      return;
    }

    this.modelsRefresh = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void this.loadModels().finally(resolve);
      }, 0);
      timer.unref();
    }).finally(() => {
      this.modelsRefresh = null;
    });
  }

  private async loadModels(): Promise<void> {
    const account = this.pool.candidates()[0] ?? null;
    if (!account) {
      this.modelsCache = { value: OPENAI_MODELS, expiresAt: Date.now() + config.zai.modelsCacheTtlMs };
      return;
    }

    try {
      const upstream = await this.fetchJson<unknown>(
        account,
        "/api/models",
        { method: "GET", signal: AbortSignal.timeout(config.zai.fetchTimeoutMs) }
      );
      const upstreamModels = upstreamModelRecords(upstream)
        .map(upstreamModelToOpenAIModel)
        .filter((model) => model !== null);

      if (upstreamModels.length > 0) {
        this.modelsCache = {
          value: mergeModels(upstreamModels),
          expiresAt: Date.now() + config.zai.modelsCacheTtlMs
        };
        return;
      }
    } catch (error) {
      logger.warn("UPSTREAM", "Could not load upstream model list; using local catalog", error);
    }

    this.modelsCache = { value: OPENAI_MODELS, expiresAt: Date.now() + config.zai.modelsCacheTtlMs };
  }

  async createCompletionStream(
    request: ChatCompletionRequest,
    signal: AbortSignal
  ): Promise<Response> {
    const normalizedRequest = await this.normalizeAndValidateRequest(request);
    const accounts = this.pool.candidates();
    if (accounts.length === 0) {
      throw new Error(noUsableAccountMessage(this.accounts.list()));
    }

    let lastError: unknown = null;
    for (const account of accounts) {
      try {
        const response = await this.createCompletionStreamForAccount(account, normalizedRequest, signal);
        this.pool.reportSuccess(account);
        return response;
      } catch (error) {
        lastError = error;
        this.pool.reportFailure(account, error);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "All accounts failed"));
  }

  cancelRequestConversation(request: ChatCompletionRequest): void {
    const model = normalizeModelId(request.model || config.zai.defaultModel);
    const raw = conversationRawKey(request);
    const suffix = `:${model}:${sanitizeConversationKey(raw)}`;
    let removed = 0;
    for (const key of this.conversations.keys()) {
      if (key.endsWith(suffix)) {
        this.conversations.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      logger.info("UPSTREAM", "Dropped cancelled Z.ai conversation cache", { removed, model });
    }
    const persistedRemoved = this.conversationStore?.deleteBySuffix(suffix) ?? 0;
    if (persistedRemoved > 0) {
      logger.info("UPSTREAM", "Dropped persisted cancelled Z.ai conversation cache", {
        removed: persistedRemoved,
        model
      });
    }
    for (const task of this.activeUpstreamTasks.values()) {
      if (task.conversationKey.endsWith(suffix)) {
        void this.stopUpstreamTask(task, "client_requested_cancel");
      }
    }
  }

  private async createCompletionStreamForAccount(
    account: ZaiAccount,
    request: ChatCompletionRequest,
    signal: AbortSignal
  ): Promise<Response> {
    const model = normalizeModelId(request.model || config.zai.defaultModel);
    const prompt = latestUserPrompt(request.messages);
    if (!prompt) {
      throw new Error("messages must include at least one user message with text content");
    }
    const created = await this.prepareConversation(account, request, model, prompt, signal);
    this.registerActiveUpstreamTask(account, model, created, signal);
    const stopTimer = timing("UPSTREAM", "Z.ai completion request");
    let captchaSolved = Boolean(request.zai?.captcha_verify_param);
    let completionRequest = request;

    try {
      if (!captchaSolved && shouldSolveCaptchaBeforeCompletion(model, request)) {
        logger.warn("UPSTREAM", "Z.ai model requires frontend captcha; solving before completion request");
        const captcha = await this.captcha.solve(account);
        captchaSolved = true;
        completionRequest = withCaptcha(request, captcha);
      }

      const response = await this.fetchSignedCompletion(account, completionRequest, model, prompt, created, signal);
      let inspected = await this.inspectInitialCompletion(response);
      if (inspected.captchaRequired) {
        if (completionRequest.zai?.captcha_verify_param) {
          throw new Error("FRONTEND_CAPTCHA_REQUIRED: Z.ai rejected the captcha verification");
        }
        await inspected.response.body?.cancel().catch(() => {});
        logger.warn("UPSTREAM", "Z.ai requested frontend captcha; solving and retrying");
        const captcha = await this.captcha.solve(account);
        captchaSolved = true;
        const retryRequest = withCaptcha(request, captcha);
        const retryResponse = await this.fetchSignedCompletion(account, retryRequest, model, prompt, created, signal);
        inspected = await this.inspectInitialCompletion(retryResponse);
        if (inspected.captchaRequired) {
          throw new Error("FRONTEND_CAPTCHA_REQUIRED: Z.ai rejected the captcha verification");
        }
      }

      return this.persistConversationFromStream(inspected.response, account, model, created);
    } catch (error) {
      if (shouldRetryWithFreshChat(error, request, captchaSolved)) {
        this.activeUpstreamTasks.delete(created.conversationKey);
        this.forgetConversation(created.conversationKey);
        logger.warn("UPSTREAM", "Z.ai internal error on cached chat; retrying once with a fresh chat");
        return await this.createCompletionStreamForAccount(
          account,
          {
            ...request,
            zai: {
              ...request.zai,
              force_new_chat: true,
              fresh_chat_retry: true
            }
          },
          signal
        );
      }
      this.activeUpstreamTasks.delete(created.conversationKey);
      throw error;
    } finally {
      stopTimer();
    }
  }

  private registerActiveUpstreamTask(
    account: ZaiAccount,
    model: string,
    created: CreatedChat,
    signal: AbortSignal
  ): void {
    const task: ActiveUpstreamTask = {
      account,
      model,
      chatId: created.chatId,
      messageId: created.assistantMessageId,
      conversationKey: created.conversationKey
    };
    this.activeUpstreamTasks.set(created.conversationKey, task);
    signal.addEventListener(
      "abort",
      () => {
        void this.stopUpstreamTask(task, "client_abort");
      },
      { once: true }
    );
  }

  private async stopUpstreamTask(task: ActiveUpstreamTask, reason: string): Promise<void> {
    try {
      await this.fetchUpstream(task.account, `/api/tasks/stop/${encodeURIComponent(task.messageId)}`, {
        method: "POST",
        signal: AbortSignal.timeout(config.zai.fetchTimeoutMs),
        body: JSON.stringify({
          chat_id: task.chatId,
          model: task.model,
          reason
        })
      });
      logger.info("UPSTREAM", "Requested Z.ai task stop", {
        chat_id: task.chatId,
        message_id: task.messageId,
        reason
      });
    } catch (error) {
      logger.warn("UPSTREAM", "Z.ai task stop request failed", {
        chat_id: task.chatId,
        message_id: task.messageId,
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async fetchSignedCompletion(
    account: ZaiAccount,
    request: ChatCompletionRequest,
    model: string,
    prompt: string,
    created: CreatedChat,
    signal: AbortSignal
  ): Promise<Response> {
    const telemetry = this.buildTelemetry(account, created.chatId);
    const sortedPayload = sortedSignaturePayload(telemetry.base);
    const signature = computeZaiSignature(sortedPayload, prompt, telemetry.timestamp);
    const url = `/api/v2/chat/completions?${telemetry.query}&signature_timestamp=${telemetry.timestamp}`;
    const body = this.buildCompletionPayload(account, request, model, prompt, created);
    return this.fetchCompletion(account, url, signature, body, signal);
  }

  private async fetchCompletion(
    account: ZaiAccount,
    url: string,
    signature: string,
    body: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Response> {
    const response = await this.fetchUpstream(account, url, {
      method: "POST",
      signal,
      headers: {
        Accept: "text/event-stream",
        "X-Signature": signature
      },
      body: JSON.stringify(body)
    });

    if (!response.body) {
      throw new Error("Z.ai response body is empty");
    }

    return response;
  }

  private async inspectInitialCompletion(
    response: Response
  ): Promise<{ response: Response; captchaRequired: boolean }> {
    if (!response.body) {
      throw new Error("Z.ai response body is empty");
    }

    const [inspectStream, forwardStream] = response.body.tee();
    const forwarded = new Response(forwardStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });

    try {
      for await (const event of parseSse(inspectStream)) {
        const parsed = parseZaiEvent(event.data);
        const error = getZaiError(parsed);
        if (error) {
          const code = error.code ?? error.error_code;
          if (code === "FRONTEND_CAPTCHA_REQUIRED") {
            return { response: forwarded, captchaRequired: true };
          }
          throw new Error(formatZaiError(error));
        }
        break;
      }
    } finally {
      void inspectStream.cancel().catch(() => {});
    }

    return { response: forwarded, captchaRequired: false };
  }

  private persistConversationFromStream(
    response: Response,
    account: ZaiAccount,
    model: string,
    created: CreatedChat
  ): Response {
    if (!response.body) {
      this.commitConversation(account, model, created);
      this.activeUpstreamTasks.delete(created.conversationKey);
      return response;
    }

    const [observer, forwarded] = response.body.tee();
    void this.observeCompletionParentId(observer, account, model, created);
    return new Response(forwarded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  private async observeCompletionParentId(
    stream: ReadableStream<Uint8Array>,
    account: ZaiAccount,
    model: string,
    created: CreatedChat
  ): Promise<void> {
    let upstreamMessageId: string | null = null;
    try {
      for await (const event of parseSse(stream)) {
        const parsed = parseZaiEvent(event.data);
        const candidate = upstreamParentMessageId(parsed);
        if (candidate) {
          upstreamMessageId = candidate;
        }
        if (parsed?.data?.done || parsed?.data?.phase === "done") {
          break;
        }
      }
    } catch (error) {
      logger.warn("UPSTREAM", "Could not observe Z.ai parent message id; using local fallback", error);
    } finally {
      this.commitConversation(account, model, created, upstreamMessageId ?? created.assistantMessageId);
      this.activeUpstreamTasks.delete(created.conversationKey);
    }
  }

  private async prepareConversation(
    account: ZaiAccount,
    request: ChatCompletionRequest,
    model: string,
    prompt: string,
    signal: AbortSignal
  ): Promise<CreatedChat> {
    const conversationKey = this.conversationKey(account, request, model);
    return this.withConversationLock(conversationKey, async () => {
      this.pruneConversations();
      const forceNewChat = Boolean(request.zai?.force_new_chat);
      const persisted = this.conversationStore?.get(conversationKey) ?? null;
      if (persisted && Date.now() - persisted.updatedAt > CONVERSATION_TTL_MS) {
        this.conversationStore?.delete(conversationKey);
      }
      const cached =
        this.conversations.get(conversationKey) ??
        (persisted && Date.now() - persisted.updatedAt <= CONVERSATION_TTL_MS
          ? {
              accountId: persisted.accountId,
              model: persisted.model,
              chatId: persisted.chatId,
              currentMessageId: persisted.currentMessageId,
              updatedAt: persisted.updatedAt
            }
          : null);
      if (!forceNewChat && cached?.accountId === account.id && cached.model === model) {
        this.conversations.set(conversationKey, { ...cached, updatedAt: Date.now() });
        logger.info("UPSTREAM", "Reusing persisted Z.ai conversation", {
          chat_id: cached.chatId,
          parent_message_id: cached.currentMessageId,
          key: publicConversationKey(conversationKey)
        });
        return {
          chatId: cached.chatId,
          userMessageId: randomUUID(),
          assistantMessageId: randomUUID(),
          parentMessageId: cached.currentMessageId,
          conversationKey
        };
      }

      return this.createChat(account, request, model, prompt, conversationKey, signal);
    });
  }

  private commitConversation(
    account: ZaiAccount,
    model: string,
    created: CreatedChat,
    currentMessageId = created.assistantMessageId
  ): void {
    const conversation = {
      accountId: account.id,
      model,
      chatId: created.chatId,
      currentMessageId,
      updatedAt: Date.now()
    };
    this.conversations.set(created.conversationKey, conversation);
    this.conversationStore?.save({
      conversationKey: created.conversationKey,
      accountId: conversation.accountId,
      model: conversation.model,
      chatId: conversation.chatId,
      currentMessageId: conversation.currentMessageId
    });
    logger.info("UPSTREAM", "Persisted Z.ai conversation cursor", {
      chat_id: conversation.chatId,
      parent_message_id: conversation.currentMessageId,
      key: publicConversationKey(created.conversationKey)
    });
  }

  private forgetConversation(conversationKey: string): void {
    this.conversations.delete(conversationKey);
    this.conversationStore?.delete(conversationKey);
  }

  private conversationKey(account: ZaiAccount, request: ChatCompletionRequest, model: string): string {
    const raw = conversationRawKey(request);
    return `${account.id}:${model}:${sanitizeConversationKey(raw)}`;
  }

  private async withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.conversationLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.conversationLocks.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.conversationLocks.get(key) === tail) {
        this.conversationLocks.delete(key);
      }
    }
  }

  private pruneConversations(): void {
    const now = Date.now();
    for (const [key, conversation] of this.conversations) {
      if (now - conversation.updatedAt > CONVERSATION_TTL_MS) {
        this.conversations.delete(key);
      }
    }
    this.conversationStore?.pruneOlderThan(now - CONVERSATION_TTL_MS);
  }

  private async createChat(
    account: ZaiAccount,
    request: ChatCompletionRequest,
    model: string,
    prompt: string,
    conversationKey: string,
    signal: AbortSignal
  ): Promise<CreatedChat> {
    const chatId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const timestampMs = Date.now();
    const timestampSeconds = Math.floor(timestampMs / 1000);
    const enableThinking = request.zai?.enable_thinking ?? true;
    const webSearch = request.zai?.web_search ?? request.zai?.auto_web_search ?? false;
    const autoWebSearch = request.zai?.auto_web_search ?? webSearch;
    const upstreamModel = zaiUpstreamModelId(model);
    const flags = zaiFlags(request);
    const mcpServers = zaiMcpServers(request);
    const type = flags.includes("general_agent") ? "general_agent" : "default";
    const webSessionId = zaiWebSessionId(account);

    const chat = {
      id: chatId,
      title: "New Chat",
      models: [upstreamModel],
      params: {},
      history: {
        messages: {
          [userMessageId]: {
            id: userMessageId,
            parentId: null,
            childrenIds: [],
            role: "user",
            content: prompt,
            timestamp: timestampSeconds,
            models: [upstreamModel]
          }
        },
        currentId: userMessageId
      },
      tags: [],
      flags,
      features: zaiChatFeatures(enableThinking, flags.includes("general_agent")),
      mcp_servers: mcpServers,
      enable_thinking: enableThinking,
      reasoning_effort: zaiReasoningEffort(request),
      auto_web_search: autoWebSearch,
      message_version: 1,
      extra: {},
      timestamp: timestampMs,
      type
    };

    const payload = {
      id: chatId,
      user_id: account.id,
      title: "New Chat",
      chat,
      updated_at: timestampSeconds,
      created_at: timestampSeconds,
      share_id: null,
      archived: false,
      pinned: false,
      meta: {
        auto_web_search: autoWebSearch,
        flags,
        mcp_servers: mcpServers,
        models: [upstreamModel],
        web_session_id: webSessionId,
        workspace_id: chatId
      },
      folder_id: null,
      message_version: 1,
      type,
      im_context: {
        session_id: webSessionId,
        session_name: "New Chat",
        channel: "zai-web",
        type,
        zai_user_id: account.id
      }
    };

    const response = await this.fetchJson<{ id?: string; chat?: { id?: string } }>(
      account,
      "/api/v1/chats/new",
      {
        method: "POST",
        signal,
        body: JSON.stringify(payload)
      }
    );

    const upstreamChatId = response.chat?.id ?? response.id ?? chatId;
    if (!upstreamChatId) {
      throw new Error("Z.ai did not return a chat id");
    }

    logger.info("UPSTREAM", "Created new Z.ai conversation", {
      chat_id: upstreamChatId,
      key: publicConversationKey(conversationKey)
    });
    return { chatId: upstreamChatId, userMessageId, assistantMessageId, parentMessageId: null, conversationKey };
  }

  private buildCompletionPayload(
    account: ZaiAccount,
    request: ChatCompletionRequest,
    model: string,
    prompt: string,
    created: CreatedChat
  ) {
    const enableThinking = request.zai?.enable_thinking ?? true;
    const webSearch = request.zai?.web_search ?? request.zai?.auto_web_search ?? false;
    const autoWebSearch = request.zai?.auto_web_search ?? webSearch;
    const vision = request.zai?.vision ?? requestContainsImages(request.messages);
    const mcpServers = zaiMcpServers(request);
    const upstreamModel = zaiUpstreamModelId(model);
    const params: Record<string, unknown> = {};
    if (typeof request.temperature === "number") params.temperature = request.temperature;
    if (typeof request.top_p === "number") params.top_p = request.top_p;
    if (typeof request.max_tokens === "number") params.max_tokens = request.max_tokens;
    if (typeof request.max_completion_tokens === "number") {
      params.max_tokens = request.max_completion_tokens;
    }
    if (request.stop) params.stop = Array.isArray(request.stop) ? request.stop : [request.stop];

    return {
      stream: true,
      model: upstreamModel,
      messages: normalizeMessages(request.messages),
      signature_prompt: prompt,
      params,
      extra: {
        ...(vision ? { vision: true } : {})
      },
      ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
      features: {
        image_generation: false,
        web_search: false,
        auto_web_search: autoWebSearch,
        flags: zaiFlags(request),
        vlm_tools_enable: false,
        vlm_web_search_enable: vision && autoWebSearch,
        vlm_website_mode: false,
        preview_mode: true,
        enable_thinking: enableThinking,
        reasoning_effort: zaiReasoningEffort(request)
      },
      variables: this.variables(account),
      chat_id: created.chatId,
      id: created.assistantMessageId,
      current_user_message_id: created.userMessageId,
      current_user_message_parent_id: created.parentMessageId,
      background_tasks: {
        title_generation: true,
        tags_generation: true
      },
      ...(request.zai?.captcha_verify_param
        ? { captcha_verify_param: request.zai.captcha_verify_param }
        : {})
    };
  }

  private buildTelemetry(account: ZaiAccount, chatId: string) {
    const timestamp = String(Date.now());
    const fingerprint = account.browserFingerprint;
    const baseUrl = new URL(config.zai.baseUrl);
    const userAgent = accountUserAgent(account);
    const language = stringValue(fingerprint?.language) ?? config.zai.language;
    const languages = languageList(fingerprint);
    const screenWidth = numberParam(fingerprint?.screen?.width, "1920");
    const screenHeight = numberParam(fingerprint?.screen?.height, "1080");
    const viewportWidth = numberParam(fingerprint?.viewport?.width, "1343");
    const viewportHeight = numberParam(fingerprint?.viewport?.height, "960");
    const base = {
      timestamp,
      requestId: randomUUID(),
      user_id: account.id
    };

    const query = new URLSearchParams({
      ...base,
      version: "0.0.1",
      platform: "web",
      token: account.token,
      user_agent: userAgent,
      language,
      languages,
      timezone: stringValue(fingerprint?.timezone) ?? config.zai.timezone,
      cookie_enabled: booleanParam(fingerprint?.cookieEnabled, "true"),
      screen_width: screenWidth,
      screen_height: screenHeight,
      screen_resolution: `${screenWidth}x${screenHeight}`,
      viewport_height: viewportHeight,
      viewport_width: viewportWidth,
      viewport_size: `${viewportWidth}x${viewportHeight}`,
      color_depth: numberParam(fingerprint?.screen?.colorDepth, "24"),
      pixel_ratio: numberParam(fingerprint?.pixelRatio, "1"),
      current_url: `${config.zai.baseUrl}/c/${chatId}`,
      pathname: `/c/${chatId}`,
      search: "",
      hash: "",
      host: baseUrl.host,
      hostname: baseUrl.hostname,
      protocol: baseUrl.protocol,
      referrer: "",
      title: "Z.ai - Advanced AI Chatbot & Agent powered by GLM-5.2",
      timezone_offset: numberParam(fingerprint?.timezoneOffset, "180"),
      local_time: new Date().toISOString(),
      utc_time: new Date().toUTCString(),
      is_mobile: "false",
      is_touch: booleanParam(fingerprint?.isTouch, "false"),
      max_touch_points: numberParam(fingerprint?.maxTouchPoints, "0"),
      browser_name: stringValue(fingerprint?.browserName) ?? inferBrowserName(userAgent),
      os_name: stringValue(fingerprint?.osName) ?? inferOsName(userAgent)
    }).toString();

    return { timestamp, base, query };
  }

  private variables(account: ZaiAccount) {
    const now = new Date();
    const date = formatDateTimeParts(now, config.zai.timezone);
    return {
      "{{USER_NAME}}": account.displayName ?? account.email.split("@", 1)[0] ?? "User",
      "{{USER_LOCATION}}": "Unknown",
      "{{CURRENT_DATETIME}}": `${date.date} ${date.time}`,
      "{{CURRENT_DATE}}": date.date,
      "{{CURRENT_TIME}}": date.time,
      "{{CURRENT_WEEKDAY}}": date.weekday,
      "{{CURRENT_TIMEZONE}}": config.zai.timezone,
      "{{USER_LANGUAGE}}": config.zai.language
    };
  }

  private async fetchJson<T>(
    account: ZaiAccount,
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const response = await this.fetchUpstream(account, path, init);
    return (await response.json()) as T;
  }

  private async fetchUpstream(
    account: ZaiAccount,
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${config.zai.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    const fingerprintAcceptLanguage = fingerprintHeader(account, "accept-language");
    headers.set("Authorization", `Bearer ${account.token}`);
    headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
    headers.set("Accept-Language", fingerprintAcceptLanguage ?? config.zai.acceptLanguage);
    headers.set("Origin", fingerprintHeader(account, "origin") ?? config.zai.baseUrl);
    headers.set("Referer", fingerprintHeader(account, "referer") ?? `${config.zai.baseUrl}/`);
    headers.set("User-Agent", accountUserAgent(account));
    setHeaderIfPresent(headers, "Accept-Encoding", fingerprintHeader(account, "accept-encoding"));
    setHeaderIfPresent(headers, "Sec-CH-UA", fingerprintHeader(account, "sec-ch-ua"));
    setHeaderIfPresent(headers, "Sec-CH-UA-Mobile", fingerprintHeader(account, "sec-ch-ua-mobile"));
    setHeaderIfPresent(headers, "Sec-CH-UA-Platform", fingerprintHeader(account, "sec-ch-ua-platform"));
    setHeaderIfPresent(headers, "Sec-Fetch-Dest", fingerprintHeader(account, "sec-fetch-dest"));
    setHeaderIfPresent(headers, "Sec-Fetch-Mode", fingerprintHeader(account, "sec-fetch-mode"));
    setHeaderIfPresent(headers, "Sec-Fetch-Site", fingerprintHeader(account, "sec-fetch-site"));
    headers.set("X-FE-Version", config.zai.feVersion);
    headers.set("X-Region", config.zai.region);
    headers.set("Cookie", cookieHeader(account.cookies));

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.warn("UPSTREAM", `${response.status} ${response.statusText} from ${path}`, text);
      throw new Error(text || `Z.ai upstream error ${response.status}`);
    }

    return response;
  }
}

function cookieHeader(cookies: unknown[]): string {
  return cookies
    .map((cookie) => cookie as CookieLike)
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function zaiFlags(request: ChatCompletionRequest): string[] {
  const extraFlags = Array.isArray(request.zai?.flags)
    ? request.zai.flags.filter((flag): flag is string => typeof flag === "string")
    : [];
  const wantsAgentMode =
    request.zai?.agent_mode === true ||
    extraFlags.includes("general_agent") ||
    zaiMcpServers(request).length > 0;
  return uniqueStrings([...(wantsAgentMode ? ["general_agent"] : []), ...extraFlags]);
}

function zaiMcpServers(request: ChatCompletionRequest): unknown[] {
  return Array.isArray(request.zai?.mcp_servers)
    ? request.zai.mcp_servers.filter((server) => isRecord(server))
    : [];
}

function zaiChatFeatures(enableThinking: boolean, agentMode: boolean): Array<Record<string, string>> {
  const features = [
    { type: "web_search", server: "web_search_h", status: "hidden" }
  ];
  if (agentMode) {
    features.push({ type: "tool_selector", server: "tool_selector_h", status: "hidden" });
  }
  if (enableThinking) {
    features.push({ type: "hidden-thinking", server: "hidden-thinking", status: "hidden" });
  }
  return features;
}

function zaiReasoningEffort(request: ChatCompletionRequest): string {
  return stringValue(request.zai?.reasoning_effort) ?? (request.zai?.enable_thinking === false ? "none" : "max");
}

function zaiUpstreamModelId(model: string): string {
  return model.trim().toLowerCase();
}

function zaiModelItem(model: string, upstreamModel: string): Record<string, unknown> {
  const local = findModel(OPENAI_MODELS, model) ?? findModel(OPENAI_MODELS, upstreamModel);
  return {
    id: upstreamModel,
    name: local?.description ?? model,
    owned_by: "z.ai",
    object: "model",
    info: {
      meta: {
        capabilities: {
          ...(local?.capabilities ?? defaultCapabilitiesForModel(model)),
          reasoning_effort: Boolean(local?.capabilities?.reasoning ?? model.includes("GLM-5"))
        }
      }
    }
  };
}

function zaiWebSessionId(account: ZaiAccount): string {
  const direct = firstLocalStorageString(account, [
    "web_session_id",
    "webSessionId",
    "session_id",
    "sessionId"
  ]);
  if (direct) {
    return direct.startsWith("web-") ? direct : `web-${direct}`;
  }

  for (const value of Object.values(account.localStorage)) {
    const parsed = parseJsonRecord(value);
    if (!parsed) {
      continue;
    }
    for (const key of ["web_session_id", "webSessionId", "session_id", "sessionId"]) {
      const candidate = stringValue(parsed[key]);
      if (candidate) {
        return candidate.startsWith("web-") ? candidate : `web-${candidate}`;
      }
    }
  }

  return `web-${randomUUID()}`;
}

function firstLocalStorageString(account: ZaiAccount, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(account.localStorage[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatDateTimeParts(date: Date, timeZone: string): { date: string; time: string; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = value("hour") === "24" ? "00" : value("hour");
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${hour}:${value("minute")}:${value("second")}`,
    weekday: value("weekday") || date.toLocaleDateString("en-US", { weekday: "long", timeZone })
  };
}

function accountUserAgent(account: ZaiAccount): string {
  return stringValue(account.browserFingerprint?.userAgent) ?? account.userAgent;
}

function fingerprintHeader(account: ZaiAccount, key: string): string | null {
  const normalizedKey = key.trim().toLowerCase();
  return stringValue(account.browserFingerprint?.requestHeaders?.[normalizedKey]);
}

function setHeaderIfPresent(headers: Headers, key: string, value: string | null): void {
  if (value) {
    headers.set(key, value);
  }
}

function languageList(fingerprint: ZaiBrowserFingerprint | null): string {
  const languages = uniqueStrings(fingerprint?.languages ?? []);
  return languages.length > 0 ? languages.join(",") : `${config.zai.language},pt,en-US,en`;
}

function numberParam(value: unknown, fallback: string): string {
  const number = numberValue(value);
  return number === null ? fallback : String(number);
}

function booleanParam(value: unknown, fallback: string): string {
  return typeof value === "boolean" ? String(value) : fallback;
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

function requestContainsImages(messages: OpenAIMessage[]): boolean {
  return messages.some((message) => {
    if (typeof message.content === "string") {
      return /!\[image\]\([^)]+\)|\[image_file:\s*[^]]+\]/.test(message.content);
    }
    if (!Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((part) => part.type === "image_url" || part.type === "input_image");
  });
}

function requestContainsImageFileRefs(messages: OpenAIMessage[]): boolean {
  return messages.some((message) => {
    if (typeof message.content === "string") {
      return /\[image_file:\s*[^]]+\]/.test(message.content);
    }
    if (!Array.isArray(message.content)) {
      return false;
    }
    return message.content.some((part) => part.type === "input_image" && Boolean(part.file_id));
  });
}

function upstreamModelRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of ["data", "models", "items"]) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return nested.filter(isRecord);
    }
  }
  return [];
}

function upstreamModelToOpenAIModel(model: Record<string, unknown>) {
  const rawId = stringValue(model.id) ?? stringValue(model.model) ?? stringValue(model.name);
  if (!rawId) {
    return null;
  }
  const id = canonicalModelId(rawId);
  const local = findModel(OPENAI_MODELS, id);
  const maxTokens = modelMaxTokens(model);
  return {
    id,
    object: "model" as const,
    created: numberValue(model.created) ?? local?.created ?? 1764547200,
    owned_by: "z.ai",
    root: id,
    parent: null,
    capabilities: {
      ...defaultCapabilitiesForModel(id),
      ...(local?.capabilities ?? {}),
      ...capabilitiesFromUpstream(model, id)
    },
    description:
      stringValue(model.description) ??
      stringValue(model.display_name) ??
      stringValue(model.name) ??
      local?.description ??
      id,
    family: local?.family ?? (id.startsWith("GLM-5") ? "GLM-5" : "GLM-4"),
    aliases: uniqueStrings([...(local?.aliases ?? []), rawId, `z.ai/${id}`, `z.ai.${id}`]),
    ...(maxTokens ? { context_length: maxTokens, max_tokens: maxTokens } : {}),
    source: "upstream" as const
  };
}

function defaultCapabilitiesForModel(id: string): Record<string, boolean> {
  return {
    chat: true,
    streaming: true,
    reasoning: id.includes("GLM-5"),
    tools: true,
    vision: /V(?:-|$)/.test(id) || id.includes("4.6V") || id.includes("5V"),
    web_search: true,
    image_generation: false,
    agentic_tasks: id.includes("GLM-5"),
    openai_chat_completions: true,
    chat_completions: true,
    prompt_cache_key: true,
    parallel_tool_calls: true,
    interleaved_reasoning: false
  };
}

function capabilitiesFromUpstream(model: Record<string, unknown>, id: string): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {};
  const containers = [
    model.capabilities,
    model.features,
    model.tags,
    getNested(model, ["info", "capabilities"]),
    getNested(model, ["info", "features"]),
    getNested(model, ["info", "meta", "capabilities"]),
    getNested(model, ["info", "meta", "features"]),
    getNested(model, ["meta", "capabilities"]),
    getNested(model, ["meta", "features"])
  ];

  for (const container of containers) {
    mergeCapabilities(capabilities, container);
  }

  if (capabilities.vlm_tools) {
    capabilities.vision = true;
  }
  if (capabilities.agent_mode) {
    capabilities.agentic_tasks = true;
  }
  if (capabilities.think) {
    capabilities.reasoning = true;
  }
  if (id.includes("5V") || id.includes("4.6V")) {
    capabilities.vision = true;
  }
  return capabilities;
}

function mergeCapabilities(target: Record<string, boolean>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      const key = capabilityKey(item);
      if (key) {
        target[key] = true;
      }
    }
    return;
  }
  if (typeof value === "string") {
    const key = capabilityKey(value);
    if (key) {
      target[key] = true;
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = capabilityKey(rawKey);
    if (!key) {
      continue;
    }
    target[key] = typeof rawValue === "boolean" ? rawValue : Boolean(rawValue);
  }
}

function capabilityKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["think", "thinking", "reasoning"].includes(key)) return key === "think" ? "think" : "reasoning";
  if (["vision", "vlm", "vlm_tools", "image_input"].includes(key)) return key === "vlm" ? "vision" : key;
  if (["web_search", "search", "browser_search"].includes(key)) return "web_search";
  if (["agent_mode", "agentic", "agentic_tasks"].includes(key)) return key === "agentic" ? "agentic_tasks" : key;
  if (["file_qa", "mcp", "citations", "tools", "parallel_tool_calls"].includes(key)) return key;
  return key.startsWith("enable_") ? key.slice("enable_".length) : key;
}

function modelMaxTokens(model: Record<string, unknown>): number | null {
  const candidates = [
    model.max_tokens,
    model.context_length,
    model.max_context_length,
    model.max_input_tokens,
    getNested(model, ["info", "max_tokens"]),
    getNested(model, ["info", "context_length"]),
    getNested(model, ["info", "meta", "max_tokens"]),
    getNested(model, ["info", "meta", "context_length"])
  ];
  for (const candidate of candidates) {
    const value = numberValue(candidate);
    if (value) {
      return value;
    }
  }
  return null;
}

function mergeModels(upstreamModels: typeof OPENAI_MODELS): typeof OPENAI_MODELS {
  const byId = new Map<string, (typeof OPENAI_MODELS)[number]>();
  for (const model of OPENAI_MODELS) byId.set(model.id, model);
  for (const model of upstreamModels) byId.set(model.id, model);
  return [...byId.values()];
}

function getNested(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))];
}

function metadataString(metadata: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!metadata) {
    return null;
  }
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function conversationRawKey(request: ChatCompletionRequest): string {
  const metadataKey = metadataString(request.metadata, [
    "conversation_id",
    "thread_id",
    "session_id",
    "chat_id"
  ]);
  return (
    request.zai?.conversation_key ??
    request.prompt_cache_key ??
    metadataKey ??
    request.previous_response_id ??
    request.user ??
    "default"
  );
}

function sanitizeConversationKey(value: string): string {
  return value.trim().slice(0, 160).replace(/[^a-zA-Z0-9_.:@/-]+/g, "_") || "default";
}

function normalizeModelId(model: string): string {
  return canonicalModelId(model || config.zai.defaultModel) || config.zai.defaultModel;
}

function shouldRetryWithFreshChat(error: unknown, request: ChatCompletionRequest, captchaSolved = false): boolean {
  if (captchaSolved || request.zai?.fresh_chat_retry || request.zai?.force_new_chat || request.zai?.captcha_verify_param) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /INTERNAL_ERROR|Oops, something went wrong/i.test(message);
}

function shouldSolveCaptchaBeforeCompletion(model: string, request: ChatCompletionRequest): boolean {
  if (typeof request.zai?.frontend_captcha === "boolean") {
    return request.zai.frontend_captcha;
  }
  return canonicalModelId(model) === "GLM-5.2";
}

function withCaptcha(request: ChatCompletionRequest, captcha: string): ChatCompletionRequest {
  return {
    ...request,
    zai: {
      ...request.zai,
      captcha_verify_param: captcha
    }
  };
}

function upstreamParentMessageId(event: unknown): string | null {
  const paths = [
    ["data", "response_id"],
    ["data", "message_id"],
    ["data", "id"],
    ["response_id"],
    ["message_id"],
    ["id"],
    ["data", "data", "response_id"],
    ["data", "data", "message_id"],
    ["data", "data", "id"]
  ];
  for (const path of paths) {
    const value = nestedString(event, path);
    if (value && looksLikeMessageId(value)) {
      return value;
    }
  }
  return null;
}

function nestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function looksLikeMessageId(value: string): boolean {
  if (!value.trim()) return false;
  if (/^(chatcmpl|resp|req|chat)_/i.test(value)) return false;
  return /^[a-zA-Z0-9_.:-]{8,160}$/.test(value);
}

function publicConversationKey(value: string): string {
  const parts = value.split(":");
  return parts.length > 2 ? parts.slice(1).join(":") : value;
}
