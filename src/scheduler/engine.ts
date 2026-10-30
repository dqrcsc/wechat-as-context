import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { AppConfig } from "../config.ts";
import type {
  ContextDatabase,
  ScheduledActionPayload,
  ScheduledTaskRecord,
} from "../db.ts";
import type { WeChatClawBotClient } from "../clawbot/client.ts";
import { callAgentLlm } from "../agent/llm.ts";
import { sanitizeSlug, yamlQuote } from "../extractor/wechat.ts";
import { writeNewFile } from "../storage.ts";
import {
  type DeliverableFormat,
  ensureMultiFormatDeliverables,
} from "../agent/doc_exporter.ts";
import {
  describeCronExpression,
  formatZonedDateTime,
  getNextCronRunMs,
} from "./cron.ts";
import { syncScheduledTasksToVaultQueue } from "./vault_sync.ts";

export class ScheduleRunRejected extends Error {
  constructor(public code: "busy" | "not_found" | "not_executed", message: string) { super(message); }
}

export interface ScheduledRunOutcome {
  taskId: number;
  title: string;
  taskKind: string;
  scheduleType: "once" | "cron";
  status: "succeeded" | "failed" | "skipped_misfire";
  replyClientId?: string;
  recipient?: string;
  depositedPath?: string;
  summary: string;
  nextRunAt: number | null;
}

export function parseTaskActionPayload(
  task: ScheduledTaskRecord
): ScheduledActionPayload {
  try {
    const parsed = JSON.parse(task.action_payload || "{}");
    if (parsed && typeof parsed === "object") {
      return {
        executor:
          parsed.executor ||
          (task.task_kind === "digest" ? "web_search_digest" : "reminder_push"),
        prompt: String(parsed.prompt || task.title),
        searchQueries: Array.isArray(parsed.searchQueries)
          ? parsed.searchQueries.map(String)
          : undefined,
        includeVaultNow:
          typeof parsed.includeVaultNow === "boolean"
            ? parsed.includeVaultNow
            : true,
        includeRecentArticlesHours:
          typeof parsed.includeRecentArticlesHours === "number"
            ? parsed.includeRecentArticlesHours
            : 24,
        archiveToVault:
          typeof parsed.archiveToVault === "boolean"
            ? parsed.archiveToVault
            : true,
        relatedArticleId:
          typeof parsed.relatedArticleId === "number"
            ? parsed.relatedArticleId
            : task.related_article_id ?? undefined,
        deliverables: Array.isArray(parsed.deliverables)
          ? parsed.deliverables
          : undefined,
      };
    }
  } catch {}
  return {
    executor:
      task.task_kind === "digest" ? "web_search_digest" : "reminder_push",
    prompt: task.title,
    includeVaultNow: true,
    includeRecentArticlesHours: 24,
    archiveToVault: true,
    relatedArticleId: task.related_article_id ?? undefined,
  };
}

export class TaskSchedulerEngine {
  private isTicking = false;

  constructor(
    public config: AppConfig,
    public db: ContextDatabase,
    public clawbot: WeChatClawBotClient
  ) {}

  public resolveTaskRecipient(task: ScheduledTaskRecord): string {
    if (task.sender_id && task.sender_id.trim()) {
      return task.sender_id.trim();
    }
    return this.clawbot.resolveDefaultRecipient() || "local_user";
  }

