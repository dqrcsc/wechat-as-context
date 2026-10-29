import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AppConfig, expandHomePath, loadConfig, notifyExternalWebhookIfConfigured } from "./config.ts";
import { ArticleRecord, ContextDatabase } from "./db.ts";
import { extractWeChatArticle, sanitizeSlug, saveRawArticleToVault } from "./extractor/wechat.ts";
import {
  extractGeneralWebArticle,
  isWeChatArticleUrl,
  normalizeExternalWebUrl,
  saveRawWebArticleToVault,
} from "./extractor/web.ts";
import { analyzeArticleWithVault, isFallbackLightNote } from "./vault/analyzer.ts";
import { createIdeaSeedInVault, gatherVaultContext, saveCompanionLightNote } from "./vault/context.ts";
import {
  ClawBotMessage,
  extractTextFromClawBotMessage,
  unpackClawBotMessage,
  WeChatClawBotClient,
} from "./clawbot/client.ts";
import { documentLevel } from "./storage.ts";
import { WeChatAgentRuntime } from "./agent/runtime.ts";
import { formatLiveTaskStatusReport, isTaskStatusQuery } from "./agent/progress.ts";
import { DeliverableFormat, ensureMultiFormatDeliverables } from "./agent/doc_exporter.ts";
import { detectExplicitCliBackend, detectScheduleIntent } from "./agent/router.ts";
import { ScheduledRunOutcome, TaskSchedulerEngine } from "./scheduler/engine.ts";

export interface PushToWeChatOptions {
  text?: string;
  title?: string;
  files?: string[];
  formats?: DeliverableFormat[];
  articleId?: number;
  includeArticleFile?: boolean;
  useSourceFile?: boolean;
  recipient?: string;
  queueOnly?: boolean;
  clientIdPrefix?: string;
}

export interface PushDeliveryItemResult {
  clientId: string;
  kind: "text" | "file" | "image";
  target: string;
  status: "sent" | "pending" | "failed";
  attempts: number;
  error: string;
}

export interface PushToWeChatResult {
  ok: boolean;
  recipient: string;
  articleId: number | null;
  queuedCount: number;
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  compiledFiles: string[];
  missingFormats: DeliverableFormat[];
  items: PushDeliveryItemResult[];
}

export class WeChatContextPipeline {
  public clawbot: WeChatClawBotClient;
  public agent: WeChatAgentRuntime;
  public scheduler: TaskSchedulerEngine;
  private lastEnvMtimeMs = 0;
  private isDrainingArticles = false;
  private isDrainingAgents = false;

  constructor(public config: AppConfig, public db: ContextDatabase) {
    this.clawbot = new WeChatClawBotClient(db);
    this.scheduler = new TaskSchedulerEngine(config, db, this.clawbot);
    this.agent = new WeChatAgentRuntime(
      config,
      db,
      (id, triage, level) => this.markArticleTriage(id, triage, level),
      async (senderId, text) => {
        if (this.clawbot.isConfigured()) {
          await this.clawbot.sendTextMessage(
            senderId,
            text,
            `progress_${randomUUID().slice(0, 12)}`
          );
        }
      }
    );
    this.lastEnvMtimeMs = this.getEnvFileMtimeMs();
  }

  private getEnvFileMtimeMs(): number {
    try {
      const envPath = join(this.config.projectRoot, ".env");
      if (existsSync(envPath)) {
        return statSync(envPath).mtimeMs;
      }
    } catch {}
    return 0;
  }

  public refreshConfigFromDiskIfChanged(): void {
    const currentMtime = this.getEnvFileMtimeMs();
    if (currentMtime > 0 && currentMtime !== this.lastEnvMtimeMs) {
      const fresh = loadConfig(undefined, this.config.projectRoot);
      this.updateConfig(fresh);
    }
  }

  public updateConfig(config: AppConfig): void {
    this.config = config;
    this.agent.updateConfig(config);
    this.scheduler.config = config;
    this.lastEnvMtimeMs = this.getEnvFileMtimeMs();
  }

