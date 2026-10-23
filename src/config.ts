import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type LlmProviderId =
  | "gemini"
  | "deepseek"
  | "opencode"
  | "openai"
  | "openrouter"
  | "dashscope"
  | "siliconflow"
  | "moonshot"
  | "zhipu"
  | "anthropic"
  | "custom";

export interface LlmProviderPreset {
  id: LlmProviderId;
  name: string;
  envKeyName: string;
  altEnvKeyNames?: string[];
  baseUrl: string;
  defaultModel: string;
  defaultFastModel: string;
  defaultProModel: string;
  defaultModels: string[];
  description: string;
}

export interface ConfiguredLlmProvider {
  id: string;
  name: string;
  envKeyName: string;
  apiKey: string;
  apiKeySource?: string;
  baseUrl: string;
  models: string[];
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: "gemini",
    name: "Google Gemini (AI Studio / OpenAI 兼容)",
    envKeyName: "GEMINI_API_KEY",
    altEnvKeyNames: ["GOOGLE_API_KEY"],
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    defaultFastModel: "gemini-2.5-flash",
    defaultProModel: "gemini-2.5-pro",
    defaultModels: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
    ],
    description: "原生支持 Google Search 实时联网 Grounding 与多模态视觉理解",
  },
  {
    id: "deepseek",
    name: "DeepSeek (深度求索官方 API)",
    envKeyName: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    defaultFastModel: "deepseek-chat",
    defaultProModel: "deepseek-reasoner",
    defaultModels: [
      "deepseek-chat",
      "deepseek-reasoner",
    ],
    description: "高性价比中文深度提纯与 R1 推理模型（deepseek-chat / deepseek-reasoner）",
  },
  {
    id: "opencode",
    name: "OpenCode Go / Zen (OpenCode 官方模型网关)",
    envKeyName: "OPENCODE_API_KEY",
    altEnvKeyNames: ["OPENCODE_GO_API_KEY"],
    baseUrl: "https://opencode.ai/zen/v1",
    defaultModel: "glm-5.1",
    defaultFastModel: "glm-5.1",
    defaultProModel: "claude-sonnet-4-5",
    defaultModels: [
      "glm-5.1",
      "kimi-k2.5",
      "minimax-m2.5",
      "claude-sonnet-4-5",
      "deepseek-r1",
      "gpt-4o",
    ],
    description: "兼容 OpenCode Go / Zen 订阅 Key（支持 glm-5.1、kimi-k2.5、minimax-m2.5、claude 等）",
  },
  {
    id: "openai",
    name: "OpenAI 官方 API",
    envKeyName: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    defaultFastModel: "gpt-4o-mini",
    defaultProModel: "gpt-4o",
    defaultModels: [
      "gpt-4o-mini",
      "gpt-4o",
      "gpt-4.1-mini",
      "gpt-4.1",
      "o3-mini",
      "o4-mini",
    ],
    description: "标准 OpenAI 接口（gpt-4o-mini / gpt-4o / o3-mini）",
  },
  {
    id: "openrouter",
    name: "OpenRouter (全球模型聚合网关)",
    envKeyName: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemini-2.5-flash",
    defaultFastModel: "google/gemini-2.5-flash",
    defaultProModel: "anthropic/claude-3.7-sonnet",
    defaultModels: [
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "anthropic/claude-3.7-sonnet",
      "deepseek/deepseek-chat-v3-0324",
      "deepseek/deepseek-r1",
      "openai/gpt-4o-mini",
    ],
    description: "一个 Key 任意调用 Claude、Gemini、DeepSeek、Llama 等全系模型",
  },
  {
    id: "dashscope",
    name: "阿里云百炼 / 通义千问 (DashScope)",
    envKeyName: "DASHSCOPE_API_KEY",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    defaultFastModel: "qwen-plus",
    defaultProModel: "qwen-max",
    defaultModels: [
      "qwen-plus",
      "qwen-max",
      "qwen-turbo",
      "qwq-plus",
      "deepseek-v3",
      "deepseek-r1",
    ],
    description: "阿里云百炼 OpenAI 兼容接口（qwen-plus / qwen-max / qwq-plus）",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow (硅基流动)",
    envKeyName: "SILICONFLOW_API_KEY",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    defaultFastModel: "deepseek-ai/DeepSeek-V3",
    defaultProModel: "deepseek-ai/DeepSeek-R1",
    defaultModels: [
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Pro/deepseek-ai/DeepSeek-V3",
      "Pro/deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen2.5-72B-Instruct",
    ],
    description: "国内高速推理网关（DeepSeek-V3 / DeepSeek-R1 / Qwen）",
  },
  {
    id: "moonshot",
    name: "Moonshot AI (Kimi 开放平台)",
    envKeyName: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2-0711-preview",
    defaultFastModel: "kimi-k2-0711-preview",
    defaultProModel: "kimi-thinking-preview",
    defaultModels: [
      "kimi-k2-0711-preview",
      "kimi-thinking-preview",
      "moonshot-v1-auto",
      "moonshot-v1-128k",
    ],
    description: "Kimi 长文本与深度思考模型接口",
  },
  {
    id: "zhipu",
    name: "智谱开放平台 (BigModel / GLM)",
    envKeyName: "ZHIPU_API_KEY",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    defaultFastModel: "glm-4-flash",
    defaultProModel: "glm-4-plus",
    defaultModels: [
      "glm-4-flash",
      "glm-4-plus",
      "glm-4-air",
      "glm-z1-air",
    ],
    description: "智谱 GLM 系列模型接口（glm-4-flash / glm-4-plus）",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude (OpenAI 兼容层)",
    envKeyName: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-5-haiku-latest",
    defaultFastModel: "claude-3-5-haiku-latest",
    defaultProModel: "claude-3-7-sonnet-latest",
    defaultModels: [
      "claude-3-5-haiku-latest",
      "claude-3-7-sonnet-latest",
      "claude-sonnet-4-20250514",
    ],
    description: "Anthropic 官方 OpenAI 兼容端点",
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容网关 / 本地 Ollama",
    envKeyName: "LLM_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    defaultFastModel: "gpt-4o-mini",
    defaultProModel: "gpt-4o",
    defaultModels: [
      "gpt-4o-mini",
      "gpt-4o",
    ],
    description: "任意支持 /v1/chat/completions 的自建网关、OneAPI、NewAPI 或本地 Ollama",
  },
];

