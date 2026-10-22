import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { AppConfig, notifyExternalWebhookIfConfigured } from "../config.ts";
import { ArticleRecord, ContextDatabase, ConversationTurnRecord, TriageLevel } from "../db.ts";
import { ClawBotMessage, unpackClawBotMessage, UnpackedClawBotMessage } from "../clawbot/client.ts";
import { downloadAndDecryptCdnMedia } from "../clawbot/media.ts";
import { isWeChatArticleUrl, normalizeExternalWebUrl } from "../extractor/web.ts";
import { sanitizeSlug } from "../extractor/wechat.ts";
import { normalizeWeChatUrl } from "../pipeline.ts";
import {
  createIdeaSeedInVault,
  createInboxCaptureInVault,
  findSiblingMultiFormatFiles,
  findVaultFilesByQuery,
  gatherVaultArchitectureContext,
  gatherVaultContext,
} from "../vault/context.ts";
import {
  DeliverableFormat,
  detectRequestedFormats,
  detectWantsFileDelivery,
  ensureMultiFormatDeliverables,
  isDocumentGenerationTask,
} from "./doc_exporter.ts";
import { callAgentLlm, getFastModel, getProModel, MultimodalImageInput } from "./llm.ts";
import {
  AgentIntentKind,
  classifyMessageIntent,
  detectExplicitCliBackend,
  findPriorComplexTaskTurn,
  IntentDecision,
} from "./router.ts";
import {
  executeTieredAgentTask,
  getPreferredCliBackend,
  selectAgyModel,
  SubagentBackend,
} from "./subagent_cli.ts";
import {
  formatLiveTaskStatusReport,
  isTaskStatusQuery,
  TaskProgressReporter,
} from "./progress.ts";

export interface IntentExecutionContext {
  config: AppConfig;
  db: ContextDatabase;
  messageKey: string;
  senderId: string;
  rawMessage: ClawBotMessage;
  unpacked: UnpackedClawBotMessage;
  decision: IntentDecision;
  recentTurns: ConversationTurnRecord[];
  recentArticle: ArticleRecord | null;
  referencedArticle: ArticleRecord | null;
  markTriageCallback?: (
    id: number,
    triage: TriageLevel,
    level?: "raw" | "light" | "deep"
  ) => ArticleRecord | null;
  sendProgressCallback?: (senderId: string, text: string) => Promise<void>;
}

export interface IntentExecutionResult {
  replyText: string;
  mediaDeliveries?: Array<{
    mediaType: "file" | "image";
    mediaPath: string;
  }>;
  modelUsed: string;
  relatedArticleId?: number | null;
  depositedPath?: string;
}

export type IntentHandlerFn = (
  ctx: IntentExecutionContext
) => Promise<IntentExecutionResult>;

export class WeChatAgentRuntime {
  private handlers = new Map<AgentIntentKind, IntentHandlerFn>();

  constructor(
    private config: AppConfig,
    private db: ContextDatabase,
    private markTriageCallback?: IntentExecutionContext["markTriageCallback"],
    private sendProgressCallback?: IntentExecutionContext["sendProgressCallback"]
  ) {
    this.registerDefaultHandlers();
  }

  public updateConfig(config: AppConfig): void {
    this.config = config;
  }

  /**
   * Extensibility hook: Register or override any Intent Handler at runtime.
   */
  public registerIntentHandler(
    intent: AgentIntentKind,
    handler: IntentHandlerFn
  ): void {
    this.handlers.set(intent, handler);
  }

  private registerDefaultHandlers(): void {
    this.handlers.set("capture_idea", (ctx) => this.handleCaptureIdea(ctx));
    this.handlers.set("capture_inbox", (ctx) => this.handleCaptureInbox(ctx));
    this.handlers.set("ingest_link", (ctx) => this.handleIngestLink(ctx));
    this.handlers.set("article_followup", (ctx) => this.handleArticleFollowup(ctx));
    this.handlers.set("vault_query", (ctx) => this.handleVaultQuery(ctx));
    this.handlers.set("web_search", (ctx) => this.handleWebSearch(ctx));
    this.handlers.set("multimodal_ingest", (ctx) => this.handleMultimodalIngest(ctx));
    this.handlers.set("generate_image", (ctx) => this.handleGenerateImage(ctx));
    this.handlers.set("delegate_subagent", (ctx) => this.handleDelegateSubagent(ctx));
    this.handlers.set("send_file", (ctx) => this.handleSendFile(ctx));
    this.handlers.set("general_assistant", (ctx) => this.handleGeneralAssistant(ctx));
  }

  /**
   * Process a single ClawBotMessage through the Intent Router and execute the matched Intent Handler.
   */
  public async processClawBotMessage(params: {
    messageKey: string;
    senderId: string;
    rawMessage: ClawBotMessage;
  }): Promise<IntentExecutionResult> {
    const { messageKey, senderId, rawMessage } = params;
    const unpacked = unpackClawBotMessage(rawMessage);

    // Fast-path for live task progress / status queries ("进度" / "状态" / "还在跑吗")
    if (isTaskStatusQuery(unpacked.userText) && unpacked.mediaItems.length === 0) {
      const statusText = formatLiveTaskStatusReport(this.db, senderId);
      const msgHash = createHash("sha256").update(messageKey).digest("hex");
      this.db.queueReply(`message_${msgHash}`, senderId, statusText);
      return {
        replyText: statusText,
        modelUsed: "task_status_monitor",
      };
    }

    const recentArticle = this.db.db
      .query("SELECT * FROM articles WHERE sender_id = ? ORDER BY id DESC LIMIT 1")
      .get(senderId) as ArticleRecord | null;

    const referencedArticle = this.resolveReferencedArticle(unpacked, senderId);
    const recentTurns = this.db.getRecentConversationTurns(senderId, 6);

    const decision = await classifyMessageIntent({
      config: this.config,
      unpacked,
      recentTurns,
      recentArticle,
      referencedArticle,
    });

    const handler =
      this.handlers.get(decision.intent) ??
      ((ctx: IntentExecutionContext) => this.handleGeneralAssistant(ctx));

    const result = await handler({
      config: this.config,
      db: this.db,
      messageKey,
      senderId,
      rawMessage,
      unpacked,
      decision,
      recentTurns,
      recentArticle,
      referencedArticle,
      markTriageCallback: this.markTriageCallback,
      sendProgressCallback: this.sendProgressCallback,
    });

    // Queue text reply and any media attachments into reply_outbox
    const msgHash = createHash("sha256").update(messageKey).digest("hex");
    if (result.replyText.trim()) {
      this.db.queueReply(`message_${msgHash}`, senderId, result.replyText);
    }
    if (result.mediaDeliveries?.length) {
      for (let i = 0; i < result.mediaDeliveries.length; i++) {
        const md = result.mediaDeliveries[i];
        this.db.queueMediaReply(
          `media_${msgHash}_${i}`,
          senderId,
          md.mediaType,
          md.mediaPath
        );
      }
    }

    // Record turn into conversation_turns for multi-turn memory
    this.db.recordConversationTurn({
      messageKey,
      senderId,
      userText:
        unpacked.userText ||
        (unpacked.mediaItems.length > 0
          ? `[多媒体消息: ${unpacked.mediaItems.map((m) => m.kind).join(",")}]`
          : ""),
      refText: unpacked.refContext?.quotedText || unpacked.refContext?.title || "",
      mediaSummary: unpacked.mediaItems
        .map((m) => `${m.kind}:${m.fileName || "unnamed"}`)
        .join(", "),
      intent: decision.intent,
      complexity: decision.complexity,
      modelUsed: result.modelUsed,
      relatedArticleId: result.relatedArticleId ?? decision.targetArticleId ?? null,
      depositedPath: result.depositedPath ?? "",
      assistantReply: result.replyText,
    });

    return result;
  }

  private resolveReferencedArticle(
    unpacked: UnpackedClawBotMessage,
    senderId: string
  ): ArticleRecord | null {
    const ref = unpacked.refContext;
    if (!ref) return null;

    if (ref.embeddedUrl) {
      const byUrl = this.db.findByUrlOrMsgid(ref.embeddedUrl);
      if (byUrl) return byUrl;
    }
    const combinedRef = [ref.title, ref.quotedText].filter(Boolean).join("\n");
    if (combinedRef) {
      return this.db.findArticleByQuery(combinedRef, senderId);
    }
    return null;
  }

