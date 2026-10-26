import { AppConfig } from "../config.ts";

export type ModelTier = "fast" | "deep";

export interface MultimodalImageInput {
  mimeType: string;
  base64Data: string;
}

export interface LlmCallResult {
  text: string;
  modelUsed: string;
  tierUsed: ModelTier;
  searchQueries?: string[];
  sources?: Array<{ title: string; uri: string }>;
}

export interface ResolvedModelEndpoint {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as Record<string, any>;
  const code = typeof anyErr.code === "string" ? anyErr.code : "";
  if (
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "EPIPE",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
  ) {
    return true;
  }
  const name = typeof anyErr.name === "string" ? anyErr.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }
  const msg = String(anyErr.message || err);
  return /(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket connection was closed|unable to connect|fetch failed|network error|timed? ?out)/i.test(
    msg
  );
}

export async function fetchWithTransientRetry(
  url: string,
  initFactory: () => RequestInit,
  options?: { maxAttempts?: number; baseDelayMs?: number; retryHttpStatuses?: boolean }
): Promise<Response> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const retryHttpStatuses = options?.retryHttpStatuses ?? true;
  const defaultDelay =
    process.env.WECHAT_CTX_TEST_ISOLATION === "1" || process.env.WXCTX_TEST_ROOT
      ? 10
      : 600;
  const baseDelayMs = options?.baseDelayMs ?? defaultDelay;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, initFactory());
      if (
        retryHttpStatuses &&
        attempt < maxAttempts &&
        TRANSIENT_HTTP_STATUSES.has(resp.status)
      ) {
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return resp;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isTransientNetworkError(err)) {
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || "LLM request failed after retries"));
}

export function getFastModel(config: AppConfig): string {
  return config.llm.fastModel || config.llm.model || "gemini-2.5-flash";
}

export function getProModel(config: AppConfig): string {
  const configured = config.llm.proModel || "gemini-2.5-pro";
  if (
    configured === "gemini-pro" &&
    config.llm.baseUrl.includes("generativelanguage.googleapis.com")
  ) {
    return "gemini-2.5-pro";
  }
  return configured;
}

export function resolveModelEndpoint(
  config: AppConfig,
  tier: ModelTier
): ResolvedModelEndpoint {
  const model = tier === "deep" ? getProModel(config) : getFastModel(config);
  const explicitProviderId =
    tier === "deep" ? config.llm.proProvider : config.llm.fastProvider;
  const providers = config.llm.providers ?? [];

  if (explicitProviderId) {
    const matched = providers.find(
      (p) => p.id === explicitProviderId && p.apiKey
    );
    if (matched) {
      const explicitTierModel =
        tier === "deep" ? config.llm.proModel : config.llm.fastModel;
      const resolvedModel =
        explicitTierModel ||
        (matched.models.includes(model) ? model : matched.models[0] || model);
      return {
        providerId: matched.id,
        baseUrl: matched.baseUrl,
        apiKey: matched.apiKey,
        model: resolvedModel,
      };
    }
  }

  const byModelList = providers.find(
    (p) => p.apiKey && p.models.includes(model)
  );
  if (byModelList) {
    return {
      providerId: byModelList.id,
      baseUrl: byModelList.baseUrl,
      apiKey: byModelList.apiKey,
      model,
    };
  }

  return {
    providerId: config.llm.provider || "custom",
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    model,
  };
}

/**
 * Unified Two-Tier LLM Client:
 * - tier = "fast" -> fastModel (intent recognition, quick capture, OCR, simple Q&A)
 * - tier = "deep" -> proModel (complex synthesis, deep article critique, multi-step reasoning)
 * Supports cross-provider routing (e.g., fastModel on Gemini + proModel on DeepSeek)
 * and automatic fallback from proModel to fastModel if the upstream gateway rejects proModel.
 */