  /**
   * Scan and execute due scheduled tasks.
   * Safe to invoke periodically from the daemon heartbeat or manually via CLI/API.
   */
  public async tick(options?: {
    nowMs?: number;
    forceTaskId?: number;
    manual?: boolean;
    misfireGraceMs?: number;
  }): Promise<ScheduledRunOutcome[]> {
    if (this.isTicking) {
      if (options?.manual || options?.forceTaskId !== undefined) throw new ScheduleRunRejected("busy", "调度繁忙，本次未执行，也未加入待执行队列");
      return [];
    }
    this.isTicking = true;
    const nowMs = options?.nowMs ?? Date.now();
    const misfireGraceMs = options?.misfireGraceMs ?? 12 * 3600_000;

    try {
      return await this.db.withLock("scheduler", async (ownsLock) => {
        this.recoverInterruptedRuns(nowMs);
        let dueTasks: ScheduledTaskRecord[] = [];
        if (options?.forceTaskId !== undefined) {
          const t = this.db.getScheduledTaskById(options.forceTaskId);
          if (!t) throw new ScheduleRunRejected("not_found", "任务不存在，本次未执行");
          dueTasks = [t];
        } else {
          dueTasks = this.db.getDueScheduledTasks(nowMs, 20);
        }

        if (dueTasks.length === 0) return [];

        const outcomes: ScheduledRunOutcome[] = [];
        for (const task of dueTasks) {
          const outcome = await this.executeSingleTask(task, {
            nowMs,
            forced: options?.forceTaskId === task.id,
            misfireGraceMs,
            ownsLock,
          });
          if (outcome) {
            outcomes.push(outcome);
          }
        }

        try {
          syncScheduledTasksToVaultQueue(this.config, this.db);
        } catch (err) {
          console.error("[Scheduler] Failed to sync queue.md:", err);
        }

        if (options?.forceTaskId !== undefined && !outcomes.length) {
          throw new ScheduleRunRejected("not_executed", "任务状态已变化或该次运行已处理，本次未执行，也未加入待执行队列");
        }
        return outcomes;
      }, { renew: true });
    } catch (err: any) {
      if (options?.manual || options?.forceTaskId !== undefined) {
        if (String(err?.message || "").includes("Operation busy")) throw new ScheduleRunRejected("busy", "调度繁忙，本次未执行，也未加入待执行队列");
        throw err;
      }
      if (!String(err?.message || "").includes("Operation busy")) {
        console.error("[Scheduler] tick error:", err);
      }
      return [];
    } finally {
      this.isTicking = false;
    }
  }

  // Called only while holding the scheduler's process lock. A live owner renews
  // its lease; expired/replaced owners are fenced out before side effects commit.
  private recoverInterruptedRuns(nowMs: number): void {
    const tasks = this.db.db.query("SELECT * FROM scheduled_tasks WHERE status = 'running'").all() as ScheduledTaskRecord[];
    for (const task of tasks) {
      const run = this.db.getScheduledTaskRuns(task.id, 1)[0];
      const queued = run && this.db.db.query("SELECT id FROM reply_outbox WHERE id = ?")
        .get(`sched_${task.id}_${run.scheduled_for_ms}`);
      const partialMedia = run && !queued && this.db.db.query("SELECT id FROM reply_outbox WHERE id GLOB ? LIMIT 1")
        .get(`sched_media_${task.id}_${run.scheduled_for_ms}_*`);
      this.db.db.transaction(() => {
        if (this.db.getScheduledTaskById(task.id)?.revision !== task.revision) return;
        if (partialMedia) {
          this.db.updateScheduledTask(task.id, { status: "paused", last_error: "旧版本附件已入队但正文状态不明；已暂停，需人工核对，未重试发送" }, task.revision);
          return;
        }
        if (queued || run?.status === "succeeded") {
          // Legacy versions could crash between enqueue and completion. Preserve
          // even failed outbox rows: recovery must not retry or replace delivery.
          const next = task.schedule_type === "cron" && task.cron_expr
            ? getNextCronRunMs(task.cron_expr, nowMs, task.timezone) : null;
          this.db.updateScheduledTask(task.id, { status: next === null ? "completed" : "active",
            next_run_at: next, run_count: task.run_count + 1, last_error: "" }, task.revision);
          if (run) this.db.updateScheduledTaskRun(run.id, { status: "succeeded", finished_at: new Date(nowMs).toISOString() });
        } else {
          this.db.updateScheduledTask(task.id, { status: "active", next_run_at: run?.scheduled_for_ms ?? task.next_run_at ?? nowMs,
            last_error: "检测到中断，将从已保存的生成结果恢复" }, task.revision);
        }
      }).immediate();
    }
  }