  public async processArticleById(id: number, options?: { sendWeChatReply?: boolean }): Promise<ArticleRecord> {
    return this.db.withLock(`article_${id}`, async () => {
      const record = this.db.getArticleById(id);
      if (!record) throw new Error(`Article #${id} not found`);
      // Existing work is authoritative. Even an unmarked human edit must never be regenerated.
      if (record.process_level === "deep" || (record.note_md_path && existsSync(record.note_md_path))) {
        if (record.note_md_path && existsSync(record.note_md_path) && ["pending_extract", "extracting", "analyzing", "failed"].includes(record.status)) {
          const deep = record.process_level === "deep" || ["deep", "synthesis"].includes(documentLevel(record.note_md_path) || "");
          return this.db.db.transaction(() => {
            const recovered = this.db.updateArticle(id, { status: deep ? "deep_done" : "light_done", process_level: deep ? "deep" : "light", error_message: "" })!;
            if (options?.sendWeChatReply !== false && record.channel === "clawbot" && record.sender_id) this.db.queueReply(`article_${id}_light`, record.sender_id, record.short_summary || `文章 #${id} 的原文与伴读笔记已保留，可在电脑端查看。`);
            return recovered;
          })();
        }
        return record;
      }
      return this.clawbot.withTypingIndicator(
        record.channel === "clawbot" ? record.sender_id : undefined,
        async () => {
          try {
            this.db.updateArticle(id, { status: "extracting", error_message: "" });
            const isWeChat = isWeChatArticleUrl(record.url);
            const extracted =
              record.source_md_path && existsSync(record.source_md_path)
                ? {
                    url: record.url,
                    title: record.title,
                    author: record.author,
                    digest: record.digest,
                    publishDate: "",
                    markdownBody: readFileSync(record.source_md_path, "utf8").replace(
                      /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
                      ""
                    ),
                    imageUrls: [],
                    extractorUsed: "native_http" as const,
                  }
                : isWeChat
                  ? await extractWeChatArticle(
                      record.url,
                      record.title,
                      record.author,
                      record.digest
                    )
                  : await extractGeneralWebArticle(
                      record.url,
                      record.title,
                      record.author,
                      record.digest,
                      {
                        allowJinaFallback: this.config.allowJinaFallback,
                        config: this.config,
                      }
                    );

            this.db.updateArticle(id, {
              title: extracted.title,
              author: extracted.author,
              digest: extracted.digest,
              status: "analyzing",
            });
            const vaultContext = gatherVaultContext(
              this.config.vaultRoot,
              [
                extracted.title,
                extracted.digest,
                record.user_notes,
                extracted.markdownBody.slice(0, 3000),
              ].join("\n"),
              { ...this.config.vaultLayout,
                excludePaths: [record.source_md_path, record.note_md_path].filter(Boolean),
                excludeSourceUrls: [record.url],
              }
            );
            const analysis = await analyzeArticleWithVault({
              config: this.config,
              article: extracted,
              userNotes: record.user_notes,
              vaultContext,
            });

            const isVideoSource = extracted.mediaKind === "video";
            const targetExternalDir = isVideoSource
              ? this.config.videoDir ||
                join(this.config.vaultRoot, "01_inputs", "video")
              : this.config.webArticlesDir ||
                join(this.config.vaultRoot, "01_inputs", "articles", "web");
            const externalFilePrefix = isVideoSource
              ? "video_source"
              : "web_article";

            const sourceMdPath = isWeChat
              ? await saveRawArticleToVault({
                  wechatArticlesDir: this.config.wechatArticlesDir,
                  article: extracted,
                  slug: analysis.english_slug,
                  userNotes: record.user_notes,
                  existingPath:
                    record.source_md_path ||
                    join(
                      this.config.wechatArticlesDir,
                      `wechat_article_${createHash("sha256")
                        .update(record.url)
                        .digest("hex")
                        .slice(0, 24)}.md`
                    ),
                })
              : await saveRawWebArticleToVault({
                  articlesDir: targetExternalDir,
                  article: extracted,
                  slug: analysis.english_slug,
                  userNotes: record.user_notes,
                  existingPath:
                    record.source_md_path ||
                    join(
                      targetExternalDir,
                      `${externalFilePrefix}_${createHash("sha256")
                        .update(record.url)
                        .digest("hex")
                        .slice(0, 24)}.md`
                    ),
                });

            // Persist paths before the next write, so a crash reuses the same files.
            const noteMdPath =
              record.note_md_path || sourceMdPath.replace(/\.md$/, "_note.md");
            this.db.updateArticle(id, {
              source_md_path: sourceMdPath,
              note_md_path: noteMdPath,
            });
            saveCompanionLightNote({
              sourceMdPath,
              existingPath: noteMdPath,
              sourceUrl: extracted.url,
              title: extracted.title,
              author: extracted.author,
              triage: analysis.triage,
              relatedVaultNodes: analysis.related_vault_nodes,
              noteMarkdownBody: analysis.companion_note_markdown,
            });
            const latest = this.db.getArticleById(id)!;
            const deep =
              latest.process_level === "deep" ||
              ["deep", "synthesis"].includes(documentLevel(noteMdPath) || "");
            const resultRecord = this.db.db.transaction(() => {
              const updated = this.db.updateArticle(id, {
                status: deep ? "deep_done" : "light_done",
                process_level: deep ? "deep" : "light",
                triage: deep ? latest.triage : analysis.triage,
                short_summary: analysis.wechat_reply,
                related_vault_nodes: JSON.stringify(analysis.related_vault_nodes),
              })!;
              if (
                options?.sendWeChatReply !== false &&
                record.channel === "clawbot" &&
                record.sender_id
              ) {
                this.db.queueReply(
                  `article_${id}_light`,
                  record.sender_id,
                  analysis.wechat_reply
                );
              }
              return updated;
            })();
            notifyExternalWebhookIfConfigured(
              this.config,
              "article",
              extracted.title,
              analysis.wechat_reply
            ).catch(() => {});
            return resultRecord;
          } catch (err: any) {
            this.db.updateArticle(id, {
              status: "failed",
              error_message: err?.message || String(err),
            });
            if (
              options?.sendWeChatReply !== false &&
              record.channel === "clawbot" &&
              record.sender_id
            ) {
              this.db.queueReply(
                `article_${id}_error`,
                record.sender_id,
                `⚠️ 文章 #${id} 处理失败，记录已保留，请在电脑端查看错误并重试。`
              );
            }
            throw err;
          }
        }
      );
    });
  }

