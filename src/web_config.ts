import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AppConfig,
  ConfiguredLlmProvider,
  CustomCliAgentConfig,
  DetectedProviderKeyInfo,
  expandHomePath,
  LLM_PROVIDER_PRESETS,
  loadConfig,
  loadProjectDotEnv,
  resolveDetectedProviderKeys,
  saveProjectDotEnv,
} from "./config.ts";
import { ContextDatabase } from "./db.ts";
import { WeChatContextPipeline } from "./pipeline.ts";
import { scanLocalAgentClis } from "./agent/subagent_cli.ts";
import { ensureStarterVaultInitialized } from "./vault/context.ts";

export interface VaultSubdirStatus {
  id: string;
  relPath: string;
  label: string;
  absPath: string;
  exists: boolean;
}

export function inspectVaultSubdirectories(
  vaultRootInput: string,
  projectRoot: string,
  wechatDirInput?: string,
  ideasDirInput?: string
): VaultSubdirStatus[] {
  const vaultRoot = expandHomePath(vaultRootInput || join(projectRoot, "vault"), projectRoot);
  const wechatDir = wechatDirInput
    ? expandHomePath(wechatDirInput, vaultRoot)
    : join(vaultRoot, "01_inputs", "articles", "wechat");
  const ideasDir = ideasDirInput
    ? expandHomePath(ideasDirInput, vaultRoot)
    : join(vaultRoot, "03_ideas", "seeds");

  const specs = [
    { id: "home", relPath: "00_home", label: "主线与队列", absPath: join(vaultRoot, "00_home") },
    { id: "wechat", relPath: "01_inputs/articles/wechat", label: "公众号文章", absPath: wechatDir },
    { id: "web", relPath: "01_inputs/articles/web", label: "外部网页", absPath: join(vaultRoot, "01_inputs", "articles", "web") },
    { id: "inbox", relPath: "01_inputs/inbox", label: "图文收集箱", absPath: join(vaultRoot, "01_inputs", "inbox") },
    { id: "ideas", relPath: "03_ideas/seeds", label: "灵感种子", absPath: ideasDir },
    { id: "topics", relPath: "04_topics", label: "主题笔记", absPath: join(vaultRoot, "04_topics") },
    { id: "plans", relPath: "05_outputs/plans", label: "深度方案", absPath: join(vaultRoot, "05_outputs", "plans") },
  ];

  return specs.map((s) => ({
    ...s,
    exists: existsSync(s.absPath),
  }));
}

export interface ConfigApiResponse {
  ok: boolean;
  envPath: string;
  vaultExists: boolean;
  vaultSubdirs: VaultSubdirStatus[];
  config: {
    projectRoot: string;
    port: number;
    vaultRoot: string;
    vaultMode?: string;
    vaultEnabled?: boolean;
    wechatArticlesDir: string;
    ideasSeedsDir: string;
    annotationWaitSeconds: number;
    taskHeartbeatSeconds: number;
    vaultLayout: AppConfig["vaultLayout"];
    llm: {
      provider: string;
      apiKey: string;
      apiKeySource: string;
      apiKeyConfigured: boolean;
      apiKeyMasked: string;
      baseUrl: string;
      model: string;
      fastModel: string;
      fastProvider: string;
      proModel: string;
      proProvider: string;
      providers: ConfiguredLlmProvider[];
      allowCodexFallback: boolean;
      cliRoutingChain: string[];
      customCliAgents: CustomCliAgentConfig[];
    };
  };
  detectedProviderKeys: Record<string, DetectedProviderKeyInfo>;
  envValues: Record<string, string>;
  providerPresets: typeof LLM_PROVIDER_PRESETS;
  discoveredClis: ReturnType<typeof scanLocalAgentClis>;
  clawbot: {
    configured: boolean;
    botId: string;
    baseUrl: string;
    savedAt: string;
    lastPoll: unknown;
  };
}

function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 4)}••••••${secret.slice(-4)}`;
}

export function buildConfigApiPayload(
  db: ContextDatabase,
  pipeline: WeChatContextPipeline
): ConfigApiResponse {
  const projectRoot = pipeline.config.projectRoot;
  const envPath = join(projectRoot, ".env");
  const dotEnv = loadProjectDotEnv(projectRoot);
  const freshConfig = loadConfig(undefined, projectRoot);
  pipeline.updateConfig(freshConfig);

  const discoveredClis = scanLocalAgentClis(freshConfig);
  const detectedProviderKeys = resolveDetectedProviderKeys(projectRoot);
  const creds = pipeline.clawbot.getCredentials();
  const lastPollRaw = db.getState("clawbot_last_poll");
  let lastPoll: unknown = null;
  if (lastPollRaw) {
    try {
      lastPoll = JSON.parse(lastPollRaw);
    } catch {
      lastPoll = lastPollRaw;
    }
  }

  const safeEnvValues: Record<string, string> = { ...dotEnv };

  return {
    ok: true,
    envPath,
    vaultExists: existsSync(freshConfig.vaultRoot),
    vaultSubdirs: inspectVaultSubdirectories(
      freshConfig.vaultRoot,
      projectRoot,
      freshConfig.wechatArticlesDir,
      freshConfig.ideasSeedsDir
    ),
    config: {
      projectRoot: freshConfig.projectRoot,
      port: freshConfig.port,
      vaultRoot: freshConfig.vaultRoot,
      vaultMode: freshConfig.vaultMode || "structured_vault",
      vaultEnabled: Boolean(freshConfig.vaultEnabled),
      wechatArticlesDir: freshConfig.wechatArticlesDir,
      ideasSeedsDir: freshConfig.ideasSeedsDir,
      annotationWaitSeconds: freshConfig.annotationWaitSeconds,
      taskHeartbeatSeconds: freshConfig.taskHeartbeatSeconds ?? 25,
      vaultLayout: freshConfig.vaultLayout,
      llm: {
        provider: freshConfig.llm.provider || "custom",
        apiKey: freshConfig.llm.apiKey || "",
        apiKeySource: freshConfig.llm.apiKeySource || "",
        apiKeyConfigured: Boolean(freshConfig.llm.apiKey),
        apiKeyMasked: maskSecret(freshConfig.llm.apiKey),
        baseUrl: freshConfig.llm.baseUrl,
        model: freshConfig.llm.model,
        fastModel: freshConfig.llm.fastModel || freshConfig.llm.model,
        fastProvider:
          freshConfig.llm.fastProvider || freshConfig.llm.provider || "custom",
        proModel: freshConfig.llm.proModel || freshConfig.llm.model,
        proProvider:
          freshConfig.llm.proProvider || freshConfig.llm.provider || "custom",
        providers: freshConfig.llm.providers || [],
        allowCodexFallback: freshConfig.llm.allowCodexFallback,
        cliRoutingChain: freshConfig.llm.cliRoutingChain || ["agy", "codex"],
        customCliAgents: freshConfig.llm.customCliAgents || [],
      },
    },
    detectedProviderKeys,
    envValues: safeEnvValues,
    providerPresets: LLM_PROVIDER_PRESETS,
    discoveredClis,
    clawbot: {
      configured: Boolean(creds),
      botId: creds?.botId || "",
      baseUrl: creds?.baseUrl || "",
      savedAt: creds?.savedAt || "",
      lastPoll,
    },
  };
}

export async function handleSaveConfigRequest(
  req: Request,
  db: ContextDatabase,
  pipeline: WeChatContextPipeline
): Promise<Response> {
  const projectRoot = pipeline.config.projectRoot;
  const contentType = req.headers.get("content-type") || "";
  let updates: Record<string, string | undefined> = {};
  let deletedKeys: string[] = [];
  let isFormSubmit = false;

  try {
    if (contentType.includes("application/json")) {
      const body = (await req.json()) as {
        updates?: Record<string, string | undefined>;
        deletedKeys?: string[];
      };
      updates = body.updates || {};
      deletedKeys = Array.isArray(body.deletedKeys) ? body.deletedKeys : [];
    } else {
      isFormSubmit = true;
      const formData = await req.formData();
      const cliChainItems: string[] = [];
      for (const [k, v] of formData.entries()) {
        if (typeof v !== "string") continue;
        if (k === "cli_chain_item") {
          cliChainItems.push(v);
        } else if (k.startsWith("env_key_")) {
          const idx = k.slice("env_key_".length);
          const val = formData.get(`env_val_${idx}`);
          if (v.trim() && typeof val === "string") {
            updates[v.trim()] = val;
          }
        } else {
          updates[k] = v;
        }
      }
      if (cliChainItems.length > 0 && !updates.CLI_ROUTING_CHAIN) {
        updates.CLI_ROUTING_CHAIN = cliChainItems.join(",");
      }
    }
  } catch (err: any) {
    return Response.json(
      { ok: false, error: `Invalid config payload: ${err?.message || err}` },
      { status: 400 }
    );
  }

  // If LLM_API_KEY was left blank in the UI and already exists in .env, preserve existing key unless explicitly cleared
  const currentDotEnv = loadProjectDotEnv(projectRoot);
  if (
    updates.LLM_API_KEY === "__KEEP_EXISTING__" ||
    (updates.LLM_API_KEY === "" &&
      !deletedKeys.includes("LLM_API_KEY") &&
      currentDotEnv.LLM_API_KEY)
  ) {
    delete updates.LLM_API_KEY;
  }

  for (const delKey of deletedKeys) {
    if (delKey && /^[A-Za-z_][A-Za-z0-9_]*$/.test(delKey)) {
      updates[delKey] = undefined;
    }
  }

  // Filter out non-env form helper fields
  const cleanUpdates: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      cleanUpdates[k] = v;
    }
  }

  // Also sync provider-specific env key (e.g. GEMINI_API_KEY, DEEPSEEK_API_KEY, OPENCODE_API_KEY) when LLM_API_KEY is updated
  if (cleanUpdates.LLM_PROVIDER && cleanUpdates.LLM_API_KEY) {
    const matchedPreset = LLM_PROVIDER_PRESETS.find(
      (p) => p.id === cleanUpdates.LLM_PROVIDER
    );
    if (
      matchedPreset &&
      matchedPreset.envKeyName &&
      matchedPreset.envKeyName !== "LLM_API_KEY" &&
      cleanUpdates[matchedPreset.envKeyName] === undefined
    ) {
      cleanUpdates[matchedPreset.envKeyName] = cleanUpdates.LLM_API_KEY;
    }
  }

  saveProjectDotEnv(projectRoot, cleanUpdates);

  const realProjectRoot = join(import.meta.dir, "..");
  if (projectRoot === realProjectRoot) {
    // Sync updated keys into process.env so loadConfig() immediately reflects changes
    for (const [k, v] of Object.entries(cleanUpdates)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  let newConfig = loadConfig(undefined, projectRoot);
  if (newConfig.vaultMode === "structured_vault") {
    ensureStarterVaultInitialized(newConfig);
    newConfig = loadConfig(undefined, projectRoot);
  } else if (newConfig.vaultMode === "generic_folder") {
    for (const dir of [
      newConfig.vaultRoot,
      newConfig.wechatArticlesDir,
      newConfig.ideasSeedsDir,
    ]) {
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  } else {
    for (const dir of [
      newConfig.vaultRoot,
      newConfig.wechatArticlesDir,
      newConfig.webArticlesDir,
      newConfig.inboxDir,
      newConfig.papersDir,
      newConfig.ideasSeedsDir,
    ]) {
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }
  pipeline.updateConfig(newConfig);

  if (isFormSubmit) {
    return new Response(null, {
      status: 303,
      headers: { Location: "/config?saved=1" },
    });
  }

  return Response.json({
    ...buildConfigApiPayload(db, pipeline),
    savedAt: new Date().toISOString(),
  });
}

export async function handleTestLlmConnection(
  req: Request,
  pipeline: WeChatContextPipeline
): Promise<Response> {
  try {
    const body = (await req.json()) as {
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };

    const dotEnv = loadProjectDotEnv(pipeline.config.projectRoot);
    const freshConfig = loadConfig({ ...process.env, ...dotEnv }, pipeline.config.projectRoot);

    let targetProvider = body.provider?.trim() || "";
    let rawModel = body.model?.trim() || "";
    if (rawModel.includes("::")) {
      const idx = rawModel.indexOf("::");
      if (!targetProvider) targetProvider = rawModel.slice(0, idx).trim();
      rawModel = rawModel.slice(idx + 2).trim();
    }

    const matchedProv = targetProvider
      ? freshConfig.llm.providers?.find((p) => p.id === targetProvider)
      : undefined;

    const apiKey =
      body.apiKey && body.apiKey !== "__KEEP_EXISTING__"
        ? body.apiKey.trim()
        : matchedProv?.apiKey || freshConfig.llm.apiKey;
    const baseUrl = (
      body.baseUrl ||
      matchedProv?.baseUrl ||
      freshConfig.llm.baseUrl ||
      ""
    ).replace(/\/+$/, "");
    const model =
      rawModel ||
      matchedProv?.models?.[0] ||
      freshConfig.llm.fastModel ||
      freshConfig.llm.model ||
      "gemini-2.5-flash";

    if (!apiKey) {
      return Response.json(
        {
          ok: false,
          error: "未提供 API Key（请先输入 API Key 或保存后再测试）",
        },
        { status: 400 }
      );
    }
    if (!baseUrl) {
      return Response.json(
        { ok: false, error: "未提供 Base URL" },
        { status: 400 }
      );
    }

    const endpoint = `${baseUrl}/chat/completions`;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: "Reply with a short greeting in 10 words or fewer.",
            },
          ],
          max_tokens: 32,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startedAt;
      const rawText = await res.text();
      if (!res.ok) {
        return Response.json(
          {
            ok: false,
            latencyMs,
            endpoint,
            model,
            error: `HTTP ${res.status}: ${rawText.slice(0, 300)}`,
          },
          { status: 200 }
        );
      }

      let replySample = rawText.slice(0, 160);
      try {
        const parsed = JSON.parse(rawText);
        replySample =
          parsed?.choices?.[0]?.message?.content?.trim() || replySample;
      } catch {}

      return Response.json({
        ok: true,
        latencyMs,
        endpoint,
        model,
        replySample,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    return Response.json(
      {
        ok: false,
        error: err?.message || String(err),
      },
      { status: 200 }
    );
  }
}

export async function handleFetchProviderModels(
  req: Request,
  pipeline: WeChatContextPipeline
): Promise<Response> {
  try {
    const body = (await req.json()) as {
      providerId?: string;
      apiKey?: string;
      baseUrl?: string;
    };

    const projectRoot = pipeline.config.projectRoot;
    const dotEnv = loadProjectDotEnv(projectRoot);
    const freshConfig = loadConfig({ ...process.env, ...dotEnv }, projectRoot);
    const detectedKeys = resolveDetectedProviderKeys(projectRoot);

    const providerId = body.providerId?.trim() || "";
    const matchedProv = freshConfig.llm.providers?.find(
      (p) => p.id === providerId
    );
    const effectiveApiKey =
      body.apiKey?.trim() ||
      matchedProv?.apiKey ||
      (providerId && detectedKeys[providerId]?.apiKey) ||
      freshConfig.llm.apiKey ||
      "";
    const cleanBaseUrl = (
      body.baseUrl?.trim() ||
      matchedProv?.baseUrl ||
      freshConfig.llm.baseUrl ||
      ""
    ).replace(/\/+$/, "");

    if (!cleanBaseUrl) {
      return Response.json(
        { ok: false, error: "未提供 API Base URL" },
        { status: 400 }
      );
    }

    const isLocalhost =
      cleanBaseUrl.includes("127.0.0.1") || cleanBaseUrl.includes("localhost");
    if (!effectiveApiKey && !isLocalhost) {
      return Response.json(
        {
          ok: false,
          error: "请先在该供应商卡片中填写 API Key，然后再拉取模型列表",
        },
        { status: 200 }
      );
    }

    const endpoint = `${cleanBaseUrl}/models`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (effectiveApiKey) {
      headers.Authorization = `Bearer ${effectiveApiKey}`;
    }

    const res = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    const rawText = await res.text();
    if (!res.ok) {
      return Response.json(
        {
          ok: false,
          endpoint,
          error: `HTTP ${res.status}: ${rawText.slice(0, 240)}`,
        },
        { status: 200 }
      );
    }

    const parsed = JSON.parse(rawText) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ name?: string; id?: string }>;
    };
    const rawList: string[] = [];
    if (Array.isArray(parsed.data)) {
      for (const item of parsed.data) {
        if (item && typeof item.id === "string") {
          rawList.push(item.id.replace(/^models\//, "").trim());
        }
      }
    } else if (Array.isArray(parsed.models)) {
      for (const item of parsed.models) {
        const rawId = item?.id || item?.name;
        if (typeof rawId === "string") {
          rawList.push(rawId.replace(/^models\//, "").trim());
        }
      }
    }

    const filteredModels = Array.from(
      new Set(
        rawList.filter(
          (id) =>
            id &&
            !/(embedding|whisper|tts|dall-e|babbage|davinci|moderation|aqa|imagen|veo)/i.test(
              id
            )
        )
      )
    );

    return Response.json({
      ok: true,
      endpoint,
      models: filteredModels,
    });
  } catch (err: any) {
    return Response.json(
      {
        ok: false,
        error: err?.message || String(err),
      },
      { status: 200 }
    );
  }
}

export async function handlePickDirectoryRequest(
  req: Request,
  pipeline: WeChatContextPipeline
): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      prompt?: string;
    };
    const safePrompt = (body.prompt || "请选择本地知识库文件夹").replace(/["\\]/g, "");
    let selectedPath = "";

    if (process.platform === "darwin") {
      const res = spawnSync(
        "osascript",
        ["-e", `POSIX path of (choose folder with prompt "${safePrompt}")`],
        { encoding: "utf-8", timeout: 120_000 }
      );
      if (res.status !== 0 || !res.stdout?.trim()) {
        return Response.json({ ok: false, cancelled: true });
      }
      selectedPath = res.stdout.trim();
    } else if (process.platform === "win32") {
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '${safePrompt}'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }`;
      const res = spawnSync("powershell", ["-NoProfile", "-Command", psScript], {
        encoding: "utf-8",
        timeout: 120_000,
      });
      if (res.status !== 0 || !res.stdout?.trim()) {
        return Response.json({ ok: false, cancelled: true });
      }
      selectedPath = res.stdout.trim();
    } else {
      const zenityRes = spawnSync(
        "zenity",
        ["--file-selection", "--directory", `--title=${safePrompt}`],
        { encoding: "utf-8", timeout: 120_000 }
      );
      if (zenityRes.status === 0 && zenityRes.stdout?.trim()) {
        selectedPath = zenityRes.stdout.trim();
      } else {
        return Response.json({
          ok: false,
          error: "当前系统环境不支持图形文件夹选择器，请直接在输入框中填写路径",
        });
      }
    }

    const cleanPath =
      selectedPath.length > 1 ? selectedPath.replace(/\/+$/, "") : selectedPath;
    const defaultWechatDir = join(cleanPath, "01_inputs", "articles", "wechat");
    const defaultIdeasDir = join(cleanPath, "03_ideas", "seeds");

    return Response.json({
      ok: true,
      path: cleanPath,
      defaultWechatDir,
      defaultIdeasDir,
      vaultExists: existsSync(cleanPath),
      vaultSubdirs: inspectVaultSubdirectories(
        cleanPath,
        pipeline.config.projectRoot,
        defaultWechatDir,
        defaultIdeasDir
      ),
    });
  } catch (err: any) {
    return Response.json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}