  private isStandaloneMode(): boolean {
    return (
      this.config.vaultMode === "standalone" ||
      this.config.vaultEnabled === false
    );
  }

  private getOutputsDir(): string {
    if (this.isStandaloneMode()) {
      return join(this.config.vaultRoot, "outputs");
    }
    if (
      this.config.vaultMode === "generic_folder" &&
      !existsSync(join(this.config.vaultRoot, "05_outputs"))
    ) {
      return join(this.config.vaultRoot, "outputs");
    }
    return join(this.config.vaultRoot, "05_outputs", "research_notes");
  }

  // ============================================================================
  // 1. Intent: capture_idea (03_ideas/seeds/)
  // ============================================================================
  private async handleCaptureIdea(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const rawThought =
      ctx.decision.slots.coreContent?.trim() ||
      ctx.unpacked.userText
        .replace(/^(?:想法|灵感|观点|我有一个想法|idea)\s*[:：]\s*/i, "")
        .trim();

    const targetArticle =
      (ctx.decision.targetArticleId
        ? this.db.getArticleById(ctx.decision.targetArticleId)
        : null) ??
      ctx.referencedArticle ??
      ctx.recentArticle;

    const vaultCtx = gatherVaultContext(
      this.config.vaultRoot,
      rawThought,
      this.config.vaultLayout
    );
    const relatedNodes =
      vaultCtx.matchedNotes.length > 0
        ? vaultCtx.matchedNotes.map((m) => m.wikiLink)
        : targetArticle
          ? safeParseJsonArray(targetArticle.related_vault_nodes)
          : [];

    const seedPath = createIdeaSeedInVault({
      ideasSeedsDir: this.config.ideasSeedsDir,
      thoughtText: rawThought,
      slug: ctx.decision.slots.ideaSlug || "wechat_thought",
      captureId: ctx.messageKey,
      sourceMdPath: targetArticle?.source_md_path || undefined,
      sourceUrl: targetArticle?.url || undefined,
      relatedVaultNodes: relatedNodes,
    });

    let modelUsed = "local_rule";
    let aiReflection = "";
    if (this.config.llm.apiKey) {
      try {
        const llmRes = await callAgentLlm({
          config: this.config,
          tier: ctx.decision.complexity,
          systemPrompt: `你是用户的第二大脑思考伙伴。用户刚刚记录了一条个人想法并已存入 03_ideas/seeds/。
请用 80~180 字简短回应：
1. 提炼该想法最有价值的 1 个张力或切入点；
2. 指出它与知识库命中节点的潜在连接或可追问的下一步问题。保持干练、有启发性。`,
          userPrompt: `【用户的想法】\n${rawThought}\n\n【关联文章】\n${targetArticle?.title || "无"}\n\n【命中知识库节点】\n${relatedNodes.join("、") || "暂无"}`,
          temperature: 0.3,
        });
        aiReflection = `\n\n✨ 思考共鸣（${llmRes.modelUsed}）：\n${llmRes.text}`;
        modelUsed = llmRes.modelUsed;
      } catch {}
    }

    void notifyExternalWebhookIfConfigured(
      this.config,
      "idea",
      `新想法已捕获 (${basename(seedPath)})`,
      rawThought.slice(0, 300)
    ).catch(() => {});

    return {
      replyText: `💡 想法已保存：03_ideas/seeds/${basename(seedPath)}${
        relatedNodes.length > 0
          ? `\n🔗 关联节点：${relatedNodes.slice(0, 4).join("、")}`
          : ""
      }${aiReflection}`,
      modelUsed,
      relatedArticleId: targetArticle?.id ?? null,
      depositedPath: seedPath,
    };
  }

  // ============================================================================
  // 2. Intent: capture_inbox (01_inputs/inbox/)
  // ============================================================================
  private async handleCaptureInbox(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const inboxDir =
      this.config.inboxDir || join(this.config.vaultRoot, "01_inputs", "inbox");
    const bodyText =
      ctx.decision.slots.coreContent?.trim() || ctx.unpacked.userText.trim();
    const title =
      ctx.decision.slots.ideaTitle?.trim() ||
      bodyText.slice(0, 36).replace(/\r?\n/g, " ");

    const filePath = createInboxCaptureInVault({
      inboxDir,
      title,
      bodyText,
      slug: ctx.decision.slots.ideaSlug || "wechat_memo",
      captureId: ctx.messageKey,
    });

    return {
      replyText: `📥 备忘/速记已存入收集箱：01_inputs/inbox/${basename(filePath)}`,
      modelUsed: getFastModel(this.config),
      depositedPath: filePath,
    };
  }