export interface CustomCliAgentConfig {
  id: string;
  name: string;
  binaryPath: string;
  argsTemplate?: string; // e.g. 'run --dir {{WORKDIR}} {{PROMPT}}'
}

export type VaultMode = "standalone" | "generic_folder" | "structured_vault";

export interface AppConfig {
  projectRoot: string;
  dataDir: string;
  dbPath: string;
  vaultRoot: string;
  vaultEnabled?: boolean;
  vaultMode?: VaultMode;
  wechatArticlesDir: string;
  webArticlesDir?: string;
  inboxDir?: string;
  papersDir?: string;
  ideasSeedsDir: string;
  vaultLayout?: {
    nowFile: string;
    queueFile: string;
    topicsFile: string;
    searchDirs: string[];
    domainKeywords: string[];
  };
  port: number;
  annotationWaitSeconds: number;
  taskHeartbeatSeconds?: number;
  allowJinaFallback?: boolean;
  notifyWebhookUrl?: string;
  notifyWebhookSecret?: string;
  notifyWebhookKeyword?: string;
  notifyOnEvents?: string[];
  llm: {
    provider?: LlmProviderId;
    apiKey: string;
    apiKeySource?: string;
    baseUrl: string;
    model: string;
    fastModel?: string;
    fastProvider?: string;
    proModel?: string;
    proProvider?: string;
    providers?: ConfiguredLlmProvider[];
    allowCodexFallback: boolean;
    cliRoutingChain?: string[];
    customCliAgents?: CustomCliAgentConfig[];
  };
}

export function expandHomePath(inputPath: string, baseDir?: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) return baseDir ? resolve(baseDir) : process.cwd();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  if (isAbsolute(trimmed)) return resolve(trimmed);
  return baseDir ? resolve(baseDir, trimmed) : resolve(trimmed);
}

export function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export function loadProjectDotEnv(projectRoot: string): Record<string, string> {
  return parseDotEnvFile(join(projectRoot, ".env"));
}

/**
 * Save or update key-value pairs in the project's `.env` file while preserving comments
 * and removing keys explicitly set to `null` or `undefined`.
 */