export async function handleInitVaultRequest(
  req: Request,
  pipeline: WeChatContextPipeline
): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      vaultRoot?: string;
      wechatArticlesDir?: string;
      ideasSeedsDir?: string;
      nowFile?: string;
      inspectOnly?: boolean;
    };

    const projectRoot = pipeline.config.projectRoot;
    const vaultRoot = expandHomePath(
      body.vaultRoot?.trim() || pipeline.config.vaultRoot,
      projectRoot
    );
    const wechatArticlesDir = body.wechatArticlesDir?.trim()
      ? expandHomePath(body.wechatArticlesDir.trim(), vaultRoot)
      : join(vaultRoot, "01_inputs", "articles", "wechat");
    const ideasSeedsDir = body.ideasSeedsDir?.trim()
      ? expandHomePath(body.ideasSeedsDir.trim(), vaultRoot)
      : join(vaultRoot, "03_ideas", "seeds");
    const nowFile = body.nowFile?.trim() || "00_home/now.md";

    const tempConfig: AppConfig = {
      ...pipeline.config,
      vaultRoot,
      wechatArticlesDir,
      webArticlesDir: join(vaultRoot, "01_inputs", "articles", "web"),
      inboxDir: join(vaultRoot, "01_inputs", "inbox"),
      papersDir: join(vaultRoot, "01_inputs", "papers"),
      ideasSeedsDir,
      vaultLayout: {
        nowFile,
        queueFile: pipeline.config.vaultLayout?.queueFile || "00_home/queue.md",
        topicsFile: pipeline.config.vaultLayout?.topicsFile || "00_home/topics.md",
        searchDirs: pipeline.config.vaultLayout?.searchDirs || [],
        domainKeywords: pipeline.config.vaultLayout?.domainKeywords || [],
      },
    };

    const result = body.inspectOnly
      ? { createdDirs: [], skippedDirs: [], createdFiles: [], skippedFiles: [] }
      : ensureStarterVaultInitialized(tempConfig);
    const vaultSubdirs = inspectVaultSubdirectories(
      vaultRoot,
      projectRoot,
      wechatArticlesDir,
      ideasSeedsDir
    );

    return Response.json({
      ok: true,
      vaultRoot,
      wechatArticlesDir,
      ideasSeedsDir,
      nowFile,
      createdDirs: result.createdDirs,
      skippedDirs: result.skippedDirs,
      createdFiles: result.createdFiles,
      skippedFiles: result.skippedFiles,
      vaultExists: existsSync(vaultRoot),
      vaultSubdirs,
    });
  } catch (err: any) {
    return Response.json(
      {
        ok: false,
        error: err?.message || String(err),
      },
      { status: 400 }
    );
  }
}