  private async executeSingleTask(
    task: ScheduledTaskRecord,
    params: { nowMs: number; forced: boolean; misfireGraceMs: number; ownsLock: () => boolean }
  ): Promise<ScheduledRunOutcome | null> {
    const { nowMs, forced, misfireGraceMs, ownsLock } = params;
    const current = this.db.getScheduledTaskById(task.id);
    if (!ownsLock() || !current || current.revision !== task.revision || current.status === "running" || (!forced && current.status !== "active")) return null;
    const tz = task.timezone || "Asia/Shanghai";
    const scheduledForMs = task.next_run_at ?? nowMs;
    const overdueMs = Math.max(0, nowMs - scheduledForMs);
    if (!forced && task.schedule_type === "cron" && task.cron_expr && overdueMs > misfireGraceMs) {
      const nextRunAt = getNextCronRunMs(task.cron_expr, nowMs, tz);
      this.db.db.transaction(() => {
        const run = this.db.recordScheduledTaskRun({ taskId: task.id, scheduledForMs, finishedAt: new Date(nowMs).toISOString(),
          status: "skipped_misfire", outputSummary: "Skipped expired cron slot" });
        if (run) this.db.updateScheduledTaskRun(run.id, { status: "skipped_misfire", finished_at: new Date(nowMs).toISOString(), output_summary: "Skipped expired cron slot" });
        this.db.updateScheduledTask(task.id, { next_run_at: nextRunAt,
          last_result_summary: `跳过过期触发窗口，已顺延至 ${formatZonedDateTime(nextRunAt, tz)}` }, task.revision);
      }).immediate();
      return { taskId: task.id, title: task.title, taskKind: task.task_kind, scheduleType: task.schedule_type,
        status: "skipped_misfire", summary: "Skipped expired cron slot", nextRunAt };
    }

    const runSlotKey = forced ? nowMs : scheduledForMs;
    const claim = this.db.db.transaction(() => {
      const run = this.db.recordScheduledTaskRun({ taskId: task.id, scheduledForMs: runSlotKey,
        startedAt: new Date(nowMs).toISOString(), status: "running" });
      if (!run || run.status === "succeeded" || run.status === "skipped_misfire") return null;
      const owned = this.db.updateScheduledTask(task.id, { status: "running" }, task.revision);
      if (!owned) return null;
      this.db.updateScheduledTaskRun(run.id, { status: "running", finished_at: "", error: "" });
      return { run, revision: owned.revision };
    }).immediate();
    if (!claim) return null;
    const { run, revision } = claim;
    const ownsRun = () => {
      const latest = this.db.getScheduledTaskById(task.id);
      return ownsLock() && latest?.status === "running" && latest.revision === revision;
    };
    const superseded = () => {
      if (!ownsLock()) return null;
      this.db.updateScheduledTaskRun(run.id, { status: "failed", finished_at: new Date().toISOString(),
        error: "Task changed during execution; result not queued" });
      return null;
    };
    const payload = parseTaskActionPayload(task);
    const recipient = this.resolveTaskRecipient(task);
    const inputKey = JSON.stringify([task.title, task.action_payload, task.schedule_type, task.cron_expr, task.timezone]);
    try {
      let prepared: { inputKey: string; wechatReply: string; depositedPath: string; modelUsed: string; archiveContent?: string } | undefined;
      if (run.prepared_result) {
        const cached = JSON.parse(run.prepared_result);
        if (cached.inputKey === inputKey) prepared = cached;
      }
      if (!prepared) {
        if (["web_search_digest", "vault_digest", "agent_delegate"].includes(payload.executor) || task.task_kind === "digest") {
          prepared = { ...await this.executeDigestOrCollectionTask(task, payload, nowMs, runSlotKey), inputKey };
        } else {
          prepared = { inputKey, wechatReply: this.buildReminderNotificationText(task, payload, scheduledForMs, nowMs),
            depositedPath: "", modelUsed: "scheduler-engine" };
        }
        if (!ownsRun()) return superseded();
        // Persist full generated content before writing files or queuing messages.
        this.db.updateScheduledTaskRun(run.id, { prepared_result: JSON.stringify(prepared) });
      }
      if (!ownsRun()) return superseded();
      const { wechatReply: replyText, depositedPath, modelUsed, archiveContent } = prepared;
      if (depositedPath && archiveContent !== undefined) {
        writeNewFile(depositedPath, archiveContent);
        if (readFileSync(depositedPath, "utf8") !== archiveContent) throw new Error("Digest archive changed; refusing to overwrite or send stale content");
      }
      let attachments: string[] = [];
      if (depositedPath && payload.deliverables?.length) {
        attachments = await ensureMultiFormatDeliverables({ markdownPath: depositedPath, outputDir: dirname(depositedPath),
          baseFileStem: basename(depositedPath, extname(depositedPath)), title: task.title,
          requestedFormats: payload.deliverables.map(fmt => fmt === "markdown" ? "md" : fmt as DeliverableFormat) });
      }
      const replyClientId = `sched_${task.id}_${runSlotKey}`;
      const nowIso = new Date(nowMs).toISOString();
      const nextRunAt = task.schedule_type === "cron" && task.cron_expr ? getNextCronRunMs(task.cron_expr, nowMs, tz) : null;
      const committed = this.db.db.transaction(() => {
        if (!ownsRun()) return false;
        for (const [index, filePath] of attachments.entries()) {
          this.db.queueMediaReply(`sched_media_${task.id}_${runSlotKey}_${index}`, recipient, "file", filePath, `📎 定时简报附件：${task.title}`);
        }
        this.db.queueReply(replyClientId, recipient, replyText);
        this.db.updateScheduledTask(task.id, { status: task.schedule_type === "cron" ? "active" : "completed",
          next_run_at: nextRunAt, run_count: task.run_count + 1, last_run_at: nowIso,
          last_result_summary: replyText.slice(0, 280), last_error: "" }, revision);
        this.db.updateScheduledTaskRun(run.id, { finished_at: nowIso, status: "succeeded",
          output_summary: replyText.slice(0, 300), deposited_path: depositedPath, error: "" });
        this.db.recordConversationTurn({ messageKey: `scheduled_task_${task.id}_${runSlotKey}`, senderId: recipient,
          userText: `[定时任务触发 #${task.id}] ${task.title}`, intent: "manage_schedule",
          complexity: task.task_kind === "digest" ? "deep" : "fast", modelUsed,
          relatedArticleId: payload.relatedArticleId ?? task.related_article_id, depositedPath, assistantReply: replyText });
        return true;
      }).immediate();
      if (!committed) return superseded();
      return { taskId: task.id, title: task.title, taskKind: task.task_kind, scheduleType: task.schedule_type,
        status: "succeeded", replyClientId, recipient, depositedPath: depositedPath || undefined,
        summary: replyText.slice(0, 200), nextRunAt };
    } catch (err: any) {
      if (!ownsRun()) return superseded();
      const errMsg = String(err?.message || err);
      const nextRunAt = task.schedule_type === "cron" && task.cron_expr ? getNextCronRunMs(task.cron_expr, nowMs, tz) : nowMs + 5 * 60_000;
      this.db.db.transaction(() => {
        this.db.updateScheduledTask(task.id, { status: "active", next_run_at: nextRunAt, last_error: errMsg.slice(0, 300) }, revision);
        this.db.updateScheduledTaskRun(run.id, { finished_at: new Date(nowMs).toISOString(), status: "failed", error: errMsg.slice(0, 300) });
      }).immediate();
      return { taskId: task.id, title: task.title, taskKind: task.task_kind, scheduleType: task.schedule_type,
        status: "failed", summary: errMsg, nextRunAt };
    }
  }