  /**
   * Explicitly re-run initial model analysis on an existing article (e.g., to upgrade
   * a fallback local digest note after transient network or validation errors).
   * Never overwrites deep/synthesis notes, and only overwrites non-fallback light notes
   * when `force: true` is passed.
   */
  public async reanalyzeArticleById(
    id: number,
    options?: { sendWeChatReply?: boolean; force?: boolean }
  ): Promise<{
    record: ArticleRecord;
    upgradedFromFallback: boolean;
    isFallback: boolean;
  }> {
    this.refreshConfigFromDiskIfChanged();
    return this.db.withLock(`article_${id}`, async () => {
      const record = this.db.getArticleById(id);
      if (!record) throw new Error(`Article #${id} not found`);

      const existingNoteLevel = record.note_md_path
        ? documentLevel(record.note_md_path)
        : undefined;
      if (
        record.process_level === "deep" ||
        existingNoteLevel === "deep" ||
        existingNoteLevel === "synthesis"
      ) {
        throw new Error(
          `Article #${id} is already at ${existingNoteLevel || record.process_level} level; refusing to overwrite with light re-analysis.`
        );
      }

      const existingNoteContent =
        record.note_md_path && existsSync(record.note_md_path)
          ? readFileSync(record.note_md_path, "utf8")
          : "";
      const wasFallback =
        !existingNoteContent ||
        isFallbackLightNote(existingNoteContent) ||
        isFallbackLightNote(record.short_summary);

      if (existingNoteContent && !wasFallback && !options?.force) {
        throw new Error(
          `Article #${id} already has a completed model analysis note (${record.note_md_path}). Pass --force to re-generate light note.`
        );
      }

      const isWeChat = isWeChatArticleUrl(record.url);
      const existingSourceContent =
        record.source_md_path && existsSync(record.source_md_path)
          ? readFileSync(record.source_md_path, "utf8")
          : "";
      const shouldReextractSource =
        Boolean(options?.force) &&
        (!existingSourceContent ||
          /transcript_engine:\s*["']?metadata_only["']?/i.test(
            existingSourceContent
          ) ||
          existingSourceContent.includes("暂未获取到视频音频流或转写结果"));

      const extracted =
        existingSourceContent && !shouldReextractSource
          ? {
              url: record.url,
              title: record.title,
              author: record.author,
              digest: record.digest,
              publishDate:
                record.created_at?.slice(0, 10) ||
                new Date().toISOString().slice(0, 10),
              markdownBody: existingSourceContent.replace(
                /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
                ""
              ),
              imageUrls: [],
              extractorUsed: "native_http" as const,
            }
          : isWeChat
            ? await extractWeChatArticle(
                record.url,
                record.title,
                record.author,
                record.digest
              )
            : await extractGeneralWebArticle(
                record.url,
                record.title,
                record.author,
                record.digest,
                {
                  allowJinaFallback: this.config.allowJinaFallback,
                  config: this.config,
                }
              );

      const vaultContext = gatherVaultContext(
        this.config.vaultRoot,
        [
          extracted.title,
          extracted.digest,
          record.user_notes,
          extracted.markdownBody.slice(0, 3000),
        ].join("\n"),
        {
          ...this.config.vaultLayout,
          excludePaths: [record.source_md_path, record.note_md_path].filter(Boolean),
          excludeSourceUrls: [record.url],
        }
      );

      const analysis = await analyzeArticleWithVault({
        config: this.config,
        article: extracted,
        userNotes: record.user_notes,
        vaultContext,
      });

      const isStillFallback = isFallbackLightNote(analysis.wechat_reply);
      if (isStillFallback && existingNoteContent) {
        return {
          record,
          upgradedFromFallback: false,
          isFallback: true,
        };
      }

      const targetExternalDir =
        extracted.mediaKind === "video"
          ? this.config.videoDir ||
            join(this.config.vaultRoot, "01_inputs", "video")
          : this.config.webArticlesDir ||
            join(this.config.vaultRoot, "01_inputs", "articles", "web");
      const sourceMdPath =
        record.source_md_path &&
        existsSync(record.source_md_path) &&
        !shouldReextractSource
          ? record.source_md_path
          : isWeChat
            ? await saveRawArticleToVault({
                wechatArticlesDir: this.config.wechatArticlesDir,
                article: extracted,
                slug: analysis.english_slug,
                userNotes: record.user_notes,
                existingPath: record.source_md_path || undefined,
              })
            : await saveRawWebArticleToVault({
                articlesDir: targetExternalDir,
                article: extracted,
                slug: analysis.english_slug,
                userNotes: record.user_notes,
                existingPath: record.source_md_path || undefined,
                overwriteExisting: shouldReextractSource,
              });

      const noteMdPath =
        record.note_md_path || sourceMdPath.replace(/\.md$/, "_note.md");
      saveCompanionLightNote({
        sourceMdPath,
        existingPath: noteMdPath,
        overwriteExisting: true,
        sourceUrl: extracted.url,
        title: extracted.title,
        author: extracted.author,
        triage: analysis.triage,
        relatedVaultNodes: analysis.related_vault_nodes,
        noteMarkdownBody: analysis.companion_note_markdown,
      });

      const updated = this.db.db.transaction(() => {
        const row = this.db.updateArticle(id, {
          title: extracted.title || record.title,
          author: extracted.author || record.author,
          digest: extracted.digest || record.digest,
          source_md_path: sourceMdPath,
          note_md_path: noteMdPath,
          status: "light_done",
          process_level: "light",
          triage: analysis.triage,
          short_summary: analysis.wechat_reply,
          related_vault_nodes: JSON.stringify(analysis.related_vault_nodes),
          error_message: "",
        })!;
        if (options?.sendWeChatReply && record.sender_id) {
          this.db.queueReply(
            `article_${id}_reanalyze_${Date.now()}`,
            record.sender_id,
            analysis.wechat_reply
          );
        }
        return row;
      })();

      return {
        record: updated,
        upgradedFromFallback: wasFallback && !isStillFallback,
        isFallback: isStillFallback,
      };
    });
  }

  private async withActiveTaskSleepGuard<T>(action: () => Promise<T>): Promise<T> {
    if (
      process.platform !== "darwin" ||
      process.env.WXCTX_TEST_ROOT ||
      !existsSync("/usr/bin/caffeinate")
    ) {
      return action();
    }
    let guardProc: ReturnType<typeof Bun.spawn> | null = null;
    try {
      guardProc = Bun.spawn(
        ["/usr/bin/caffeinate", "-i", "-s", "-w", String(process.pid)],
        { stdout: "ignore", stderr: "ignore" }
      );
    } catch {}
    try {
      return await action();
    } finally {
      if (guardProc) {
        try {
          guardProc.kill();
        } catch {}
      }
    }
  }