export function saveProjectDotEnv(
  projectRoot: string,
  updates: Record<string, string | null | undefined>
): string {
  const envPath = join(projectRoot, ".env");
  const examplePath = join(projectRoot, ".env.example");
  let baseContent = "";
  if (existsSync(envPath)) {
    baseContent = readFileSync(envPath, "utf-8");
  } else if (existsSync(examplePath)) {
    baseContent = readFileSync(examplePath, "utf-8");
  }

  const lines = baseContent ? baseContent.split(/\r?\n/) : [];
  const handledKeys = new Set<string>();
  const outLines: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      outLines.push(rawLine);
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) {
      outLines.push(rawLine);
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      handledKeys.add(key);
      const newVal = updates[key];
      if (newVal === null || newVal === undefined) {
        // Delete this key
        continue;
      }
      outLines.push(`${key}=${formatEnvValue(newVal)}`);
    } else {
      outLines.push(rawLine);
    }
  }

  for (const [key, val] of Object.entries(updates)) {
    if (handledKeys.has(key) || val === null || val === undefined) continue;
    const cleanKey = key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) continue;
    outLines.push(`${cleanKey}=${formatEnvValue(val)}`);
  }

  const finalContent = outLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  writeFileSync(envPath, finalContent, "utf-8");
  return envPath;
}

