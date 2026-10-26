#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { auditSkillsDirectoryHealth, expandHomePath, loadConfig } from "./config.ts";
import { ContextDatabase, TriageLevel } from "./db.ts";
import { WeChatContextPipeline, normalizeWeChatUrl } from "./pipeline.ts";
import { isWeChatArticleUrl, normalizeExternalWebUrl } from "./extractor/web.ts";
import {
  createIdeaSeedInVault,
  ensureStarterVaultInitialized,
} from "./vault/context.ts";
import { loadAnalysisContext } from "./vault/analysis_context.ts";
import { isFallbackLightNote } from "./vault/analyzer.ts";
import { renderQrCodeToTerminal } from "./clawbot/client.ts";
import { scanLocalAgentClis } from "./agent/subagent_cli.ts";
import { detectRequestedFormats } from "./agent/doc_exporter.ts";
import { createHttpHandler, LOCAL_HOST } from "./http.ts";

let config = loadConfig();
const db = new ContextDatabase(config.dbPath);
const pipeline = new WeChatContextPipeline(config, db);

const args = process.argv.slice(2);
const command = args[0] || "help";

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  for (const arg of args) {
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function getAllFlags(names: string[]): string[] {
  const results: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (names.includes(token) && i + 1 < args.length) {
      results.push(args[i + 1]);
      i++;
      continue;
    }
    for (const name of names) {
      if (token.startsWith(`${name}=`)) {
        results.push(token.slice(name.length + 1));
      }
    }
  }
  return results;
}

function extractPositionalArgs(valueFlags: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (valueFlags.includes(token)) {
      i++;
      continue;
    }
    if (token.startsWith("--") || token.startsWith("-")) {
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}

const isJson = args.includes("--json") || getFlag("--format") === "json";

function installSkillFromTemplate(
  projectRoot: string,
  targetSkillsRoot = join(homedir(), ".codex", "skills"),
  overwrite = false
): { installed: boolean; skillPath: string } {
  const templatePath = join(projectRoot, "skills", "wechat-as-context", "SKILL.md");
  const skillDir = join(targetSkillsRoot, "wechat-as-context");
  const skillPath = join(skillDir, "SKILL.md");

  if (!existsSync(templatePath)) {
    return { installed: false, skillPath };
  }
  if (existsSync(skillPath) && !overwrite) {
    return { installed: false, skillPath };
  }

  mkdirSync(skillDir, { recursive: true });
  const rawTemplate = readFileSync(templatePath, "utf-8");
  const rendered = rawTemplate.replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot);
  writeFileSync(skillPath, rendered, "utf-8");
  return { installed: true, skillPath };
}

function openUrlInBrowser(url: string): void {
  const os = platform();
  const cmd = os === "darwin" ? "open" : os === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = os === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    child.unref();
  } catch {}
}

async function launchConfigWebStudio(options?: {
  openBrowser?: boolean;
}): Promise<void> {
  const shouldOpen = options?.openBrowser !== false;
  const preferredUrl = `http://${LOCAL_HOST}:${config.port}`;

  // Check if background daemon is already serving /api/config
  try {
    const checkRes = await fetch(`${preferredUrl}/api/config`, {
      signal: AbortSignal.timeout(1200),
    });
    if (checkRes.ok) {
      const targetUrl = `${preferredUrl}/config`;
      console.log(`\n🌐 配置工作台已在后台守护进程就绪: ${targetUrl}`);
      if (shouldOpen) {
        console.log(`🚀 正在浏览器中打开可视化配置页面...`);
        openUrlInBrowser(targetUrl);
      }
      return;
    }
  } catch {}

  // Otherwise start an interactive local config server (try config.port first, fallback to ephemeral port if busy)
  const handler = createHttpHandler(db, pipeline);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: LOCAL_HOST,
      port: config.port,
      fetch: handler,
    });
  } catch {
    server = Bun.serve({
      hostname: LOCAL_HOST,
      port: 0,
      fetch: handler,
    });
  }

  const targetUrl = `http://${LOCAL_HOST}:${server.port}/config`;
  console.log(`\n🌐 已启动本地可视化配置与路由工作台: ${targetUrl}`);
  if (shouldOpen) {
    console.log(`🚀 正在浏览器中自动打开配置页面（保存配置后可按 Ctrl+C 退出）...`);
    openUrlInBrowser(targetUrl);
  }
  await new Promise(() => {});
}