export async function callAgentLlm(params: {
  config: AppConfig;
  tier: ModelTier;
  systemPrompt: string;
  userPrompt: string;
  images?: MultimodalImageInput[];
  jsonMode?: boolean;
  enableWebSearch?: boolean;
  temperature?: number;
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  const { config, tier } = params;
  const primaryEndpoint = resolveModelEndpoint(config, tier);
  const fastEndpoint = resolveModelEndpoint(config, "fast");

  if (!primaryEndpoint.apiKey && !fastEndpoint.apiKey && !config.llm.apiKey) {
    throw new Error("LLM_API_KEY is not configured");
  }

  const invokeEndpoint = async (
    ep: ResolvedModelEndpoint,
    usedTier: ModelTier
  ): Promise<LlmCallResult> => {
    const effectiveBaseUrl = ep.baseUrl || config.llm.baseUrl;
    const effectiveApiKey = ep.apiKey || config.llm.apiKey;
    if (!effectiveApiKey) {
      throw new Error(`API Key is not configured for provider ${ep.providerId}`);
    }

    const hasFastFallback =
      usedTier === "deep" &&
      (primaryEndpoint.model !== fastEndpoint.model ||
        primaryEndpoint.baseUrl !== fastEndpoint.baseUrl);

    if (
      params.enableWebSearch &&
      !params.jsonMode &&
      effectiveBaseUrl.includes("generativelanguage.googleapis.com")
    ) {
      return executeGeminiGroundedSearchCall({
        ...params,
        baseUrl: effectiveBaseUrl,
        apiKey: effectiveApiKey,
        model: ep.model,
        tierUsed: usedTier,
        retryHttpStatuses: !hasFastFallback,
      });
    }
    const text = await executeOpenAICompatibleCall({
      ...params,
      baseUrl: effectiveBaseUrl,
      apiKey: effectiveApiKey,
      model: ep.model,
      retryHttpStatuses: !hasFastFallback,
    });
    return { text, modelUsed: ep.model, tierUsed: usedTier };
  };

  try {
    return await invokeEndpoint(primaryEndpoint, tier);
  } catch (err: any) {
    if (
      tier === "deep" &&
      (primaryEndpoint.model !== fastEndpoint.model ||
        primaryEndpoint.baseUrl !== fastEndpoint.baseUrl)
    ) {
      console.warn(
        `[LLM] Pro model (${primaryEndpoint.model}) failed (${err?.message || err}); falling back to fast model (${fastEndpoint.model})`
      );
      const fallbackRes = await invokeEndpoint(fastEndpoint, "fast");
      return {
        ...fallbackRes,
        modelUsed: `${fastEndpoint.model} (fallback from ${primaryEndpoint.model})`,
      };
    }
    throw err;
  }
}

async function executeGeminiGroundedSearchCall(params: {
  config: AppConfig;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  tierUsed: ModelTier;
  systemPrompt: string;
  userPrompt: string;
  images?: MultimodalImageInput[];
  temperature?: number;
  timeoutMs?: number;
  retryHttpStatuses?: boolean;
}): Promise<LlmCallResult> {
  const nativeBase = (params.baseUrl || params.config.llm.baseUrl)
    .replace(/\/+$/, "")
    .replace(/\/openai$/, "");
  const cleanModel = params.model.replace(/^models\//, "");
  const endpoint = `${nativeBase}/models/${cleanModel}:generateContent?key=${encodeURIComponent(
    params.apiKey || params.config.llm.apiKey
  )}`;

  const resp = await fetchWithTransientRetry(
    endpoint,
    () => ({
      method: "POST",
      signal: AbortSignal.timeout(params.timeoutMs ?? 60_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: params.systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: params.userPrompt },
              ...(params.images || []).map(img => ({
                inlineData: { mimeType: img.mimeType, data: img.base64Data },
              })),
            ],
          },
        ],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: params.temperature ?? 0.25,
        },
      }),
    }),
    { retryHttpStatuses: params.retryHttpStatuses }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `Gemini Grounded Search HTTP ${resp.status} (${cleanModel}): ${errText.slice(0, 300)}`
    );
  }

  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        webSearchQueries?: string[];
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      };
    }>;
  };

  const candidate = data.candidates?.[0];
  const text =
    candidate?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim() || "";
  if (!text) {
    throw new Error(`Empty response from Gemini Grounded Search (${cleanModel})`);
  }

  const searchQueries = candidate?.groundingMetadata?.webSearchQueries ?? [];
  const sources: Array<{ title: string; uri: string }> = [];
  const seenTitles = new Set<string>();
  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    const title = chunk.web?.title?.trim();
    const uri = chunk.web?.uri?.trim();
    if (title && uri && !seenTitles.has(title)) {
      seenTitles.add(title);
      sources.push({ title, uri });
    }
  }

  return {
    text,
    modelUsed: `${cleanModel} + GoogleSearch`,
    tierUsed: params.tierUsed,
    searchQueries,
    sources,
  };
}

async function executeOpenAICompatibleCall(params: {
  config: AppConfig;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  images?: MultimodalImageInput[];
  jsonMode?: boolean;
  temperature?: number;
  timeoutMs?: number;
  retryHttpStatuses?: boolean;
}): Promise<string> {
  const endpoint = `${(params.baseUrl || params.config.llm.baseUrl).replace(/\/+$/, "")}/chat/completions`;

  const userContent: any =
    params.images && params.images.length > 0
      ? [
          { type: "text", text: params.userPrompt },
          ...params.images.map((img) => ({
            type: "image_url",
            image_url: {
              url: `data:${img.mimeType};base64,${img.base64Data}`,
            },
          })),
        ]
      : params.userPrompt;

  const body: Record<string, any> = {
    model: params.model,
    temperature: params.temperature ?? 0.2,
    messages: [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  const sendRequest = (useJsonObjectFormat: boolean) => {
    const reqBody: Record<string, any> = {
      ...body,
      ...(useJsonObjectFormat ? { response_format: { type: "json_object" } } : {}),
    };
    if (!useJsonObjectFormat) {
      delete reqBody.response_format;
    }
    return fetchWithTransientRetry(
      endpoint,
      () => ({
        method: "POST",
        signal: AbortSignal.timeout(params.timeoutMs ?? 60_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey || params.config.llm.apiKey}`,
        },
        body: JSON.stringify(reqBody),
      }),
      { retryHttpStatuses: params.retryHttpStatuses }
    );
  };

  let resp = await sendRequest(Boolean(params.jsonMode));
  if (params.jsonMode && resp.status === 400) {
    resp = await sendRequest(false);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM HTTP ${resp.status} (${params.model}): ${errText.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Empty response from LLM (${params.model})`);
  }
  return content.trim();
}

export function parseJsonSafe<T = any>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned) as T;
}