  private buildReminderNotificationText(
    task: ScheduledTaskRecord,
    payload: ScheduledActionPayload,
    scheduledForMs: number,
    nowMs: number
  ): string {
    const tz = task.timezone || "Asia/Shanghai";
    const overdueMs = Math.max(0, nowMs - scheduledForMs);
    const lines: string[] = [];

    const kindBadge =
      task.task_kind === "todo"
        ? "📌 【待办到期提醒】"
        : "⏰ 【定时提醒】";
    lines.push(`${kindBadge} #${task.id}`);

    if (overdueMs > 10 * 60_000 && task.schedule_type === "once") {
      lines.push(
        `⚠️ [离线唤醒补推 · 原定 ${formatZonedDateTime(scheduledForMs, tz)}]`
      );
    }

    lines.push("");
    lines.push(`🔔 **${task.title}**`);

    if (
      payload.prompt &&
      payload.prompt.trim() &&
      payload.prompt.trim() !== task.title.trim()
    ) {
      lines.push(`📝 备注：${payload.prompt.trim()}`);
    }

    const articleId = payload.relatedArticleId ?? task.related_article_id;
    if (articleId) {
      const article = this.db.getArticleById(articleId);
      if (article) {
        lines.push(
          `📄 关联文章：#${article.id}《${article.title || article.url}》`
        );
        if (article.short_summary) {
          lines.push(`💡 摘要：${article.short_summary.slice(0, 120)}`);
        }
      }
    }

    lines.push("");
    if (task.schedule_type === "cron" && task.cron_expr) {
      const nextMs = getNextCronRunMs(task.cron_expr, nowMs, tz);
      lines.push(
        `🔄 周期规则：${describeCronExpression(task.cron_expr)}（下次提醒：${formatZonedDateTime(nextMs, tz)}）`
      );
    } else if (task.is_default_time) {
      lines.push(
        `💡 这是为您自动分配的 20:00 晚间兜底提醒。如需改期，可直接回复「把 #${task.id} 改到明早 9 点」。`
      );
    } else {
      lines.push(`✅ 该单次提醒已触发完成，已同步更新至 queue.md。`);
    }

    return lines.join("\n");
  }