async function main() {
  switch (command) {
    case "init":
    case "setup": {
      const envPath = join(config.projectRoot, ".env");
      const envExamplePath = join(config.projectRoot, ".env.example");
      const customVaultArg = getFlag("--vault");
      const noVaultFlag =
        args.includes("--no-vault") ||
        args.includes("--standalone") ||
        (customVaultArg !== undefined &&
          /^(none|off|false|disabled|standalone)$/i.test(customVaultArg.trim()));
      let envCreated = false;

      if (!existsSync(envPath) && existsSync(envExamplePath)) {
        let exampleContent = readFileSync(envExamplePath, "utf-8");
        if (noVaultFlag) {
          exampleContent = exampleContent.replace(
            /^VAULT_ROOT=.*$/m,
            `VAULT_ROOT=none`
          );
        } else if (customVaultArg) {
          const resolvedVault = expandHomePath(customVaultArg, config.projectRoot);
          exampleContent = exampleContent.replace(
            /^VAULT_ROOT=.*$/m,
            `VAULT_ROOT=${resolvedVault}`
          );
        }
        writeFileSync(envPath, exampleContent, "utf-8");
        envCreated = true;
      } else if ((customVaultArg || noVaultFlag) && existsSync(envPath)) {
        const targetVaultVal = noVaultFlag
          ? "none"
          : expandHomePath(customVaultArg!, config.projectRoot);
        const existingEnv = readFileSync(envPath, "utf-8");
        const updatedEnv = /^VAULT_ROOT=/m.test(existingEnv)
          ? existingEnv.replace(/^VAULT_ROOT=.*$/m, `VAULT_ROOT=${targetVaultVal}`)
          : `${existingEnv.trimEnd()}\nVAULT_ROOT=${targetVaultVal}\n`;
        writeFileSync(envPath, updatedEnv, "utf-8");
      }

      config = loadConfig();
      pipeline.updateConfig(config);

      let vaultInit: {
        createdDirs: string[];
        skippedDirs: string[];
        createdFiles: string[];
        skippedFiles: string[];
      } = {
        createdDirs: [],
        skippedDirs: [],
        createdFiles: [],
        skippedFiles: [],
      };

      const forceStructuredTemplate = args.includes("--init-vault-template");
      const isExplicitNoVault =
        noVaultFlag || config.vaultRoot === join(config.dataDir, "archive");

      if (isExplicitNoVault) {
        // Standalone mode: only ensure clean local archive directories exist; never create 00_home..05_outputs
        for (const dir of [
          config.vaultRoot,
          config.wechatArticlesDir,
          config.webArticlesDir,
          config.inboxDir,
          config.papersDir,
          config.ideasSeedsDir,
        ]) {
          if (!dir) continue;
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
            vaultInit.createdDirs.push(dir);
          } else {
            vaultInit.skippedDirs.push(dir);
          }
        }
      } else if (
        config.vaultMode === "generic_folder" &&
        !forceStructuredTemplate
      ) {
        // Existing generic folder (e.g. user's existing Obsidian vault without 00_home):
        // Do NOT pollute their vault root with 00_home..05_outputs unless explicitly requested
        for (const dir of [
          config.vaultRoot,
          config.wechatArticlesDir,
          config.ideasSeedsDir,
        ]) {
          if (!dir) continue;
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
            vaultInit.createdDirs.push(dir);
          } else {
            vaultInit.skippedDirs.push(dir);
          }
        }
      } else {
        vaultInit = ensureStarterVaultInitialized(config);
        config = loadConfig();
        pipeline.updateConfig(config);
      }

      const discoveredClis = scanLocalAgentClis(config);

      const forceSkill = args.includes("--install-skill") || args.includes("--force-skill");
      const targetSkillsDir = getFlag("--skills-dir")
        ? expandHomePath(getFlag("--skills-dir")!, config.projectRoot)
        : join(homedir(), ".codex", "skills");
      const skillRes = installSkillFromTemplate(
        config.projectRoot,
        targetSkillsDir,
        forceSkill
      );

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              envCreated,
              envPath,
              vaultMode: config.vaultMode,
              vaultEnabled: config.vaultEnabled,
              vaultRoot: config.vaultRoot,
              createdDirs: vaultInit.createdDirs,
              createdFiles: vaultInit.createdFiles,
              skill: skillRes,
              discoveredClis,
              clawbotBound: pipeline.clawbot.isConfigured(),
            },
            null,
            2
          )
        );
      } else {
        console.log("🎉 === wechat-as-context 初始化完成 ===");
        console.log(
          `- 配置文件: ${envPath} (${envCreated ? "已从 .env.example 生成" : "已存在"})`
        );
        console.log(
          `- 存储模式: ${config.vaultMode} (${
            config.vaultEnabled ? `知识库目录: ${config.vaultRoot}` : `无外部知识库，本地归档: ${config.vaultRoot}`
          })`
        );
        if (vaultInit.createdFiles.length > 0) {
          console.log(
            `  已初始化知识库焦点模板: ${vaultInit.createdFiles.join(", ")}`
          );
        }
        console.log(
          `- 全局 Skill: ${skillRes.skillPath} (${
            skillRes.installed ? "已安装更新" : "已存在"
          })`
        );
        const installedClis = discoveredClis.filter((c) => c.installed);
        console.log(
          `- 本机 AI Agent CLI 扫描: 发现 ${installedClis.length} 个可用工具 (${installedClis.map((c) => `${c.id}[${c.binaryPath}]`).join(", ") || "无"})`
        );
        console.log(
          `- 当前 Tier 1 CLI 路由链: ${(config.llm.cliRoutingChain ?? []).join(" -> ")}`
        );
        console.log(`\n👉 下一步快速开始：`);
        console.log(`   1. 在即将打开的 HTML 配置页面中选择并填入你的 LLM API Key（支持 Gemini / DeepSeek / OpenCode Go / OpenAI / OpenRouter 等）并勾选 CLI 路由链`);
        console.log(`   2. 扫码绑定个人微信置顶「微信ClawBot [AI]」: bun run src/cli.ts login`);
        console.log(`   3. 启动开机常驻守护服务: bash scripts/install_daemon.sh`);

        const noOpen = args.includes("--no-open") || args.includes("--headless");
        if (!noOpen) {
          await launchConfigWebStudio({ openBrowser: true });
        }
      }
      break;
    }

    case "config":
    case "ui": {
      const noOpen = args.includes("--no-open") || args.includes("--headless");
      await launchConfigWebStudio({ openBrowser: !noOpen });
      break;
    }

    case "scan-cli": {
      const clis = scanLocalAgentClis(config);
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              cliRoutingChain: config.llm.cliRoutingChain,
              discoveredClis: clis,
            },
            null,
            2
          )
        );
      } else {
        console.log("🔍 === 本机 AI Agent CLI 扫描结果 ===");
        for (const c of clis) {
          console.log(
            `- [${c.installed ? "✅ 已安装" : "⚪ 未安装"}] ${c.name} (${c.id}): ${
              c.installed ? c.binaryPath : `未检测到 ${c.id}`
            }${c.enabledInRoute ? ` [路由优先级 #${c.routePriority}]` : ""}`
          );
        }
      }
      break;
    }

    case "install-skill": {
      const targetSkillsDir = getFlag("--skills-dir")
        ? expandHomePath(getFlag("--skills-dir")!, config.projectRoot)
        : join(homedir(), ".codex", "skills");
      const res = installSkillFromTemplate(
        config.projectRoot,
        targetSkillsDir,
        true
      );
      if (isJson) {
        console.log(JSON.stringify({ ok: res.installed, ...res }, null, 2));
      } else {
        console.log(`✅ 已安装 wechat-as-context Skill 至: ${res.skillPath}`);
      }
      break;
    }

    case "doctor": {
      const clawbotCreds = pipeline.clawbot.getCredentials();
      const llmReady = Boolean(config.llm.apiKey);
      const vaultExists = existsSync(config.vaultRoot);
      const vaultMode = config.vaultMode || (vaultExists ? "generic_folder" : "standalone");
      const skillsHealth = auditSkillsDirectoryHealth();
      const analysisContext = config.analysisContextFile
        ? loadAnalysisContext(config.analysisContextFile)
        : null;
      const skillTemplatePath = join(config.projectRoot, "skills", "wechat-as-context", "SKILL.md");
      const installedSkillPath = join(homedir(), ".codex", "skills", "wechat-as-context", "SKILL.md");
      let installedSkillCheck = "not_installed";
      if (existsSync(skillTemplatePath) && existsSync(installedSkillPath)) {
        const expectedSkill = readFileSync(skillTemplatePath, "utf-8").replace(
          /\{\{PROJECT_ROOT\}\}/g,
          config.projectRoot
        );
        const actualSkill = readFileSync(installedSkillPath, "utf-8");
        installedSkillCheck =
          expectedSkill === actualSkill
            ? `ok (in sync: ${installedSkillPath})`
            : `out_of_sync (run \`bun run src/cli.ts install-skill\` to sync ${installedSkillPath})`;
      }

      const report = {
        ok: Boolean(clawbotCreds),
        scope: "local_configuration_only",
        vaultMode,
        vaultEnabled: Boolean(config.vaultEnabled),
        lastPoll: db.getState("clawbot_last_poll") ? JSON.parse(db.getState("clawbot_last_poll")!) : null,
        delivery: db.deliveryStatus(),
        deliveryErrors: db.db.query("SELECT id, status, attempts, error FROM reply_outbox WHERE error != '' ORDER BY rowid DESC LIMIT 10").all(),
        inboxErrors: db.db.query("SELECT message_key, error FROM inbound_messages WHERE error != '' ORDER BY sequence DESC LIMIT 10").all(),
        vaultRoot: config.vaultRoot,
        wechatArticlesDir: config.wechatArticlesDir,
        webArticlesDir: config.webArticlesDir,
        ideasSeedsDir: config.ideasSeedsDir,
        analysisContextFile: config.analysisContextFile || null,
        analysisContext,
        dbPath: config.dbPath,
        skillsHealth,
        checks: {
          vault: vaultExists
            ? `ok (mode: ${vaultMode})`
            : "standalone mode (no external knowledge base required; local archive directories created on demand)",
          llmApiKey: llmReady
            ? `configured (fastModel: ${config.llm.fastModel || config.llm.model}, proModel: ${config.llm.proModel || "gemini-2.5-pro"}, baseUrl: ${config.llm.baseUrl})`
            : "missing (using local heuristic fallback until LLM_API_KEY is set)",
          clawbot: clawbotCreds
            ? `configured; connection not verified (botId: ${clawbotCreds.botId}, baseUrl: ${clawbotCreds.baseUrl}, savedAt: ${clawbotCreds.savedAt})`
            : "not connected (run `bun run src/cli.ts login` to scan QR and bind 微信ClawBot [AI])",
          skills: !skillsHealth.exists
            ? "not initialized"
            : skillsHealth.invalidSkillFiles.length === 0
              ? `ok (${skillsHealth.totalSkills} skills valid)`
              : `warning (${skillsHealth.invalidSkillFiles.length} invalid SKILL.md frontmatter files)`,
          installedSkill: installedSkillCheck,
          analysisContext: !config.analysisContextFile
            ? "not configured (optional; set ANALYSIS_CONTEXT_FILE in .env to enable viewpoint & business snapshot)"
            : analysisContext && analysisContext.warnings.length > 0 && analysisContext.entries.length === 0
              ? `warning (${analysisContext.warnings.join("; ")})`
              : `ok (${analysisContext?.entries.length ?? 0} active entries${
                  analysisContext?.warnings.length ? `; warnings: ${analysisContext.warnings.join("; ")}` : ""
                })`,
        },
      };

      if (isJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log("=== wechat-as-context 环境自检 ===");
        console.log(`- 存储与知识库模式: ${report.vaultMode} (${report.vaultRoot}) [${report.checks.vault}]`);
        console.log(`- 微信文章落盘: ${report.wechatArticlesDir}`);
        console.log(`- LLM 初筛引擎: ${report.checks.llmApiKey}`);
        console.log(`- 微信ClawBot [AI] (置顶长轮询通道): ${report.checks.clawbot}`);
        console.log(JSON.stringify({ lastPoll: report.lastPoll, delivery: report.delivery, deliveryErrors: report.deliveryErrors, inboxErrors: report.inboxErrors }, null, 2));
      }
      break;
    }

    case "login": {
      console.log("🚀 正在向腾讯 iLink AI 网关请求「微信ClawBot [AI]」绑定二维码...");
      const { qrcode, qrcodeUrl } = await pipeline.clawbot.fetchLoginQrCode();
      console.log("\n📱 请使用手机微信扫描下方二维码连接你的「微信ClawBot [AI]」：\n");
      await renderQrCodeToTerminal(qrcodeUrl);
      console.log("⏳ 等待手机微信扫码确认中（有效期 3 分钟）...");
      const creds = await pipeline.clawbot.waitForQrConfirmation(qrcode);
      console.log(`\n✅ 绑定成功！`);
      console.log(`- Bot ID: ${creds.botId}`);
      console.log(`- 网关地址: ${creds.baseUrl}`);
      console.log(
        `\n🎉 现在只需运行 \`bun run start\`（或 \`bash scripts/install_daemon.sh\`）启动后台守护，你就可以在微信置顶的「微信ClawBot [AI]」里直接发公众号链接和想法了！`
      );
      break;
    }

    case "ingest": {
      const targetUrl = args[1];
      if (!targetUrl || targetUrl.startsWith("--")) {
        console.error(
          "用法: bun run src/cli.ts ingest <mp.weixin.qq.com URL> [--note '你的批注/关注点'] [--title '可选标题'] [--json]"
        );
        process.exit(1);
      }
      const userNote = getFlag("--note") ?? "";
      const title = getFlag("--title") ?? "";

      const normalizedUrl = isWeChatArticleUrl(targetUrl)
        ? normalizeWeChatUrl(targetUrl)
        : normalizeExternalWebUrl(targetUrl);

      const { record } = db.enqueueArticle({
        msgid: `cli_${Date.now()}`,
        url: normalizedUrl,
        title,
        user_notes: userNote,
        channel: "cli",
        waitSeconds: 0,
      });

      const updated = await pipeline.processArticleById(record.id, {
        sendWeChatReply: false,
      });

      if (isJson) {
        console.log(JSON.stringify({ ok: true, article: updated }, null, 2));
      } else {
        console.log(`\n✅ 文章抓取与知识库初筛完成 [ID: #${updated.id}]`);
        console.log(`- 标题: ${updated.title}`);
        console.log(`- 公众号/作者: ${updated.author}`);
        console.log(`- 建议分诊 (Triage): ${updated.triage}`);
        console.log(`- 原文路径: ${updated.source_md_path}`);
        console.log(`- 初筛伴读卡: ${updated.note_md_path}`);
        console.log(`\n--- 📲 手机微信回执预览 ---\n${updated.short_summary}\n`);
      }
      break;
    }

    case "list": {
      const status = getFlag("--status");
      const triage = getFlag("--triage");
      const limit = Number(getFlag("--limit") ?? "20") || 20;
      const items = db.listArticles({ status, triage, limit });

      if (isJson) {
        console.log(
          JSON.stringify({ ok: true, total: items.length, articles: items }, null, 2)
        );
      } else {
        if (items.length === 0) {
          console.log("📭 当前公众号收件箱为空。");
          break;
        }
        console.log(`📬 公众号文章收件箱（最近 ${items.length} 篇）：\n`);
        for (const a of items) {
          const nodes = safeParseArray(a.related_vault_nodes).join(", ");
          console.log(
            `[#${a.id}] [${a.process_level}/${a.triage}] 《${a.title || a.url}》 (${a.author || "未知公众号"})`
          );
          console.log(`    时间: ${a.created_at.slice(0, 19).replace("T", " ")}`);
          if (a.user_notes) console.log(`    🎯 批注: ${a.user_notes}`);
          if (nodes) console.log(`    🔗 关联知识库: ${nodes}`);
          if (a.source_md_path) console.log(`    📄 原文: ${a.source_md_path}`);
          if (a.note_md_path) console.log(`    📝 伴读卡: ${a.note_md_path}`);
          console.log("");
        }
      }
      break;
    }

    case "show": {
      const id = Number(args[1]);
      if (!id) {
        console.error("用法: bun run src/cli.ts show <id> [--json]");
        process.exit(1);
      }
      const item = db.getArticleById(id);
      if (!item) {
        console.error(`未找到 ID 为 #${id} 的文章记录`);
        process.exit(1);
      }
      const noteContent =
        item.note_md_path && existsSync(item.note_md_path)
          ? readFileSync(item.note_md_path, "utf-8")
          : "";

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              article: item,
              isFallbackNote: isFallbackLightNote(noteContent || item.short_summary),
              noteMarkdown: noteContent,
            },
            null,
            2
          )
        );
      } else {
        const fallbackTag = isFallbackLightNote(noteContent || item.short_summary)
          ? " ⚠️ [未完成模型分析/本地回退摘录]"
          : "";
        console.log(`=== [#${item.id}] ${item.title}${fallbackTag} ===`);
        console.log(`- 公众号/作者: ${item.author}`);
        console.log(`- 原文链接: ${item.url}`);
        console.log(`- 状态/分诊: ${item.process_level} / ${item.triage}`);
        console.log(`- 用户批注: ${item.user_notes || "（无）"}`);
        console.log(`- 原文 Markdown: ${item.source_md_path}`);
        console.log(`- 伴读笔记 Markdown: ${item.note_md_path}`);
        if (noteContent) {
          console.log(`\n--- 伴读笔记 (_note.md) ---\n${noteContent}`);
        }
      }
      break;
    }

    case "reanalyze": {
      const id = Number(args[1]);
      if (!id) {
        console.error(
          "用法: bun run src/cli.ts reanalyze <id> [--force] [--send] [--json]"
        );
        process.exit(1);
      }
      const force = args.includes("--force");
      const sendWeChatReply = args.includes("--send");
      const res = await pipeline.reanalyzeArticleById(id, {
        force,
        sendWeChatReply,
      });
      if (sendWeChatReply && pipeline.clawbot.isConfigured()) {
        await pipeline.flushRepliesWithRetry();
      }
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              ok: !res.isFallback,
              upgradedFromFallback: res.upgradedFromFallback,
              isFallback: res.isFallback,
              article: res.record,
            },
            null,
            2
          )
        );
      } else {
        const statusIcon = res.isFallback ? "⚠️" : "✅";
        console.log(
          `${statusIcon} 文章 #${id}《${res.record.title}》重新初筛完成 (${
            res.isFallback
              ? "仍为本地回退摘录，请检查 LLM 网络或配置"
              : res.upgradedFromFallback
                ? "已从本地回退摘录升级为完整模型初筛"
                : "已更新模型初筛"
          })`
        );
        console.log(`- 建议分诊 (Triage): ${res.record.triage}`);
        console.log(`- 伴读笔记: ${res.record.note_md_path}`);
        console.log(`\n--- 📲 手机微信初筛回执 ---\n${res.record.short_summary}\n`);
      }
      break;
    }

    case "recent":
    case "turns":
    case "inbox":
    case "tasks": {
      const limit = Number(getFlag("--limit") ?? "15") || 15;
      const intentFilter =
        getFlag("--intent") ||
        (command === "inbox" ? "capture_inbox" : undefined);
      const turns =
        command === "tasks"
          ? []
          : db.listConversationTurns({ intent: intentFilter, limit });
      const tasks =
        command === "inbox"
          ? []
          : db.getRecentAgentTasks(undefined, command === "tasks" ? limit : 10);

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              intentFilter: intentFilter || null,
              turnsCount: turns.length,
              turns,
              tasksCount: tasks.length,
              tasks,
            },
            null,
            2
          )
        );
      } else {
        if (turns.length > 0) {
          console.log(
            `💬 最近微信消息与捕获记录（共 ${turns.length} 条${
              intentFilter ? `，intent=${intentFilter}` : ""
            }）：\n`
          );
          for (const t of turns) {
            console.log(
              `[Turn #${t.id}] [${t.intent}/${t.complexity}] (${t.created_at
                .slice(0, 19)
                .replace("T", " ")}) 模型: ${t.model_used || "-"}`
            );
            console.log(
              `  👤 用户消息: ${t.user_text.slice(0, 180).replace(/\r?\n/g, " ")}${
                t.user_text.length > 180 ? "…" : ""
              }`
            );
            if (t.deposited_path) {
              console.log(`  📂 落盘文件: ${t.deposited_path}`);
            }
            console.log(
              `  🤖 回复摘要: ${t.assistant_reply.slice(0, 140).replace(/\r?\n/g, " ")}${
                t.assistant_reply.length > 140 ? "…" : ""
              }\n`
            );
          }
        } else if (command !== "tasks") {
          console.log("📭 未找到匹配的微信对话或收集箱记录。");
        }
        if (tasks.length > 0 && command !== "inbox") {
          console.log(`⚙️ 最近 Agent 异步任务队列（共 ${tasks.length} 条）：\n`);
          for (const tk of tasks) {
            console.log(
              `[Task #${tk.id}] [${tk.status}] (${tk.updated_at
                .slice(0, 19)
                .replace("T", " ")}) stage=${tk.stage || "-"} ${
                tk.error ? `error=${tk.error}` : ""
              }`
            );
          }
        }
      }
      break;
    }

    case "sync": {
      if (!pipeline.clawbot.isConfigured()) {
        console.error(
          "尚未绑定 微信ClawBot [AI]，请先运行 `bun run src/cli.ts login` 扫码绑定。"
        );
        process.exit(1);
      }
      const count = await pipeline.pollClawBotUpdates(5_000);
      if (isJson) {
        console.log(JSON.stringify({ ok: true, syncedMessages: count, delivery: db.deliveryStatus(), pendingMessages: db.pendingMessages().length }));
      } else {
        console.log(`🔄 同步完成，共处理 ${count} 条新消息。`);
      }
      break;
    }

    case "triage": {
      const id = Number(args[1]);
      const triageVal = (args[2] as TriageLevel) || "process_now";
      const levelVal = getFlag("--level") as "raw" | "light" | "deep" | undefined;
      if (!id) {
        console.error(
          "用法: bun run src/cli.ts triage <id> <keep_raw|reference|process_later|process_now> [--level light|deep]"
        );
        process.exit(1);
      }
      const updated = pipeline.markArticleTriage(id, triageVal, levelVal);
      if (!updated) {
        console.error(`未找到文章 #${id}`);
        process.exit(1);
      }
      console.log(
        `✅ 已更新文章 #${id}：《${updated.title}》 -> triage=${updated.triage}, process_level=${updated.process_level}`
      );
      break;
    }

    case "idea": {
      const maybeId = Number(args[1]);
      const hasNumericId = Boolean(args[1] && !Number.isNaN(maybeId) && maybeId > 0);
      const thought = hasNumericId ? args[2] || "" : args[1] || "";

      if (!thought || thought.startsWith("--")) {
        console.error(
          '用法: bun run src/cli.ts idea [<article_id>] "你的想法内容" [--slug <slug>]'
        );
        process.exit(1);
      }

      const rec = hasNumericId ? db.getArticleById(maybeId) : null;
      if (hasNumericId && !rec) {
        console.error(`未找到文章 #${maybeId}`);
        process.exit(1);
      }
      const relatedNodes = rec ? safeParseArray(rec.related_vault_nodes) : [];
      const seedPath = createIdeaSeedInVault({
        ideasSeedsDir: config.ideasSeedsDir,
        thoughtText: thought,
        slug:
          getFlag("--slug") ??
          (hasNumericId ? `idea_from_article_${maybeId}` : "standalone_idea"),
        sourceMdPath: rec?.source_md_path || undefined,
        sourceUrl: rec?.url || undefined,
        relatedVaultNodes: relatedNodes,
      });
      console.log(`💡 个人想法已写入: ${seedPath}`);
      break;
    }

    case "push":
    case "send":
    case "notify": {
      const valueFlags = [
        "--text",
        "-t",
        "--title",
        "--file",
        "-f",
        "--image",
        "-i",
        "--formats",
        "--export",
        "--article",
        "-a",
        "--to",
        "--format",
      ];
      const explicitFiles = getAllFlags(["--file", "-f", "--image", "-i"]).flatMap(
        (raw) =>
          raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
      );
      const explicitTexts = getAllFlags(["--text", "-t"]);
      const titleFlag = getFlag("--title");
      const toFlag = getFlag("--to");
      const articleFlag = getFlag("--article") ?? getFlag("-a");
      const articleId = articleFlag ? Number(articleFlag) : undefined;
      if (articleFlag && (!articleId || Number.isNaN(articleId))) {
        console.error(`无效的文章 ID: ${articleFlag}`);
        process.exit(1);
      }

      const rawFormats = getAllFlags(["--formats", "--export"]).flatMap((raw) =>
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      const formats =
        rawFormats.length > 0 ? detectRequestedFormats("", rawFormats) : [];

      const positionals = extractPositionalArgs(valueFlags);
      const files = [...explicitFiles];
      const textParts = [...explicitTexts];

      for (const pos of positionals) {
        const looksLikePath =
          pos.startsWith("/") ||
          pos.startsWith("./") ||
          pos.startsWith("../") ||
          pos.startsWith("~/");
        if (looksLikePath) {
          const candidate = expandHomePath(pos, process.cwd());
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            files.push(candidate);
            continue;
          }
        }
        textParts.push(pos);
      }

      if (args.includes("--stdin")) {
        const stdinText = (await Bun.stdin.text()).trim();
        if (stdinText) {
          textParts.push(stdinText);
        }
      }

      const combinedText = textParts.join("\n\n").trim();
      const includeArticleFile =
        args.includes("--with-file") ||
        args.includes("--source") ||
        formats.length > 0;
      const useSourceFile = args.includes("--source");
      const queueOnly = args.includes("--queue-only");

      if (!combinedText && files.length === 0 && articleId === undefined) {
        console.error(
          `用法:
  bun run src/cli.ts push "要发送到微信的文本或结论" [--json]
  bun run src/cli.ts push --file <本地文件或图片路径> [--text "附带说明"] [--formats md,html,pdf] [--json]
  bun run src/cli.ts push --article <id> [--with-file] [--formats md,html,pdf] [--json]
  cat report.md | bun run src/cli.ts push --stdin [--formats md,html,pdf] [--title "标题"] [--json]`
        );
        process.exit(1);
      }

      const result = await pipeline.pushToWeChat({
        text: combinedText || undefined,
        title: titleFlag,
        files,
        formats,
        articleId,
        includeArticleFile,
        useSourceFile,
        recipient: toFlag,
        queueOnly,
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const statusIcon = result.ok ? "✅" : "⚠️";
        console.log(
          `${statusIcon} 微信推送结果: 已发送 ${result.sentCount}/${result.queuedCount} 项 (接收方: ${result.recipient})`
        );
        for (const item of result.items) {
          const targetLabel =
            item.kind === "text" ? `"${item.target}"` : basename(item.target);
          console.log(
            `  - [${item.status.toUpperCase()}] (${item.kind}) ${targetLabel}${
              item.error ? ` -> 错误: ${item.error}` : ""
            }`
          );
        }
        if (result.missingFormats.length > 0) {
          console.warn(
            `  ⚠️ 以下请求格式未能生成: ${result.missingFormats.join(", ")}`
          );
        }
      }

      if (!result.ok) {
        process.exit(1);
      }
      break;
    }

    default: {
      console.log(`wechat-as-context (wx-ctx) — 微信公众号文章 -> 个人知识库 & AI Agent 桥接工具

可用命令:
  bun run src/cli.ts setup [--vault <path>] [--no-open]    一键初始化配置 (.env)、知识库骨架与全局 Skill，并打开 HTML 配置工作台
  bun run src/cli.ts config [--no-open]                    打开可视化 HTML 配置与 AI Agent 路由工作台 (http://127.0.0.1:8787/config)
  bun run src/cli.ts scan-cli [--json]                     扫描本机已安装的 AI Agent CLI (agy / codex / opencode / claude / gemini / aider 等)
  bun run src/cli.ts login                                 扫码绑定「微信ClawBot [AI]」（免公网隧道、支持微信置顶）
  bun run src/cli.ts doctor                                检查本地环境、知识库、LLM 与 微信ClawBot 绑定状态
  bun run src/cli.ts list [--triage <t>] [--json]          列出公众号文章收件箱及知识库初筛状态
  bun run src/cli.ts show <id> [--json]                    查看单篇文章详情、原文路径及伴读笔记
  bun run src/cli.ts reanalyze <id> [--force] [--send]     重新执行单篇文章的模型初筛（可将未完成模型分析的本地摘录升级为完整伴读）
  bun run src/cli.ts recent [--intent <i>] [--json]        查看最近的非文章类微信消息、收集箱速记 (inbox)、想法与 Agent 任务记录
  bun run src/cli.ts inbox [--limit <n>] [--json]          查看最近通过微信转发存入 01_inputs/inbox/ 的速记与备忘记录
  bun run src/cli.ts ingest <url> [--note "关注点"]         手动/测试抓取一篇公众号文章并生成知识库初筛卡
  bun run src/cli.ts sync                                  主动从「微信ClawBot [AI]」拉取离线期间发送的文章
  bun run src/cli.ts push [text] [--file <path>] [--formats md,html,pdf] [--article <id>]
                                                           主动将文本结论、本地图片/文件或多格式文档推送到手机微信
  bun run src/cli.ts triage <id> <triage> [--level deep]   更新文章分诊状态与处理深度（同步更新 Markdown frontmatter）
  bun run src/cli.ts idea <id> "我的想法..."               从某篇文章提炼一条个人想法存入 03_ideas/seeds/
`);
      break;
    }
  }
}

function safeParseArray(jsonStr: string): string[] {
  try {
    const arr = JSON.parse(jsonStr);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

main().catch((err) => {
  console.error("❌ 执行出错:", err?.message || err);
  process.exit(1);
});