export function renderConfigPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- MANDATORY: Declare support for both light and dark themes -->
  <meta name="color-scheme" content="light dark">
  <title>wechat-as-context · 配置与智能体路由工作台</title>
  <style>
    /* MANDATORY: Apply color-scheme to :root or html for viewport-wide theming */
    :root {
      --bg-canvas-light: #f6f8fc;
      --bg-canvas-dark: #0f141c;
      --bg-surface-light: #ffffff;
      --bg-surface-dark: #171f2c;
      --bg-subtle-light: #eef2f9;
      --bg-subtle-dark: #1f293a;
      --text-primary-light: #141b26;
      --text-primary-dark: #e9eef7;
      --text-secondary-light: #4b5565;
      --text-secondary-dark: #9ba7b8;
      --border-color-light: #cbd5e1;
      --border-color-dark: #2e3c52;
      --brand-accent-light: #0b57d0;
      --brand-accent-dark: #66b2ff;
      --brand-accent-text-light: #ffffff;
      --brand-accent-text-dark: #081221;
      --danger-light: #d93025;
      --danger-dark: #ff8980;
      --danger-bg-light: #fce8e6;
      --danger-bg-dark: #3b1818;
      --success-light: #188038;
      --success-dark: #6dd58c;
      --success-bg-light: #e6f4ea;
      --success-bg-dark: #143321;
      --scrollbar-track-light: #eef2f9;
      --scrollbar-track-dark: #171f2c;
      --scrollbar-thumb-light: #94a3b8;
      --scrollbar-thumb-dark: #475569;

      --bg-canvas: var(--bg-canvas-light);
      --bg-surface: var(--bg-surface-light);
      --bg-subtle: var(--bg-subtle-light);
      --text-primary: var(--text-primary-light);
      --text-secondary: var(--text-secondary-light);
      --border-color: var(--border-color-light);
      --accent-color: var(--brand-accent-light);
      --accent-text: var(--brand-accent-text-light);
      --danger-color: var(--danger-light);
      --danger-bg: var(--danger-bg-light);
      --success-color: var(--success-light);
      --success-bg: var(--success-bg-light);
      --scrollbar-track: var(--scrollbar-track-light);
      --scrollbar-thumb: var(--scrollbar-thumb-light);

      /* MANDATORY: Fallback for browsers without light-dark support */
      @media (prefers-color-scheme: dark) {
        --bg-canvas: var(--bg-canvas-dark);
        --bg-surface: var(--bg-surface-dark);
        --bg-subtle: var(--bg-subtle-dark);
        --text-primary: var(--text-primary-dark);
        --text-secondary: var(--text-secondary-dark);
        --border-color: var(--border-color-dark);
        --accent-color: var(--brand-accent-dark);
        --accent-text: var(--brand-accent-text-dark);
        --danger-color: var(--danger-dark);
        --danger-bg: var(--danger-bg-dark);
        --success-color: var(--success-dark);
        --success-bg: var(--success-bg-dark);
        --scrollbar-track: var(--scrollbar-track-dark);
        --scrollbar-thumb: var(--scrollbar-thumb-dark);
      }

      /* OPTIONAL: use light-dark() for more control of built-in UI colors */
      @supports (color: light-dark(white, black)) {
        --bg-canvas: light-dark(var(--bg-canvas-light), var(--bg-canvas-dark));
        --bg-surface: light-dark(var(--bg-surface-light), var(--bg-surface-dark));
        --bg-subtle: light-dark(var(--bg-subtle-light), var(--bg-subtle-dark));
        --text-primary: light-dark(var(--text-primary-light), var(--text-primary-dark));
        --text-secondary: light-dark(var(--text-secondary-light), var(--text-secondary-dark));
        --border-color: light-dark(var(--border-color-light), var(--border-color-dark));
        --accent-color: light-dark(var(--brand-accent-light), var(--brand-accent-dark));
        --accent-text: light-dark(var(--brand-accent-text-light), var(--brand-accent-text-dark));
        --danger-color: light-dark(var(--danger-light), var(--danger-dark));
        --danger-bg: light-dark(var(--danger-bg-light), var(--danger-bg-dark));
        --success-color: light-dark(var(--success-light), var(--success-dark));
        --success-bg: light-dark(var(--success-bg-light), var(--success-bg-dark));
        --scrollbar-track: light-dark(var(--scrollbar-track-light), var(--scrollbar-track-dark));
        --scrollbar-thumb: light-dark(var(--scrollbar-thumb-light), var(--scrollbar-thumb-dark));
      }

      /* MANDATORY: Automatically adapt native UI to user system preferences */
      color-scheme: light dark;
      accent-color: var(--accent-color);
      scrollbar-width: thin;
      scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
    }

    @supports not (scrollbar-color: auto) {
      ::-webkit-scrollbar {
        width: 10px;
        height: 10px;
      }
      ::-webkit-scrollbar-thumb {
        background: var(--scrollbar-thumb);
      }
      ::-webkit-scrollbar-track {
        background: var(--scrollbar-track);
      }
    }

    pre, code {
      color-scheme: dark;
      /* Mandatory: any inherited color properties must be set again, even if to the same design tokens */
      accent-color: var(--accent-color);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      background-color: var(--bg-canvas);
      color: var(--text-primary);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      line-height: 1.55;
      font-size: 1rem;
    }

    .container {
      max-width: 1040px;
      margin-inline: auto;
      padding: 1.75rem 1.25rem 6.5rem;
    }

    header.page-header {
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 1.35rem 1.5rem;
      margin-block-end: 1.35rem;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
    }

    header.page-header h1 {
      margin: 0 0 0.35rem 0;
      font-size: 1.38rem;
      letter-spacing: -0.01em;
    }

    header.page-header p {
      margin: 0;
      color: var(--text-secondary);
      font-size: 0.9rem;
    }

    .header-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.6rem;
    }

    .status-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-block-start: 0.75rem;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.25rem 0.65rem;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
    }

    .badge.ok {
      background: var(--success-bg);
      color: var(--success-color);
      border-color: var(--success-color);
    }

    .badge.warn {
      background: var(--danger-bg);
      color: var(--danger-color);
      border-color: var(--danger-color);
    }

    fieldset {
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 1.35rem 1.5rem;
      margin-block-end: 1.35rem;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
    }

    legend {
      font-weight: 700;
      font-size: 1.08rem;
      padding-inline: 0.5rem;
    }

    .section-desc {
      margin-block: 0 1.1rem;
      color: var(--text-secondary);
      font-size: 0.88rem;
    }

    /* Gestalt Proximity Rule: vertical margin between label and input is smaller than margin between form-groups */
    .form-group {
      margin-block-end: 1.15rem;
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1rem;
    }

    @media (min-width: 720px) {
      .form-row.two-col {
        grid-template-columns: 1fr 1fr;
      }
    }

    label {
      display: inline-block;
      font-weight: 600;
      font-size: 0.92rem;
      padding: 8px 0;
      margin: -8px 0 0.2rem 0;
    }

    .hint {
      display: block;
      color: var(--text-secondary);
      font-size: 0.82rem;
      margin-block-end: 0.35rem;
    }

    .error-msg {
      display: none;
      color: var(--danger-color);
      font-size: 0.84rem;
      margin-block-start: 0.3rem;
    }

    input[type="text"],
    input[type="url"],
    input[type="password"],
    select,
    textarea {
      width: 100%;
      font-size: 0.95rem;
      padding: 0.65rem 0.85rem;
      min-height: 46px;
      border-radius: 10px;
      border: 1.5px solid var(--border-color);
      background-color: var(--bg-canvas);
      color: var(--text-primary);
      box-sizing: border-box;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    @media (pointer: coarse) {
      input[type="text"],
      input[type="url"],
      input[type="password"],
      select,
      button {
        min-height: 50px;
      }
    }

    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible,
    button:focus-visible,
    summary:focus-visible {
      outline: 3px solid var(--accent-color);
      outline-offset: 2px;
    }

    /* DO: Only show error styles after user interaction */
    input:user-invalid,
    input.user-invalid-fallback {
      border-color: var(--danger-color);
      background-color: var(--danger-bg);
    }

    input:user-invalid + .error-msg,
    input.user-invalid-fallback + .error-msg {
      display: block;
    }

    input:user-valid {
      border-color: var(--success-color);
    }

    .preset-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      margin-block-end: 1rem;
    }

    button {
      font-size: 0.9rem;
      font-weight: 600;
      min-height: 42px;
      padding: 0.5rem 0.95rem;
      border-radius: 10px;
      border: 1px solid var(--border-color);
      background-color: var(--bg-subtle);
      color: var(--text-primary);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.38rem;
      transition: all 0.15s ease;
    }

    button:hover:not(:disabled) {
      border-color: var(--accent-color);
      filter: brightness(0.98);
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    button.primary {
      background-color: var(--accent-color);
      color: var(--accent-text);
      border-color: var(--accent-color);
      box-shadow: 0 2px 8px rgba(11, 87, 208, 0.22);
    }

    button.preset-pill {
      min-height: 36px;
      padding: 0.32rem 0.78rem;
      font-size: 0.84rem;
      border-radius: 999px;
      background: var(--bg-canvas);
    }

    button.preset-pill.ready-pill {
      border-color: var(--success-color);
      background: var(--success-bg);
      color: var(--success-color);
    }

    button.preset-pill.active {
      background-color: var(--accent-color);
      color: var(--accent-text);
      border-color: var(--accent-color);
      box-shadow: 0 2px 6px rgba(11, 87, 208, 0.25);
    }

    .password-wrapper {
      display: flex;
      gap: 0.45rem;
      align-items: stretch;
    }

    .password-wrapper input {
      flex: 1;
    }

    .providers-stack {
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      margin-block-end: 1.25rem;
    }

    .provider-card {
      border: 1.5px solid var(--border-color);
      border-radius: 14px;
      padding: 1.1rem 1.2rem;
      background: var(--bg-canvas);
      transition: border-color 0.15s ease;
    }

    .provider-card.ready {
      border-color: var(--accent-color);
    }

    .provider-card-header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 0.65rem;
      margin-block-end: 0.85rem;
      padding-block-end: 0.65rem;
      border-bottom: 1px solid var(--border-color);
    }

    .provider-card-title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.45rem;
      font-weight: 700;
      font-size: 0.98rem;
    }

    .provider-card-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
    }

    .provider-card-actions button {
      min-height: 34px;
      padding: 0.28rem 0.68rem;
      font-size: 0.8rem;
      border-radius: 8px;
    }

    .provider-models-box {
      margin-block-start: 0.75rem;
      padding: 0.75rem 0.9rem;
      border-radius: 10px;
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
    }

    .model-chips-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin-block: 0.45rem 0.65rem;
    }

    .model-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.22rem 0.6rem;
      border-radius: 999px;
      font-size: 0.8rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
    }

    .model-chip button.chip-remove {
      min-height: 20px;
      padding: 0 0.3rem;
      font-size: 0.78rem;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      border-radius: 999px;
    }

    .model-chip button.chip-remove:hover {
      background: var(--danger-bg);
      color: var(--danger-color);
    }

    .add-model-inline {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      align-items: center;
    }

    .add-model-inline input[type="text"] {
      flex: 1;
      min-width: 180px;
      min-height: 36px;
      padding: 0.35rem 0.7rem;
      font-size: 0.85rem;
    }

    .add-model-inline button {
      min-height: 36px;
      padding: 0.32rem 0.75rem;
      font-size: 0.82rem;
    }

    /* Branded Customizable Select & Rich Media Picker */
    select.custom-select,
    select.custom-select::picker(select) {
      appearance: base-select;
    }

    select.custom-select {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-height: 48px;
      padding: 0.6rem 0.9rem;
      background-color: var(--bg-surface);
      border: 1.5px solid var(--border-color);
      border-radius: 10px;
      color: var(--text-primary);
      font-size: 0.94rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
    }

    select.custom-select > button {
      all: unset;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      flex: 1;
      min-width: 0;
      cursor: pointer;
    }

    select.custom-select selectedcontent {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }

    select.custom-select:hover {
      border-color: var(--accent-color);
    }

    select.custom-select::picker-icon {
      color: var(--text-secondary);
    }

    select.custom-select::picker(select) {
      background-color: var(--bg-surface);
      color: var(--text-primary);
      border: 1.5px solid var(--border-color);
      border-radius: 12px;
      padding: 0.5rem;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
      width: anchor-size(width);
      max-height: 340px;
      overflow-y: auto;
    }

    select.custom-select optgroup {
      font-weight: 700;
      font-size: 0.8rem;
      color: var(--text-secondary);
      padding: 0.45rem 0.5rem 0.25rem;
    }

    select.custom-select option {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 0.55rem;
      padding: 0.52rem 0.7rem;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.9rem;
      color: var(--text-primary);
    }

    select.custom-select option:hover {
      background-color: var(--bg-subtle);
    }

    select.custom-select option::before {
      display: none;
    }

    select.custom-select option::checkmark {
      display: none;
    }

    /* MANDATORY: Provide multiple visual indicators (background color + bold title) for checked option */
    select.custom-select option:checked {
      background-color: var(--accent-color);
      color: var(--accent-text);
      font-weight: 700;
    }

    select.custom-select option:checked .option-title {
      font-weight: 700;
    }

    select.custom-select option:checked .option-provider-pill {
      background: rgba(255, 255, 255, 0.22);
      color: var(--accent-text);
      border-color: transparent;
    }

    .option-row-main {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }

    .option-provider-pill {
      display: inline-block;
      padding: 0.14rem 0.5rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .option-title {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .model-routing-panel {
      background: var(--bg-subtle);
      border: 1.5px solid var(--border-color);
      border-radius: 14px;
      padding: 1.15rem 1.25rem;
      margin-block-start: 0.5rem;
    }

    .model-routing-panel h3 {
      margin: 0 0 0.25rem 0;
      font-size: 1rem;
    }

    .tier-model-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 1rem 1.1rem;
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }

    .tier-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }

    .tier-card-header label {
      margin: 0;
      padding: 0;
      font-size: 0.94rem;
    }

    .tier-card-header button {
      min-height: 30px;
      padding: 0.2rem 0.6rem;
      font-size: 0.78rem;
      border-radius: 6px;
    }

    .route-endpoint-tag {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
      margin-block-start: 0.25rem;
      font-size: 0.8rem;
      color: var(--text-secondary);
    }

    .cli-grid {
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
      margin-block-end: 1.1rem;
    }

    .cli-card {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.65rem;
      padding: 0.8rem 0.95rem;
      border-radius: 12px;
      border: 1.5px solid var(--border-color);
      background: var(--bg-canvas);
    }

    .cli-card.selected {
      border-color: var(--accent-color);
      background: var(--bg-subtle);
    }

    .cli-card-main {
      display: flex;
      align-items: flex-start;
      gap: 0.7rem;
      flex: 1;
      min-width: 200px;
    }

    .cli-card-main input[type="checkbox"] {
      width: 1.2rem;
      height: 1.2rem;
      margin-top: 0.18rem;
      cursor: pointer;
    }

    .cli-title {
      font-weight: 700;
      font-size: 0.93rem;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
    }

    .cli-meta {
      font-size: 0.78rem;
      color: var(--text-secondary);
      margin-top: 0.2rem;
      word-break: break-all;
    }

    .cli-actions {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    .cli-actions button {
      min-height: 32px;
      padding: 0.22rem 0.55rem;
      font-size: 0.78rem;
      border-radius: 6px;
    }

    .routing-preview {
      padding: 0.75rem 1rem;
      border-radius: 10px;
      background: var(--bg-subtle);
      border: 1px dashed var(--border-color);
      margin-block-end: 1rem;
      font-size: 0.86rem;
    }

    details.advanced-disclosure {
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 1rem 1.35rem;
      margin-block-end: 1.35rem;
    }

    details.advanced-disclosure summary {
      font-weight: 700;
      font-size: 1rem;
      cursor: pointer;
      padding: 0.25rem 0;
    }

    .env-table {
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
      margin-block: 0.85rem 1rem;
    }

    .env-row {
      display: grid;
      grid-template-columns: 1.15fr 1.6fr auto;
      gap: 0.55rem;
      align-items: start;
      padding: 0.45rem 0.6rem;
      border-radius: 10px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
    }

    .env-key-cell {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .env-key-desc {
      font-size: 0.75rem;
      color: var(--text-secondary);
      padding-inline-start: 0.2rem;
    }

    .adv-presets-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.45rem;
      margin-block: 0.5rem 0.65rem;
    }

    @media (max-width: 640px) {
      .env-row {
        grid-template-columns: 1fr;
      }
    }

    .sticky-footer {
      position: sticky;
      bottom: 0.85rem;
      z-index: 40;
      background: var(--bg-surface);
      border: 1.5px solid var(--border-color);
      border-radius: 14px;
      padding: 0.75rem 1.15rem;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 0.85rem;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
      backdrop-filter: blur(12px);
    }

    .visually-hidden {
      position: absolute;
      clip-path: inset(50%);
      overflow: hidden;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      border: 0;
      white-space: nowrap;
    }

    .toast-banner {
      padding: 0.85rem 1.1rem;
      border-radius: 10px;
      margin-block-end: 1.25rem;
      font-weight: 600;
      display: none;
    }

    .toast-banner.show {
      display: block;
    }

    .toast-banner.ok {
      background: var(--success-bg);
      color: var(--success-color);
      border: 1px solid var(--success-color);
    }

    .toast-banner.err {
      background: var(--danger-bg);
      color: var(--danger-color);
      border: 1px solid var(--danger-color);
    }

    .header-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.55rem;
    }

    .provider-tabs-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-block-end: 0.45rem;
    }

    .provider-models-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .test-result-banner {
      margin-block-start: 0.65rem;
      font-size: 0.86rem;
      font-weight: 600;
      min-height: 1.25rem;
    }

    .test-result-banner.ok {
      color: var(--success-color);
    }

    .test-result-banner.err {
      color: var(--danger-color);
    }

    .test-result-banner.pending {
      color: var(--text-secondary);
    }

    .cli-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-block-end: 0.85rem;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .custom-cli-drawer {
      border-top: 1px solid var(--border-color);
      padding-top: 0.75rem;
      margin-top: 0.5rem;
    }

    .vault-subdirs-box {
      margin-block: 0.5rem 0.75rem;
      padding: 0.7rem 0.9rem;
      border-radius: 10px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }

    .vault-subdirs-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.5rem;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text-secondary);
    }

    details.sub-disclosure summary {
      font-weight: 600;
      font-size: 0.88rem;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0.25rem 0;
    }

    details.sub-disclosure[open] summary {
      color: var(--text-primary);
      margin-block-end: 0.75rem;
    }

    .footer-meta {
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="page-header">
      <div>
        <h1>⚙️ wechat-as-context 配置中心</h1>
        <p>管理模型密钥、本机 Agent CLI 优先级与本地知识库路径</p>
        <div class="status-strip" id="status-strip" aria-live="polite">
          <span class="badge">加载中...</span>
        </div>
      </div>
      <div class="header-actions">
        <button type="button" id="reload-config-btn">🔄 刷新</button>
        <button type="submit" form="config-form" class="primary">💾 保存配置</button>
      </div>
    </header>

    <div id="toast-banner" class="toast-banner" role="status" aria-live="polite"></div>

    <main>
      <form id="config-form" action="/api/config" method="POST">
        <!-- 1. Multi-Provider LLM Connections & Model Selection -->
        <fieldset>
          <legend>1. 模型服务与默认模型</legend>

          <div class="form-group">
            <div class="provider-tabs-bar">
              <label id="provider-pills-label">模型供应商</label>
              <span id="provider-hint" class="hint">点击切换或新增供应商（带 ✅ 表示已配好 Key）</span>
            </div>
            <div class="preset-pills" id="preset-pills" role="group" aria-labelledby="provider-pills-label" aria-describedby="provider-hint"></div>
          </div>

          <!-- Hidden compatibility fields synced automatically on submit -->
          <input type="hidden" id="llm-provider" name="LLM_PROVIDER" value="gemini">
          <input type="hidden" id="llm-api-key" name="LLM_API_KEY" value="">
          <input type="hidden" id="llm-base-url" name="LLM_BASE_URL" value="">
          <input type="hidden" id="llm-fast-provider" name="LLM_FAST_PROVIDER" value="">
          <input type="hidden" id="llm-pro-provider" name="LLM_PRO_PROVIDER" value="">
          <input type="hidden" id="llm-providers-config" name="LLM_PROVIDERS_CONFIG" value="[]">

          <!-- Active Provider Configuration Card -->
          <div class="providers-stack" id="providers-list-container" role="region" aria-label="当前选中的模型供应商配置卡片"></div>

          <!-- Unified Fast / Pro Model Dropdown Selector from Ready Providers Only -->
          <div class="model-routing-panel">
            <div class="form-row two-col">
              <div class="tier-model-card">
                <div class="tier-card-header">
                  <label for="llm-fast-model">⚡ 快思模型</label>
                  <button type="button" id="test-llm-btn">⚡ 测试</button>
                </div>
                <span id="fast-model-hint" class="hint">日常秒回、意图分流与伴读初筛</span>
                <select
                  class="custom-select"
                  id="llm-fast-model"
                  name="LLM_FAST_MODEL"
                  required
                  aria-describedby="fast-model-hint fast-model-route-info"
                ></select>
                <div id="fast-model-route-info" class="route-endpoint-tag"></div>
              </div>

              <div class="tier-model-card">
                <div class="tier-card-header">
                  <label for="llm-pro-model">🧠 深思模型</label>
                  <button type="button" id="test-pro-llm-btn">⚡ 测试</button>
                </div>
                <span id="pro-model-hint" class="hint">长文精读、复杂推演与 CLI 降级兜底</span>
                <select
                  class="custom-select"
                  id="llm-pro-model"
                  name="LLM_PRO_MODEL"
                  required
                  aria-describedby="pro-model-hint pro-model-route-info"
                ></select>
                <div id="pro-model-route-info" class="route-endpoint-tag"></div>
              </div>
            </div>

            <div id="test-llm-result" class="test-result-banner" aria-live="polite"></div>
          </div>
        </fieldset>

        <!-- 2. Local AI Agent CLI Discovery & Tier 1 Routing Chain -->
        <fieldset>
          <legend>2. 本地 Agent CLI 优先级</legend>

          <div class="routing-preview" id="routing-chain-preview" aria-live="polite">
            正在加载路由顺序...
          </div>

          <div class="cli-toolbar">
            <span class="hint footer-meta">勾选启用，并通过「上移 / 下移」调整调用优先级：</span>
            <button type="button" id="rescan-cli-btn">🔍 重新扫描</button>
          </div>

          <input type="hidden" id="cli-routing-chain-input" name="CLI_ROUTING_CHAIN" value="">
          <input type="hidden" id="custom-cli-agents-input" name="CUSTOM_CLI_AGENTS" value="[]">

          <div class="cli-grid" id="cli-list-container" role="region" aria-label="AI Agent CLI 路由选择列表"></div>

          <!-- Add Custom CLI Agent (Collapsed by default) -->
          <details class="custom-cli-drawer sub-disclosure">
            <summary>➕ 添加自定义 CLI 工具</summary>
            <div class="form-row two-col">
              <div class="form-group">
                <label for="custom-cli-id">标识 ID</label>
                <input type="text" id="custom-cli-id" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="例如: cursor-agent">
              </div>
              <div class="form-group">
                <label for="custom-cli-binary">可执行文件路径</label>
                <input type="text" id="custom-cli-binary" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="例如: /usr/local/bin/my-cli">
              </div>
            </div>
            <div class="form-group">
              <label for="custom-cli-template">执行命令模板</label>
              <span id="custom-cli-template-hint" class="hint">支持占位符 {{prompt}} 与 {{dir}}</span>
              <input type="text" id="custom-cli-template" autocorrect="off" autocapitalize="off" spellcheck="false" aria-describedby="custom-cli-template-hint" placeholder="例如: my-cli run --cwd {{dir}} {{prompt}}">
            </div>
            <button type="button" id="add-custom-cli-btn">➕ 添加到列表</button>
          </details>
        </fieldset>

        <!-- 3. Personal Knowledge Base & Vault Paths -->
        <fieldset>
          <legend>3. 本地知识库路径</legend>

          <div class="form-group">
            <label for="vault-root">知识库根目录 (VAULT_ROOT)</label>
            <div class="password-wrapper">
              <input
                type="text"
                id="vault-root"
                name="VAULT_ROOT"
                required
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                aria-errormessage="vault-root-error"
                placeholder="例如: ~/Documents/MyVault（填 none 则启用无知识库独立模式）"
              >
              <button type="button" id="pick-vault-root-btn">📂 选择文件夹</button>
              <button type="button" id="use-standalone-vault-btn" title="无需外部知识库，文章与想法自动保存在项目本地 data/archive/ 目录">🪶 无知识库独立模式</button>
              <button type="button" id="init-vault-dirs-btn" title="仅补全缺失的子目录，已存在的目录自动跳过，绝不删除或覆盖任何已有目录与文件">✨ 补全缺失子目录</button>
            </div>
            <div id="vault-root-error" class="error-msg">
              <span aria-hidden="true">❌</span> 知识库根目录不能为空。
            </div>
          </div>

          <div class="vault-subdirs-box">
            <div class="vault-subdirs-header">
              <span id="vault-subdirs-header-text">📁 必要子目录状态（安全保护：仅补全缺失目录，已存在目录自动跳过，绝不删除或覆盖任何本地目录与文件）</span>
            </div>
            <div class="status-strip" id="vault-subdirs-status" aria-live="polite"></div>
          </div>

          <details class="custom-cli-drawer sub-disclosure">
            <summary>⚙️ 子目录与关注主题词设置（可选，默认随根目录自动映射）</summary>
            <div class="form-row two-col">
              <div class="form-group">
                <label for="wechat-articles-dir">公众号文章目录</label>
                <div class="password-wrapper">
                  <input
                    type="text"
                    id="wechat-articles-dir"
                    name="VAULT_WECHAT_DIR"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                  >
                  <button type="button" id="pick-wechat-dir-btn">📂 选择</button>
                </div>
              </div>

              <div class="form-group">
                <label for="ideas-seeds-dir">个人想法目录</label>
                <div class="password-wrapper">
                  <input
                    type="text"
                    id="ideas-seeds-dir"
                    name="VAULT_IDEAS_DIR"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                  >
                  <button type="button" id="pick-ideas-dir-btn">📂 选择</button>
                </div>
              </div>
            </div>

            <div class="form-row two-col">
              <div class="form-group">
                <label for="vault-home-note">主线笔记相对路径</label>
                <input
                  type="text"
                  id="vault-home-note"
                  name="VAULT_NOW_FILE"
                  autocorrect="off"
                  autocapitalize="off"
                  spellcheck="false"
                  placeholder="00_home/now.md"
                >
              </div>

              <div class="form-group">
                <label for="vault-focus-terms">核心关注主题词（逗号分隔）</label>
                <input
                  type="text"
                  id="vault-focus-terms"
                  name="VAULT_DOMAIN_KEYWORDS"
                  autocorrect="off"
                  autocapitalize="off"
                  spellcheck="false"
                  placeholder="留空则自动从知识库提取"
                >
              </div>
            </div>
          </details>
        </fieldset>

        <!-- 4. Custom & Advanced .env Key-Value Pairs (Collapsible Native Disclosure) -->
        <details class="advanced-disclosure" open>
          <summary>4. 高级环境变量 (.env) · 交互节奏与外部通道扩展</summary>
          <div class="adv-presets-bar" id="adv-presets-bar" role="group" aria-label="快捷添加高级配置项"></div>
          <div class="env-table" id="custom-env-list" role="region" aria-label="自定义环境变量列表"></div>
          <button type="button" id="add-env-row-btn">➕ 新增自定义变量</button>
        </details>

        <div class="sticky-footer">
          <div>
            <strong id="dirty-indicator">✅ 配置已同步</strong>
            <div class="hint footer-meta" id="env-path-display"></div>
          </div>
          <div class="header-actions">
            <button type="submit" id="save-config-btn" class="primary">💾 保存配置</button>
          </div>
        </div>
      </form>
    </main>
  </div>

  <script>
    // JavaScript Fallback for :user-invalid using WeakMap
    const UserInvalidFallback = (() => {
      const dirtyState = new WeakMap();

      const updateState = (input) => {
        const isValid = input.checkValidity();
        input.classList.toggle('user-invalid-fallback', !isValid);
        input.classList.toggle('user-valid-fallback', isValid);
        if (!isValid) {
          input.setAttribute('aria-invalid', 'true');
        } else {
          input.removeAttribute('aria-invalid');
        }
      };

      const handleEvent = (event) => {
        const input = event.target;
        if (event.type === 'reset') {
          const controls = input.elements || [];
          for (const control of controls) {
            dirtyState.delete(control);
            control.classList.remove('user-invalid-fallback');
            control.classList.remove('user-valid-fallback');
            control.removeAttribute('aria-invalid');
          }
          return;
        }
        if (!input || !input.checkValidity) return;
        if (event.type === 'input' || event.type === 'change') {
          const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
          state.hasInteracted = true;
          dirtyState.set(input, state);
          if (state.hasBlurred) updateState(input);
        } else if (event.type === 'blur') {
          const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
          state.hasBlurred = true;
          dirtyState.set(input, state);
          if (state.hasInteracted) updateState(input);
        }
      };

      const init = (root = document) => {
        if (CSS.supports('selector(:user-invalid)')) return;
        root.addEventListener('blur', handleEvent, true);
        root.addEventListener('input', handleEvent);
        root.addEventListener('change', handleEvent);
        root.addEventListener('reset', handleEvent, true);
      };

      return { init };
    })();

    // Sync aria-invalid with native CSS :user-invalid state
    const syncAria = (el) => {
      if (el && typeof el.matches === 'function' && el.tagName === 'INPUT') {
        try {
          el.setAttribute('aria-invalid', el.matches(':user-invalid') ? 'true' : 'false');
        } catch {}
      }
    };
    document.addEventListener('blur', (e) => syncAria(e.target), true);
    document.addEventListener('input', (e) => {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute('aria-invalid')) {
        syncAria(e.target);
      }
    });

    const form = document.getElementById('config-form');
    UserInvalidFallback.init(form);

    // State management
    let appState = null;
    let configuredProviders = [];
    let activeProviderId = '';
    let selectedFastSpec = '';
    let selectedProSpec = '';
    let discoveredClis = [];
    let customCliAgents = [];
    let deletedEnvKeys = new Set();

    const MANAGED_KEYS = new Set([
      'LLM_PROVIDER',
      'LLM_API_KEY',
      'LLM_BASE_URL',
      'LLM_FAST_MODEL',
      'LLM_FAST_PROVIDER',
      'LLM_PRO_MODEL',
      'LLM_PRO_PROVIDER',
      'LLM_PROVIDERS_CONFIG',
      'CLI_ROUTING_CHAIN',
      'CUSTOM_CLI_AGENTS',
      'VAULT_ROOT',
      'VAULT_WECHAT_DIR',
      'VAULT_IDEAS_DIR',
      'VAULT_NOW_FILE',
      'VAULT_DOMAIN_KEYWORDS'
    ]);

    function showToast(message, isError = false) {
      const banner = document.getElementById('toast-banner');
      banner.textContent = message;
      banner.className = 'toast-banner show ' + (isError ? 'err' : 'ok');
    }

    function markDirty() {
      const ind = document.getElementById('dirty-indicator');
      ind.textContent = '✏️ 有未保存的修改';
    }

    function shortProviderLabel(name, id) {
      return (name || id || '').split(' (')[0].trim();
    }

    // Only providers with a non-empty API Key (or explicit local Ollama localhost gateway) can appear in model selectors
    function isProviderReadyForModels(prov) {
      if (!prov) return false;
      if (prov.apiKey && String(prov.apiKey).trim().length > 0) return true;
      const url = String(prov.baseUrl || '').toLowerCase();
      if (prov.id && prov.id.startsWith('custom') && (url.includes('localhost') || url.includes('127.0.0.1'))) {
        return true;
      }
      return false;
    }

    function parseSpec(spec) {
      const raw = String(spec || '').trim();
      const idx = raw.indexOf('::');
      if (idx > 0) {
        return {
          providerId: raw.slice(0, idx).trim(),
          model: raw.slice(idx + 2).trim()
        };
      }
      const readyList = configuredProviders.filter(isProviderReadyForModels);
      const fallbackProv = (readyList[0] || configuredProviders[0] || { id: 'gemini' }).id;
      return { providerId: fallbackProv, model: raw };
    }

    function syncHiddenLlmInputs() {
      const fastParsed = parseSpec(selectedFastSpec);
      const proParsed = parseSpec(selectedProSpec);
      const readyProviders = configuredProviders.filter(isProviderReadyForModels);
      const fastProv =
        configuredProviders.find((p) => p.id === fastParsed.providerId) ||
        readyProviders[0] ||
        configuredProviders[0];
      const proProv =
        configuredProviders.find((p) => p.id === proParsed.providerId) ||
        fastProv;

      document.getElementById('llm-provider').value = fastProv ? fastProv.id : 'custom';
      document.getElementById('llm-api-key').value = fastProv ? (fastProv.apiKey || '') : '';
      document.getElementById('llm-base-url').value = fastProv ? (fastProv.baseUrl || '') : '';
      document.getElementById('llm-fast-provider').value = fastParsed.providerId;
      document.getElementById('llm-pro-provider').value = proParsed.providerId;
      document.getElementById('llm-providers-config').value = JSON.stringify(
        configuredProviders.map((p) => ({
          id: p.id,
          name: p.name,
          envKeyName: p.envKeyName,
          baseUrl: p.baseUrl,
          models: p.models
        }))
      );

      const fastInfoEl = document.getElementById('fast-model-route-info');
      const proInfoEl = document.getElementById('pro-model-route-info');

      if (fastProv && isProviderReadyForModels(fastProv)) {
        fastInfoEl.textContent = '通道: ' + shortProviderLabel(fastProv.name, fastProv.id);
      } else {
        fastInfoEl.textContent = '⚠️ 请先配置上方供应商 API Key';
      }

      if (proProv && isProviderReadyForModels(proProv)) {
        proInfoEl.textContent = '通道: ' + shortProviderLabel(proProv.name, proProv.id);
      } else {
        proInfoEl.textContent = '⚠️ 请先配置上方供应商 API Key';
      }
    }

    function renderStatusStrip(data) {
      const strip = document.getElementById('status-strip');
      strip.replaceChildren();

      const readyProviders = (configuredProviders || []).filter(isProviderReadyForModels);
      const readyLabel = readyProviders.length > 0
        ? '🔑 模型服务: ' + readyProviders.map((p) => shortProviderLabel(p.name, p.id)).join(' / ')
        : '⚠️ 未配置 API Key';

      const items = [
        {
          ok: data.vaultExists,
          text: data.vaultExists ? '📁 知识库就绪' : '⚠️ 知识库待创建'
        },
        {
          ok: readyProviders.length > 0,
          text: readyLabel
        },
        {
          ok: data.discoveredClis.some((c) => c.installed && c.enabledInRoute),
          text:
            '🤖 CLI: ' +
            ((data.config.llm.cliRoutingChain || []).join(' → ') || '未启用')
        },
        {
          ok: data.clawbot.configured,
          text: data.clawbot.configured
            ? '📱 微信已绑定'
            : '📱 微信未绑定'
        }
      ];

      for (const item of items) {
        const span = document.createElement('span');
        span.className = 'badge ' + (item.ok ? 'ok' : 'warn');
        span.textContent = item.text;
        strip.appendChild(span);
      }
    }

    function renderPresetPills() {
      if (!appState) return;
      const container = document.getElementById('preset-pills');
      container.replaceChildren();
      const presets = appState.providerPresets || [];

      // 1. Render pills for all configured providers first
      for (const prov of configuredProviders) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isActive = prov.id === activeProviderId;
        const isReady = isProviderReadyForModels(prov);
        const shortName = shortProviderLabel(prov.name, prov.id);

        btn.className =
          'preset-pill' +
          (isActive ? ' active' : isReady ? ' ready-pill' : '');
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        btn.textContent = (isReady ? '✅ ' : '⚙️ ') + shortName;
        btn.addEventListener('click', () => {
          activeProviderId = prov.id;
          renderPresetPills();
          renderProvidersList();
        });
        container.appendChild(btn);
      }

      // 2. Render pills for unconfigured presets so user can add with 1 click
      for (const preset of presets) {
        if (preset.id !== 'custom' && configuredProviders.some((p) => p.id === preset.id)) {
          continue;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'preset-pill';
        const shortName = shortProviderLabel(preset.name, preset.id);

        if (preset.id === 'custom') {
          btn.textContent = '➕ 自定义网关 / Ollama';
          btn.addEventListener('click', () => {
            addProviderFromPreset('custom');
          });
        } else {
          const hasSavedKey = Boolean(
            appState.detectedProviderKeys &&
              appState.detectedProviderKeys[preset.id] &&
              appState.detectedProviderKeys[preset.id].apiKey
          );
          btn.textContent = '➕ ' + shortName + (hasSavedKey ? ' (有本机密钥)' : '');
          btn.addEventListener('click', () => {
            addProviderFromPreset(preset.id);
          });
        }
        container.appendChild(btn);
      }
    }

    function addProviderFromPreset(presetId) {
      if (!appState) return;
      const preset =
        appState.providerPresets.find((p) => p.id === presetId) ||
        appState.providerPresets[appState.providerPresets.length - 1];

      let id = preset.id;
      let name = preset.name;
      let envKeyName = preset.envKeyName;

      if (presetId === 'custom') {
        let idx = 1;
        while (configuredProviders.some((p) => p.id === (idx === 1 ? 'custom' : 'custom_' + idx))) {
          idx++;
        }
        id = idx === 1 ? 'custom' : 'custom_' + idx;
        name = idx === 1 ? preset.name : '自定义网关 #' + idx;
        envKeyName = idx === 1 ? 'CUSTOM_API_KEY' : 'CUSTOM_' + idx + '_API_KEY';
      } else {
        const existing = configuredProviders.find((p) => p.id === id);
        if (existing) {
          activeProviderId = existing.id;
          renderPresetPills();
          renderProvidersList();
          return;
        }
      }

      const detected = appState.detectedProviderKeys && appState.detectedProviderKeys[id];
      const newProv = {
        id,
        name,
        envKeyName,
        apiKey: detected ? detected.apiKey : '',
        apiKeySource: detected ? detected.source : '',
        baseUrl: preset.baseUrl,
        models: Array.isArray(preset.defaultModels) && preset.defaultModels.length > 0
          ? [...preset.defaultModels]
          : [preset.defaultFastModel, preset.defaultProModel].filter(Boolean)
      };

      configuredProviders.push(newProv);
      activeProviderId = newProv.id;
      deletedEnvKeys.delete(envKeyName);
      renderPresetPills();
      renderProvidersList();
      renderModelDropdowns();
      updateRoutingPreview();
      markDirty();

      const keyInput = document.getElementById('prov-key-' + id);
      if (keyInput) {
        keyInput.focus();
      }
      if (isProviderReadyForModels(newProv)) {
        showToast('➕ 已切换至「' + shortProviderLabel(name, id) + '」，其模型已加入下方选择列表。');
      } else {
        showToast('➕ 已展开「' + shortProviderLabel(name, id) + '」配置卡片，填写 API Key 后其模型将自动加入下方选择列表。');
      }
    }

    function createRichModelOption(spec, shortName, modelName) {
      const opt = document.createElement('option');
      opt.value = spec;
      opt.setAttribute('aria-label', shortName + ' ' + modelName);

      const mainWrap = document.createElement('span');
      mainWrap.className = 'option-row-main';

      const pill = document.createElement('span');
      pill.className = 'option-provider-pill';
      pill.textContent = '[' + shortName + ']';

      const spaceNode = document.createTextNode(' ');

      const title = document.createElement('span');
      title.className = 'option-title';
      title.textContent = modelName;

      mainWrap.appendChild(pill);
      mainWrap.appendChild(spaceNode);
      mainWrap.appendChild(title);

      opt.appendChild(mainWrap);
      return opt;
    }

    function attachCustomizableSelectButton(selectEl) {
      if (
        typeof CSS !== 'undefined' &&
        typeof CSS.supports === 'function' &&
        CSS.supports('appearance', 'base-select')
      ) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const selectedContent = document.createElement('selectedcontent');
        btn.appendChild(selectedContent);
        selectEl.appendChild(btn);
      }
    }

    function renderModelDropdowns() {
      const fastSelect = document.getElementById('llm-fast-model');
      const proSelect = document.getElementById('llm-pro-model');
      fastSelect.replaceChildren();
      proSelect.replaceChildren();

      attachCustomizableSelectButton(fastSelect);
      attachCustomizableSelectButton(proSelect);

      // Strictly filter to ONLY providers that have an API Key configured (or localhost custom gateway)
      const readyProviders = configuredProviders.filter(isProviderReadyForModels);
      const allValidSpecs = [];

      if (readyProviders.length === 0) {
        const emptyFast = document.createElement('option');
        emptyFast.value = '';
        emptyFast.disabled = true;
        emptyFast.selected = true;
        emptyFast.textContent = '⚠️ 请先在上方供应商卡片中配置 API Key 以解锁可选模型';
        fastSelect.appendChild(emptyFast);

        const emptyPro = document.createElement('option');
        emptyPro.value = '';
        emptyPro.disabled = true;
        emptyPro.selected = true;
        emptyPro.textContent = '⚠️ 请先在上方供应商卡片中配置 API Key 以解锁可选模型';
        proSelect.appendChild(emptyPro);

        syncHiddenLlmInputs();
        return;
      }

      for (const prov of readyProviders) {
        const shortName = shortProviderLabel(prov.name, prov.id);
        const groupLabel = '🏢 ' + shortName + ' (✅ ' + prov.envKeyName + ')';

        const fastGroup = document.createElement('optgroup');
        fastGroup.label = groupLabel;
        const proGroup = document.createElement('optgroup');
        proGroup.label = groupLabel;

        const models = Array.isArray(prov.models) && prov.models.length > 0
          ? prov.models
          : ['gpt-4o-mini'];

        for (const modelName of models) {
          const spec = prov.id + '::' + modelName;
          allValidSpecs.push(spec);

          fastGroup.appendChild(createRichModelOption(spec, shortName, modelName));
          proGroup.appendChild(createRichModelOption(spec, shortName, modelName));
        }

        fastSelect.appendChild(fastGroup);
        proSelect.appendChild(proGroup);
      }

      if (!allValidSpecs.includes(selectedFastSpec)) {
        const parsed = parseSpec(selectedFastSpec);
        const matchByModel = allValidSpecs.find((s) => s.endsWith('::' + parsed.model));
        selectedFastSpec = matchByModel || allValidSpecs[0] || '';
      }
      if (!allValidSpecs.includes(selectedProSpec)) {
        const parsed = parseSpec(selectedProSpec);
        const matchByModel = allValidSpecs.find((s) => s.endsWith('::' + parsed.model));
        selectedProSpec = matchByModel || allValidSpecs[Math.min(1, allValidSpecs.length - 1)] || allValidSpecs[0] || '';
      }

      fastSelect.value = selectedFastSpec;
      proSelect.value = selectedProSpec;
      syncHiddenLlmInputs();
    }

    function renderProvidersList() {
      const container = document.getElementById('providers-list-container');
      container.replaceChildren();

      if (configuredProviders.length === 0) return;
      if (!activeProviderId || !configuredProviders.some((p) => p.id === activeProviderId)) {
        const firstReady = configuredProviders.find(isProviderReadyForModels);
        activeProviderId = (firstReady || configuredProviders[0]).id;
      }

      const activeProv =
        configuredProviders.find((p) => p.id === activeProviderId) ||
        configuredProviders[0];

      [activeProv].forEach((prov) => {
        const isReady = isProviderReadyForModels(prov);
        const card = document.createElement('div');
        card.className = 'provider-card' + (isReady ? ' ready' : '');
        card.id = 'provider-card-' + prov.id;

        // 1. Header
        const header = document.createElement('div');
        header.className = 'provider-card-header';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'provider-card-title';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = shortProviderLabel(prov.name, prov.id);
        titleWrap.appendChild(titleSpan);

        const statusBadge = document.createElement('span');
        statusBadge.id = 'prov-status-' + prov.id;
        statusBadge.className = 'badge ' + (isReady ? 'ok' : 'warn');
        statusBadge.textContent = isReady ? '✅ 已启用' : '⚠️ 未填 Key';
        titleWrap.appendChild(statusBadge);

        const actions = document.createElement('div');
        actions.className = 'provider-card-actions';

        const testStatusSpan = document.createElement('span');
        testStatusSpan.className = 'hint footer-meta';
        testStatusSpan.setAttribute('aria-live', 'polite');

        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.textContent = '⚡ 测试';
        testBtn.addEventListener('click', async () => {
          testBtn.disabled = true;
          testStatusSpan.textContent = '⏳ 测试中...';
          try {
            const res = await fetch('/api/config/test-llm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                provider: prov.id,
                apiKey: prov.apiKey,
                baseUrl: prov.baseUrl,
                model: (prov.models && prov.models[0]) || ''
              })
            });
            const data = await res.json();
            if (data.ok) {
              testStatusSpan.textContent =
                '✅ ' + data.latencyMs + 'ms';
            } else {
              testStatusSpan.textContent = '❌ ' + (data.error || '连接失败');
            }
          } catch (err) {
            testStatusSpan.textContent = '❌ 请求出错';
          } finally {
            testBtn.disabled = false;
          }
        });

        const fetchModelsBtn = document.createElement('button');
        fetchModelsBtn.type = 'button';
        fetchModelsBtn.textContent = '🔄 拉取模型';
        fetchModelsBtn.addEventListener('click', async () => {
          fetchModelsBtn.disabled = true;
          fetchModelsBtn.textContent = '⏳ 拉取中...';
          try {
            const res = await fetch('/api/config/fetch-models', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                providerId: prov.id,
                apiKey: prov.apiKey,
                baseUrl: prov.baseUrl
              })
            });
            const data = await res.json();
            if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
              prov.models = Array.from(new Set([...(prov.models || []), ...data.models]));
              renderProvidersList();
              renderModelDropdowns();
              updateRoutingPreview();
              markDirty();
              showToast('✅ 已同步 ' + prov.models.length + ' 个可用模型');
            } else {
              showToast('⚠️ ' + (data.error || '请手动添加模型名称'), true);
            }
          } catch (err) {
            showToast('❌ 拉取失败: ' + err, true);
          } finally {
            fetchModelsBtn.disabled = false;
            fetchModelsBtn.textContent = '🔄 拉取模型';
          }
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '🗑️ 移除';
        removeBtn.addEventListener('click', () => {
          if (configuredProviders.length <= 1) {
            showToast('请至少保留一个模型供应商。', true);
            return;
          }
          if (prov.envKeyName) {
            deletedEnvKeys.add(prov.envKeyName);
          }
          configuredProviders = configuredProviders.filter((p) => p.id !== prov.id);
          const nextReady = configuredProviders.find(isProviderReadyForModels);
          activeProviderId = (nextReady || configuredProviders[0]).id;
          renderPresetPills();
          renderProvidersList();
          renderModelDropdowns();
          updateRoutingPreview();
          if (appState) renderStatusStrip(appState);
          markDirty();
        });

        actions.appendChild(testStatusSpan);
        actions.appendChild(testBtn);
        actions.appendChild(fetchModelsBtn);
        actions.appendChild(removeBtn);

        header.appendChild(titleWrap);
        header.appendChild(actions);
        card.appendChild(header);

        // 2. Two-column API Key + Base URL inputs
        const row = document.createElement('div');
        row.className = 'form-row two-col';

        const keyGroup = document.createElement('div');
        keyGroup.className = 'form-group';

        const keyLabel = document.createElement('label');
        keyLabel.htmlFor = 'prov-key-' + prov.id;
        keyLabel.textContent = 'API Key (' + prov.envKeyName + ')';

        const pwWrap = document.createElement('div');
        pwWrap.className = 'password-wrapper';

        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.id = 'prov-key-' + prov.id;
        keyInput.value = prov.apiKey || '';
        keyInput.placeholder = '输入 ' + prov.envKeyName;
        keyInput.setAttribute('autocomplete', 'new-password');
        keyInput.setAttribute('autocorrect', 'off');
        keyInput.setAttribute('autocapitalize', 'off');
        keyInput.setAttribute('spellcheck', 'false');
        keyInput.addEventListener('input', () => {
          prov.apiKey = keyInput.value.trim();
          prov.apiKeySource = prov.apiKey ? '已填写' : '';
          const nowReady = isProviderReadyForModels(prov);
          card.classList.toggle('ready', nowReady);
          statusBadge.className = 'badge ' + (nowReady ? 'ok' : 'warn');
          statusBadge.textContent = nowReady ? '✅ 已启用' : '⚠️ 未填 Key';
          renderPresetPills();
          renderModelDropdowns();
          updateRoutingPreview();
          if (appState) renderStatusStrip(appState);
          markDirty();
        });

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.setAttribute('aria-pressed', 'false');
        toggleBtn.setAttribute('aria-label', '显示 ' + prov.name + ' API Key');
        toggleBtn.textContent = '👁️';
        toggleBtn.addEventListener('click', () => {
          const isHidden = keyInput.type === 'password';
          keyInput.type = isHidden ? 'text' : 'password';
          toggleBtn.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
          toggleBtn.textContent = isHidden ? '🙈' : '👁️';
        });

        pwWrap.appendChild(keyInput);
        pwWrap.appendChild(toggleBtn);
        keyGroup.appendChild(keyLabel);
        keyGroup.appendChild(pwWrap);

        const urlGroup = document.createElement('div');
        urlGroup.className = 'form-group';

        const urlLabel = document.createElement('label');
        urlLabel.htmlFor = 'prov-url-' + prov.id;
        urlLabel.textContent = '接口地址 (Base URL)';

        const urlInput = document.createElement('input');
        urlInput.type = 'url';
        urlInput.id = 'prov-url-' + prov.id;
        urlInput.required = true;
        urlInput.pattern = 'https?://.+';
        urlInput.value = prov.baseUrl || '';
        urlInput.setAttribute('autocorrect', 'off');
        urlInput.setAttribute('autocapitalize', 'off');
        urlInput.setAttribute('spellcheck', 'false');
        urlInput.addEventListener('input', () => {
          prov.baseUrl = urlInput.value.trim().replace(/\\/+$/, '');
          renderModelDropdowns();
          markDirty();
        });

        urlGroup.appendChild(urlLabel);
        urlGroup.appendChild(urlInput);

        row.appendChild(keyGroup);
        row.appendChild(urlGroup);
        card.appendChild(row);

        // 3. Available Models Pool inside this Provider Card
        const modelsBox = document.createElement('div');
        modelsBox.className = 'provider-models-box';

        const modelsTitle = document.createElement('div');
        modelsTitle.className = 'provider-models-title';
        modelsTitle.textContent = '可用模型列表';
        modelsBox.appendChild(modelsTitle);

        const chipsList = document.createElement('div');
        chipsList.className = 'model-chips-list';

        (prov.models || []).forEach((modelName) => {
          const chip = document.createElement('span');
          chip.className = 'model-chip';

          const nameSpan = document.createElement('span');
          nameSpan.textContent = modelName;
          chip.appendChild(nameSpan);

          const delChipBtn = document.createElement('button');
          delChipBtn.type = 'button';
          delChipBtn.className = 'chip-remove';
          delChipBtn.setAttribute('aria-label', '移除模型 ' + modelName);
          delChipBtn.textContent = '×';
          delChipBtn.addEventListener('click', () => {
            if (prov.models.length <= 1) {
              showToast('至少保留 1 个模型。', true);
              return;
            }
            prov.models = prov.models.filter((m) => m !== modelName);
            renderProvidersList();
            renderModelDropdowns();
            updateRoutingPreview();
            markDirty();
          });

          chip.appendChild(delChipBtn);
          chipsList.appendChild(chip);
        });
        modelsBox.appendChild(chipsList);

        const addModelRow = document.createElement('div');
        addModelRow.className = 'add-model-inline';

        const newModelInput = document.createElement('input');
        newModelInput.type = 'text';
        newModelInput.id = 'add-model-input-' + prov.id;
        newModelInput.placeholder = '输入模型名称回车添加...';
        newModelInput.setAttribute('aria-label', '为 ' + prov.name + ' 添加模型');
        newModelInput.setAttribute('autocorrect', 'off');
        newModelInput.setAttribute('autocapitalize', 'off');
        newModelInput.setAttribute('spellcheck', 'false');

        const addModelBtn = document.createElement('button');
        addModelBtn.type = 'button';
        addModelBtn.textContent = '➕ 添加';

        const handleAddModel = () => {
          const m = newModelInput.value.trim();
          if (!m) return;
          if (!prov.models.includes(m)) {
            prov.models.push(m);
          }
          newModelInput.value = '';
          renderProvidersList();
          renderModelDropdowns();
          updateRoutingPreview();
          markDirty();
        };

        newModelInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            handleAddModel();
          }
        });
        addModelBtn.addEventListener('click', handleAddModel);

        addModelRow.appendChild(newModelInput);
        addModelRow.appendChild(addModelBtn);
        modelsBox.appendChild(addModelRow);

        card.appendChild(modelsBox);
        container.appendChild(card);
      });
    }

    function updateRoutingPreview() {
      const selectedIds = discoveredClis
        .filter((c) => c.enabledInRoute)
        .map((c) => c.id);
      document.getElementById('cli-routing-chain-input').value = selectedIds.join(',');
      document.getElementById('custom-cli-agents-input').value = JSON.stringify(customCliAgents);

      const proParsed = parseSpec(document.getElementById('llm-pro-model').value || selectedProSpec);
      const proLabel = proParsed.model || 'pro-model';

      const chainText = selectedIds.length > 0
        ? selectedIds.join(' ➔ ')
        : '未启用本地 CLI';

      const preview = document.getElementById('routing-chain-preview');
      preview.textContent =
        '⚡ 调用顺序：' + chainText + '  ➔  云端兜底 (' + proLabel + ')';
    }

    function renderCliList() {
      const container = document.getElementById('cli-list-container');
      container.replaceChildren();

      discoveredClis.forEach((cli, index) => {
        const card = document.createElement('div');
        card.className = 'cli-card' + (cli.enabledInRoute ? ' selected' : '');

        const main = document.createElement('div');
        main.className = 'cli-card-main';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'cli_chain_item';
        checkbox.value = cli.id;
        checkbox.id = 'cli-cb-' + cli.id;
        checkbox.checked = Boolean(cli.enabledInRoute);
        checkbox.addEventListener('change', () => {
          cli.enabledInRoute = checkbox.checked;
          const selected = discoveredClis.filter((c) => c.enabledInRoute);
          const unselected = discoveredClis.filter((c) => !c.enabledInRoute);
          discoveredClis = [...selected, ...unselected];
          renderCliList();
          updateRoutingPreview();
          markDirty();
        });

        const info = document.createElement('div');
        const titleRow = document.createElement('div');
        titleRow.className = 'cli-title';

        const label = document.createElement('label');
        label.htmlFor = 'cli-cb-' + cli.id;
        label.textContent = cli.name.includes('(' + cli.id + ')')
          ? cli.name
          : cli.name + ' (' + cli.id + ')';
        titleRow.appendChild(label);

        if (cli.enabledInRoute) {
          const prioBadge = document.createElement('span');
          prioBadge.className = 'badge ok';
          const orderNum = discoveredClis.filter((c) => c.enabledInRoute).indexOf(cli) + 1;
          prioBadge.textContent = '#' + orderNum;
          titleRow.appendChild(prioBadge);
        }

        const meta = document.createElement('div');
        meta.className = 'cli-meta';
        meta.textContent = cli.binaryPath;

        info.appendChild(titleRow);
        info.appendChild(meta);

        main.appendChild(checkbox);
        main.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'cli-actions';

        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.textContent = '↑ 上移';
        upBtn.disabled = index === 0;
        upBtn.addEventListener('click', () => {
          if (index > 0) {
            const tmp = discoveredClis[index - 1];
            discoveredClis[index - 1] = discoveredClis[index];
            discoveredClis[index] = tmp;
            renderCliList();
            updateRoutingPreview();
            markDirty();
          }
        });

        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.textContent = '↓ 下移';
        downBtn.disabled = index === discoveredClis.length - 1;
        downBtn.addEventListener('click', () => {
          if (index < discoveredClis.length - 1) {
            const tmp = discoveredClis[index + 1];
            discoveredClis[index + 1] = discoveredClis[index];
            discoveredClis[index] = tmp;
            renderCliList();
            updateRoutingPreview();
            markDirty();
          }
        });

        actions.appendChild(upBtn);
        actions.appendChild(downBtn);

        if (cli.isCustom) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.textContent = '🗑️ 移除';
          delBtn.addEventListener('click', () => {
            discoveredClis = discoveredClis.filter((c) => c.id !== cli.id);
            customCliAgents = customCliAgents.filter((c) => c.id !== cli.id);
            renderCliList();
            updateRoutingPreview();
            markDirty();
          });
          actions.appendChild(delBtn);
        }

        card.appendChild(main);
        card.appendChild(actions);
        container.appendChild(card);
      });
    }

    const ADVANCED_ENV_PRESETS = [
      {
        key: 'TASK_HEARTBEAT_SECONDS',
        defaultVal: '25',
        shortLabel: '💓 长任务进度同步秒数',
        desc: '场景5/6 · 生图与深度研究等长任务向微信推送心跳进度的间隔秒数（默认 25 秒，填 0 关闭定时推送）',
        placeholder: '默认 25（单位：秒，填 0 关闭自动进度推送）'
      },
      {
        key: 'ANNOTATION_WAIT_SECONDS',
        defaultVal: '10',
        shortLabel: '⏱️ 批注合并等待秒数',
        desc: '场景1 · 转发链接后等待追加语音/文字批注的秒数（默认 10 秒）',
        placeholder: '默认 10（如习惯长语音可设为 20 或 30）'
      },
      {
        key: 'PORT',
        defaultVal: '8787',
        shortLabel: '🔌 本地服务端口',
        desc: '场景1 · 后台守护进程与配置页监听端口（默认 8787）',
        placeholder: '默认 8787'
      },
      {
        key: 'ALLOW_CODEX_FALLBACK',
        defaultVal: 'true',
        shortLabel: '🤖 本地 CLI 调度开关',
        desc: '场景1 · 是否允许唤醒本机 Agent CLI 处理深度任务（true / false）',
        placeholder: 'true 开启 / false 仅用云端 API'
      },
      {
        key: 'WECHAT_CONTEXT_DATA_DIR',
        defaultVal: './data',
        shortLabel: '🗄️ 数据库存储目录',
        desc: '场景1 · SQLite 数据库与会话状态存储目录（默认 ./data）',
        placeholder: '默认 ./data'
      },
      {
        key: 'NOTIFY_WEBHOOK_URL',
        defaultVal: '',
        shortLabel: '🔔 外部通知 Webhook',
        desc: '场景4 · 文章归档/灵感记录后同步推送（支持飞书/钉钉/企微机器人或自定义 JSON Webhook）',
        placeholder: '选填：粘贴飞书/钉钉机器人或自定义 Webhook URL'
      },
      {
        key: 'NOTIFY_WEBHOOK_SECRET',
        defaultVal: '',
        shortLabel: '🔐 Webhook 加签密钥',
        desc: '场景4 · 钉钉机器人加签密钥（SEC开头）或飞书签名校验密钥（自动计算 HMAC-SHA256 签名）',
        placeholder: '选填：粘贴钉钉 SEC... 加签密钥或飞书签名密钥'
      },
      {
        key: 'NOTIFY_WEBHOOK_KEYWORD',
        defaultVal: '',
        shortLabel: '🏷️ Webhook 安全关键词',
        desc: '场景4 · 若钉钉/飞书机器人采用「自定义关键词」安全设置，填写该关键词将自动注入消息前缀',
        placeholder: '选填：如 知识库 / AI通知'
      },
      {
        key: 'NOTIFY_ON_EVENTS',
        defaultVal: 'article,idea,plan',
        shortLabel: '📡 Webhook 触发事件',
        desc: '场景4 · 触发外部 Webhook 推送的事件类型（逗号分隔）',
        placeholder: '默认 article,idea,plan'
      }
    ];

    function findAdvPreset(key) {
      const clean = (key || '').trim();
      return ADVANCED_ENV_PRESETS.find((p) => p.key === clean) || null;
    }

    function renderAdvancedEnvPresetBar() {
      const bar = document.getElementById('adv-presets-bar');
      if (!bar) return;
      bar.replaceChildren();

      const existingKeys = new Set(
        Array.from(document.querySelectorAll('#custom-env-list .env-row')).map((row) => {
          const inp = row.querySelector('input');
          return inp ? inp.value.trim() : '';
        })
      );

      for (const preset of ADVANCED_ENV_PRESETS) {
        const active = existingKeys.has(preset.key);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'preset-pill ' + (active ? 'active' : '');
        btn.title = preset.desc;
        btn.textContent = (active ? '✓ ' : '+ ') + preset.shortLabel;
        btn.addEventListener('click', () => {
          const rows = Array.from(document.querySelectorAll('#custom-env-list .env-row'));
          const foundRow = rows.find((r) => {
            const inp = r.querySelector('input');
            return inp && inp.value.trim() === preset.key;
          });
          if (foundRow) {
            const inputs = foundRow.querySelectorAll('input');
            if (inputs[1]) inputs[1].focus();
            return;
          }
          deletedEnvKeys.delete(preset.key);
          const newRow = addCustomEnvRow(preset.key, preset.defaultVal);
          renderAdvancedEnvPresetBar();
          markDirty();
          const inputs = newRow.querySelectorAll('input');
          if (inputs[1]) inputs[1].focus();
        });
        bar.appendChild(btn);
      }
    }

    function addCustomEnvRow(key = '', value = '') {
      const container = document.getElementById('custom-env-list');
      const rowIdx = container.children.length;
      const row = document.createElement('div');
      row.className = 'env-row';

      const preset = findAdvPreset(key);

      const keyCell = document.createElement('div');
      keyCell.className = 'env-key-cell';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.name = 'env_key_' + rowIdx;
      keyInput.value = key;
      keyInput.placeholder = '变量名 (如 NOTIFY_WEBHOOK_URL)';
      keyInput.setAttribute('autocorrect', 'off');
      keyInput.setAttribute('autocapitalize', 'off');
      keyInput.setAttribute('spellcheck', 'false');

      const descEl = document.createElement('span');
      descEl.className = 'env-key-desc';
      descEl.textContent = preset ? preset.desc : '自定义 .env 环境变量';

      keyCell.appendChild(keyInput);
      keyCell.appendChild(descEl);

      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.name = 'env_val_' + rowIdx;
      valInput.value = value;
      valInput.placeholder = preset ? preset.placeholder : '变量值';
      valInput.setAttribute('autocorrect', 'off');
      valInput.setAttribute('autocapitalize', 'off');
      valInput.setAttribute('spellcheck', 'false');
      valInput.addEventListener('input', markDirty);

      keyInput.addEventListener('input', () => {
        const matched = findAdvPreset(keyInput.value);
        descEl.textContent = matched ? matched.desc : '自定义 .env 环境变量';
        valInput.placeholder = matched ? matched.placeholder : '变量值';
        renderAdvancedEnvPresetBar();
        markDirty();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '🗑️ 删除';
      delBtn.addEventListener('click', () => {
        if (keyInput.value.trim()) {
          deletedEnvKeys.add(keyInput.value.trim());
        }
        row.remove();
        renderAdvancedEnvPresetBar();
        markDirty();
      });

      row.appendChild(keyCell);
      row.appendChild(valInput);
      row.appendChild(delBtn);
      container.appendChild(row);
      return row;
    }

    function isManagedEnvKey(k) {
      if (MANAGED_KEYS.has(k)) return true;
      if (configuredProviders.some((p) => p.envKeyName === k)) return true;
      return false;
    }

    function renderCustomEnvTable(envValues) {
      const container = document.getElementById('custom-env-list');
      container.replaceChildren();
      deletedEnvKeys.clear();

      for (const [k, v] of Object.entries(envValues)) {
        if (isManagedEnvKey(k)) continue;
        addCustomEnvRow(k, v);
      }
      renderAdvancedEnvPresetBar();
    }

    function stripTrailingSlash(str) {
      let s = (str || '').trim();
      while (s.length > 1 && s.endsWith('/')) {
        s = s.slice(0, -1);
      }
      return s;
    }

    let lastSyncedVaultRoot = '';

    function syncVaultRootDerivedDirs(newRoot) {
      const cleanNew = stripTrailingSlash(newRoot);
      if (!cleanNew) return;
      const wechatEl = document.getElementById('wechat-articles-dir');
      const ideasEl = document.getElementById('ideas-seeds-dir');
      if (/^(none|off|false|standalone)$/i.test(cleanNew)) {
        wechatEl.value = '';
        ideasEl.value = '';
        lastSyncedVaultRoot = cleanNew;
        return;
      }
      const cleanOld = stripTrailingSlash(lastSyncedVaultRoot);

      if (
        !wechatEl.value.trim() ||
        (cleanOld && wechatEl.value.trim() === cleanOld + '/01_inputs/articles/wechat')
      ) {
        wechatEl.value = cleanNew + '/01_inputs/articles/wechat';
      }
      if (
        !ideasEl.value.trim() ||
        (cleanOld && ideasEl.value.trim() === cleanOld + '/03_ideas/seeds')
      ) {
        ideasEl.value = cleanNew + '/03_ideas/seeds';
      }
      lastSyncedVaultRoot = cleanNew;
    }

    let lastVaultSubdirs = [];

    function renderVaultSubdirsStatus(subdirs) {
      const container = document.getElementById('vault-subdirs-status');
      if (!container) return;
      container.replaceChildren();
      const list = Array.isArray(subdirs) ? subdirs : [];
      lastVaultSubdirs = list;

      let missingCount = 0;
      for (const item of list) {
        if (!item.exists) missingCount++;
        const badge = document.createElement('span');
        badge.className = 'status-badge ' + (item.exists ? 'ok' : 'warn');
        badge.title = item.absPath || item.relPath;
        badge.textContent =
          (item.exists ? '✅ ' : '➕ 待创建: ') +
          item.relPath +
          ' (' +
          item.label +
          ')';
        container.appendChild(badge);
      }

      const initBtn = document.getElementById('init-vault-dirs-btn');
      const headerText = document.getElementById('vault-subdirs-header-text');
      if (initBtn) {
        if (list.length > 0 && missingCount === 0) {
          initBtn.disabled = true;
          initBtn.textContent = '✅ 子目录已完备（无需创建）';
          initBtn.title = '当前知识库下所有必要子目录均已存在，已自动跳过创建（安全保护：绝不删除或覆盖任何已有目录与文件）';
        } else if (missingCount > 0) {
          initBtn.disabled = false;
          initBtn.textContent = '✨ 补全缺失子目录 (' + missingCount + ' 项)';
          initBtn.title = '仅创建状态为「➕ 待创建」的缺失目录；已存在目录自动跳过，绝不删除或覆盖任何已有目录与文件';
        } else {
          initBtn.disabled = false;
          initBtn.textContent = '✨ 补全缺失子目录';
        }
      }
      if (headerText) {
        if (list.length > 0 && missingCount === 0) {
          headerText.textContent =
            '📁 必要子目录状态（全部已就绪 · 安全保护：已存在目录自动跳过，绝不删除或修改任何本地目录与文件）';
        } else if (missingCount > 0) {
          headerText.textContent =
            '📁 必要子目录状态（检测到 ' +
            missingCount +
            ' 个缺失目录 · 点击右上角仅增量补全缺失项，已存在目录与文件受严格保护）';
        }
      }
    }

    async function loadConfigFromServer() {
      const res = await fetch('/api/config');
      const data = await res.json();
      appState = data;

      document.getElementById('env-path-display').textContent = '配置文件路径: ' + data.envPath;

      configuredProviders = Array.isArray(data.config.llm.providers) && data.config.llm.providers.length > 0
        ? data.config.llm.providers.map((p) => ({
            ...p,
            models: Array.isArray(p.models) ? [...p.models] : []
          }))
        : [];

      const firstReady = configuredProviders.find(isProviderReadyForModels);
      activeProviderId = (firstReady || configuredProviders[0] || { id: 'gemini' }).id;

      const fastProvId = data.config.llm.fastProvider || data.config.llm.provider || activeProviderId;
      const proProvId = data.config.llm.proProvider || data.config.llm.provider || activeProviderId;
      selectedFastSpec = fastProvId + '::' + (data.config.llm.fastModel || 'gemini-2.5-flash');
      selectedProSpec = proProvId + '::' + (data.config.llm.proModel || 'gemini-2.5-pro');

      renderStatusStrip(data);
      renderPresetPills();
      renderProvidersList();
      renderModelDropdowns();

      document.getElementById('vault-root').value = data.config.vaultRoot;
      lastSyncedVaultRoot = stripTrailingSlash(data.config.vaultRoot);
      document.getElementById('wechat-articles-dir').value = data.config.wechatArticlesDir;
      document.getElementById('ideas-seeds-dir').value = data.config.ideasSeedsDir;
      document.getElementById('vault-home-note').value = (data.config.vaultLayout && data.config.vaultLayout.nowFile) || '00_home/now.md';
      document.getElementById('vault-focus-terms').value = ((data.config.vaultLayout && data.config.vaultLayout.domainKeywords) || []).join(', ');
      renderVaultSubdirsStatus(data.vaultSubdirs || []);

      customCliAgents = Array.isArray(data.config.llm.customCliAgents)
        ? [...data.config.llm.customCliAgents]
        : [];

      // Order discoveredClis so selected ones come first in priority order
      const selected = data.discoveredClis
        .filter((c) => c.enabledInRoute)
        .sort((a, b) => a.routePriority - b.routePriority);
      const unselected = data.discoveredClis.filter((c) => !c.enabledInRoute);
      discoveredClis = [...selected, ...unselected];

      renderCliList();
      updateRoutingPreview();
      renderCustomEnvTable(data.envValues || {});
      document.getElementById('dirty-indicator').textContent = '✅ 当前配置已与本地 .env 同步';
    }

    // Event Listeners
    document.getElementById('llm-fast-model').addEventListener('change', (e) => {
      selectedFastSpec = e.target.value;
      syncHiddenLlmInputs();
      updateRoutingPreview();
      markDirty();
    });

    document.getElementById('llm-pro-model').addEventListener('change', (e) => {
      selectedProSpec = e.target.value;
      syncHiddenLlmInputs();
      updateRoutingPreview();
      markDirty();
    });

    document.getElementById('rescan-cli-btn').addEventListener('click', async () => {
      const btn = document.getElementById('rescan-cli-btn');
      btn.disabled = true;
      btn.textContent = '⏳ 扫描中...';
      try {
        const res = await fetch('/api/config/scan-cli');
        const data = await res.json();
        if (data.ok) {
          const selectedIds = new Set(
            discoveredClis.filter((c) => c.enabledInRoute).map((c) => c.id)
          );
          discoveredClis = data.discoveredClis.map((c) => ({
            ...c,
            enabledInRoute: selectedIds.has(c.id)
          }));
          renderCliList();
          updateRoutingPreview();
          showToast('✅ 已重新扫描本机 AI Agent CLI，共发现 ' + discoveredClis.filter((c) => c.installed).length + ' 个已安装工具。');
        }
      } catch (err) {
        showToast('扫描 CLI 失败: ' + err, true);
      } finally {
        btn.disabled = false;
        btn.textContent = '🔍 重新扫描本机 CLI';
      }
    });

    document.getElementById('add-custom-cli-btn').addEventListener('click', () => {
      const id = document.getElementById('custom-cli-id').value.trim().toLowerCase();
      const binaryPath = document.getElementById('custom-cli-binary').value.trim();
      const argsTemplate = document.getElementById('custom-cli-template').value.trim();

      if (!id || !binaryPath || !argsTemplate) {
        showToast('请完整填写自定义 CLI 的标识 ID、可执行文件名与执行命令模板。', true);
        return;
      }

      const spec = {
        id,
        name: id + ' (Custom CLI)',
        binaryPath,
        argsTemplate
      };
      customCliAgents = [...customCliAgents.filter((c) => c.id !== id), spec];
      discoveredClis = [
        ...discoveredClis.filter((c) => c.id !== id),
        {
          ...spec,
          description: '用户自定义 AI Agent CLI (' + argsTemplate + ')',
          installed: true,
          enabledInRoute: true,
          routePriority: discoveredClis.filter((c) => c.enabledInRoute).length,
          capabilities: ['custom_cli'],
          isCustom: true
        }
      ];

      document.getElementById('custom-cli-id').value = '';
      document.getElementById('custom-cli-binary').value = '';
      document.getElementById('custom-cli-template').value = '';
      renderCliList();
      updateRoutingPreview();
      markDirty();
      showToast('✅ 已添加自定义 CLI [' + id + '] 到路由链，请点击底部「保存全部配置」持久化。');
    });

    document.getElementById('add-env-row-btn').addEventListener('click', () => {
      addCustomEnvRow('', '');
      markDirty();
    });

    async function testSelectedModelBySpec(spec, btnEl, tierLabel) {
      const out = document.getElementById('test-llm-result');
      const parsed = parseSpec(spec);
      const prov =
        configuredProviders.find((p) => p.id === parsed.providerId) ||
        configuredProviders[0];
      if (!prov || !parsed.model) {
        out.textContent = '⚠️ 请先配置供应商 API Key 并选择模型后再测试。';
        out.className = 'test-result-banner err';
        return;
      }

      btnEl.disabled = true;
      out.textContent = '⏳ 正在向 [' + shortProviderLabel(prov.name, prov.id) + '] 测试模型 ' + parsed.model + ' ...';
      out.className = 'test-result-banner pending';
      try {
        const res = await fetch('/api/config/test-llm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: prov.id,
            apiKey: prov.apiKey,
            baseUrl: prov.baseUrl,
            model: parsed.model
          })
        });
        const data = await res.json();
        if (data.ok) {
          out.textContent =
            '✅ ' +
            tierLabel +
            '连通成功 (' +
            data.latencyMs +
            'ms · ' +
            shortProviderLabel(prov.name, prov.id) +
            '/' +
            data.model +
            ') 响应: "' +
            data.replySample +
            '"';
          out.className = 'test-result-banner ok';
        } else {
          out.textContent = '❌ ' + tierLabel + '连通失败: ' + (data.error || '未知错误');
          out.className = 'test-result-banner err';
        }
      } catch (err) {
        out.textContent = '❌ 请求出错: ' + err;
        out.className = 'test-result-banner err';
      } finally {
        btnEl.disabled = false;
      }
    }

    document.getElementById('test-llm-btn').addEventListener('click', () => {
      testSelectedModelBySpec(
        document.getElementById('llm-fast-model').value,
        document.getElementById('test-llm-btn'),
        '快思模型'
      );
    });

    document.getElementById('test-pro-llm-btn').addEventListener('click', () => {
      testSelectedModelBySpec(
        document.getElementById('llm-pro-model').value,
        document.getElementById('test-pro-llm-btn'),
        '深思模型'
      );
    });

    document.getElementById('reload-config-btn').addEventListener('click', () => {
      loadConfigFromServer();
    });

    let inspectTimer = null;

    async function inspectCurrentVaultSubdirs() {
      const vaultRoot = document.getElementById('vault-root').value.trim();
      if (!vaultRoot) return;
      try {
        const wechatArticlesDir = document.getElementById('wechat-articles-dir').value.trim();
        const ideasSeedsDir = document.getElementById('ideas-seeds-dir').value.trim();
        const res = await fetch('/api/config/init-vault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vaultRoot,
            wechatArticlesDir,
            ideasSeedsDir,
            inspectOnly: true
          })
        });
        const data = await res.json();
        if (data.ok && Array.isArray(data.vaultSubdirs)) {
          renderVaultSubdirsStatus(data.vaultSubdirs);
        }
      } catch {}
    }

    function scheduleVaultInspect() {
      if (inspectTimer) clearTimeout(inspectTimer);
      inspectTimer = setTimeout(() => {
        inspectCurrentVaultSubdirs();
      }, 250);
    }

    document.getElementById('vault-root').addEventListener('input', (e) => {
      syncVaultRootDerivedDirs(e.target.value);
      scheduleVaultInspect();
    });

    document.getElementById('wechat-articles-dir').addEventListener('input', () => {
      scheduleVaultInspect();
    });

    document.getElementById('ideas-seeds-dir').addEventListener('input', () => {
      scheduleVaultInspect();
    });

    async function pickDirectoryForInput(inputId, promptTitle, isVaultRoot = false) {
      const inputEl = document.getElementById(inputId);
      const btnId =
        inputId === 'vault-root'
          ? 'pick-vault-root-btn'
          : inputId === 'wechat-articles-dir'
            ? 'pick-wechat-dir-btn'
            : 'pick-ideas-dir-btn';
      const btnEl = document.getElementById(btnId);
      const origText = btnEl.textContent;
      btnEl.disabled = true;
      btnEl.textContent = '⏳ 正在打开...';
      try {
        const res = await fetch('/api/config/pick-directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: promptTitle,
            defaultPath: inputEl.value.trim()
          })
        });
        const data = await res.json();
        if (data.cancelled) {
          return;
        }
        if (data.ok && data.path) {
          inputEl.value = data.path;
          if (isVaultRoot) {
            syncVaultRootDerivedDirs(data.path);
            if (Array.isArray(data.vaultSubdirs)) {
              renderVaultSubdirsStatus(data.vaultSubdirs);
            }
          } else {
            inspectCurrentVaultSubdirs();
          }
          markDirty();
          showToast('📂 已选择文件夹: ' + data.path + '（点击底部保存生效）');
        } else {
          showToast('❌ 选择文件夹失败: ' + (data.error || '未知错误'), true);
        }
      } catch (err) {
        showToast('❌ 打开系统文件夹选择器失败: ' + err, true);
      } finally {
        btnEl.disabled = false;
        btnEl.textContent = origText;
      }
    }

    document.getElementById('pick-vault-root-btn').addEventListener('click', () => {
      pickDirectoryForInput('vault-root', '请选择本地知识库根目录 (VAULT_ROOT)', true);
    });

    document.getElementById('use-standalone-vault-btn').addEventListener('click', () => {
      document.getElementById('vault-root').value = 'none';
      document.getElementById('wechat-articles-dir').value = '';
      document.getElementById('ideas-seeds-dir').value = '';
      deletedEnvKeys.add('VAULT_WECHAT_DIR');
      deletedEnvKeys.add('VAULT_IDEAS_DIR');
      lastSyncedVaultRoot = 'none';
      markDirty();
      showToast('🪶 已切换为「无知识库独立模式 (VAULT_ROOT=none)」，请点击底部保存配置生效。');
    });

    document.getElementById('pick-wechat-dir-btn').addEventListener('click', () => {
      pickDirectoryForInput('wechat-articles-dir', '请选择公众号文章存储目录', false);
    });

    document.getElementById('pick-ideas-dir-btn').addEventListener('click', () => {
      pickDirectoryForInput('ideas-seeds-dir', '请选择个人想法种子存储目录', false);
    });

    document.getElementById('init-vault-dirs-btn').addEventListener('click', async () => {
      const vaultRoot = document.getElementById('vault-root').value.trim();
      if (!vaultRoot) {
        showToast('请先填写或选择知识库根目录 (VAULT_ROOT)。', true);
        return;
      }
      const btn = document.getElementById('init-vault-dirs-btn');
      btn.disabled = true;
      btn.textContent = '⏳ 检查并补全缺失目录...';
      try {
        syncVaultRootDerivedDirs(vaultRoot);
        const wechatArticlesDir = document.getElementById('wechat-articles-dir').value.trim();
        const ideasSeedsDir = document.getElementById('ideas-seeds-dir').value.trim();
        const nowFile = document.getElementById('vault-home-note').value.trim() || '00_home/now.md';
        const res = await fetch('/api/config/init-vault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vaultRoot,
            wechatArticlesDir,
            ideasSeedsDir,
            nowFile
          })
        });
        const data = await res.json();
        if (data.ok) {
          document.getElementById('vault-root').value = data.vaultRoot;
          lastSyncedVaultRoot = stripTrailingSlash(data.vaultRoot);
          document.getElementById('wechat-articles-dir').value = data.wechatArticlesDir;
          document.getElementById('ideas-seeds-dir').value = data.ideasSeedsDir;
          renderVaultSubdirsStatus(data.vaultSubdirs || []);
          if (appState) {
            appState.vaultExists = true;
            renderStatusStrip(appState);
          }
          const createdCount = Array.isArray(data.createdDirs) ? data.createdDirs.length : 0;
          const skippedCount = Array.isArray(data.skippedDirs) ? data.skippedDirs.length : 0;
          const filesCount = Array.isArray(data.createdFiles) ? data.createdFiles.length : 0;
          if (createdCount > 0 || filesCount > 0) {
            showToast(
              '✨ 已安全补全 ' +
                createdCount +
                ' 个缺失子目录、跳过 ' +
                skippedCount +
                ' 个已存在目录（未触碰任何已有文件）！请点击底部保存配置。'
            );
          } else {
            showToast('✅ 所有必要子目录均已存在，已自动跳过，未改动任何已有目录或文件！');
          }
        } else {
          renderVaultSubdirsStatus(lastVaultSubdirs);
          showToast('❌ 补全子目录失败: ' + (data.error || '未知错误'), true);
        }
      } catch (err) {
        renderVaultSubdirsStatus(lastVaultSubdirs);
        showToast('❌ 请求补全子目录出错: ' + err, true);
      }
    });

    form.addEventListener('input', () => {
      markDirty();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      const saveBtn = document.getElementById('save-config-btn');
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ 正在写入 .env 并热重载...';

      try {
        syncHiddenLlmInputs();
        const fastParsed = parseSpec(document.getElementById('llm-fast-model').value);
        const proParsed = parseSpec(document.getElementById('llm-pro-model').value);
        const fastProv =
          configuredProviders.find((p) => p.id === fastParsed.providerId) ||
          configuredProviders[0];

        const updates = {
          LLM_PROVIDER: fastProv ? fastProv.id : 'custom',
          LLM_API_KEY: fastProv ? (fastProv.apiKey || '').trim() : '',
          LLM_BASE_URL: fastProv ? (fastProv.baseUrl || '').trim() : '',
          LLM_FAST_PROVIDER: fastParsed.providerId,
          LLM_FAST_MODEL: fastParsed.model,
          LLM_PRO_PROVIDER: proParsed.providerId,
          LLM_PRO_MODEL: proParsed.model,
          LLM_PROVIDERS_CONFIG: document.getElementById('llm-providers-config').value,
          CLI_ROUTING_CHAIN: document.getElementById('cli-routing-chain-input').value.trim(),
          CUSTOM_CLI_AGENTS: document.getElementById('custom-cli-agents-input').value.trim(),
          VAULT_ROOT: document.getElementById('vault-root').value.trim(),
          VAULT_WECHAT_DIR: document.getElementById('wechat-articles-dir').value.trim(),
          VAULT_IDEAS_DIR: document.getElementById('ideas-seeds-dir').value.trim(),
          VAULT_NOW_FILE: document.getElementById('vault-home-note').value.trim(),
          VAULT_DOMAIN_KEYWORDS: document.getElementById('vault-focus-terms').value.trim()
        };

        // Save each configured provider's API Key into its dedicated env variable
        for (const prov of configuredProviders) {
          if (prov.envKeyName && prov.apiKey && prov.apiKey.trim()) {
            updates[prov.envKeyName] = prov.apiKey.trim();
            deletedEnvKeys.delete(prov.envKeyName);
          }
        }

        // Collect custom .env rows
        const envRows = document.querySelectorAll('#custom-env-list .env-row');
        for (const row of envRows) {
          const inputs = row.querySelectorAll('input');
          if (inputs.length >= 2) {
            const k = inputs[0].value.trim();
            const v = inputs[1].value;
            if (k) {
              updates[k] = v;
              deletedEnvKeys.delete(k);
            }
          }
        }

        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates,
            deletedKeys: Array.from(deletedEnvKeys)
          })
        });
        const data = await res.json();
        if (data.ok) {
          appState = data;
          renderStatusStrip(data);
          renderVaultSubdirsStatus(data.vaultSubdirs || []);
          renderCustomEnvTable(data.envValues || {});
          document.getElementById('dirty-indicator').textContent =
            '✅ 已保存并同步至 .env (' + new Date().toLocaleTimeString() + ')';
          showToast('🎉 配置已成功保存到 .env 并热重载生效！多供应商模型与 CLI 路由链已更新。');
        } else {
          showToast('❌ 保存失败: ' + (data.error || '未知错误'), true);
        }
      } catch (err) {
        showToast('❌ 保存请求失败: ' + err, true);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 保存全部配置并热重载 (.env)';
      }
    });

    // Initial load
    loadConfigFromServer();
  </script>
</body>
</html>`;
}
