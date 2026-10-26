import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, sep } from "node:path";
import { AppConfig, CustomCliAgentConfig, expandHomePath } from "../config.ts";
import {
  callAgentLlm,
  getProModel,
  MultimodalImageInput,
} from "./llm.ts";

export type SubagentBackend =
  | "agy"
  | "codex"
  | "opencode"
  | "claude"
  | "gemini"
  | "workbuddy"
  | "aider"
  | (string & {});

export interface BuiltinCliDescriptor {
  id: string;
  name: string;
  envOverrideKey: string;
  binaryNames: string[];
  extraSearchDirs: string[];
  description: string;
  capabilities: string[];
}

export const BUILTIN_CLI_DESCRIPTORS: BuiltinCliDescriptor[] = [
  {
    id: "agy",
    name: "Antigravity CLI (agy)",
    envOverrideKey: "AGY_BIN",
    binaryNames: ["agy"],
    extraSearchDirs: [join(homedir(), ".local", "bin")],
    description: "支持多模态视觉读取、子智能体 image-generator 生图及知识库深读",
    capabilities: ["vision", "image_gen", "deep_research", "vault_edit"],
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI (codex)",
    envOverrideKey: "CODEX_BIN",
    binaryNames: ["codex"],
    extraSearchDirs: [join(homedir(), ".local", "bin")],
    description: "支持内置 image_gen 生图、本地仓库与知识库多文件深度治理、图片输入 (-i) 与非交互 exec 执行",
    capabilities: ["vision", "image_gen", "vault_edit", "code_edit", "deep_research"],
  },
  {
    id: "opencode",
    name: "OpenCode CLI (opencode)",
    envOverrideKey: "OPENCODE_BIN",
    binaryNames: ["opencode"],
    extraSearchDirs: [
      join(homedir(), ".opencode", "bin"),
      join(homedir(), ".local", "bin"),
    ],
    description: "支持 `opencode run --auto` 非交互执行、附件挂载 (-f) 与 OpenCode Go/Zen 多模型调度",
    capabilities: ["vision", "vault_edit", "code_edit", "deep_research"],
  },
  {
    id: "claude",
    name: "Claude Code CLI (claude)",
    envOverrideKey: "CLAUDE_BIN",
    binaryNames: ["claude"],
    extraSearchDirs: [
      join(homedir(), ".local", "bin"),
      join(homedir(), ".claude", "local"),
    ],
    description: "Anthropic 官方终端 Agent，支持 `-p` 非交互深度推理与跨目录知识库编辑",
    capabilities: ["vault_edit", "code_edit", "deep_research"],
  },
  {
    id: "gemini",
    name: "Google Gemini CLI (gemini)",
    envOverrideKey: "GEMINI_BIN",
    binaryNames: ["gemini"],
    extraSearchDirs: [join(homedir(), ".local", "bin")],
    description: "Google 官方终端 Agent，支持 `-p` 非交互模式与 `-y` 自动执行",
    capabilities: ["vault_edit", "deep_research"],
  },
  {
    id: "workbuddy",
    name: "WorkBuddy / CodeBuddy CLI (workbuddy)",
    envOverrideKey: "WORKBUDDY_BIN",
    binaryNames: ["workbuddy", "codebuddy", "cbc"],
    extraSearchDirs: [
      "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin",
      "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin",
      join(homedir(), ".workbuddy", "bin"),
      join(homedir(), ".local", "bin"),
    ],
    description: "腾讯 WorkBuddy / CodeBuddy 终端 Agent，支持 `-p -y` 非交互执行、跨目录工具调用与多模型切换",
    capabilities: ["vision", "image_gen", "vault_edit", "code_edit", "deep_research"],
  },
  {
    id: "aider",
    name: "Aider CLI (aider)",
    envOverrideKey: "AIDER_BIN",
    binaryNames: ["aider"],
    extraSearchDirs: [join(homedir(), ".local", "bin")],
    description: "经典终端 AI 结对编程与文档编辑工具（`aider --message ... --yes`）",
    capabilities: ["vault_edit", "code_edit"],
  },
];

export interface DiscoveredCliAgent {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  binaryPath: string;
  enabledInRoute: boolean;
  routePriority: number;
  capabilities: string[];
  isCustom?: boolean;
  argsTemplate?: string;
}

export interface SubagentRunRequest {
  config: AppConfig;
  backend: SubagentBackend;
  prompt: string;
  workingDir?: string;
  imagePaths?: string[];
  preferredModel?: string;
  expectGeneratedImage?: boolean;
  timeoutMs?: number;
  honorCooldownInTests?: boolean;
  onStageChange?: (
    stage: string,
    options?: { detail?: string; pushWeChat?: boolean; wechatMessage?: string }
  ) => Promise<void> | void;
  onActivity?: (detail: string) => void;
}

export interface SubagentRunResult {
  backend: SubagentBackend;
  modelUsed: string;
  outputText: string;
  generatedImages: string[];
  generatedFiles: string[];
}

export const CLI_COOLDOWN_TTL_MS = 3 * 60 * 1000;
const cliFailureCooldownMap = new Map<
  string,
  { failedAt: number; reason: string }
>();

export function recordCliBackendFailure(backend: string, reason: string, nowMs = Date.now()): void {
  cliFailureCooldownMap.set(backend.toLowerCase(), {
    failedAt: nowMs,
    reason,
  });
}

export function clearCliBackendFailure(backend: string): void {
  cliFailureCooldownMap.delete(backend.toLowerCase());
}

export function isCliBackendInCooldown(
  backend: string,
  nowMs = Date.now(),
  ttlMs = CLI_COOLDOWN_TTL_MS
): boolean {
  const entry = cliFailureCooldownMap.get(backend.toLowerCase());
  if (!entry) return false;
  if (nowMs - entry.failedAt >= ttlMs) {
    cliFailureCooldownMap.delete(backend.toLowerCase());
    return false;
  }
  return true;
}