function formatEnvValue(val: string): string {
  const clean = String(val ?? "").replace(/\r?\n/g, " ").trim();
  if (/[\s#"']/.test(clean)) {
    return JSON.stringify(clean);
  }
  return clean;
}

export interface DetectedProviderKeyInfo {
  providerId: LlmProviderId;
  envKeyName: string;
  apiKey: string;
  source: string;
}

function readConfigSources(projectRoot: string, customEnv?: Record<string, string | undefined>, skipProject = false): Array<[Record<string, string | undefined>, string]> {
  const project = skipProject ? {} : parseDotEnvFile(join(projectRoot, ".env"));
  const runtime = customEnv ?? process.env;
  const ignoreHome = (runtime.IGNORE_HOME_DOTENV || project.IGNORE_HOME_DOTENV || "").toLowerCase() === "true";
  const home = ignoreHome ? {} : parseDotEnvFile(join(homedir(), ".env"));
  const projectSource: [Record<string, string | undefined>, string] = [project, "项目 .env"];
  const runtimeSource: [Record<string, string | undefined>, string] = [runtime, "环境变量"];
  return [...(customEnv ? [runtimeSource, projectSource] : [projectSource, runtimeSource]), [home, "全局 ~/.env"]];
}

function lookupConfigValue(sources: Array<[Record<string, string | undefined>, string]>, key: string, defaultValue = ""): {value: string; source: string} {
  for (const [values, label] of sources) {
    if (values[key] !== undefined && values[key] !== "") return {value: values[key]!, source: `${label} (${key})`};
  }
  return {value: defaultValue, source: ""};
}

export function resolveDetectedProviderKeys(projectRootOverride?: string): Record<string, DetectedProviderKeyInfo> {
  const sources = readConfigSources(projectRootOverride ? resolve(projectRootOverride) : resolve(import.meta.dir, ".."));
  const out: Record<string, DetectedProviderKeyInfo> = {};
  for (const preset of LLM_PROVIDER_PRESETS) {
    for (const key of [preset.envKeyName, ...(preset.altEnvKeyNames ?? [])].filter(Boolean)) {
      const found = lookupConfigValue(sources, key);
      if (found.value) {
        out[preset.id] = {providerId: preset.id, envKeyName: key, apiKey: found.value, source: found.source};
        break;
      }
    }
  }
  return out;
}

export function loadConfig(
  customEnv?: Record<string, string | undefined>,
  projectRootOverride?: string
): AppConfig {
  const projectRoot = projectRootOverride
    ? resolve(projectRootOverride)
    : resolve(import.meta.dir, "..");
  const sources = readConfigSources(projectRoot, customEnv, Boolean(customEnv && !projectRootOverride));
  const getWithSource = (key: string, defaultVal = "") => lookupConfigValue(sources, key, defaultVal);

  const get = (key: string, defaultVal = ""): string =>
    getWithSource(key, defaultVal).value;

  const heartbeatSecondsRaw = get("TASK_HEARTBEAT_SECONDS", "").trim();
  const heartbeatLegacyRaw = get("TASK_HEARTBEAT_MS", "").trim();
  const heartbeatValue = heartbeatSecondsRaw !== ""
    ? Number(heartbeatSecondsRaw)
    : heartbeatLegacyRaw !== "" ? Number(heartbeatLegacyRaw) / 1000 : 25;
  const taskHeartbeatSeconds = Number.isFinite(heartbeatValue) && heartbeatValue >= 0 && heartbeatValue <= 2_147_483.647
    ? heartbeatValue : 25;

  const explicitProvider = get("LLM_PROVIDER", "").toLowerCase() as LlmProviderId | "";
  const getPresetKey = (
    preset: LlmProviderPreset
  ): { value: string; source: string } => {
    const primary = getWithSource(preset.envKeyName);
    if (primary.value) return primary;
    for (const alt of preset.altEnvKeyNames ?? []) {
      const val = getWithSource(alt);
      if (val.value) return val;
    }
    return { value: "", source: "" };
  };

  let activePreset: LlmProviderPreset | undefined;
  const directLlmKey = getWithSource("LLM_API_KEY");
  let llmApiKey = directLlmKey.value;
  let llmApiKeySource = directLlmKey.source;

  if (explicitProvider && explicitProvider !== "custom") {
    activePreset = LLM_PROVIDER_PRESETS.find((p) => p.id === explicitProvider);
    if (activePreset && !llmApiKey) {
      const pk = getPresetKey(activePreset);
      llmApiKey = pk.value;
      llmApiKeySource = pk.source;
    }
  }

  // If no explicit provider or key yet, auto-detect across all supported provider env vars
  if (!llmApiKey) {
    const autoDetectOrder: LlmProviderId[] = [
      "openai",
      "deepseek",
      "opencode",
      "gemini",
      "openrouter",
      "dashscope",
      "siliconflow",
      "moonshot",
      "zhipu",
      "anthropic",
    ];
    for (const pid of autoDetectOrder) {
      const preset = LLM_PROVIDER_PRESETS.find((p) => p.id === pid)!;
      const foundKey = getPresetKey(preset);
      if (foundKey.value) {
        llmApiKey = foundKey.value;
        llmApiKeySource = foundKey.source;
        if (!activePreset) activePreset = preset;
        break;
      }
    }
  }

  const defaultBaseUrl = activePreset?.baseUrl || "https://api.openai.com/v1";
  let llmBaseUrl = get("LLM_BASE_URL", defaultBaseUrl);
  if (activePreset?.id === "openai" && !get("LLM_BASE_URL") && get("OPENAI_BASE_URL")) {
    llmBaseUrl = get("OPENAI_BASE_URL", llmBaseUrl);
  }

  const llmModel = get("LLM_MODEL", activePreset?.defaultModel || "gpt-4o-mini");

  // Infer provider from baseUrl / model if not explicitly matched
  if (!activePreset) {
    activePreset = LLM_PROVIDER_PRESETS.find(
      (p) => p.id !== "custom" && llmBaseUrl.includes(new URL(p.baseUrl).hostname)
    );
  }

  const isGeminiProvider =
    activePreset?.id === "gemini" ||
    llmBaseUrl.includes("generativelanguage.googleapis.com") ||
    llmModel.startsWith("gemini-");

  const defaultProModel = activePreset
    ? activePreset.defaultProModel
    : isGeminiProvider
      ? "gemini-2.5-pro"
      : llmModel;

  const rawFastModelInput = get(
    "LLM_FAST_MODEL",
    llmModel || activePreset?.defaultFastModel || "gemini-2.5-flash"
  );
  const rawProModelInput = get("LLM_PRO_MODEL", defaultProModel);

  const parseProviderModelSpec = (
    rawSpec: string,
    explicitProv: string
  ): { providerId: string; model: string } => {
    if (rawSpec.includes("::")) {
      const idx = rawSpec.indexOf("::");
      const p = rawSpec.slice(0, idx).trim();
      const m = rawSpec.slice(idx + 2).trim();
      if (p && m) return { providerId: p, model: m };
    }
    return { providerId: explicitProv.trim(), model: rawSpec.trim() };
  };

  const parsedFast = parseProviderModelSpec(
    rawFastModelInput,
    get("LLM_FAST_PROVIDER", "")
  );
  const parsedPro = parseProviderModelSpec(
    rawProModelInput,
    get("LLM_PRO_PROVIDER", "")
  );
  const fastModel = parsedFast.model;
  const proModel = parsedPro.model;

  // Build multi-provider connection list (from LLM_PROVIDERS_CONFIG + auto-detected provider keys)
  const configuredProviders: ConfiguredLlmProvider[] = [];
  const seenProviderIds = new Set<string>();
  const rawProvidersJson = get("LLM_PROVIDERS_CONFIG", "");
  if (rawProvidersJson) {
    try {
      const parsedList = JSON.parse(rawProvidersJson);
      if (Array.isArray(parsedList)) {
        for (const item of parsedList) {
          if (!item || typeof item.id !== "string") continue;
          const pid = item.id.trim();
          if (!pid || seenProviderIds.has(pid)) continue;
          const preset = LLM_PROVIDER_PRESETS.find((p) => p.id === pid);
          const envKeyName =
            (typeof item.envKeyName === "string" && item.envKeyName.trim()) ||
            preset?.envKeyName ||
            `${pid.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_API_KEY`;

          let keyInfo = getWithSource(envKeyName);
          if (!keyInfo.value && preset) {
            keyInfo = getPresetKey(preset);
          }
          if (
            !keyInfo.value &&
            pid === (activePreset?.id || explicitProvider || "custom") &&
            directLlmKey.value
          ) {
            keyInfo = directLlmKey;
          }

          const rawModels: string[] = Array.isArray(item.models)
            ? item.models.map((m: unknown) => String(m || "").trim()).filter(Boolean)
            : [];
          const mergedModels: string[] = Array.from(
            new Set<string>(rawModels.length > 0 ? rawModels : preset?.defaultModels || [])
          );

          configuredProviders.push({
            id: pid,
            name:
              (typeof item.name === "string" && item.name.trim()) ||
              preset?.name ||
              pid,
            envKeyName,
            apiKey: keyInfo.value,
            apiKeySource: keyInfo.source,
            baseUrl: (
              (typeof item.baseUrl === "string" && item.baseUrl.trim()) ||
              preset?.baseUrl ||
              llmBaseUrl
            ).replace(/\/+$/, ""),
            models: mergedModels,
          });
          seenProviderIds.add(pid);
        }
      }
    } catch {}
  }

  // Also include any built-in provider that has an API key present in env
  for (const preset of LLM_PROVIDER_PRESETS) {
    if (preset.id === "custom" || seenProviderIds.has(preset.id)) continue;
    const pk = getPresetKey(preset);
    if (pk.value) {
      const customBaseUrl =
        preset.id === (activePreset?.id || explicitProvider) && get("LLM_BASE_URL")
          ? get("LLM_BASE_URL")
          : preset.baseUrl;
      configuredProviders.push({
        id: preset.id,
        name: preset.name,
        envKeyName: preset.envKeyName,
        apiKey: pk.value,
        apiKeySource: pk.source,
        baseUrl: customBaseUrl.replace(/\/+$/, ""),
        models: [...preset.defaultModels],
      });
      seenProviderIds.add(preset.id);
    }
  }

  // Ensure the primary/active provider is always represented in configuredProviders
  const primaryProviderId =
    activePreset?.id || (explicitProvider as LlmProviderId) || "custom";
  if (!seenProviderIds.has(primaryProviderId)) {
    const preset =
      LLM_PROVIDER_PRESETS.find((p) => p.id === primaryProviderId) ||
      LLM_PROVIDER_PRESETS[LLM_PROVIDER_PRESETS.length - 1]!;
    configuredProviders.unshift({
      id: primaryProviderId,
      name: preset.name,
      envKeyName: preset.envKeyName,
      apiKey: llmApiKey,
      apiKeySource: llmApiKeySource,
      baseUrl: llmBaseUrl.replace(/\/+$/, ""),
      models: [...preset.defaultModels],
    });
    seenProviderIds.add(primaryProviderId);
  }

  const inferProviderForModel = (
    modelName: string,
    explicitPid: string
  ): string => {
    if (explicitPid && seenProviderIds.has(explicitPid)) return explicitPid;
    const byModelList = configuredProviders.find((p) =>
      p.models.includes(modelName)
    );
    if (byModelList) return byModelList.id;
    return configuredProviders[0]?.id || primaryProviderId;
  };

  const fastProvider = inferProviderForModel(fastModel, parsedFast.providerId);
  const proProvider = inferProviderForModel(proModel, parsedPro.providerId);

  // Ensure fastModel and proModel are present in their respective provider's models list
  for (const [pid, mName] of [
    [fastProvider, fastModel],
    [proProvider, proModel],
  ] as const) {
    const targetProv = configuredProviders.find((p) => p.id === pid);
    if (targetProv && mName && !targetProv.models.includes(mName)) {
      targetProv.models.unshift(mName);
    }
  }

  // Sync primary llm.apiKey and llm.baseUrl with fastProvider if primary wasn't explicitly overridden
  const fastProvObj = configuredProviders.find((p) => p.id === fastProvider);
  if (fastProvObj && !directLlmKey.value && fastProvObj.apiKey) {
    llmApiKey = fastProvObj.apiKey;
    llmApiKeySource = fastProvObj.apiKeySource || "";
    if (!get("LLM_BASE_URL")) {
      llmBaseUrl = fastProvObj.baseUrl;
    }
  }

  const dataDir = expandHomePath(
    get("WECHAT_CONTEXT_DATA_DIR", join(projectRoot, "data")),
    projectRoot
  );
  const rawVaultRoot = get("VAULT_ROOT", join(projectRoot, "vault")).trim();
  const explicitVaultDisabled =
    ["false", "0", "no", "off", "none"].includes(
      get("VAULT_ENABLED", "").trim().toLowerCase()
    ) ||
    ["none", "false", "standalone", "off"].includes(
      rawVaultRoot.toLowerCase()
    );

  const vaultRoot = explicitVaultDisabled
    ? join(dataDir, "archive")
    : expandHomePath(rawVaultRoot || join(projectRoot, "vault"), projectRoot);

  const hasStructuredVaultMarkers =
    !explicitVaultDisabled &&
    existsSync(vaultRoot) &&
    (existsSync(join(vaultRoot, "00_home")) ||
      existsSync(join(vaultRoot, "AGENTS.md")) ||
      existsSync(join(vaultRoot, "04_topics")));

  const vaultMode: VaultMode = explicitVaultDisabled
    ? "standalone"
    : hasStructuredVaultMarkers
      ? "structured_vault"
      : existsSync(vaultRoot)
        ? "generic_folder"
        : "standalone";
  const vaultEnabled = vaultMode !== "standalone";

  const resolveInVault = (
    envKey: string,
    defaultStructuredRelPath: string,
    defaultStandaloneRelPath?: string
  ): string => {
    if (explicitVaultDisabled && defaultStandaloneRelPath) {
      return expandHomePath(defaultStandaloneRelPath, vaultRoot);
    }
    const configured = get(envKey, defaultStructuredRelPath);
    return expandHomePath(configured, vaultRoot);
  };

  const searchDirsRaw = get("VAULT_SEARCH_DIRS", "");
  const searchDirs = searchDirsRaw
    ? searchDirsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const domainKeywordsRaw = get("VAULT_DOMAIN_KEYWORDS", "");
  const domainKeywords = domainKeywordsRaw
    ? domainKeywordsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const cliRoutingChainRaw = get(
    "CLI_ROUTING_CHAIN",
    "agy,codex,opencode,claude,gemini"
  );
  const cliRoutingChain = cliRoutingChainRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let customCliAgents: CustomCliAgentConfig[] = [];
  const customCliRaw = get("CUSTOM_CLI_AGENTS", "");
  if (customCliRaw) {
    try {
      const parsed = JSON.parse(customCliRaw);
      if (Array.isArray(parsed)) {
        customCliAgents = parsed.filter(
          (item) => item && typeof item.id === "string" && typeof item.binaryPath === "string"
        );
      }
    } catch {}
  }

  return {
    projectRoot,
    dataDir,
    dbPath: join(dataDir, "wechat_context.db"),
    vaultRoot,
    vaultEnabled,
    vaultMode,
    wechatArticlesDir: resolveInVault(
      "VAULT_WECHAT_DIR",
      join("01_inputs", "articles", "wechat"),
      "wechat"
    ),
    webArticlesDir: resolveInVault(
      "VAULT_WEB_DIR",
      join("01_inputs", "articles", "web"),
      "web"
    ),
    inboxDir: resolveInVault("VAULT_INBOX_DIR", join("01_inputs", "inbox"), "inbox"),
    papersDir: resolveInVault("VAULT_PAPERS_DIR", join("01_inputs", "papers"), "papers"),
    ideasSeedsDir: resolveInVault("VAULT_IDEAS_DIR", join("03_ideas", "seeds"), "ideas"),
    vaultLayout: {
      nowFile: get("VAULT_NOW_FILE", join("00_home", "now.md")),
      queueFile: get("VAULT_QUEUE_FILE", join("00_home", "queue.md")),
      topicsFile: get("VAULT_TOPICS_FILE", join("00_home", "topics.md")),
      searchDirs,
      domainKeywords,
    },
    port: Number(get("PORT", "8787")) || 8787,
    allowJinaFallback: get("ALLOW_JINA_FALLBACK", "false").toLowerCase() === "true",
    annotationWaitSeconds:
      Number(get("ANNOTATION_WAIT_SECONDS", "10")) >= 0
        ? Number(get("ANNOTATION_WAIT_SECONDS", "10"))
        : 10,
    taskHeartbeatSeconds,
    notifyWebhookUrl: get("NOTIFY_WEBHOOK_URL", "").trim(),
    notifyWebhookSecret: get("NOTIFY_WEBHOOK_SECRET", "").trim(),
    notifyWebhookKeyword: get("NOTIFY_WEBHOOK_KEYWORD", "").trim(),
    notifyOnEvents: get("NOTIFY_ON_EVENTS", "article,idea,plan")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    llm: {
      provider: activePreset?.id || (explicitProvider as LlmProviderId) || "custom",
      apiKey: llmApiKey,
      apiKeySource: llmApiKeySource,
      baseUrl: llmBaseUrl.replace(/\/+$/, ""),
      model: llmModel,
      fastModel,
      fastProvider,
      proModel,
      proProvider,
      providers: configuredProviders,
      allowCodexFallback:
        get("ALLOW_CODEX_FALLBACK", "true").toLowerCase() !== "false",
      cliRoutingChain,
      customCliAgents,
    },
  };
}

/**
 * Compute DingTalk custom robot HMAC-SHA256 signature (`timestamp + "\n" + secret` -> Base64 -> urlEncode).
 */
export function computeDingTalkWebhookSign(
  timestampMs: number,
  secret: string
): string {
  const stringToSign = `${timestampMs}\n${secret}`;
  const hmacBase64 = createHmac("sha256", secret)
    .update(stringToSign, "utf8")
    .digest("base64");
  return encodeURIComponent(hmacBase64);
}

/**
 * Compute Feishu/Lark custom bot HMAC-SHA256 signature (`"${timestampSec}\n${secret}"` as HMAC key, empty msg -> Base64).
 */
export function computeFeishuWebhookSign(
  timestampSec: number,
  secret: string
): string {
  const stringToSign = `${timestampSec}\n${secret}`;
  return createHmac("sha256", stringToSign).update("").digest("base64");
}

/**
 * Send an outbound webhook notification (DingTalk / Feishu / WeCom Bot / Generic JSON)
 * when `NOTIFY_WEBHOOK_URL` is configured and `eventType` is enabled in `NOTIFY_ON_EVENTS`.
 * Supports DingTalk `SEC...` URL signature (`NOTIFY_WEBHOOK_SECRET`) and custom security keyword (`NOTIFY_WEBHOOK_KEYWORD`).
 */
export async function notifyExternalWebhookIfConfigured(
  config: AppConfig,
  eventType: "article" | "idea" | "plan",
  title: string,
  summary: string
): Promise<boolean> {
  const rawUrl = config.notifyWebhookUrl?.trim();
  if (!rawUrl) return false;
  const enabledEvents = config.notifyOnEvents ?? ["article", "idea", "plan"];
  if (!enabledEvents.includes(eventType) && !enabledEvents.includes("all")) {
    return false;
  }

  const secret = config.notifyWebhookSecret?.trim() || "";
  const keyword = config.notifyWebhookKeyword?.trim() || "";
  const kwPrefix = keyword ? `[${keyword}] ` : "";
  const headerTitle = `${kwPrefix}【WeChat-as-Context · ${eventType.toUpperCase()}】${title}`.trim();
  const textBody = `${headerTitle}\n${summary}`.trim();

  let targetUrl = rawUrl;
  let payload: Record<string, unknown>;

  if (rawUrl.includes("dingtalk.com")) {
    if (secret) {
      const ts = Date.now();
      const sign = computeDingTalkWebhookSign(ts, secret);
      const sep = rawUrl.includes("?") ? "&" : "?";
      targetUrl = `${rawUrl}${sep}timestamp=${ts}&sign=${sign}`;
    }
    payload = {
      msgtype: "markdown",
      markdown: {
        title: headerTitle,
        text: `### ${headerTitle}\n\n${summary}`,
      },
    };
  } else if (rawUrl.includes("feishu.cn") || rawUrl.includes("larksuite.com")) {
    const feishuBody: Record<string, unknown> = {
      msg_type: "text",
      content: { text: textBody },
    };
    if (secret) {
      const tsSec = Math.floor(Date.now() / 1000);
      feishuBody.timestamp = String(tsSec);
      feishuBody.sign = computeFeishuWebhookSign(tsSec, secret);
    }
    payload = feishuBody;
  } else if (rawUrl.includes("qyapi.weixin.qq.com")) {
    payload = {
      msgtype: "markdown",
      markdown: { content: `**${headerTitle}**\n${summary}` },
    };
  } else {
    payload = {
      event: eventType,
      title: headerTitle,
      summary,
      text: textBody,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return false;
    try {
      const data = (await res.json()) as {
        errcode?: number;
        errmsg?: string;
        code?: number;
        msg?: string;
      };
      if (typeof data.errcode === "number" && data.errcode !== 0) {
        console.warn(
          `[Webhook] DingTalk/WeCom business error (errcode=${data.errcode}): ${data.errmsg}`
        );
        return false;
      }
      if (typeof data.code === "number" && data.code !== 0) {
        console.warn(
          `[Webhook] Feishu business error (code=${data.code}): ${data.msg}`
        );
        return false;
      }
    } catch {
      // Non-JSON 200 response from generic webhook is treated as success
    }
    return true;
  } catch {
    return false;
  }
}

export interface SkillsDirectoryHealth {
  exists: boolean;
  skillsDir: string;
  totalSkills: number;
  invalidSkillFiles: string[];
  heavyNodeModulesDirs: string[];
}

/**
 * Audit a Codex/Agent skills directory (e.g. ~/.codex/skills) for broken SKILL.md
 * YAML frontmatter or nested node_modules directories that can trip CLI directory scanners.
 */
export function auditSkillsDirectoryHealth(
  skillsDir?: string
): SkillsDirectoryHealth {
  if (
    !skillsDir &&
    !process.env.WXCTX_SKILLS_DIR &&
    (process.env.IGNORE_HOME_DOTENV || "").toLowerCase() === "true"
  ) {
    return {
      exists: false,
      skillsDir: "",
      totalSkills: 0,
      invalidSkillFiles: [],
      heavyNodeModulesDirs: [],
    };
  }
  const resolvedRoot = expandHomePath(
    skillsDir || process.env.WXCTX_SKILLS_DIR || join(homedir(), ".codex", "skills")
  );
  if (!existsSync(resolvedRoot)) {
    return {
      exists: false,
      skillsDir: resolvedRoot,
      totalSkills: 0,
      invalidSkillFiles: [],
      heavyNodeModulesDirs: [],
    };
  }

  let totalSkills = 0;
  const invalidSkillFiles: string[] = [];
  const heavyNodeModulesDirs: string[] = [];

  const scanDir = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (entry === "node_modules") {
        heavyNodeModulesDirs.push(full);
        continue;
      }
      if (entry === "SKILL.md") {
        totalSkills++;
        try {
          const head = readFileSync(full, "utf-8").slice(0, 4000);
          if (!/^---\r?\n[\s\S]+?\r?\n---(?:\r?\n|$)/.test(head)) {
            invalidSkillFiles.push(full);
          }
        } catch {
          invalidSkillFiles.push(full);
        }
        continue;
      }
      try {
        const subEntries = readdirSync(full);
        if (Array.isArray(subEntries)) {
          scanDir(full, depth + 1);
        }
      } catch {}
    }
  };

  scanDir(resolvedRoot, 0);
  return {
    exists: true,
    skillsDir: resolvedRoot,
    totalSkills,
    invalidSkillFiles,
    heavyNodeModulesDirs,
  };
}