  public async drainReadyQueue(): Promise<ArticleRecord[]> {
    if (this.isDrainingArticles) return [];
    this.isDrainingArticles = true;
    const processed: ArticleRecord[] = [];
    try {
      const pendingItems = this.db.getReadyPendingArticles();
      if (pendingItems.length === 0) return [];
      await this.withActiveTaskSleepGuard(async () => {
        for (const item of pendingItems) {
          try {
            processed.push(
              await this.processArticleById(item.id, { sendWeChatReply: true })
            );
          } catch (err: any) {
            if (!String(err?.message || "").includes("Operation busy")) {
              console.error(`[Pipeline] Article #${item.id}:`, err);
            }
          }
        }
      });
    } finally {
      this.isDrainingArticles = false;
    }
    return processed;
  }

  // Synchronous routing is committed with the inbox acknowledgement. No network awaits in this transaction.
  public handleIncomingMessage(params: { msgid: string; senderId: string; channel: "clawbot" | "cli"; msgType: string; title?: string; digest?: string; url?: string; textContent?: string }): void {
    const { msgid, senderId, channel } = params;
    const text = (params.textContent || "").trim();
    const reply = (body: string) => {
      if (channel === "clawbot") this.db.queueReply(`message_${createHash("sha256").update(msgid).digest("hex")}`, senderId, body);
    };
    const recent = () => this.db.db.query("SELECT * FROM articles WHERE sender_id = ? ORDER BY id DESC LIMIT 1").get(senderId) as ArticleRecord | null;
    const idea = text.match(/^(?:想法|灵感|观点|我有一个想法|idea)\s*[:：]\s*([\s\S]+)$/i);
    if (idea) {
      const article = recent();
      const seed = createIdeaSeedInVault({ ideasSeedsDir: this.config.ideasSeedsDir, thoughtText: idea[1].trim(), slug: "wechat_thought", captureId: msgid, sourceMdPath: article?.source_md_path, sourceUrl: article?.url, relatedVaultNodes: article ? JSON.parse(article.related_vault_nodes) : [] });
      reply(`💡 想法已保存：03_ideas/seeds/${basename(seed)}`);
      return;
    }
    const url = params.url || text.match(/https?:\/\/[^\s<>"]+/i)?.[0];
    if (url) {
      const normalized = normalizeWeChatUrl(url);
      const inlineNote = params.url ? "" : text.replace(url, "").trim();
      const { record, isNew } = this.db.enqueueArticle({ msgid, url: normalized, title: params.title, digest: params.digest, user_notes: inlineNote, sender_id: senderId, channel, waitSeconds: inlineNote ? 0 : this.config.annotationWaitSeconds });
      reply(isNew ? `⏳ 已收到文章 #${record.id}，将抓取并生成初筛笔记；可继续补充批注。` : `已记录文章 #${record.id} 的补充批注，已有原文和伴读笔记保持不变。`);
      return;
    }
    if (/^(?:深读|精读|优先|process_now)$/i.test(text)) {
      const article = recent();
      if (article) {
        // Queue priority only; no background edits to existing Markdown.
        this.db.updateArticle(article.id, { triage: "process_now" });
        reply(`📌 文章 #${article.id} 已加入优先深读队列。`);
        return;
      }
    }
    const attached = this.db.attachUserNoteToRecentArticle(senderId, text, 15);
    reply(attached ? `已保存文章 #${attached.id} 的批注；已有笔记不会自动重写，请在电脑端结合批注继续深读。` : "请发送公众号链接，或使用「想法：...」保存个人想法。");
  }

  public markArticleTriage(id: number, triage: "keep_raw" | "reference" | "process_later" | "process_now", processLevel?: "raw" | "light" | "deep"): ArticleRecord | null {
    if (!["keep_raw", "reference", "process_later", "process_now"].includes(triage) || (processLevel && !["raw", "light", "deep"].includes(processLevel))) throw new Error("Invalid triage or process level");
    const rec = this.db.getArticleById(id);
    if (!rec) return null;
    const edits: Array<[string, string]> = [];
    for (const path of [rec.source_md_path, rec.note_md_path]) {
      if (!path || !existsSync(path)) throw new Error("Article or companion file missing; state was not updated");
      const content = readFileSync(path, "utf8");
      const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
      if (!match) throw new Error(`Missing frontmatter: ${path}`);
      let header = match[2].replace(/^triage:[^\r\n]*/m, `triage: ${triage}`);
      if (!/^triage:/m.test(header)) header += `\ntriage: ${triage}`;
      if (processLevel) {
        header = header.replace(/^process_level:[^\r\n]*/m, `process_level: ${processLevel}`);
        if (!/^process_level:/m.test(header)) header += `\nprocess_level: ${processLevel}`;
      }
      edits.push([path, match[1] + header + match[3] + content.slice(match[0].length)]);
    }
    // Failure is surfaced, never reported as a successful database-only update.
    for (const [path, content] of edits) writeFileSync(path, content, "utf8");
    return this.db.updateArticle(id, { triage, ...(processLevel ? { process_level: processLevel, status: processLevel === "deep" ? "deep_done" : processLevel === "light" ? "light_done" : "pending_extract" } : {}) });
  }

  public processPendingMessages(): number {
    let count = 0;
    for (const pending of this.db.pendingMessages()) {
      try {
        this.db.db.transaction(() => {
          const row = this.db.db.query("SELECT status FROM inbound_messages WHERE message_key = ?").get(pending.message_key) as { status: string };
          if (row.status !== "pending") return;
          const m = JSON.parse(pending.payload) as ClawBotMessage;
          const unpacked = unpackClawBotMessage(m);
          const text = extractTextFromClawBotMessage(m);
          const hasContent = Boolean(text || unpacked.mediaItems.length > 0);

          if ((!m.message_type || m.message_type === 1) && hasContent) {
            if (!m.from_user_id) throw new Error("Message has no sender identity");
            if (isTaskStatusQuery(unpacked.userText) && unpacked.mediaItems.length === 0) {
              const statusText = formatLiveTaskStatusReport(this.db, m.from_user_id, this.config.taskHeartbeatSeconds ?? 25);
              this.db.queueReply(
                `message_${createHash("sha256").update(pending.message_key).digest("hex")}`,
                m.from_user_id,
                statusText
              );
            } else if (
              this.db.hasRunningAgentTask() &&
              this.canBypassBusyAgentQueue(unpacked, text)
            ) {
              this.handleIncomingMessage({
                msgid: pending.message_key,
                senderId: m.from_user_id,
                channel: "clawbot",
                msgType: "text",
                textContent: text,
              });
            } else if (this.shouldUseAsyncAgentRuntime(m, unpacked)) {
              const wasBusy = this.db.hasRunningAgentTask();
              const taskRec = this.db.enqueueAgentTask(
                pending.message_key,
                m.from_user_id,
                pending.payload
              );
              if (wasBusy && taskRec.id > 0) {
                const aheadCount = this.db.countActiveAgentTasksAhead(taskRec.id);
                if (aheadCount > 0) {
                  this.db.queueReply(
                    `queue_ack_${createHash("sha256").update(pending.message_key).digest("hex")}`,
                    m.from_user_id,
                    `⏳ 已收到新消息，当前前方有 ${aheadCount} 个任务正在执行，完成后将立即为你处理（可发送「进度」查看实时状态）。`
                  );
                }
              }
            } else {
              this.handleIncomingMessage({
                msgid: pending.message_key,
                senderId: m.from_user_id,
                channel: "clawbot",
                msgType: "text",
                textContent: text,
              });
            }
          }
          this.db.db.query("UPDATE inbound_messages SET status = 'done', error = '' WHERE message_key = ?").run(pending.message_key);
          count++;
        }).immediate();
      } catch (e: any) {
        this.db.db.query("UPDATE inbound_messages SET error = ? WHERE message_key = ?").run(e.message, pending.message_key);
        console.error(`[Inbox] ${pending.message_key}: ${e.message}`);
      }
    }
    return count;
  }

  private canBypassBusyAgentQueue(
    unpacked: ReturnType<typeof unpackClawBotMessage>,
    rawText: string
  ): boolean {
    if (unpacked.mediaItems.length > 0 || unpacked.refContext) return false;
    const t = (unpacked.userText || rawText || "").trim();
    if (!t || detectExplicitCliBackend(t)) return false;
    if (/^(?:想法|灵感|观点|我有一个想法|idea)\s*[:：]\s*([\s\S]+)$/i.test(t)) {
      return true;
    }
    if (/^(?:深读|精读|优先|process_now)$/i.test(t)) {
      return true;
    }
    if (unpacked.urls.length === 1 && isWeChatArticleUrl(unpacked.urls[0])) {
      return true;
    }
    return false;
  }

  private shouldUseAsyncAgentRuntime(
    _msg: ClawBotMessage,
    unpacked: ReturnType<typeof unpackClawBotMessage>
  ): boolean {
    if (this.config.llm.apiKey) return true;
    if (
      unpacked.mediaItems.some(
        (i) => i.kind === "image" || i.kind === "file" || i.kind === "video"
      )
    ) {
      return true;
    }
    if (unpacked.refContext) return true;
    if (unpacked.urls.some((u) => !isWeChatArticleUrl(u))) return true;
    const t = unpacked.userText.trim();
    if (detectExplicitCliBackend(t)) return true;
    if (detectScheduleIntent(t)) return true;
    if (
      /^(?:\/help|help|帮助|功能|菜单|问|查询|检索|搜索|查一下|搜一下|找一下|ask|\?|待办|备忘|速记|提醒我|todo|inbox)/i.test(
        t
      ) ||
      /(?:发文件|发给我|发我微信|导出|我的知识库|知识库里|我突然想到|我想到)/i.test(t)
    ) {
      return true;
    }
    return false;
  }

  public async drainScheduledTasks(options?: {
    nowMs?: number;
    forceTaskId?: number;
  }): Promise<ScheduledRunOutcome[]> {
    this.refreshConfigFromDiskIfChanged();
    return this.scheduler.tick(options);
  }

  public async drainAgentQueue(): Promise<number> {
    if (this.isDrainingAgents) return 0;
    this.isDrainingAgents = true;
    let processedCount = 0;
    try {
      this.refreshConfigFromDiskIfChanged();
      return await this.db.withLock("agent_queue", async () => {
        // Only the exclusive worker may recover interrupted tasks. Constructors and
        // read commands must never reset work owned by another live process.
        this.db.recoverStuckAgentTasks();
        const tasks = this.db.getPendingAgentTasks(20);
        if (tasks.length === 0) return 0;
        return await this.withActiveTaskSleepGuard(async () => {
        for (const task of tasks) {
          const wasRecovered = task.stage.includes("检测到中断");
          this.db.updateAgentTaskStatus(
            task.id,
            "processing",
            "",
            wasRecovered ? "已从中断状态恢复，正在重新执行" : "已开始处理任务"
          );
          if (wasRecovered && this.clawbot.isConfigured()) {
            await this.clawbot
              .sendTextMessage(
                task.sender_id,
                `🔄 检测到上次长任务 (#${task.id}) 因后台重启曾短暂中断，现已自动恢复并继续为你执行…`,
                `recover_${task.id}_${Date.now()}`
              )
              .catch(() => {});
          }
          try {
            const rawMessage = JSON.parse(task.raw_payload) as ClawBotMessage;
            await this.clawbot.withTypingIndicator(task.sender_id, async () => {
              const result = await this.agent.processClawBotMessage({
                messageKey: task.message_key,
                senderId: task.sender_id,
                rawMessage,
              });
              this.db.updateAgentTaskStatus(task.id, result.outcome === "failed" ? "failed" : "done",
                result.outcome === "failed" ? result.error || result.replyText : "",
                result.outcome === "failed" ? "任务执行失败，错误回执已入队" : result.outcome === "partial" ? "任务部分完成，缺失内容见回执" : "任务执行完成，回执已入队");
            });
            processedCount++;
            if (this.clawbot.isConfigured()) {
              await this.flushReplies().catch(() => {});
            }
          } catch (err: any) {
            const errMsg = err?.message || String(err);
            this.db.updateAgentTaskStatus(
              task.id,
              "failed",
              errMsg,
              `执行异常终止: ${errMsg.slice(0, 80)}`
            );
            const msgHash = createHash("sha256").update(task.message_key).digest("hex");
            this.db.queueReply(
              `message_${msgHash}`,
              task.sender_id,
              `⚠️ 长任务 (#${task.id}) 执行异常终止：\n${errMsg.slice(0, 240)}\n\n💡 你可以直接回复「按我之前的需求重新生成」进行重试。`
            );
            if (this.clawbot.isConfigured()) {
              await this.flushReplies().catch(() => {});
            }
            console.error(`[AgentQueue] Task #${task.id} (${task.message_key}) failed:`, errMsg);
          }
        }
        return processedCount;
        });
      });
    } catch (err: any) {
      if (err?.message === "Operation busy: agent_queue") return 0;
      throw err;
    } finally {
      this.isDrainingAgents = false;
    }
  }

  public async flushReplies(options?: {
    enforceRetryBackoff?: boolean;
    nowMs?: number;
    ignoreBusy?: boolean;
  }): Promise<void> {
    const nowMs = options?.nowMs ?? Date.now();
    const enforceBackoff = Boolean(options?.enforceRetryBackoff);
    try {
      await this.db.withLock("outbox", async () => {
        this.db.db.query("UPDATE reply_outbox SET status = 'failed', error = CASE WHEN error = '' THEN 'Delivery outcome unknown after interrupted attempt' ELSE error END WHERE status = 'pending' AND attempts >= 3").run();
        const rows = this.db.db
          .query(
            "SELECT * FROM reply_outbox WHERE status = 'pending' AND attempts < 3 AND (? = 0 OR next_retry_at <= ?) ORDER BY rowid"
          )
          .all(enforceBackoff ? 1 : 0, nowMs) as Array<{
          id: string;
          recipient: string;
          text: string;
          attempts: number;
          media_type?: string;
          media_path?: string;
          media_sha256?: string;
        }>;
        for (const row of rows) {
          const nextAttempts = row.attempts + 1;
          this.db.db.query("UPDATE reply_outbox SET attempts = ? WHERE id = ?").run(nextAttempts, row.id);
          try {
            if (
              (row.media_type === "file" || row.media_type === "image") &&
              row.media_path
            ) {
              if (!row.media_sha256) throw new Error("Legacy media entry has no content snapshot; requeue the file");
              const digest = createHash("sha256").update(readFileSync(row.media_path)).digest("hex");
              if (digest !== row.media_sha256) throw new Error("Outbox media snapshot checksum mismatch; requeue the file");
              await this.clawbot.sendMediaFile(row.recipient, row.media_path, row.id);
            } else {
              await this.clawbot.sendTextMessage(row.recipient, row.text, row.id);
            }
            this.db.db.query("UPDATE reply_outbox SET status = 'sent', error = '', next_retry_at = 0 WHERE id = ?").run(row.id);
          } catch (e: any) {
            const backoffMs =
              nextAttempts === 1 ? 5_000 : nextAttempts === 2 ? 15_000 : 45_000;
            const nextRetryAt = nextAttempts >= 3 ? 0 : nowMs + backoffMs;
            this.db.db
              .query(
                "UPDATE reply_outbox SET status = ?, error = ?, next_retry_at = ? WHERE id = ?"
              )
              .run(nextAttempts >= 3 ? "failed" : "pending", e.message, nextRetryAt, row.id);
            console.error(`[Outbox] ${row.id}: ${e.message}`);
          }
        }
        this.db.pruneSentOutboxMedia();
        this.db.pruneHistoricalRecords({ nowMs });
      });
    } catch (err: any) {
      if (
        options?.ignoreBusy &&
        String(err?.message || "").includes("Operation busy: outbox")
      ) {
        return;
      }
      throw err;
    }
  }

  public async flushRepliesWithRetry(maxLockRetries = 5, retryDelayMs = 300): Promise<void> {
    for (let attempt = 0; attempt < maxLockRetries; attempt++) {
      try {
        await this.flushReplies();
        return;
      } catch (err: any) {
        if (
          String(err?.message || "").includes("Operation busy: outbox") &&
          attempt + 1 < maxLockRetries
        ) {
          await Bun.sleep(retryDelayMs);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Proactively push text messages, local files/images, multi-format deliverables (.md/.html/.pdf),
   * or an inbox article's summary/companion note from local CLI (Codex / Antigravity) to WeChat.
   */
  public async pushToWeChat(options: PushToWeChatOptions): Promise<PushToWeChatResult> {
    if (!this.clawbot.isConfigured()) {
      throw new Error(
        "尚未绑定 微信ClawBot [AI]，请先运行 `bun run src/cli.ts login` 扫码绑定。"
      );
    }

    const recipient = this.clawbot.resolveDefaultRecipient(options.recipient);
    if (!recipient) {
      throw new Error(
        "未找到微信接收人 userId，请先运行 `bun run src/cli.ts login` 绑定或在微信中向 ClawBot 发送一条消息。"
      );
    }

    let finalText = (options.text ?? "").trim();
    const rawInputFiles = [...(options.files ?? [])];
    const requestedFormats: DeliverableFormat[] = options.formats ?? [];
    let targetArticle: ArticleRecord | null = null;

    if (options.articleId !== undefined) {
      targetArticle = this.db.getArticleById(options.articleId);
      if (!targetArticle) {
        throw new Error(`未找到 ID 为 #${options.articleId} 的文章记录`);
      }

      const wantsArticleFile =
        options.includeArticleFile === true ||
        options.useSourceFile === true ||
        requestedFormats.length > 0;

      if (wantsArticleFile) {
        const candidatePath = options.useSourceFile
          ? targetArticle.source_md_path
          : targetArticle.note_md_path || targetArticle.source_md_path;
        if (!candidatePath || !existsSync(candidatePath)) {
          throw new Error(
            `文章 #${targetArticle.id} 尚无可用的本地 Markdown 文件（当前状态: ${targetArticle.status}）`
          );
        }
        rawInputFiles.push(candidatePath);
      }

      if (!finalText) {
        if (wantsArticleFile) {
          finalText =
            targetArticle.short_summary ||
            `📎 推送文章 #${targetArticle.id}《${targetArticle.title || targetArticle.url}》文档`;
        } else {
          finalText =
            targetArticle.short_summary ||
            (targetArticle.note_md_path && existsSync(targetArticle.note_md_path)
              ? readFileSync(targetArticle.note_md_path, "utf-8").slice(0, 1500)
              : `📄 文章 #${targetArticle.id}《${targetArticle.title || targetArticle.url}》`);
        }
      }
    }

    const resolvedFiles: string[] = [];
    for (const rawFile of rawInputFiles) {
      const trimmed = rawFile.trim();
      if (!trimmed) continue;
      const absPath = expandHomePath(trimmed, process.cwd());
      if (!existsSync(absPath) || !statSync(absPath).isFile()) {
        throw new Error(`未找到要推送的本地文件: ${rawFile}`);
      }
      if (!resolvedFiles.includes(absPath)) {
        resolvedFiles.push(absPath);
      }
    }

    const finalFiles: string[] = [];
    const compiledFiles: string[] = [];
    const missingFormats: DeliverableFormat[] = [];

    if (requestedFormats.length > 0) {
      const mdFiles = resolvedFiles.filter((f) =>
        [".md", ".markdown"].includes(extname(f).toLowerCase())
      );
      const nonMdFiles = resolvedFiles.filter(
        (f) => ![".md", ".markdown"].includes(extname(f).toLowerCase())
      );

      if (mdFiles.length > 0) {
        for (const mdPath of mdFiles) {
          const produced = await ensureMultiFormatDeliverables({
            markdownPath: mdPath,
            outputDir: dirname(mdPath),
            baseFileStem: basename(mdPath, extname(mdPath)),
            title: options.title || targetArticle?.title || undefined,
            requestedFormats,
          });
          for (const fmt of requestedFormats) {
            const hasFmt = produced.some(
              (p) => extname(p).toLowerCase().replace(/^\./, "") === fmt
            );
            if (!hasFmt && !missingFormats.includes(fmt)) {
              missingFormats.push(fmt);
            }
          }
          for (const p of produced) {
            if (!finalFiles.includes(p)) finalFiles.push(p);
            if (!compiledFiles.includes(p)) compiledFiles.push(p);
          }
        }
        for (const other of nonMdFiles) {
          if (!finalFiles.includes(other)) finalFiles.push(other);
        }
      } else if (resolvedFiles.length === 0 && finalText) {
        // Compile inline Markdown text directly into requested file deliverables
        const outDir = join(this.config.dataDir, "generated");
        const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
        const stemSlug = sanitizeSlug(options.title || "pushed_document") || "pushed_document";
        const stem = `${datePrefix}_${stemSlug}_${randomUUID().slice(0, 6)}`;
        const produced = await ensureMultiFormatDeliverables({
          markdownContent: finalText,
          outputDir: outDir,
          baseFileStem: stem,
          title: options.title || "推送文档",
          requestedFormats,
        });
        for (const fmt of requestedFormats) {
          const hasFmt = produced.some(
            (p) => extname(p).toLowerCase().replace(/^\./, "") === fmt
          );
          if (!hasFmt && !missingFormats.includes(fmt)) {
            missingFormats.push(fmt);
          }
        }
        for (const p of produced) {
          if (!finalFiles.includes(p)) finalFiles.push(p);
          if (!compiledFiles.includes(p)) compiledFiles.push(p);
        }
        // Replace long raw markdown text with a concise caption so we don't spam the chat bubble with raw markdown
        if (produced.length > 0 && finalText.length > 400) {
          finalText = options.title
            ? `📎 已为你生成并推送《${options.title}》(${produced.map((p) => basename(p)).join("、")})`
            : `📎 已为你生成并推送文档 (${produced.map((p) => basename(p)).join("、")})`;
        }
      } else {
        for (const f of resolvedFiles) {
          if (!finalFiles.includes(f)) finalFiles.push(f);
        }
      }
    } else {
      for (const f of resolvedFiles) {
        if (!finalFiles.includes(f)) finalFiles.push(f);
      }
    }

    if (!finalText && finalFiles.length === 0) {
      throw new Error(
        "请提供要推送的文本内容 (--text / --stdin) 或本地文件路径 (--file)"
      );
    }

    const prefix =
      options.clientIdPrefix ||
      `wxpush_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const queuedEntries: Array<{
      clientId: string;
      kind: "text" | "file" | "image";
      target: string;
    }> = [];

    if (finalText) {
      const textClientId = `${prefix}_text`;
      this.db.queueReply(textClientId, recipient, finalText);
      queuedEntries.push({
        clientId: textClientId,
        kind: "text",
        target: finalText.slice(0, 120),
      });
    }

    for (let i = 0; i < finalFiles.length; i++) {
      const fPath = finalFiles[i];
      const ext = extname(fPath).toLowerCase();
      const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
      const kind: "file" | "image" = isImage ? "image" : "file";
      const mediaClientId = `${prefix}_media_${i}`;
      this.db.queueMediaReply(mediaClientId, recipient, kind, fPath);
      queuedEntries.push({
        clientId: mediaClientId,
        kind,
        target: fPath,
      });
    }

    if (!options.queueOnly) {
      await this.flushRepliesWithRetry();
    }

    const items: PushDeliveryItemResult[] = [];
    let sentCount = 0;
    let failedCount = 0;
    let pendingCount = 0;

    for (const entry of queuedEntries) {
      const row = this.db.db
        .query(
          "SELECT status, attempts, error FROM reply_outbox WHERE id = ?"
        )
        .get(entry.clientId) as {
        status: "sent" | "pending" | "failed";
        attempts: number;
        error: string;
      } | null;

      const status = row?.status ?? "pending";
      if (status === "sent") sentCount++;
      else if (status === "failed") failedCount++;
      else pendingCount++;

      items.push({
        clientId: entry.clientId,
        kind: entry.kind,
        target: entry.target,
        status,
        attempts: row?.attempts ?? 0,
        error: row?.error ?? "",
      });
    }

    // Record into conversation_turns so follow-up questions on WeChat know what Codex/Antigravity just pushed
    if (sentCount > 0 || options.queueOnly) {
      const fileNames = finalFiles.map((f) => basename(f)).join(", ");
      this.db.recordConversationTurn({
        messageKey: prefix,
        senderId: recipient,
        userText: fileNames
          ? `[电脑端主动推送: ${fileNames}]`
          : "[电脑端主动推送消息]",
        mediaSummary: fileNames,
        intent: "cli_push",
        complexity: "fast",
        modelUsed: "cli_push",
        relatedArticleId: targetArticle?.id ?? null,
        depositedPath: JSON.stringify(finalFiles),
        assistantReply:
          finalText ||
          `📎 已从电脑端推送文件：${finalFiles.map((f) => basename(f)).join("、")}`,
      });
    }

    const ok = options.queueOnly
      ? failedCount === 0 && missingFormats.length === 0
      : sentCount === queuedEntries.length &&
        failedCount === 0 &&
        missingFormats.length === 0;

    return {
      ok,
      recipient,
      articleId: targetArticle?.id ?? null,
      queuedCount: queuedEntries.length,
      sentCount,
      failedCount,
      pendingCount,
      compiledFiles,
      missingFormats,
      items,
    };
  }

  public async pollClawBotUpdates(
    timeoutMs = 30_000,
    options?: { backgroundDrain?: boolean }
  ): Promise<number> {
    if (!this.clawbot.isConfigured()) throw new Error("ClawBot credentials not configured");
    this.refreshConfigFromDiskIfChanged();
    return this.db.withLock("sync", async () => {
      let count = this.processPendingMessages();
      if (options?.backgroundDrain) {
        await this.flushReplies({ ignoreBusy: true });
        void this.drainAgentQueue().catch((e) =>
          console.error("[BackgroundAgentDrain]", e)
        );
      } else {
        await this.drainAgentQueue();
      }
      try {
        await this.clawbot.getUpdates(timeoutMs);
        this.db.setState("clawbot_last_poll", JSON.stringify({ checkedAt: new Date().toISOString(), error: null }));
      } catch (e: any) {
        this.db.setState("clawbot_last_poll", JSON.stringify({ checkedAt: new Date().toISOString(), error: e.message }));
        throw e;
      }
      count += this.processPendingMessages();
      if (options?.backgroundDrain) {
        // Flush any immediate synchronous replies (e.g. "进度" status query or link ack) right away
        await this.flushReplies({ ignoreBusy: true });
        // Run heavy agent/article queues in background so long-polling is never blocked!
        void (async () => {
          const aCount = await this.drainAgentQueue();
          const rList = await this.drainReadyQueue();
          const sList = await this.drainScheduledTasks();
          if (aCount > 0 || rList.length > 0 || sList.length > 0) {
            await this.flushReplies({ ignoreBusy: true });
          }
        })().catch((e) => console.error("[BackgroundDrain]", e));
      } else {
        await this.drainAgentQueue();
        await this.drainReadyQueue();
        await this.drainScheduledTasks();
        await this.flushReplies({ ignoreBusy: true });
      }
      return count;
    });
  }
}

export function normalizeWeChatUrl(rawUrl: string): string {
  const normalized = rawUrl.trim().replace(/&amp;/g, "&");
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.hostname !== "mp.weixin.qq.com" || url.port || url.username || url.password || !/^\/s(?:\/|$)/.test(url.pathname)) throw new Error("Expected an HTTPS mp.weixin.qq.com/s article URL");
  url.hash = "";
  return url.toString();
}