export function resetCliBackendCooldowns(): void {
  cliFailureCooldownMap.clear();
}

type SubagentRunnerHook = (req: SubagentRunRequest) => Promise<SubagentRunResult>;
let customTestRunner: SubagentRunnerHook | null = null;

/**
 * Allow unit tests to intercept CLI subagent invocations deterministically.
 */
export function setSubagentTestRunner(runner: SubagentRunnerHook | null): void {
  customTestRunner = runner;
  resetCliBackendCooldowns();
}

function getStandardSearchDirs(): string[] {
  const home = homedir();
  const baseDirs = [
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const pathDirs = (process.env.PATH || "")
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...baseDirs, ...pathDirs]));
}

export function findBinaryOnSystem(
  binaryNames: string[],
  envOverrideKey?: string,
  extraDirs: string[] = []
): string | null {
  if (envOverrideKey && process.env[envOverrideKey]) {
    const custom = expandHomePath(process.env[envOverrideKey]!);
    if (existsSync(custom)) return custom;
  }
  const searchDirs = Array.from(
    new Set([...extraDirs, ...getStandardSearchDirs()])
  );
  for (const binName of binaryNames) {
    if (isAbsolute(binName) && existsSync(binName)) {
      return binName;
    }
    for (const dir of searchDirs) {
      const candidate = join(dir, binName);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
  }
  return null;
}

export function resolveAgyBinary(): string {
  return (
    findBinaryOnSystem(["agy"], "AGY_BIN", [join(homedir(), ".local", "bin")]) ||
    "agy"
  );
}

export function resolveCodexBinary(): string {
  return (
    findBinaryOnSystem(["codex"], "CODEX_BIN", [
      join(homedir(), ".local", "bin"),
    ]) || "codex"
  );
}

export function resolveOpenCodeBinary(): string {
  return (
    findBinaryOnSystem(["opencode"], "OPENCODE_BIN", [
      join(homedir(), ".opencode", "bin"),
      join(homedir(), ".local", "bin"),
    ]) || "opencode"
  );
}

export function resolveClaudeBinary(): string {
  return (
    findBinaryOnSystem(["claude"], "CLAUDE_BIN", [
      join(homedir(), ".local", "bin"),
    ]) || "claude"
  );
}

export function resolveGeminiBinary(): string {
  return (
    findBinaryOnSystem(["gemini"], "GEMINI_BIN", [
      join(homedir(), ".local", "bin"),
    ]) || "gemini"
  );
}

export function resolveWorkBuddyBinary(): string {
  return (
    findBinaryOnSystem(
      ["workbuddy", "codebuddy", "cbc"],
      "WORKBUDDY_BIN",
      [
        "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin",
        "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin",
        join(homedir(), ".workbuddy", "bin"),
        join(homedir(), ".local", "bin"),
      ]
    ) || "codebuddy"
  );
}

/**
 * Scan the local machine for all known and custom AI Agent CLIs,
 * returning only installed CLIs (plus user-added custom CLIs) by default.
 */
export function scanLocalAgentClis(
  config?: AppConfig,
  options?: { includeUninstalled?: boolean }
): DiscoveredCliAgent[] {
  const includeUninstalled = options?.includeUninstalled === true;
  const routingChain = (
    config?.llm.cliRoutingChain || [
      "agy",
      "codex",
      "opencode",
      "claude",
      "gemini",
      "workbuddy",
    ]
  ).map((s) => s.toLowerCase());
  const customList = config?.llm.customCliAgents || [];
  const results: DiscoveredCliAgent[] = [];

  for (const desc of BUILTIN_CLI_DESCRIPTORS) {
    const foundPath = findBinaryOnSystem(
      desc.binaryNames,
      desc.envOverrideKey,
      desc.extraSearchDirs
    );
    if (!foundPath && !includeUninstalled) {
      continue;
    }
    const routeIdx = routingChain.indexOf(desc.id.toLowerCase());
    results.push({
      id: desc.id,
      name: desc.name,
      description: desc.description,
      installed: Boolean(foundPath),
      binaryPath: foundPath || "",
      enabledInRoute: routeIdx >= 0,
      routePriority: routeIdx >= 0 ? routeIdx + 1 : 999,
      capabilities: desc.capabilities,
      isCustom: false,
    });
  }

  for (const custom of customList) {
    const id = custom.id.trim().toLowerCase();
    if (!id || results.some((r) => r.id === id)) continue;
    const expandedBin = expandHomePath(custom.binaryPath);
    const foundPath =
      existsSync(expandedBin)
        ? expandedBin
        : findBinaryOnSystem([custom.binaryPath]);
    const routeIdx = routingChain.indexOf(id);
    results.push({
      id,
      name: custom.name || `Custom CLI (${id})`,
      description: `自定义 CLI 智能体 (${custom.argsTemplate || "{{PROMPT}}"})`,
      installed: Boolean(foundPath),
      binaryPath: foundPath || custom.binaryPath,
      enabledInRoute: routeIdx >= 0,
      routePriority: routeIdx >= 0 ? routeIdx + 1 : 999,
      capabilities: ["custom_cli", "deep_research"],
      isCustom: true,
      argsTemplate: custom.argsTemplate,
    });
  }

  results.sort((a, b) => {
    if (a.enabledInRoute !== b.enabledInRoute) {
      return a.enabledInRoute ? -1 : 1;
    }
    if (a.routePriority !== b.routePriority) {
      return a.routePriority - b.routePriority;
    }
    if (a.installed !== b.installed) {
      return a.installed ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });

  return results;
}

/**
 * Pick the primary preferred CLI backend from the user's configured routing chain.
 */
export function getPreferredCliBackend(
  config: AppConfig,
  explicitHint?: SubagentBackend
): SubagentBackend {
  if (explicitHint) return explicitHint;
  const chain = config.llm.cliRoutingChain;
  if (chain && chain.length > 0) {
    return chain[0];
  }
  return "agy";
}

/**
 * Select the best AGY model based on user hint and task complexity.
 */
export function selectAgyModel(
  userText: string,
  complexity: "fast" | "deep"
): string {
  const lower = userText.toLowerCase();
  if (lower.includes("opus")) return "claude-opus-5-5-high";
  if (lower.includes("sonnet") || lower.includes("claude")) {
    return "claude-sonnet-5-5-high";
  }
  if (lower.includes("flash")) return "gemini-3.8-flash-high";
  return complexity === "deep" ? "gemini-4-argon-high" : "gemini-3.8-flash-medium";
}

export interface TieredExecutionParams {
  config: AppConfig;
  complexity: "fast" | "deep";
  forceCliFirst?: boolean;
  skipCliTier?: boolean;
  // A local file path is not evidence available to an API model.
  apiFallbackBlockedReason?: string;
  cliTimeoutMs?: number;
  preferredBackend?: SubagentBackend;
  preferredAgyModel?: string;
  cliPrompt?: string;
  workingDir?: string;
  imagePaths?: string[];
  expectGeneratedImage?: boolean;
  systemPrompt: string;
  userPrompt: string;
  images?: MultimodalImageInput[];
  enableWebSearch?: boolean;
  temperature?: number;
  onStageChange?: (
    stage: string,
    options?: { detail?: string; pushWeChat?: boolean; wechatMessage?: string }
  ) => Promise<void> | void;
  onActivity?: (detail: string) => void;
}

export interface TieredExecutionResult {
  text: string;
  modelUsed: string;
  tierPath: string[];
  generatedImages: string[];
  generatedFiles: string[];
  sources?: Array<{ title: string; uri: string }>;
}

/**
 * Execute a complex, visual, or image-generation task by delegating to local CLI agents
 * (`agy`, `codex`, `opencode`, `claude`, `gemini`, or custom CLIs).
 * Includes automatic multi-CLI fallback across the user's configured `cliRoutingChain`.
 */
export async function runCliSubagent(
  req: SubagentRunRequest
): Promise<SubagentRunResult> {
  if (customTestRunner && !req.config.llm.cliRoutingChain?.length) {
    return customTestRunner(req);
  }
  if (!req.config.llm.allowCodexFallback) {
    throw new Error("Local CLI subagent disabled (allowCodexFallback=false)");
  }

  const configuredChain = req.config.llm.cliRoutingChain?.length
    ? req.config.llm.cliRoutingChain
    : ["agy", "codex", "opencode", "claude", "gemini"];

  const orderedBackends = Array.from(
    new Set([req.backend, ...configuredChain])
  ).filter(Boolean);

  const dispatchSingleBackend = (backend: SubagentBackend): Promise<SubagentRunResult> => {
    if (customTestRunner) {
      return customTestRunner({ ...req, backend });
    }
    switch (backend) {
      case "agy":
        return executeAgyCli({ ...req, backend: "agy" });
      case "codex":
        return executeCodexCli({ ...req, backend: "codex" });
      case "opencode":
        return executeOpenCodeCli({ ...req, backend: "opencode" });
      case "claude":
        return executeClaudeCli({ ...req, backend: "claude" });
      case "gemini":
        return executeGeminiCli({ ...req, backend: "gemini" });
      case "workbuddy":
      case "codebuddy":
        return executeWorkBuddyCli({ ...req, backend: "workbuddy" });
      case "aider":
        return executeAiderCli({ ...req, backend: "aider" });
      default:
        return executeCustomCli({ ...req, backend });
    }
  };

  let primaryError: any = null;
  const rawCandidates = req.expectGeneratedImage
    ? orderedBackends.filter((b) => b === req.backend || b === "agy" || b === "codex")
    : orderedBackends;

  const shouldApplyCooldown = !customTestRunner || req.honorCooldownInTests === true;
  const candidatosToTry = shouldApplyCooldown
    ? [
        ...rawCandidates.filter((b) => !isCliBackendInCooldown(b)),
        ...rawCandidates.filter((b) => isCliBackendInCooldown(b)),
      ]
    : rawCandidates;

  for (let i = 0; i < candidatosToTry.length; i++) {
    const candidate = candidatosToTry[i];
    try {
      await req.onStageChange?.(
        `正在调用本地智能体 [${candidate}] 执行深度任务`,
        { detail: "等待子智能体启动与推理输出" }
      );
      const res = await dispatchSingleBackend(candidate);
      clearCliBackendFailure(candidate);
      if (candidate !== req.backend) {
        return {
          ...res,
          modelUsed: `${res.modelUsed} (fallback from ${req.backend})`,
        };
      }
      return res;
    } catch (err: any) {
      recordCliBackendFailure(candidate, err?.message || String(err));
      if (i === 0) primaryError = err;
      if (i + 1 < candidatosToTry.length) {
        const nextCli = candidatosToTry[i + 1];
        console.warn(
          `[SubagentCLI] CLI (${candidate}) failed (${err?.message || err}); trying next CLI in routing chain (${nextCli})`
        );
        await req.onStageChange?.(
          `本地智能体 [${candidate}] 未完成，已自动切换至备用智能体 [${nextCli}]`,
          {
            detail: "路由链自动故障转移中",
            pushWeChat: true,
            wechatMessage: `🔄 本地智能体 [${candidate}] 响应超时或受限，系统已自动切换至备用智能体 [${nextCli}] 继续执行，任务未中断…`,
          }
        );
      }
    }
  }

  throw primaryError || new Error("No available local CLI subagent succeeded");
}

/**
 * Unified Hierarchical Execution Engine:
 * - If `complexity === "fast"` and `!forceCliFirst`:
 *     Directly calls Fast API model.
 * - If `complexity === "deep"` or `forceCliFirst === true`:
 *     Tier 1: Local CLI Subagent (`agy` / `codex` / `opencode` / `claude` / `gemini` per routing chain)
 *       ↓ (if local CLI is unavailable / fails / times out)
 *     Tier 2: Pro API Model
 *       ↓ (if Pro model is unavailable / quota exceeded / fails)
 *     Tier 3: Fast API Model
 */
export async function executeTieredAgentTask(
  params: TieredExecutionParams
): Promise<TieredExecutionResult> {
  const tierPath: string[] = [];
  const shouldTryCliFirst =
    !params.skipCliTier &&
    (params.forceCliFirst === true || params.complexity === "deep");

  // 1. Lightweight fast tasks go directly to fast model
  if (!shouldTryCliFirst && params.complexity === "fast") {
    if (params.apiFallbackBlockedReason) throw new Error(params.apiFallbackBlockedReason);
    const fastRes = await callAgentLlm({
      config: params.config,
      tier: "fast",
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      images: params.images,
      enableWebSearch: params.enableWebSearch,
      temperature: params.temperature,
    });
    tierPath.push(`fast:${fastRes.modelUsed}(ok)`);
    return {
      text: fastRes.text,
      modelUsed: fastRes.modelUsed,
      tierPath,
      generatedImages: [],
      generatedFiles: [],
      sources: fastRes.sources,
    };
  }

  // 2. Deep / Multimodal / Subagent tasks:
  //    Tier 1: Local CLI Subagent (unless skipCliTier is true)
  const backend: SubagentBackend = getPreferredCliBackend(
    params.config,
    params.preferredBackend
  );
  if (shouldTryCliFirst) {
    const cliPrompt =
      params.cliPrompt ||
      `${params.systemPrompt}\n\n${params.userPrompt}`;

    try {
      const cliRes = await runCliSubagent({
        config: params.config,
        backend,
        preferredModel:
          params.preferredAgyModel ||
          selectAgyModel(params.userPrompt, params.complexity),
        prompt: cliPrompt,
        workingDir: params.workingDir || params.config.vaultRoot,
        imagePaths: params.imagePaths,
        expectGeneratedImage: params.expectGeneratedImage,
        timeoutMs: params.cliTimeoutMs,
        onStageChange: params.onStageChange,
        onActivity: params.onActivity,
      });
      tierPath.push(`cli:${cliRes.modelUsed}(ok)`);
      return {
        text: cliRes.outputText,
        modelUsed: cliRes.modelUsed,
        tierPath,
        generatedImages: cliRes.generatedImages,
        generatedFiles: cliRes.generatedFiles,
      };
    } catch (cliErr: any) {
      tierPath.push(`cli:${backend}(failed:${cliErr?.message || cliErr})`);
      if (params.apiFallbackBlockedReason) throw new Error(params.apiFallbackBlockedReason);
      const proModelName = getProModel(params.config);
      console.warn(
        `[TieredRouter] Tier 1 Local CLI (${backend}) unavailable (${cliErr?.message || cliErr}); degrading to Tier 2 Pro model (${proModelName})`
      );
      await params.onStageChange?.(
        `正在调用云端深度模型 [${proModelName}] 合成内容`,
        {
          detail: `本地 CLI (${backend}) 已降级切换至 Tier 2 Pro 模型`,
          pushWeChat: Boolean(params.config.llm.allowCodexFallback),
          wechatMessage: `🔄 本地 CLI 智能体未完成交付，已自动切换至云端深度模型 [${proModelName}] 继续为你合成结果，任务正在处理中…`,
        }
      );
    }
  } else {
    if (params.apiFallbackBlockedReason) throw new Error(params.apiFallbackBlockedReason);
    const proModelName = getProModel(params.config);
    await params.onStageChange?.(
      `正在调用深度模型 [${proModelName}] 撰写与推演内容`,
      { detail: "正在生成结构化长文内容" }
    );
  }

  //    Tier 2 -> Tier 3: Pro API Model -> Fast API Model
  if (!params.config.llm.apiKey) {
    throw new Error(
      `Local CLI (${backend}) unavailable and LLM_API_KEY is not configured (${tierPath.join(" -> ")})`
    );
  }

  const llmRes = await callAgentLlm({
    config: params.config,
    tier: "deep",
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
    images: params.images,
    enableWebSearch: params.enableWebSearch,
    temperature: params.temperature,
    timeoutMs: 180_000,
  });

  tierPath.push(`api:${llmRes.modelUsed}(ok)`);
  return {
    text: llmRes.text,
    modelUsed: llmRes.modelUsed,
    tierPath,
    generatedImages: [],
    generatedFiles: [],
    sources: llmRes.sources,
  };
}

async function executeAgyCli(req: SubagentRunRequest): Promise<SubagentRunResult> {
  const agyBin = resolveAgyBinary();
  const model = req.preferredModel || "gemini-4-argon-high";
  const generatedDir = join(req.config.dataDir, "generated");
  mkdirSync(generatedDir, { recursive: true });

  const startMs = Date.now();
  const workDir = req.workingDir || req.config.vaultRoot;
  const timeoutMs = req.timeoutMs ?? (req.expectGeneratedImage ? 240_000 : 150_000);

  let fullPrompt = req.prompt;
  if (req.imagePaths && req.imagePaths.length > 0) {
    fullPrompt += `\n\n【待读取的本地媒体文件绝对路径（请使用 read_file 工具直接读取分析）】\n${req.imagePaths
      .map((p) => `- ${p}`)
      .join("\n")}`;
  }
  const expectedArtifacts: string[] = [];
  if (req.expectGeneratedImage) {
    const targetImgPath = join(
      generatedDir,
      `agy_img_${new Date().toISOString().slice(0, 10).replace(/-/g, "_")}_${randomUUID().slice(0, 8)}.png`
    );
    expectedArtifacts.push(targetImgPath);
    fullPrompt += `\n\n【图片生成输出要求】\n请调用你的 image-generator 子智能体（或生图工具）生成图片，并将最终图片文件保存到（或复制到）此目录：${generatedDir}（建议路径：${targetImgPath}），并在回复末尾附上生成的图片完整绝对路径。`;
  }

  const buildArgs = (includeModel: boolean): string[] => {
    const cliArgs = [
      "--print",
      fullPrompt,
      "--dangerously-skip-permissions",
    ];
    if (includeModel && model) {
      cliArgs.push("--model", model);
    }
    const agyBrainDir = join(homedir(), ".gemini", "antigravity", "brain");
    cliArgs.push(
      "--add-dir",
      req.config.vaultRoot,
      "--add-dir",
      req.config.dataDir,
      "--add-dir",
      generatedDir,
      ...(existsSync(agyBrainDir) ? ["--add-dir", agyBrainDir] : [])
    );
    return cliArgs;
  };

  const effectiveCwd = existsSync(workDir) ? workDir : req.config.projectRoot;
  let { cleanOut, stderrText, exitCode, timedOut } = await spawnCliWithTimeout(
    agyBin,
    buildArgs(true),
    effectiveCwd,
    timeoutMs,
    undefined,
    req.onActivity
  );

  let usedDefaultModel = false;
  // If the configured/selected model ID is not recognized by the user's current AGY CLI version,
  // automatically retry without `--model` so AGY uses its built-in default model.
  if (
    exitCode !== 0 &&
    /invalid model selection|not recognized as a known model/i.test(stderrText)
  ) {
    usedDefaultModel = true;
    ({ cleanOut, stderrText, exitCode, timedOut } = await spawnCliWithTimeout(
      agyBin,
      buildArgs(false),
      effectiveCwd,
      timeoutMs,
      undefined,
      req.onActivity
    ));
  }

  const { images, files } = discoverGeneratedArtifacts(
    generatedDir,
    cleanOut,
    startMs,
    req.config.vaultRoot,
    expectedArtifacts
  );

  // A process failure stays a failure even if a file happens to exist.
  if (timedOut) {
    throw new Error(`AGY CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
  }
  if (exitCode !== 0) {
    throw new Error(`AGY CLI exited with code ${exitCode}: ${stderrText.slice(0, 300)}`);
  }
  if (req.expectGeneratedImage && images.length === 0) {
    throw new Error("AGY CLI produced no attributable image; save the image to the requested output path");
  }

  if (!cleanOut && images.length === 0 && files.length === 0) {
    throw new Error(
      `AGY CLI returned empty output and produced no artifacts`
    );
  }

  return {
    backend: "agy",
    modelUsed: usedDefaultModel ? `agy (default/unknown; fallback from ${model})` : `agy (${model})`,
    outputText: cleanOut || `（AGY 子智能体已完成并生成 ${files.length + images.length} 个文件）`,
    generatedImages: images,
    generatedFiles: files,
  };
}

async function executeCodexCli(req: SubagentRunRequest): Promise<SubagentRunResult> {
  const codexBin = resolveCodexBinary();
  const workDir = req.workingDir || req.config.vaultRoot;
  const generatedDir = join(req.config.dataDir, "generated");
  mkdirSync(generatedDir, { recursive: true });

  const startMs = Date.now();
  const timeoutMs = req.timeoutMs ?? 180_000;
  const lastMsgFile = join(tmpdir(), `codex_last_msg_${randomUUID()}.txt`);

  let fullPrompt = req.prompt;
  const expectedArtifacts: string[] = [];
  if (req.expectGeneratedImage) {
    const targetImgPath = join(
      generatedDir,
      `codex_img_${new Date().toISOString().slice(0, 10).replace(/-/g, "_")}_${randomUUID().slice(0, 8)}.png`
    );
    expectedArtifacts.push(targetImgPath);
    fullPrompt += `\n\n【图片生成输出要求】\n请优先直接调用你内置的 image_gen 工具（无需 OPENAI_API_KEY）生成图片，并将最终图片文件保存到（或复制到）此目录：${generatedDir}（建议路径：${targetImgPath}），并在回复末尾附上生成的图片完整绝对路径。`;
  }

  const codexGenImgDir = join(homedir(), ".codex", "generated_images");
  const args: string[] = [
    "exec",
    "-C",
    existsSync(workDir) ? workDir : req.config.projectRoot,
    "--add-dir",
    req.config.vaultRoot,
    "--add-dir",
    req.config.dataDir,
    "--add-dir",
    generatedDir,
    ...(existsSync(codexGenImgDir) ? ["--add-dir", codexGenImgDir] : []),
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-o",
    lastMsgFile,
  ];

  if (req.imagePaths && req.imagePaths.length > 0) {
    for (const img of req.imagePaths) {
      if (existsSync(img)) {
        args.push("-i", img);
      }
    }
  }

  args.push(fullPrompt);

  const { cleanOut, stderrText, exitCode, timedOut } = await spawnCliWithTimeout(
    codexBin,
    args,
    existsSync(workDir) ? workDir : req.config.projectRoot,
    timeoutMs,
    undefined,
    req.onActivity
  );

  let outputText = "";
  if (existsSync(lastMsgFile)) {
    try {
      outputText = readFileSync(lastMsgFile, "utf-8").trim();
    } catch {}
    try {
      unlinkSync(lastMsgFile);
    } catch {}
  }
  if (!outputText) {
    outputText = cleanOut;
  }

  const { images, files } = discoverGeneratedArtifacts(
    generatedDir,
    outputText,
    startMs,
    req.config.vaultRoot,
    expectedArtifacts
  );

  if (timedOut) {
    throw new Error(
      `Codex CLI timed out after ${Math.round(timeoutMs / 1000)}s without completing final output`
    );
  }

  if (exitCode !== 0) {
    throw new Error(
      `Codex CLI exited with code ${exitCode}: ${stderrText.slice(0, 300)}`
    );
  }

  if (req.expectGeneratedImage && images.length === 0) {
    throw new Error(
      "Codex CLI produced no attributable image; save the image to the requested output path"
    );
  }

  if (!outputText && images.length === 0 && files.length === 0) {
    throw new Error(
      `Codex CLI returned empty output and produced no artifacts`
    );
  }

  return {
    backend: "codex",
    modelUsed: "codex-cli",
    outputText: outputText || `（Codex 子智能体已完成并生成 ${files.length + images.length} 个文件）`,
    generatedImages: images,
    generatedFiles: files,
  };
}

async function executeOpenCodeCli(
  req: SubagentRunRequest
): Promise<SubagentRunResult> {
  const opencodeBin = resolveOpenCodeBinary();
  const workDir = req.workingDir || req.config.vaultRoot;
  const generatedDir = join(req.config.dataDir, "generated");
  mkdirSync(generatedDir, { recursive: true });

  const startMs = Date.now();
  const timeoutMs = req.timeoutMs ?? 180_000;
  const effectiveDir = existsSync(workDir) ? workDir : req.config.projectRoot;

  const args: string[] = ["run", "--dir", effectiveDir, "--auto"];
  if (req.imagePaths && req.imagePaths.length > 0) {
    for (const img of req.imagePaths) {
      if (existsSync(img)) {
        args.push("-f", img);
      }
    }
  }
  args.push(req.prompt);

  const { cleanOut, stderrText, exitCode, timedOut } = await spawnCliWithTimeout(
    opencodeBin,
    args,
    effectiveDir,
    timeoutMs,
    undefined,
    req.onActivity
  );

  const { images, files } = discoverGeneratedArtifacts(
    generatedDir,
    cleanOut,
    startMs,
    req.config.vaultRoot
  );

  if (timedOut) {
    throw new Error(`OpenCode CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  if (exitCode !== 0) {
    throw new Error(
      `OpenCode CLI exited with code ${exitCode}: ${stderrText.slice(0, 300)}`
    );
  }

  if (!cleanOut && images.length === 0 && files.length === 0) {
    throw new Error(`OpenCode CLI returned empty output and no artifacts`);
  }

  return {
    backend: "opencode",
    modelUsed: "opencode-cli",
    outputText: cleanOut || `（OpenCode 子智能体已完成并生成 ${files.length + images.length} 个文件）`,
    generatedImages: images,
    generatedFiles: files,
  };
}

async function executeClaudeCli(
  req: SubagentRunRequest
): Promise<SubagentRunResult> {
  const claudeBin = resolveClaudeBinary();
  const workDir = req.workingDir || req.config.vaultRoot;
  const generatedDir = join(req.config.dataDir, "generated");
  mkdirSync(generatedDir, { recursive: true });

  const startMs = Date.now();
  const timeoutMs = req.timeoutMs ?? 180_000;
  const effectiveDir = existsSync(workDir) ? workDir : req.config.projectRoot;

  let fullPrompt = req.prompt;
  if (req.imagePaths && req.imagePaths.length > 0) {
    fullPrompt += `\n\n【待读取的本地媒体文件路径】\n${req.imagePaths
      .map((p) => `- ${p}`)
      .join("\n")}`;
  }

  const args: string[] = [
    "-p",
    "--dangerously-skip-permissions",
    "--add-dir",
    req.config.vaultRoot,
    "--add-dir",
    req.config.dataDir,
    fullPrompt,
  ];

  const { cleanOut, stderrText, exitCode, timedOut } = await spawnCliWithTimeout(
    claudeBin,
    args,
    effectiveDir,
    timeoutMs,
    undefined,
    req.onActivity
  );

  const { images, files } = discoverGeneratedArtifacts(
    generatedDir,
    cleanOut,
    startMs,
    req.config.vaultRoot
  );

  if (timedOut) {
    throw new Error(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  if (exitCode !== 0) {
    throw new Error(
      `Claude CLI exited with code ${exitCode}: ${stderrText.slice(0, 300)}`
    );
  }

  if (!cleanOut && images.length === 0 && files.length === 0) {
    throw new Error(`Claude CLI returned empty output and no artifacts`);
  }

  return {
    backend: "claude",
    modelUsed: "claude-cli",
    outputText: cleanOut || `（Claude Code 子智能体已完成并生成 ${files.length + images.length} 个文件）`,
    generatedImages: images,
    generatedFiles: files,
  };
}

async function executeGeminiCli(
  req: SubagentRunRequest
): Promise<SubagentRunResult> {
  const geminiBin = resolveGeminiBinary();
  const workDir = req.workingDir || req.config.vaultRoot;
  const generatedDir = join(req.config.dataDir, "generated");
  mkdirSync(generatedDir, { recursive: true });

  const startMs = Date.now();
  const timeoutMs = req.timeoutMs ?? 150_000;
  const effectiveDir = existsSync(workDir) ? workDir : req.config.projectRoot;

  const args: string[] = ["-p", req.prompt, "-y"];
  const { cleanOut, stderrText, exitCode, timedOut } = await spawnCliWithTimeout(
    geminiBin,
    args,
    effectiveDir,
    timeoutMs,
    undefined,
    req.onActivity
  );

  const { images, files } = discoverGeneratedArtifacts(
    generatedDir,
    cleanOut,
    startMs,
    req.config.vaultRoot
  );

  if (timedOut) {
    throw new Error(`Gemini CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  if (exitCode !== 0) {
    throw new Error(
      `Gemini CLI exited with code ${exitCode}: ${stderrText.slice(0, 300)}`
    );
  }

  if (!cleanOut && images.length === 0 && files.length === 0) {
    throw new Error(`Gemini CLI returned empty output and no artifacts`);
  }

  return {
    backend: "gemini",
    modelUsed: "gemini-cli",
    outputText: cleanOut || `（Gemini CLI 子智能体已完成并生成 ${files.length + images.length} 个文件）`,
    generatedImages: images,
    generatedFiles: files,
  };
}

async function executeWorkBuddyCli(
  req: SubagentRunRequest
): Promise<SubagentRunResult> {
  const workbuddyBin = resolveWorkBuddyBinary();
  const workDir = req.workingDir || req.config.vaultRoot;
  const generatedDir = join(req.config.dataDir, "generated");
  mkdirSync(generatedDir, { recursive: true });

  const startMs = Date.now();
  const timeoutMs = req.timeoutMs ?? 180_000;
  const effectiveDir = existsSync(workDir) ? workDir : req.config.projectRoot;

  let effectivePrompt = req.prompt;
  if (req.imagePaths && req.imagePaths.length > 0) {
    effectivePrompt = `${req.prompt}\n\n请读取并分析以下本地附件文件：\n${req.imagePaths
      .map((p) => `- ${p}`)
      .join("\n")}`;
  }

  const args: string[] = [
    "-p",
    "-y",
    "--add-dir",
    req.config.vaultRoot,
    "--add-dir",
    generatedDir,
    effectivePrompt,
  ];

  const { cleanOut, stderrText, exitCode, timedOut } = await spawnCliWithTimeout(
    workbuddyBin,
    args,
    effectiveDir,
    timeoutMs,
    { CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1" },
    req.onActivity
  );

  const { images, files } = discoverGeneratedArtifacts(
    generatedDir,
    cleanOut,
    startMs,
    req.config.vaultRoot
  );

  if (timedOut) {
    throw new Error(`WorkBuddy CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  if (exitCode !== 0) {
    throw new Error(
      `WorkBuddy CLI exited with code ${exitCode}: ${stderrText.slice(0, 300)}`
    );
  }

  if (!cleanOut && images.length === 0 && files.length === 0) {
    throw new Error(`WorkBuddy CLI returned empty output and no artifacts`);
  }

  return {
    backend: "workbuddy",
    modelUsed: "workbuddy-cli",
    outputText: cleanOut || `（WorkBuddy 子智能体已完成并生成 ${files.length + images.length} 个文件）`,
    generatedImages: images,
    generatedFiles: files,
  };
}

async function executeAiderCli(
  req: SubagentRunRequest
): Promise<SubagentRunResult> {
  const aiderBin =
    findBinaryOnSystem(["aider"], "AIDER_BIN", [
      join(homedir(), ".local", "bin"),
    ]) || "aider";
  const workDir = req.workingDir || req.config.vaultRoot;
  const generatedDir = join(req.config.dataDir, "generated");
  mkdirSync(generatedDir, { recursive: true });

  const startMs = Date.now();
  const timeoutMs = req.timeoutMs ?? 150_000;
  const effectiveDir = existsSync(workDir) ? workDir : req.config.projectRoot;

  const args: string[] = ["--message", req.prompt, "--yes", "--no-git"];
  const { cleanOut, stderrText, exitCode, timedOut } = await spawnCliWithTimeout(
    aiderBin,
    args,
    effectiveDir,
    timeoutMs,
    undefined,
    req.onActivity
  );

  const { images, files } = discoverGeneratedArtifacts(
    generatedDir,
    cleanOut,
    startMs,
    req.config.vaultRoot
  );

  if (timedOut) {
    throw new Error(`Aider CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  if (exitCode !== 0) {
    throw new Error(
      `Aider CLI exited with code ${exitCode}: ${stderrText.slice(0, 300)}`
    );
  }

  if (!cleanOut && images.length === 0 && files.length === 0) {
    throw new Error(`Aider CLI returned empty output and no artifacts`);
  }

  return {
    backend: "aider",
    modelUsed: "aider-cli",
    outputText: cleanOut || `（Aider 子智能体已完成并生成 ${files.length + images.length} 个文件）`,
    generatedImages: images,
    generatedFiles: files,
  };
}

async function executeCustomCli(
  req: SubagentRunRequest
): Promise<SubagentRunResult> {
  const customCfg: CustomCliAgentConfig | undefined =
    req.config.llm.customCliAgents?.find(
      (c) => c.id.toLowerCase() === String(req.backend).toLowerCase()
    );

  const bin = customCfg
    ? expandHomePath(customCfg.binaryPath)
    : findBinaryOnSystem([String(req.backend)]) || String(req.backend);
  const workDir = req.workingDir || req.config.vaultRoot;
  const effectiveDir = existsSync(workDir) ? workDir : req.config.projectRoot;
  const generatedDir = join(req.config.dataDir, "generated");
  mkdirSync(generatedDir, { recursive: true });

  const startMs = Date.now();
  const timeoutMs = req.timeoutMs ?? 150_000;
  const template = customCfg?.argsTemplate || "{{PROMPT}}";
  const tokens = template
    .split(/\s+/)
    .filter(Boolean)
    .map((t) =>
      t
        .replace(/\{\{PROMPT\}\}/g, req.prompt)
        .replace(/\{\{WORKDIR\}\}/g, effectiveDir)
        .replace(/\{\{VAULT\}\}/g, req.config.vaultRoot)
    );
  if (!template.includes("{{PROMPT}}")) {
    tokens.push(req.prompt);
  }

  const { cleanOut, stderrText, exitCode, timedOut } = await spawnCliWithTimeout(
    bin,
    tokens,
    effectiveDir,
    timeoutMs,
    undefined,
    req.onActivity
  );

  const { images, files } = discoverGeneratedArtifacts(
    generatedDir,
    cleanOut,
    startMs,
    req.config.vaultRoot
  );

  if (timedOut) {
    throw new Error(`Custom CLI (${req.backend}) timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  if (exitCode !== 0) {
    throw new Error(
      `Custom CLI (${req.backend}) exited with code ${exitCode}: ${stderrText.slice(0, 300)}`
    );
  }

  if (!cleanOut && images.length === 0 && files.length === 0) {
    throw new Error(`Custom CLI (${req.backend}) returned empty output and no artifacts`);
  }

  return {
    backend: req.backend,
    modelUsed: `${req.backend}-cli`,
    outputText: cleanOut || `（${req.backend} 子智能体已完成并生成 ${files.length + images.length} 个文件）`,
    generatedImages: images,
    generatedFiles: files,
  };
}

export async function spawnCliWithTimeout(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
  onActivity?: (detail: string) => void
): Promise<{
  cleanOut: string;
  stderrText: string;
  exitCode: number;
  timedOut: boolean;
}> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...buildRichDaemonEnv(), ...(extraEnv || {}) },
    });
  } catch (err: any) {
    throw new Error(`Failed to spawn CLI binary '${bin}': ${err?.message || err}`);
  }

  let timedOut = false;
  let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;
  let forceAbortStreams: (() => void) | null = null;
  const streamAbortPromise = new Promise<{ done: true; value: undefined }>(
    (resolve) => {
      forceAbortStreams = () => resolve({ done: true, value: undefined });
    }
  );

  const killProcessTree = (signal: "TERM" | "KILL") => {
    try {
      if (!process.env.WXCTX_TEST_ROOT && proc.pid && process.platform !== "win32") {
        Bun.spawnSync(["pkill", `-${signal}`, "-P", String(proc.pid)], {
          stdout: "ignore",
          stderr: "ignore",
        });
      }
    } catch {}
    try {
      proc.kill(signal === "KILL" ? 9 : 15);
    } catch {}
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree("TERM");
    const graceMs = Math.min(2000, Math.max(150, Math.floor(timeoutMs / 2)));
    killEscalationTimer = setTimeout(() => {
      killProcessTree("KILL");
      forceAbortStreams?.();
    }, graceMs);
  }, timeoutMs);

  let totalBytes = 0;
  let lastLine = "";

  const consumeStream = async (
    stream: ReadableStream<Uint8Array> | null | undefined
  ): Promise<string> => {
    if (!stream) return "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    try {
      while (true) {
        const { done, value } = await Promise.race([
          reader.read(),
          streamAbortPromise,
        ]);
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          const decoded = decoder.decode(value, { stream: true });
          chunks.push(decoded);
          if (onActivity) {
            const lines = decoded
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean);
            if (lines.length > 0) {
              lastLine = lines[lines.length - 1];
            }
            const kb = (totalBytes / 1024).toFixed(1);
            const snippet = lastLine
              ? ` · 最新动态：${lastLine.slice(0, 50)}`
              : "";
            onActivity(`已产生流式输出 ${kb} KB${snippet}`);
          }
        }
      }
      chunks.push(decoder.decode());
    } catch {} finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    return chunks.join("");
  };

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    consumeStream(proc.stdout as ReadableStream<Uint8Array>),
    consumeStream(proc.stderr as ReadableStream<Uint8Array>),
    Promise.race([
      proc.exited,
      streamAbortPromise.then(() => -1),
    ]),
  ]);
  clearTimeout(timer);
  if (killEscalationTimer) clearTimeout(killEscalationTimer);

  return {
    cleanOut: stdoutText.trim(),
    stderrText: stderrText.trim(),
    exitCode,
    timedOut,
  };
}