  private async executeDigestOrCollectionTask(
    task: ScheduledTaskRecord,
    payload: ScheduledActionPayload,
    nowMs: number,
    runSlotKey: number
  ): Promise<{
    wechatReply: string;
    depositedPath: string;
    modelUsed: string;
    archiveContent: string;
  }> {
    const tz = task.timezone || "Asia/Shanghai";
    const dateTimeStr = formatZonedDateTime(nowMs, tz);
    const dateStr = dateTimeStr.slice(0, 10);

    // 1. Gather local Vault context & recent activity
    const nowMdSnippet = this.readNowMdSnippet();
    const recentArticles = this.getRecentArticlesWindow(
      payload.includeRecentArticlesHours ?? 24,
      nowMs
    );
    const activeTodos = this.db.listScheduledTasks({
      status: ["active"],
      scheduleType: "once",
      limit: 10,
    });

    const recentArticlesSummary =
      recentArticles.length > 0
        ? recentArticles
            .map(
              (a, i) =>
                `${i + 1}. #${a.id}《${a.title || a.url}》 (${a.status}) - ${a.short_summary || a.digest || "无摘要"}`
            )
            .join("\n")
        : "过去 24 小时暂无新收藏文章。";

    const activeTodosSummary =
      activeTodos.length > 0
        ? activeTodos
            .map(
              (t) =>
                `- #${t.id} ${t.title} (${t.next_run_at ? formatZonedDateTime(t.next_run_at, tz) : "待定"})`
            )
            .join("\n")
        : "当前无未完成的单次待办。";

    // 2. Call LLM (with web search grounding when executor === "web_search_digest")
    const needsWebSearch = payload.executor === "web_search_digest";
    let synthesizedBody = "";
    let modelUsed = "local-digest-fallback";
    let sources: Array<{ title: string; uri: string }> = [];

    if (this.config.llm.apiKey) {
      try {
        const searchHint =
          payload.searchQueries && payload.searchQueries.length > 0
            ? `\n建议重点检索关键词：${payload.searchQueries.join("、")}`
            : "";

        const systemPrompt = [
          "你是用户的个人知识库助理与每日情报研究员。",
          `当前时间：${dateTimeStr} (${tz})。`,
          "请根据用户的定时任务指令，收集、筛选并整理一份结构清晰、信息密度高、可直接阅读与归档的中文简报。",
          "输出要求：",
          "1. 先给出 3~5 条核心要点（Key Takeaways）；",
          "2. 分模块展开核心动态、关键洞察或今日知识库回顾；",
          "3. 结合用户当前的关注重点（now.md）与待办给出 1~3 条今日行动建议（Actionable Next Steps）。",
        ].join("\n");

        const userPrompt = [
          `【定时任务标题】${task.title}`,
          `【任务指令】${payload.prompt || task.title}${searchHint}`,
          "",
          nowMdSnippet ? `【用户当前关注 (now.md)】\n${nowMdSnippet}\n` : "",
          `【近期收藏文章】\n${recentArticlesSummary}`,
          "",
          `【当前待办事项】\n${activeTodosSummary}`,
        ]
          .filter(Boolean)
          .join("\n");

        const llmRes = await callAgentLlm({
          config: this.config,
          tier: "deep",
          systemPrompt,
          userPrompt,
          enableWebSearch: needsWebSearch,
          temperature: 0.3,
        });

        synthesizedBody = llmRes.text.trim();
        modelUsed = llmRes.modelUsed;
        sources = llmRes.sources ?? [];
      } catch (err: any) {
        console.warn(
          `[Scheduler] LLM digest call failed for task #${task.id}, using structured local summary:`,
          err?.message || err
        );
      }
    }

    if (!synthesizedBody) {
      synthesizedBody = [
        `### 📌 任务指令`,
        `${payload.prompt || task.title}`,
        "",
        `### 📚 近期收藏文章回顾 (${recentArticles.length} 篇)`,
        recentArticlesSummary,
        "",
        `### ⏰ 当前待处理事项 (${activeTodos.length} 项)`,
        activeTodosSummary,
      ].join("\n");
    }

    // 3. Always archive a complete Markdown note to Vault by default (Decision #2)
    const { filePath: depositedPath, content: archiveContent } = this.prepareDigestMarkdown({
      runSlotKey,
      task,
      payload,
      dateStr,
      dateTimeStr,
      synthesizedBody,
      modelUsed,
      sources,
      recentArticlesSummary,
      activeTodosSummary,
    });

    const relPath = relative(this.config.vaultRoot, depositedPath);
    const nextRunMs =
      task.schedule_type === "cron" && task.cron_expr
        ? getNextCronRunMs(task.cron_expr, nowMs, tz)
        : null;

    // 4. Format concise WeChat push summary card
    const maxPreviewLen = 1200;
    const previewBody =
      synthesizedBody.length > maxPreviewLen
        ? `${synthesizedBody.slice(0, maxPreviewLen).trim()}...\n\n_(完整内容已归档至知识库笔记)_`
        : synthesizedBody;

    const wechatLines: string[] = [
      `🌅 【定时简报 · #${task.id}】${task.title}`,
      `📅 ${dateTimeStr}`,
      "",
      previewBody,
    ];

    if (sources.length > 0) {
      wechatLines.push(
        "",
        "🔗 参考来源：",
        ...sources.slice(0, 4).map((s, i) => `${i + 1}. ${s.title}: ${s.uri}`)
      );
    }

    wechatLines.push("", `📂 已自动归档完整 Markdown 笔记：\`${relPath}\``);
    if (nextRunMs) {
      wechatLines.push(
        `🔄 下次执行：${formatZonedDateTime(nextRunMs, tz)} (${describeCronExpression(task.cron_expr)})`
      );
    }

    return {
      wechatReply: wechatLines.join("\n"),
      depositedPath,
      modelUsed,
      archiveContent,
    };
  }