  // ============================================================================
  // 3. Intent: ingest_link (WeChat MP + External Web URLs)
  // ============================================================================
  private async handleIngestLink(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const rawUrl =
      ctx.decision.slots.url ||
      ctx.unpacked.urls[0] ||
      ctx.unpacked.userText.match(/https?:\/\/[^\s<>"]+/i)?.[0];

    if (!rawUrl) {
      return this.handleGeneralAssistant(ctx);
    }

    const isWeChat = isWeChatArticleUrl(rawUrl);
    const normalizedUrl = isWeChat
      ? normalizeWeChatUrl(rawUrl)
      : normalizeExternalWebUrl(rawUrl);

    const inlineNote =
      ctx.decision.slots.userNotes ??
      ctx.unpacked.userText.replace(rawUrl, "").trim();

    const { record, isNew } = this.db.enqueueArticle({
      msgid: ctx.messageKey,
      url: normalizedUrl,
      user_notes: inlineNote,
      sender_id: ctx.senderId,
      channel: "clawbot",
      waitSeconds: inlineNote ? 0 : this.config.annotationWaitSeconds,
    });

    if (ctx.decision.slots.triageHint) {
      this.db.updateArticle(record.id, { triage: ctx.decision.slots.triageHint });
    }

    const kindLabel = isWeChat ? "公众号文章" : "网页链接";
    return {
      replyText: isNew
        ? `⏳ 已收到${kindLabel} #${record.id}，将抓取并生成初筛笔记；可继续补充批注。`
        : `已记录${kindLabel} #${record.id} 的补充批注，已有原文和伴读笔记保持不变。`,
      modelUsed: "fast_router",
      relatedArticleId: record.id,
    };
  }

  // ============================================================================
  // 4. Intent: article_followup (annotate / triage / qa / deepen)
  // ============================================================================
  private async handleArticleFollowup(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const target =
      (ctx.decision.targetArticleId
        ? this.db.getArticleById(ctx.decision.targetArticleId)
        : null) ??
      ctx.referencedArticle ??
      ctx.recentArticle;

    if (!target) {
      return this.handleGeneralAssistant(ctx);
    }

    const subAction = ctx.decision.slots.articleSubAction || "annotate";

    if (subAction === "triage") {
      const triage: TriageLevel =
        ctx.decision.slots.triageHint || "process_now";
      if (
        ctx.markTriageCallback &&
        target.source_md_path &&
        existsSync(target.source_md_path) &&
        target.note_md_path &&
        existsSync(target.note_md_path)
      ) {
        ctx.markTriageCallback(target.id, triage);
      } else {
        this.db.updateArticle(target.id, { triage });
      }
      return {
        replyText:
          triage === "process_now"
            ? `📌 文章 #${target.id} 已加入优先深读队列。`
            : `📌 文章 #${target.id}《${target.title || target.url}》分诊已更新为：${triage}`,
        modelUsed: getFastModel(this.config),
        relatedArticleId: target.id,
      };
    }

    if (subAction === "annotate") {
      const updatedNotes = target.user_notes
        ? `${target.user_notes}\n${ctx.unpacked.userText}`
        : ctx.unpacked.userText;
      this.db.updateArticle(target.id, { user_notes: updatedNotes });
      return {
        replyText: `📝 已记录文章 #${target.id}《${target.title || "待抓取"}》的批注：${ctx.unpacked.userText}\n（你可以随时针对该文章继续提问，或发送「深读」标记为优先处理）`,
        modelUsed: "local_rule",
        relatedArticleId: target.id,
      };
    }

    // Sub-action: "qa" or "deepen" -> Answer questions or perform deep analysis on the article!
    const sourceText =
      target.source_md_path && existsSync(target.source_md_path)
        ? readFileSync(target.source_md_path, "utf-8").slice(0, 18_000)
        : target.short_summary || target.digest || "（文章正在抓取或暂无本地全文）";

    const noteText =
      target.note_md_path && existsSync(target.note_md_path)
        ? readFileSync(target.note_md_path, "utf-8").slice(0, 6_000)
        : "";

    const vaultCtx = gatherVaultContext(
      this.config.vaultRoot,
      `${target.title}\n${ctx.unpacked.userText}`,
      this.config.vaultLayout
    );

    const tier = subAction === "deepen" ? "deep" : ctx.decision.complexity;
    if (!this.config.llm.apiKey && !this.config.llm.allowCodexFallback) {
      return {
        replyText: `📖 文章 #${target.id}《${target.title}》摘要：\n${target.short_summary || target.digest}\n（配置 LLM_API_KEY 后支持全文深度追问）`,
        modelUsed: "local_fallback",
        relatedArticleId: target.id,
      };
    }

    const llmRes = await executeTieredAgentTask({
      config: this.config,
      complexity: tier,
      preferredBackend: ctx.decision.slots.subagentTarget || "agy",
      systemPrompt: `你是用户的个人知识库深度阅读搭档。用户正在手机微信上针对已入库的文章 #${target.id}《${target.title}》进行追问或要求深度拆解。
请严格基于文章原文与用户知识库既有上下文直接回答。
要求：
- 手机微信阅读友好，分段清晰，控制在 250~550 字以内；
- 如果用户引用了特定片段（partial_text），重点围绕该片段展开；
- 明确区分原文事实与你的推演判断。`,
      userPrompt: `【用户的问题/指令】
${ctx.unpacked.userText}

${
  ctx.unpacked.refContext?.partialText
    ? `【用户高亮引用的片段】\n${ctx.unpacked.refContext.partialText}\n\n`
    : ""
}【伴读初筛卡内容】
${noteText}

【文章原文内容（节选）】
${sourceText}

【知识库相关节点】
${vaultCtx.matchedNotes.map((m) => `${m.wikiLink}: ${m.excerpt}`).join("\n\n") || "（无直接命中）"}`,
      temperature: 0.25,
    });

    return {
      replyText: `📖 针对《${target.title || `#${target.id}`}》的回应（${llmRes.modelUsed}）：\n\n${llmRes.text}`,
      modelUsed: llmRes.modelUsed,
      relatedArticleId: target.id,
    };
  }

  // ============================================================================
  // 5. Intent: vault_query (Personal Knowledge Base Q&A & Retrieval)
  // ============================================================================
  private async handleVaultQuery(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const query =
      ctx.decision.slots.searchQuery?.trim() || ctx.unpacked.userText.trim();
    const matchedFiles = findVaultFilesByQuery(
      this.config.vaultRoot,
      query,
      6,
      this.config.vaultLayout?.searchDirs
    );
    const vaultCtx = gatherVaultContext(
      this.config.vaultRoot,
      query,
      this.config.vaultLayout
    );
    const matchedArticles = this.db
      .listArticles({ limit: 20 })
      .filter(
        (a) =>
          a.title.toLowerCase().includes(query.toLowerCase()) ||
          a.short_summary.toLowerCase().includes(query.toLowerCase()) ||
          a.user_notes.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, 4);

    if (!this.config.llm.apiKey && !this.config.llm.allowCodexFallback) {
      const lines = [
        `🔍 知识库检索结果（关键词：${query}）：`,
        matchedFiles.length > 0
          ? matchedFiles
              .map((m, i) => `${i + 1}. ${m.wikiLink} (\`${m.relativePath}\`)\n   ${m.excerpt.slice(0, 120)}...`)
              .join("\n")
          : "未找到直接匹配的笔记文件。",
      ];
      return {
        replyText: lines.join("\n\n"),
        modelUsed: "local_search",
      };
    }

    const notesEvidence =
      matchedFiles.length > 0
        ? matchedFiles
            .map(
              (m, i) =>
                `[笔记 ${i + 1}] ${m.wikiLink} (路径: ${m.relativePath})\n内容节选:\n${m.excerpt}`
            )
            .join("\n\n---\n\n")
        : "（未检索到直接匹配的 Markdown 笔记）";

    const articlesEvidence =
      matchedArticles.length > 0
        ? matchedArticles
            .map(
              (a) =>
                `- 文章 #${a.id}《${a.title}》(${a.author}) [${a.process_level}/${a.triage}]\n  摘要: ${a.short_summary.slice(0, 200)}`
            )
            .join("\n")
        : "（未命中相关收藏文章）";

    const progress =
      ctx.decision.complexity === "deep"
        ? new TaskProgressReporter({
            db: this.db,
            messageKey: ctx.messageKey,
            senderId: ctx.senderId,
            taskTitle: "知识库深度推演",
            sendProgressCallback: ctx.sendProgressCallback,
          })
        : null;

    if (progress) {
      await progress.start(`正在检索知识库并调用深度模型推演（命中 ${matchedFiles.length} 篇笔记）`);
    }

    try {
      const llmRes = await executeTieredAgentTask({
        config: this.config,
        complexity: ctx.decision.complexity,
        preferredBackend: ctx.decision.slots.subagentTarget || "agy",
        onStageChange: progress
          ? (stage, opts) => progress.updateStage(stage, opts)
          : undefined,
        onActivity: progress
          ? (detail) => progress.updateActivity(detail)
          : undefined,
        systemPrompt: `你是用户的个人知识库（${this.config.vaultRoot}）随身顾问。
请严格依据下方检索到的知识库真实笔记与收藏文章回答用户的查询。
规则：
1. 必须引用具体的笔记名（如 [[笔记名]] 或相对路径），绝不编造不存在的笔记；
2. 若知识库中尚无直接记录，请如实说明检索范围，并基于用户当前主线（now.md）给出补充建议；
3. 排版适合手机微信阅读，重点突出，控制在 250~550 字以内。`,
        userPrompt: `【用户查询】
${ctx.unpacked.userText}

【00_home/now.md 当前关注】
${vaultCtx.nowSummary}

【00_home/queue.md 待办队列】
${vaultCtx.queueSummary}

【检索到的知识库笔记证据】
${notesEvidence}

【检索到的微信收藏文章】
${articlesEvidence}`,
        temperature: 0.2,
      });

      return {
        replyText: `📚 知识库查询（${llmRes.modelUsed}）：\n\n${llmRes.text}`,
        modelUsed: llmRes.modelUsed,
      };
    } finally {
      progress?.stop("知识库深度推演完成");
    }
  }

  // ============================================================================
  // 5.5 Intent: web_search (Real-Time Public Information Search via Google Search Grounding)
  // ============================================================================
  private async handleWebSearch(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    if (!this.config.llm.apiKey) {
      return {
        replyText: "⚠️ 尚未配置 LLM_API_KEY，无法执行实时联网公开信息检索。",
        modelUsed: "local_fallback",
      };
    }

    const vaultCtx = gatherVaultContext(
      this.config.vaultRoot,
      ctx.unpacked.userText,
      this.config.vaultLayout
    );

    const llmRes = await callAgentLlm({
      config: this.config,
      tier: ctx.decision.complexity,
      enableWebSearch: true,
      systemPrompt: `你是用户的随身调研助理兼知识库顾问。请通过 Google Search 实时检索公开互联网信息来回答用户的问题。
要求：
1. 事实准确、时效性强，给出具体结论、数据或时间节点；
2. 结合用户当前关注的研究方向（00_home/now.md）提炼对用户最有参考价值的信号；
3. 手机微信阅读友好，分段清晰，控制在 250~550 字以内。`,
      userPrompt: `【用户联网检索请求】
${ctx.unpacked.userText}

【用户当前研究焦点参考 (00_home/now.md)】
${vaultCtx.nowSummary}`,
      temperature: 0.2,
    });

    const sourceDomains =
      llmRes.sources && llmRes.sources.length > 0
        ? `\n\n🌐 检索来源：${llmRes.sources
            .slice(0, 5)
            .map((s) => s.title)
            .join(" · ")}`
        : "";

    return {
      replyText: `🌐 公开信息检索（${llmRes.modelUsed}）：\n\n${llmRes.text}${sourceDomains}\n\n（💡 提示：回复「把刚才搜到的存进收集箱」或「存成想法」可直接归档入库）`,
      modelUsed: llmRes.modelUsed,
    };
  }

  // ============================================================================
  // 6. Intent: multimodal_ingest (C2C Image / File AES-128-ECB Decrypt & Vision)
  // ============================================================================
  private async handleMultimodalIngest(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const inboxDir =
      this.config.inboxDir || join(this.config.vaultRoot, "01_inputs", "inbox");
    const assetsDir = join(inboxDir, "assets");
    const papersDir =
      this.config.papersDir || join(this.config.vaultRoot, "01_inputs", "papers");

    const downloadedPaths: string[] = [];
    const imageInputs: MultimodalImageInput[] = [];
    const textSnippets: string[] = [];
    const unreadableApiFiles: string[] = [];

    for (const item of ctx.unpacked.mediaItems) {
      if (item.kind !== "image" && item.kind !== "file") continue;
      const targetSaveDir =
        item.kind === "file" && item.fileName?.toLowerCase().endsWith(".pdf")
          ? papersDir
          : assetsDir;

      const downloaded = await downloadAndDecryptCdnMedia({
        media: item.media,
        hexAesKeyFallback: item.hexAesKeyFallback,
        saveDir: targetSaveDir,
        suggestedFileName: item.fileName,
      });

      downloadedPaths.push(downloaded.filePath);

      if (downloaded.mimeType.startsWith("image/")) {
        imageInputs.push({
          mimeType: downloaded.mimeType,
          base64Data: downloaded.buffer.toString("base64"),
        });
      } else if (
        ["md", "txt", "json"].includes(downloaded.ext) &&
        downloaded.buffer.length < 200_000
      ) {
        textSnippets.push(
          `文件《${basename(downloaded.filePath)}》内容：\n${downloaded.buffer
            .toString("utf-8")
            .slice(0, 8000)}`
        );
      } else {
        unreadableApiFiles.push(basename(downloaded.filePath));
      }
    }

    if (downloadedPaths.length === 0) {
      return this.handleGeneralAssistant(ctx);
    }

    let extractedAnalysis = "";
    let analysisWarning = "";
    let modelUsed = "local_decrypt";

    const userInstruction =
      ctx.unpacked.userText.trim() ||
      "请提取这张图片/文件中的核心文字、架构要点或关键信息，并整理为结构化 Markdown 笔记（200~450字）。";

    // Hierarchical cascade for multimodal understanding:
    // Tier 1: Local CLI (agy / codex) -> Tier 2: Pro Model (gemini-2.5-pro) -> Tier 3: Fast Model (gemini-2.5-flash)
    const preferredBackend: SubagentBackend =
      ctx.decision.slots.subagentTarget ||
      (/codex/i.test(ctx.unpacked.userText) ? "codex" : "agy");

    try {
      const tieredRes = await executeTieredAgentTask({
        config: this.config,
        complexity: ctx.decision.complexity,
        forceCliFirst: true,
        apiFallbackBlockedReason: unreadableApiFiles.length > 0
          ? `当前 API 不支持读取这些附件正文：${unreadableApiFiles.join("、")}。本地 CLI 未完成解析；请使用可读取该文件的 CLI，或提供文本/图片后重试。`
          : undefined,
        preferredBackend,
        preferredAgyModel: selectAgyModel(
          ctx.unpacked.userText,
          ctx.decision.complexity
        ),
        workingDir: this.config.vaultRoot,
        imagePaths: downloadedPaths,
        cliPrompt: `你是用户的多模态知识采集助手。用户在微信上发来了图片或文件附件，已解密保存在本地。
请直接读取这些本地文件，提取其中的核心内容（如截图文字、架构图逻辑、书页摘录或文档核心论点），输出清晰的 Markdown 摘要。
【用户说明】
${userInstruction}

${textSnippets.join("\n\n")}`,
        systemPrompt: `你是用户的多模态知识采集助手。用户在微信上发来了图片或文件附件。
请提取其中的核心内容（如截图文字、架构图逻辑、书页摘录或文档核心论点），输出清晰的 Markdown 摘要。`,
        userPrompt: `【用户附带说明】\n${userInstruction}\n\n${textSnippets.join("\n\n")}`,
        images: imageInputs,
        temperature: 0.2,
      });
      extractedAnalysis = tieredRes.text;
      modelUsed = tieredRes.modelUsed;
    } catch (err: any) {
      analysisWarning = `已归档，未解析：${err?.message || err}`;
      modelUsed = "local_archive";
    }

    const firstAssetRel = relative(inboxDir, downloadedPaths[0]);
    const targetMode = ctx.decision.slots.multimodalTarget || "inbox";
    let depositedPath = downloadedPaths[0];

    if (targetMode === "idea") {
      depositedPath = createIdeaSeedInVault({
        ideasSeedsDir: this.config.ideasSeedsDir,
        thoughtText: [
          ctx.unpacked.userText,
          extractedAnalysis,
          analysisWarning,
          `\n关联媒体文件：\`${relative(this.config.vaultRoot, downloadedPaths[0])}\``,
        ]
          .filter(Boolean)
          .join("\n\n"),
        slug: "wechat_multimodal_idea",
        captureId: ctx.messageKey,
      });
    } else {
      depositedPath = createInboxCaptureInVault({
        inboxDir,
        title:
          ctx.unpacked.userText.slice(0, 36) ||
          `微信多媒体采集 (${basename(downloadedPaths[0])})`,
        bodyText:
          extractedAnalysis ||
          [analysisWarning, ctx.unpacked.userText].filter(Boolean).join("\n\n") ||
          ctx.unpacked.userText ||
          `已解密保存附件：${basename(downloadedPaths[0])}`,
        slug: "wechat_media_capture",
        captureId: ctx.messageKey,
        attachedAssetRelPath: firstAssetRel,
      });
    }

    const relSaved = relative(this.config.vaultRoot, depositedPath);
    return {
      replyText: [
        `🖼️ 已解密并归档媒体文件：\`${relSaved}\``,
        extractedAnalysis ? `\n📋 内容提炼（${modelUsed}）：\n${extractedAnalysis}` : "",
        analysisWarning ? `\n⚠️ ${analysisWarning}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      modelUsed,
      depositedPath,
    };
  }

  // ============================================================================
  // 6.5 Intent: generate_image (Tier 1: AGY CLI -> Tier 2: Pro Model -> Tier 3: Fast Model)
  // ============================================================================
  private async handleGenerateImage(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const imagePrompt =
      ctx.decision.slots.imagePrompt?.trim() ||
      ctx.decision.slots.coreContent?.trim() ||
      ctx.unpacked.userText.trim();

    const progress = new TaskProgressReporter({
      db: this.db,
      messageKey: ctx.messageKey,
      senderId: ctx.senderId,
      taskTitle: "视觉生图任务",
      sendProgressCallback: ctx.sendProgressCallback,
    });

    await progress.start(
      "正在调用视觉生成引擎制作图片",
      `🎨 已收到生图请求，正在调用视觉生成引擎制作图片，处理期间每 25 秒会同步一次进度，完成后立即发给你…`
    );

    try {
      const tieredRes = await executeTieredAgentTask({
        config: this.config,
        complexity: "deep",
        forceCliFirst: true,
        preferredBackend: "agy",
        preferredAgyModel: selectAgyModel(ctx.unpacked.userText, "deep"),
        workingDir: this.config.vaultRoot,
        expectGeneratedImage: true,
        onStageChange: (stage, opts) => progress.updateStage(stage, opts),
        onActivity: (detail) => progress.updateActivity(detail),
        cliPrompt: `用户在微信上请求生成一张图片。
【用户生图需求】
${imagePrompt}

${
  ctx.unpacked.refContext?.quotedText
    ? `【用户引用的上下文】\n${ctx.unpacked.refContext.quotedText}\n`
    : ""
}请调用 image-generator 生成高质量图片，并在回复中简要说明图片的设计构图亮点（100字以内）。`,
        systemPrompt: `你是用户的视觉架构师。当本地生图 CLI 不可用时，请为用户生成清晰的可视化字符架构图 / Mermaid 结构图与高精度生图 Prompt 规范。`,
        userPrompt: `【用户生图需求】\n${imagePrompt}`,
        temperature: 0.3,
      });

      if (tieredRes.generatedImages.length > 0) {
        return {
          replyText: `🎨 已通过子智能体 [${tieredRes.modelUsed}] 生成图片，正在加密回传微信：\n\n${tieredRes.text}`,
          mediaDeliveries: tieredRes.generatedImages.map((imgPath) => ({
            mediaType: "image" as const,
            mediaPath: imgPath,
          })),
          modelUsed: tieredRes.modelUsed,
          depositedPath: tieredRes.generatedImages[0],
        };
      }

      const cliFailStep = tieredRes.tierPath.find((s) =>
        s.startsWith("cli:agy(failed:")
      );
      const cliFailNote = cliFailStep
        ? `\n> ⚠️ 本地 AGY 生图未完成（\`${cliFailStep.slice(0, 180)}\`），已自动降级由云端模型提供分镜与 Prompt：\n`
        : "";

      return {
        replyText: `🎨 视觉生成响应（${tieredRes.modelUsed}）：${cliFailNote}\n${tieredRes.text}`,
        modelUsed: tieredRes.modelUsed,
      };
    } catch (err: any) {
      return {
        replyText: `⚠️ 调用生图链路失败：${err?.message || err}`,
        modelUsed: "agy_error",
      };
    } finally {
      progress.stop("视觉生图任务结束");
    }
  }

  // ============================================================================
  // 6.8 Intent: delegate_subagent (Compound Research, Document Synthesis & CLI Governance)
  // ============================================================================
  private async handleDelegateSubagent(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const explicitCli = detectExplicitCliBackend(ctx.unpacked.userText);
    const backend: SubagentBackend =
      explicitCli ||
      ctx.decision.slots.subagentTarget ||
      getPreferredCliBackend(
        this.config,
        /agy|antigravity|opus|sonnet/i.test(ctx.unpacked.userText) ? "agy" : "codex"
      );

    // Reconstruct full task requirement if user is correcting or retrying a prior turn
    const priorComplexTurn = findPriorComplexTaskTurn(ctx.recentTurns);
    const isRetryOrCorrection =
      ctx.decision.slots.isTaskRetryOrCorrection === true ||
      /(?:不是这个.*(?:帮我生成|指南|需求)|你看看我之前的需求|按我之前的需求|刚才没生成|重新帮我生成)/i.test(
        ctx.unpacked.userText
      );

    const effectiveRequirement =
      isRetryOrCorrection &&
      priorComplexTurn &&
      !ctx.unpacked.userText.includes(priorComplexTurn.user_text.slice(0, 30))
        ? `${priorComplexTurn.user_text}\n\n【用户最新补充/纠偏要求】：${ctx.unpacked.userText}`
        : ctx.decision.slots.coreContent?.trim() || ctx.unpacked.userText.trim();

    const requestedFormats = detectRequestedFormats(
      effectiveRequirement,
      ctx.decision.slots.requestedFormats
    );
    const wantsFileDelivery =
      detectWantsFileDelivery(
        effectiveRequirement,
        ctx.decision.slots.wantsFileDelivery
      ) || requestedFormats.length > 0;
    const isDocGen =
      isDocumentGenerationTask(effectiveRequirement) ||
      requestedFormats.length > 0 ||
      isRetryOrCorrection;
    const needsWebSearch =
      ctx.decision.slots.needsWebSearch === true ||
      /(?:搜一下|搜索|查一下|检索|网上|karpathy|arxiv|最新)/i.test(
        effectiveRequirement
      );

    // Only include targetArticle if explicitly referenced or matched by ID — never pollute unrelated tasks!
    const targetArticle =
      (ctx.decision.targetArticleId
        ? this.db.getArticleById(ctx.decision.targetArticleId)
        : null) ??
      ctx.referencedArticle ??
      (/(?:这篇文章|刚才那篇|上一篇)/.test(ctx.unpacked.userText)
        ? ctx.recentArticle
        : null);

    const progress = new TaskProgressReporter({
      db: this.db,
      messageKey: ctx.messageKey,
      senderId: ctx.senderId,
      taskTitle: isDocGen ? "深度研究与多格式文档生成" : "子智能体复杂任务",
      sendProgressCallback: ctx.sendProgressCallback,
    });

    try {
      // Fast-path for retry/correction: if today's matching guide already exists in 05_outputs/research_notes/,
      // ensure all requested formats (.md, .html, .pdf) are compiled and deliver them immediately!
      if (isRetryOrCorrection && isDocGen) {
        const existingTodayMd = this.findTodayMatchingOutputMd(effectiveRequirement);
        if (existingTodayMd && existsSync(existingTodayMd)) {
          await progress.start("正在读取已生成的指南并补齐多格式文件 (MD / HTML / PDF)");
          const formatsToDeliver: DeliverableFormat[] =
            requestedFormats.length > 0 ? requestedFormats : ["md", "html", "pdf"];
          const deliverableFiles = await ensureMultiFormatDeliverables({
            markdownPath: existingTodayMd,
            outputDir: this.getOutputsDir(),
            baseFileStem: basename(existingTodayMd, ".md"),
            requestedFormats: formatsToDeliver,
          });
          if (deliverableFiles.length > 0) {
            const mdPreview = readFileSync(existingTodayMd, "utf-8");
            const summaryText = extractDocumentExecutiveSummary(
              mdPreview,
              deliverableFiles,
              this.config.vaultRoot
            );
            return {
              replyText: `✅ 已按你之前的需求准备好中文新手学习指南，并生成了 ${deliverableFiles
                .map((f) => `\`${basename(f)}\``)
                .join("、")}，正在逐个推送到微信：\n\n${summaryText}`,
              mediaDeliveries: deliverableFiles.map((fPath) => ({
                mediaType: "file" as const,
                mediaPath: fPath,
              })),
              modelUsed: "vault_deliverable_compiler",
              depositedPath: deliverableFiles.join(", "),
            };
          }
        }
      }

      // Send immediate progress notice to WeChat and start periodic 25s heartbeat timer
      const fmtLabel =
        requestedFormats.length > 0
          ? `并生成【${requestedFormats.map((f) => f.toUpperCase()).join(" / ")}】文件`
          : "";
      await progress.start(
        "阶段 1/4：正在检索知识库上下文与外部资料",
        `⏳ 已收到复合任务：正在检索外部资料与你的知识库上下文${fmtLabel}，处理期间每 25 秒会自动回传一次进度（也可随时发「进度」查看状态）…`
      );

      const articleContext = targetArticle
        ? `\n【关联文章 #${targetArticle.id}】\n- 标题：${targetArticle.title}\n- 原文路径：${targetArticle.source_md_path}\n- 伴读笔记路径：${targetArticle.note_md_path}\n- 摘要：${targetArticle.short_summary || targetArticle.digest}\n`
        : "";

      const refBlock = ctx.unpacked.refContext?.quotedText
        ? `\n【用户引用的微信消息】\n${ctx.unpacked.refContext.quotedText}\n`
        : "";

      const historyBlock =
        ctx.recentTurns.length > 0
          ? `\n【最近多轮对话历史】\n` +
            ctx.recentTurns
              .map(
                (t, i) =>
                  `[${i + 1}] 用户: ${t.user_text}\n    助手: ${t.assistant_reply.slice(0, 260)}${
                    t.deposited_path ? `\n    已生成文件: ${t.deposited_path}` : ""
                  }`
              )
              .join("\n") +
            "\n"
          : "";

      const vaultCtx = gatherVaultContext(
        this.config.vaultRoot,
        effectiveRequirement,
        this.config.vaultLayout
      );
      const archCtx = gatherVaultArchitectureContext(
        this.config.vaultRoot,
        effectiveRequirement
      );

      // Step 1: If task requires external web search (e.g. "搜一下 Andrej Karpathy 的 LLM Wiki"),
      // perform fast grounded web search first so both CLI and Pro LLM have verified facts & links.
      let webSearchEvidence = "";
      if (needsWebSearch && this.config.llm.apiKey) {
        await progress.updateStage(
          "阶段 1/4：正在通过 Google Search 实时检索外部公开资料",
          { detail: `已匹配本地知识库 ${vaultCtx.matchedNotes.length} 篇相关节点` }
        );
        try {
          const webRes = await callAgentLlm({
            config: this.config,
            tier: "fast",
            enableWebSearch: true,
            timeoutMs: 30_000,
            temperature: 0.1,
            systemPrompt: `你是研究取证助手。请通过 Google Search 检索用户任务中提到的外部人物、项目、概念或原文链接，输出准确的事实要点与来源 URL。`,
            userPrompt: `请检索以下任务涉及的外部公开资料与核心事实：\n${effectiveRequirement}`,
          });
          const srcLinks =
            webRes.sources && webRes.sources.length > 0
              ? "\n参考来源链接：\n" +
                webRes.sources
                  .slice(0, 6)
                  .map((s) => `- [${s.title}](${s.uri})`)
                  .join("\n")
              : "";
          webSearchEvidence = `\n【实时联网检索外部事实证据 (${webRes.modelUsed})】\n${webRes.text}${srcLinks}\n`;
        } catch (webErr) {
          console.warn("[DelegateSubagent] Pre-search warning:", webErr);
        }
      }

      const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
      const rawSlug =
        ctx.decision.slots.documentSlug ||
        ctx.decision.slots.ideaSlug ||
        (effectiveRequirement.toLowerCase().includes("llm") &&
        effectiveRequirement.toLowerCase().includes("wiki")
          ? "llm_wiki_beginner_guide"
          : "knowledge_base_guide");
      const docSlug = sanitizeSlug(rawSlug) || "knowledge_base_guide";
      const outputDir = this.getOutputsDir();
      mkdirSync(outputDir, { recursive: true });
      const targetMdPath = join(outputDir, `${datePrefix}_${docSlug}.md`);

      // When the user requests multi-format document generation & file delivery on WeChat
      // without forcing a specific CLI, use our fast Pro synthesis + deterministic HTML/PDF compiler
      // so it completes in ~35s instead of timing out in 7m inside heavy CLI sub-loops.
      const useFastProDocPipeline =
        isDocGen && !explicitCli && Boolean(this.config.llm.apiKey);

      await progress.updateStage(
        useFastProDocPipeline
          ? `阶段 2/4：外部与知识库取证完成，正在调用深度模型 [${getProModel(this.config)}] 撰写完整文档`
          : `阶段 2/4：正在调用本地智能体 [${backend}] 深度处理任务`,
        {
          detail: webSearchEvidence
            ? "已完成联网事实核验与知识库架构注入"
            : `已加载 ${vaultCtx.matchedNotes.length} 篇知识库关联笔记`,
        }
      );

      const tieredRes = await executeTieredAgentTask({
        config: this.config,
        complexity: "deep",
        forceCliFirst: !useFastProDocPipeline,
        skipCliTier: useFastProDocPipeline,
        cliTimeoutMs: isDocGen ? 120_000 : 180_000,
        preferredBackend: backend,
        preferredAgyModel: selectAgyModel(effectiveRequirement, "deep"),
        workingDir: this.config.vaultRoot,
        enableWebSearch: needsWebSearch && !webSearchEvidence,
        onStageChange: (stage, opts) => progress.updateStage(stage, opts),
        onActivity: (detail) => progress.updateActivity(detail),
        cliPrompt: `你正在作为用户的后台子智能体（通过微信 ClawBot 远程唤起）在本地执行任务。
个人知识库根目录：${this.config.vaultRoot}
微信上下文项目目录：${this.config.projectRoot}
${articleContext}${refBlock}${historyBlock}${webSearchEvidence}
【用户核心任务指令】
${effectiveRequirement}

执行要求：
1. 若涉及个人知识库维护、深读加工或写指南/笔记，请遵循知识库根目录 AGENTS.md 的目录与 Frontmatter 规范；
2. ${
          isDocGen
            ? `请将撰写的完整中文 Markdown 正文直接保存至：${targetMdPath}（注意：无需耗时调用外部插件渲染 PDF/图片，宿主流水线会自动将你的 Markdown 编译为配套的 HTML 与 PDF 并推送到用户微信！）；`
            : "若创建或修改了文件，请在回复末尾列出完整绝对路径；"
        }
3. 最终输出的总结将直接发送到用户的手机微信，请保持结论清晰、条理分明（建议 200~500 字）。`,
        systemPrompt: isDocGen
          ? `你是用户的深度知识工程与技术写作专家（个人知识库根目录：${this.config.vaultRoot}）。
用户要求结合外部检索资料与他的个人知识库构建实践，撰写一份结构完整、适合目标读者（如新手）阅读的中文指南/报告，并导出为文件（${
              requestedFormats.length > 0
                ? requestedFormats.map((f) => f.toUpperCase()).join(" / ")
                : "MD"
            }）发送到微信。

请按以下两段式格式严格输出（使用 \`===DOCUMENT_MARKDOWN===\` 作为唯一分隔符）：
第一部分（分隔符之前）：发送给用户微信聊天窗口的精炼导读总结（200~400字，说明指南的核心结构、包含的模块与使用方式）；
\`===DOCUMENT_MARKDOWN===\`
第二部分（分隔符之后）：完整的、可直接发布分享的中文 Markdown 正文（包含 YAML frontmatter、清晰的一至三级标题、对比表格、最小可用目录结构示例、可复制的 AGENTS.md / 提示词模板、完整上手演练步骤以及跨任务 AI 共用上下文验证方法。分享版正文不要泄露本机私人绝对路径 \`/Users/...\`）。`
          : `你是用户的深度知识工程与研究智能体（个人知识库根目录：${this.config.vaultRoot}）。
请结合用户的当前关注主线（00_home/now.md）、最近多轮对话、外部检索证据与知识库笔记，深入完成用户的任务指令。`,
        userPrompt: `${articleContext}${refBlock}${historyBlock}${webSearchEvidence}
【00_home/now.md 当前关注】
${vaultCtx.nowSummary}

${archCtx ? `【个人知识库构建过程、组织架构与跨任务共享协议证据】\n${archCtx}\n` : ""}
【相关知识库节点检索结果】
${vaultCtx.matchedNotes.map((m) => `${m.wikiLink} (${m.relativePath}):\n${m.excerpt}`).join("\n\n") || "（无直接命中）"}

【用户核心任务指令】
${effectiveRequirement}`,
        temperature: 0.25,
      });

      let replySummaryText = tieredRes.text.trim();
      let generatedMarkdownContent = "";

      if (replySummaryText.includes("===DOCUMENT_MARKDOWN===")) {
        const parts = replySummaryText.split("===DOCUMENT_MARKDOWN===");
        replySummaryText = parts[0].trim();
        generatedMarkdownContent = parts.slice(1).join("\n").trim();
      } else if (
        isDocGen &&
        tieredRes.generatedFiles.length === 0 &&
        (replySummaryText.startsWith("---") ||
          replySummaryText.startsWith("# ") ||
          replySummaryText.length > 900)
      ) {
        generatedMarkdownContent = replySummaryText;
        replySummaryText = extractDocumentExecutiveSummary(
          generatedMarkdownContent,
          [],
          this.config.vaultRoot
        );
      }

      // Clean any surrounding ```markdown fences if model wrapped the document body
      if (generatedMarkdownContent) {
        generatedMarkdownContent = generatedMarkdownContent
          .replace(/^```(?:markdown|md)?\r?\n/i, "")
          .replace(/\r?\n```$/, "")
          .trim();
      }

      const mediaDeliveries: Array<{ mediaType: "file" | "image"; mediaPath: string }> = [];
      for (const imgPath of tieredRes.generatedImages) {
        mediaDeliveries.push({ mediaType: "image", mediaPath: imgPath });
      }

      let allDeliverableFiles = [...tieredRes.generatedFiles];

      if (isDocGen || requestedFormats.length > 0 || generatedMarkdownContent) {
        const formatsToBuild: DeliverableFormat[] =
          requestedFormats.length > 0 ? requestedFormats : ["md"];

        await progress.updateStage(
          `阶段 3/4：内容撰写完成，正在编译多格式文档 (${formatsToBuild
            .map((f) => f.toUpperCase())
            .join(" / ")})`,
          {
            detail: `正文约 ${generatedMarkdownContent.length || replySummaryText.length} 字`,
          }
        );

        // Choose unique file stem if targetMdPath already exists and wasn't created in this run
        let finalStem = `${datePrefix}_${docSlug}`;
        const existingPrimaryMd = allDeliverableFiles.find((f) =>
          f.toLowerCase().endsWith(".md")
        );
        if (
          !existingPrimaryMd &&
          existsSync(join(outputDir, `${finalStem}.md`)) &&
          generatedMarkdownContent
        ) {
          finalStem = `${datePrefix}_${docSlug}_${createHash("sha256")
            .update(ctx.messageKey)
            .digest("hex")
            .slice(0, 6)}`;
        }

        allDeliverableFiles = await ensureMultiFormatDeliverables({
          markdownPath: existingPrimaryMd,
          markdownContent: generatedMarkdownContent || undefined,
          outputDir,
          baseFileStem: finalStem,
          title: ctx.decision.slots.documentTitle || "知识库构建与跨任务共用上下文学习指南",
          existingFiles: allDeliverableFiles,
          requestedFormats: formatsToBuild,
        });
      }

      if (wantsFileDelivery || isDocGen) {
        for (const fPath of allDeliverableFiles) {
          if (existsSync(fPath)) {
            mediaDeliveries.push({ mediaType: "file", mediaPath: fPath });
          }
        }
      }

      const fileListBanner =
        allDeliverableFiles.length > 0
          ? `\n\n📎 已生成并为你推送文件（共 ${allDeliverableFiles.length} 个）：\n` +
            allDeliverableFiles.map((f) => `- \`${basename(f)}\``).join("\n")
          : "";

      void notifyExternalWebhookIfConfigured(
        this.config,
        "plan",
        ctx.decision.slots.documentTitle || "研究报告 / 复杂任务已完成",
        `${replySummaryText.slice(0, 300)}${fileListBanner}`
      ).catch(() => {});

      return {
        replyText: `🤖 任务执行完成 [${tieredRes.modelUsed}]：\n\n${replySummaryText}${fileListBanner}`,
        mediaDeliveries: mediaDeliveries.length > 0 ? mediaDeliveries : undefined,
        modelUsed: tieredRes.modelUsed,
        relatedArticleId: targetArticle?.id ?? null,
        depositedPath:
          allDeliverableFiles.length > 0
            ? allDeliverableFiles.join(", ")
            : tieredRes.generatedImages[0] || undefined,
      };
    } catch (err: any) {
      return {
        replyText: `⚠️ 任务执行出错 [${backend}]：${err?.message || err}`,
        modelUsed: `${backend}_error`,
      };
    } finally {
      progress.stop("阶段 4/4：任务执行完毕，已入队推送微信");
    }
  }

  private findTodayMatchingOutputMd(requirementText: string): string | null {
    const notesDir = this.getOutputsDir();
    if (!existsSync(notesDir)) return null;
    const todayPrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
    const lowerReq = requirementText.toLowerCase();
    const wantsKarpathyOrWiki =
      lowerReq.includes("karpathy") || lowerReq.includes("wiki");

    try {
      const entries = readdirSync(notesDir)
        .filter(
          (e) =>
            e.endsWith(".md") &&
            !e.endsWith("_sources.md") &&
            !e.endsWith("_v2.md") &&
            e.startsWith(todayPrefix)
        )
        .map((e) => join(notesDir, e));

      for (const fullPath of entries) {
        const nameLower = basename(fullPath).toLowerCase();
        if (wantsKarpathyOrWiki && nameLower.includes("llm_wiki")) {
          return fullPath;
        }
      }
      return entries[0] || null;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // 7. Intent: send_file (C2C AES-128-ECB Upload & Multi-Format File Delivery)
  // ============================================================================
  private async handleSendFile(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const targetArticle =
      (ctx.decision.targetArticleId
        ? this.db.getArticleById(ctx.decision.targetArticleId)
        : null) ??
      ctx.referencedArticle ??
      ctx.recentArticle;

    const fileTarget = ctx.decision.slots.fileTarget || "latest_note";
    const fileQuery = ctx.decision.slots.fileQuery || ctx.unpacked.userText;
    const requestedFormats = detectRequestedFormats(
      ctx.unpacked.userText,
      ctx.decision.slots.requestedFormats
    );

    // 1. Check if user is asking for recently generated files from a prior turn
    if (
      fileTarget === "recent_generated" ||
      /(?:文件呢|刚生成|刚才生成|学习指南|新手指南)/i.test(ctx.unpacked.userText)
    ) {
      const priorTurnWithFiles = [...ctx.recentTurns]
        .reverse()
        .find((t) => Boolean(t.deposited_path));

      if (priorTurnWithFiles?.deposited_path) {
        const paths = priorTurnWithFiles.deposited_path
          .split(/\s*,\s*/)
          .map((s) => s.trim())
          .filter((p) => p && existsSync(p));
        if (paths.length > 0) {
          const targetExts =
            requestedFormats.length > 0
              ? requestedFormats
              : (["md", "html", "pdf"] as Array<"md" | "html" | "pdf">);
          const primaryMd = paths.find((p) => p.toLowerCase().endsWith(".md"));
          let allSiblings =
            paths.length === 1
              ? findSiblingMultiFormatFiles(paths[0], targetExts)
              : requestedFormats.length > 0
              ? findSiblingMultiFormatFiles(
                  primaryMd || paths[0],
                  requestedFormats
                )
              : paths;
          const hasAnyRequested =
            requestedFormats.length > 0 &&
            requestedFormats.some((fmt) =>
              allSiblings.some((p) => p.toLowerCase().endsWith(`.${fmt}`))
            );
          if (primaryMd && requestedFormats.length > 0 && !hasAnyRequested) {
            const compiled = await ensureMultiFormatDeliverables({
              markdownPath: primaryMd,
              outputDir: resolve(primaryMd, ".."),
              baseFileStem: basename(primaryMd, ".md"),
              existingFiles: allSiblings,
              requestedFormats,
            });
            if (compiled.length > 0) {
              allSiblings = compiled;
            }
          }
          return {
            replyText: `📎 正在为你推送刚生成的文件（共 ${allSiblings.length} 个）：\n${allSiblings
              .map((p) => `- \`${basename(p)}\``)
              .join("\n")}`,
            mediaDeliveries: allSiblings.map((p) => ({
              mediaType: "file" as const,
              mediaPath: p,
            })),
            modelUsed: getFastModel(this.config),
            depositedPath: allSiblings.join(", "),
          };
        }
      }

      // Check today's generated guide in 05_outputs/research_notes/
      const todayMd = this.findTodayMatchingOutputMd(
        [
          ctx.unpacked.userText,
          ...ctx.recentTurns.map((t) => t.user_text),
        ].join("\n")
      );
      if (todayMd && existsSync(todayMd)) {
        const siblings = await ensureMultiFormatDeliverables({
          markdownPath: todayMd,
          outputDir: this.getOutputsDir(),
          baseFileStem: basename(todayMd, ".md"),
          requestedFormats:
            requestedFormats.length > 0 ? requestedFormats : ["md", "html", "pdf"],
        });
        if (siblings.length > 0) {
          return {
            replyText: `📎 正在为你推送生成的指南文件（共 ${siblings.length} 个）：\n${siblings
              .map((p) => `- \`${basename(p)}\``)
              .join("\n")}`,
            mediaDeliveries: siblings.map((p) => ({
              mediaType: "file" as const,
              mediaPath: p,
            })),
            modelUsed: getFastModel(this.config),
            depositedPath: siblings.join(", "),
          };
        }
      }
    }

    let filePathToSend = "";
    let fileDescription = "";

    if (
      fileTarget === "latest_source" &&
      targetArticle?.source_md_path &&
      existsSync(targetArticle.source_md_path)
    ) {
      filePathToSend = targetArticle.source_md_path;
      fileDescription = `文章 #${targetArticle.id}《${targetArticle.title}》原文 Markdown`;
    } else if (
      fileTarget === "latest_note" &&
      targetArticle?.note_md_path &&
      existsSync(targetArticle.note_md_path)
    ) {
      filePathToSend = targetArticle.note_md_path;
      fileDescription = `文章 #${targetArticle.id}《${targetArticle.title}》伴读笔记`;
    } else if (fileQuery) {
      const vaultMatches = findVaultFilesByQuery(this.config.vaultRoot, fileQuery, 1);
      if (vaultMatches.length > 0 && existsSync(vaultMatches[0].absolutePath)) {
        filePathToSend = vaultMatches[0].absolutePath;
        fileDescription = `知识库笔记 ${vaultMatches[0].wikiLink} (${vaultMatches[0].relativePath})`;
      } else if (targetArticle?.note_md_path && existsSync(targetArticle.note_md_path)) {
        filePathToSend = targetArticle.note_md_path;
        fileDescription = `文章 #${targetArticle.id}《${targetArticle.title}》伴读笔记`;
      }
    }

    if (!filePathToSend || !existsSync(filePathToSend)) {
      return {
        replyText: `⚠️ 未找到要发送的本地笔记文件（请确认文章已完成抓取，或提供准确的知识库笔记名称）。`,
        modelUsed: getFastModel(this.config),
      };
    }

    // Check if sibling formats (.md, .html, .pdf) exist for this note when it's in 05_outputs/ or outputs/
    let filesToSend =
      filePathToSend.includes("05_outputs") ||
      filePathToSend.includes("/outputs/") ||
      requestedFormats.length > 0
        ? findSiblingMultiFormatFiles(
            filePathToSend,
            requestedFormats.length > 0 ? requestedFormats : ["md", "html", "pdf"]
          )
        : [filePathToSend];

    const hasAnyRequestedFormat =
      requestedFormats.length > 0 &&
      requestedFormats.some((fmt) =>
        filesToSend.some((p) => p.toLowerCase().endsWith(`.${fmt}`))
      );
    if (
      filePathToSend.toLowerCase().endsWith(".md") &&
      requestedFormats.length > 0 &&
      !hasAnyRequestedFormat
    ) {
      const compiled = await ensureMultiFormatDeliverables({
        markdownPath: filePathToSend,
        outputDir: resolve(filePathToSend, ".."),
        baseFileStem: basename(filePathToSend, ".md"),
        existingFiles: filesToSend,
        requestedFormats,
      });
      if (compiled.length > 0) {
        filesToSend = compiled;
      }
    }

    return {
      replyText: `📎 正在为你推送文件：${fileDescription}\n文件列表：${filesToSend
        .map((f) => `\`${basename(f)}\``)
        .join("、")}`,
      mediaDeliveries: filesToSend.map((f) => ({
        mediaType: "file" as const,
        mediaPath: f,
      })),
      modelUsed: getFastModel(this.config),
      relatedArticleId: targetArticle?.id ?? null,
      depositedPath: filesToSend.join(", "),
    };
  }

  // ============================================================================
  // 8. Intent: general_assistant (Conversational Personal Assistant)
  // ============================================================================
  private async handleGeneralAssistant(
    ctx: IntentExecutionContext
  ): Promise<IntentExecutionResult> {
    const text = ctx.unpacked.userText.trim();

    if (/^(?:\/help|help|帮助|功能|菜单)$/i.test(text)) {
      const cliChainLabel = (this.config.llm.cliRoutingChain ?? ["agy", "codex"]).join(" -> ") || "agy -> codex";
      return {
        replyText: [
          `🤖 你的随身个人助理 & 第二大脑（分层高可用路由架构）已就绪：`,
          `0️⃣ 意图识别层：${getFastModel(this.config)}（降级 -> 本地确定性规则路由）`,
          `1️⃣ 重度/视觉首选层：本地 CLI 子智能体路由链（${cliChainLabel}）`,
          `2️⃣ 一级云端降级层：Pro 模型（${getProModel(this.config)}）`,
          `3️⃣ 终极云端兜底层：Fast 模型（${getFastModel(this.config)}）`,
          ``,
          `支持自然语言直接交互（无需固定前缀，支持文字、语音、图片、文件、引用追问）：`,
          `1️⃣ 发链接：公众号或任意外部网页 -> 自动抓取、防盗链存图、生成伴读卡`,
          `2️⃣ 聊想法：直接说出你的思考/灵感 -> 自动沉淀至 03_ideas/seeds/`,
          `3️⃣ 记备忘：随手记待办或摘抄 -> 自动存入 01_inputs/inbox/`,
          `4️⃣ 查知识库 / 联网搜：检索本地笔记，或通过 Google Search 实时检索公开信息`,
          `5️⃣ 发图片/PDF：本地 AES 解密归档 + 转交本地 CLI 视觉理解提炼`,
          `6️⃣ 画图生成：说“画一张...架构图发给我” -> AGY 生成图片并加密直发微信`,
          `7️⃣ 唤起子智能体：说“让 codex / agy / opencode / claude 帮我...”`,
          `8️⃣ 要文件：说“把刚才那篇伴读笔记发文件给我” -> 原生文件直达微信`,
        ].join("\n"),
        modelUsed: "system_help",
      };
    }

    if (!this.config.llm.apiKey && !this.config.llm.allowCodexFallback) {
      // Preserve legacy fallback message when LLM API key is empty
      const attached = this.db.attachUserNoteToRecentArticle(ctx.senderId, text, 15);
      return {
        replyText: attached
          ? `已保存文章 #${attached.id} 的批注；已有笔记不会自动重写，请在电脑端结合批注继续深读。`
          : "请发送公众号链接，或使用「想法：...」保存个人想法。",
        modelUsed: "local_fallback",
        relatedArticleId: attached?.id ?? null,
      };
    }

    const recentTurns = this.db.getRecentConversationTurns(ctx.senderId, 6);
    const historyBlock =
      recentTurns.length > 0
        ? recentTurns
            .map((t) => `用户: ${t.user_text}\n助手: ${t.assistant_reply}`)
            .join("\n\n")
        : "（新对话）";

    const vaultCtx = gatherVaultContext(
      this.config.vaultRoot,
      text,
      this.config.vaultLayout
    );
    const llmRes = await executeTieredAgentTask({
      config: this.config,
      complexity: ctx.decision.complexity,
      preferredBackend: ctx.decision.slots.subagentTarget || "agy",
      systemPrompt: `你是用户的随身个人助理兼知识工程搭档（连接着用户的个人知识库 ${this.config.vaultRoot}）。
用户在手机微信上与你对话。
请结合用户的当前关注主线（00_home/now.md）、最近对话记忆以及检索到的相关知识库笔记，提供高质量、有洞察力、条理清晰的回答。
- 手机微信阅读友好，控制在 150~450 字以内（除非用户明确要求长文）；
- 若探讨出了值得沉淀的原创观点，可在结尾提醒用户说“把刚才聊的存成想法”即可一键归档到 03_ideas/seeds/。`,
      userPrompt: `【最近对话历史】
${historyBlock}

${
  ctx.unpacked.refContext?.quotedText
    ? `【用户引用的消息】\n${ctx.unpacked.refContext.quotedText}\n\n`
    : ""
}【用户当前研究主线 (00_home/now.md)】
${vaultCtx.nowSummary}

【相关知识库笔记参考】
${vaultCtx.matchedNotes.map((m) => `${m.wikiLink}: ${m.excerpt}`).join("\n\n") || "（无特定命中）"}

【用户最新消息】
${text}`,
      temperature: 0.35,
    });

    return {
      replyText: llmRes.text,
      modelUsed: llmRes.modelUsed,
    };
  }
}

function safeParseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function extractDocumentExecutiveSummary(
  markdown: string,
  deliverableFiles: string[],
  vaultRoot: string
): string {
  const stripped = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "").trim();
  const lines = stripped.split(/\r?\n/);
  let title = "";
  const headings: string[] = [];
  const introParagraphs: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }
    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      headings.push(h2[1].trim());
      continue;
    }
    if (
      headings.length === 0 &&
      introParagraphs.length < 2 &&
      !trimmed.startsWith("#") &&
      !trimmed.startsWith("|") &&
      !trimmed.startsWith("```") &&
      trimmed.length > 20
    ) {
      introParagraphs.push(trimmed);
    }
  }

  const parts: string[] = [];
  if (title) {
    parts.push(`📘 **《${title}》**`);
  }
  if (introParagraphs.length > 0) {
    parts.push(introParagraphs.join("\n\n").slice(0, 260));
  }
  if (headings.length > 0) {
    parts.push(
      `**核心章节目录**：\n` +
        headings
          .slice(0, 9)
          .map((h) => `• ${h}`)
          .join("\n")
    );
  }
  if (deliverableFiles.length > 0) {
    parts.push(
      `**知识库归档路径**：\n` +
        deliverableFiles
          .map((f) => `- \`${relative(vaultRoot, f)}\``)
          .join("\n")
    );
  }
  return parts.join("\n\n") || stripped.slice(0, 400);
}