export function discoverGeneratedArtifacts(
  generatedDir: string,
  outputText: string,
  sinceMs: number,
  vaultRoot?: string,
  expectedPaths: string[] = []
): { images: string[]; files: string[] } {
  const imageSet = new Set<string>();
  const fileSet = new Set<string>();
  const allowedRoots = [generatedDir, vaultRoot].filter(
    (root): root is string => Boolean(root && existsSync(root))
  ).map(root => realpathSync(root));

  const registerCandidateFile = (candidatePath: string) => {
    if (!existsSync(candidatePath)) return;
    try {
      const actualPath = realpathSync(candidatePath);
      if (!allowedRoots.some(root => {
        const rel = relative(root, actualPath);
        return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      })) return;
      const st = statSync(candidatePath);
      if (!st.isFile() || st.size === 0) return;
      if (st.mtimeMs >= sinceMs - 2500) {
        if (isImagePath(candidatePath)) {
          imageSet.add(candidatePath);
        } else if (isDeliverableDocPath(candidatePath)) {
          fileSet.add(candidatePath);
        }
      }
    } catch {}
  };

  for (const expected of expectedPaths) {
    registerCandidateFile(expected);
  }

  // Only paths explicitly returned by this task are eligible, never every
  // recently modified file in shared output directories.
  const absMatches =
    outputText.match(
      /\/(?:Users|Volumes|home|tmp|var|opt|private|mnt|srv)\/[^\s"'`<>()[\]，。；！!]+\.[a-zA-Z0-9]{2,8}/g
    ) ?? [];
  for (const candidate of absMatches) {
    registerCandidateFile(candidate);
  }

  // 3. Scan outputText for vault-relative paths (e.g. 05_outputs/research_notes/xxx.md or outputs/research_notes/xxx.md)
  if (vaultRoot && existsSync(vaultRoot)) {
    const relMatches =
      outputText.match(
        /(?:00_home|01_inputs|02_conversations|03_ideas|04_topics|05_outputs|_system|outputs|wechat|web|inbox|papers|ideas)\/[^\s"'`<>()[\]，。；！!]+\.[a-zA-Z0-9]{2,8}/g
      ) ?? [];
    for (const rel of relMatches) {
      registerCandidateFile(join(vaultRoot, rel));
    }
  }

  return {
    images: Array.from(imageSet),
    files: Array.from(fileSet),
  };
}

function isImagePath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
}

function isDeliverableDocPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return [
    ".md",
    ".html",
    ".htm",
    ".pdf",
    ".docx",
    ".txt",
    ".csv",
    ".json",
    ".zip",
  ].includes(ext);
}

function buildRichDaemonEnv(): Record<string, string> {
  const home = homedir();
  const extraPaths = [
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ];
  const currentPath = process.env.PATH || "";
  return {
    ...process.env,
    HOME: home,
    PATH: `${extraPaths.join(delimiter)}${delimiter}${currentPath}`,
  } as Record<string, string>;
}