  private prepareDigestMarkdown(params: {
    runSlotKey: number;
    task: ScheduledTaskRecord;
    payload: ScheduledActionPayload;
    dateStr: string;
    dateTimeStr: string;
    synthesizedBody: string;
    modelUsed: string;
    sources: Array<{ title: string; uri: string }>;
    recentArticlesSummary: string;
    activeTodosSummary: string;
  }): { filePath: string; content: string } {
    const {
      task,
      payload,
      dateStr,
      dateTimeStr,
      synthesizedBody,
      modelUsed,
      sources,
      recentArticlesSummary,
      activeTodosSummary,
    } = params;

    const subDir =
      this.config.vaultEnabled !== false &&
      this.config.vaultMode !== "standalone" &&
      this.config.vaultMode !== "generic_folder"
        ? "05_outputs/digests"
        : "digests";

    const dirPath = join(this.config.vaultRoot, subDir);
    mkdirSync(dirPath, { recursive: true });

    const slug = sanitizeSlug(task.title) || `digest-${task.id}`;
    const filePath = join(dirPath, `${dateStr}-${slug}-${task.id}-${params.runSlotKey}.md`);

    const scheduleLabel =
      task.schedule_type === "cron" && task.cron_expr
        ? `${task.cron_expr} (${describeCronExpression(task.cron_expr)})`
        : "once";

    const mdLines: string[] = [
      "---",
      "type: scheduled_digest",
      `task_id: ${task.id}`,
      `title: ${yamlQuote(`${task.title} (${dateStr})`)}`,
      `schedule: ${yamlQuote(scheduleLabel)}`,
      `executor: ${yamlQuote(payload.executor)}`,
      `model: ${yamlQuote(modelUsed)}`,
      `created: ${yamlQuote(dateTimeStr)}`,
      "tags:",
      "  - wechat_scheduler",
      "  - scheduled_digest",
      "---",
      "",
      `# ${task.title} (${dateStr})`,
      "",
      `> ⏰ **定时任务 #${task.id}** · 生成时间：\`${dateTimeStr}\` · 规则：\`${scheduleLabel}\` · 模型：\`${modelUsed}\``,
      "",
      synthesizedBody,
    ];

    if (sources.length > 0) {
      mdLines.push("", "## 🔗 检索参考来源 (Sources)", "");
      for (const src of sources) {
        mdLines.push(`- [${src.title}](${src.uri})`);
      }
    }

    mdLines.push(
      "",
      "---",
      "",
      "## 📎 附：当时知识库上下文快照",
      "",
      "### 近期收藏文章",
      recentArticlesSummary,
      "",
      "### 待办事项快照",
      activeTodosSummary,
      ""
    );

    return { filePath, content: mdLines.join("\n") };
  }

  private readNowMdSnippet(): string {
    if (
      this.config.vaultEnabled === false ||
      this.config.vaultMode === "standalone"
    ) {
      return "";
    }
    const nowRel = this.config.vaultLayout?.nowFile || "00_home/now.md";
    const nowPath = join(this.config.vaultRoot, nowRel);
    try {
      if (!existsSync(nowPath)) return "";
      return readFileSync(nowPath, "utf-8").slice(0, 1200).trim();
    } catch {
      return "";
    }
  }

  private getRecentArticlesWindow(hours: number, nowMs: number) {
    const all = this.db.listArticles({ limit: 30 });
    const cutoffMs = nowMs - Math.max(1, hours) * 3600_000;
    return all.filter((a) => {
      const ts = Date.parse(a.created_at);
      return Number.isFinite(ts) && ts >= cutoffMs;
    });
  }
}
