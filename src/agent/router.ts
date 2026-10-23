import { decodeArtifactPaths } from "../storage.ts";
import { AppConfig } from "../config.ts";
import { ArticleRecord, ConversationTurnRecord, TriageLevel } from "../db.ts";
import { UnpackedClawBotMessage } from "../clawbot/client.ts";
import { callAgentLlm, ModelTier, parseJsonSafe } from "./llm.ts";
import { getPreferredCliBackend, SubagentBackend } from "./subagent_cli.ts";
import {
  DeliverableFormat,
  detectRequestedFormats,
  detectWantsFileDelivery,
  isDocumentGenerationTask,
} from "./doc_exporter.ts";

export type AgentIntentKind =
  | "capture_idea"
  | "capture_inbox"
  | "ingest_link"
  | "article_followup"
  | "vault_query"
  | "web_search"
  | "multimodal_ingest"
  | "generate_image"
  | "delegate_subagent"
  | "send_file"
  | "general_assistant";

export interface IntentDecision {
  intent: AgentIntentKind;
  complexity: ModelTier; // "fast" -> fast model builtin, "deep" -> delegated to local CLI routing chain
  subagentTarget?: SubagentBackend;
  reason: string;
  targetArticleId?: number | null;
  slots: {
    url?: string;
    userNotes?: string;
    triageHint?: TriageLevel;
    articleSubAction?: "annotate" | "triage" | "qa" | "deepen";
    searchQuery?: string;
    ideaTitle?: string;
    ideaSlug?: string;
    coreContent?: string;
    fileTarget?: "latest_note" | "latest_source" | "vault_file" | "recent_generated";
    fileQuery?: string;
    multimodalTarget?: "inbox" | "idea" | "qa_only";
    imagePrompt?: string;
    subagentTarget?: SubagentBackend;
    requestedFormats?: DeliverableFormat[];
    wantsFileDelivery?: boolean;
    needsWebSearch?: boolean;
    isTaskRetryOrCorrection?: boolean;
    documentTitle?: string;
    documentSlug?: string;
  };
}

export function findPriorComplexTaskTurn(
  recentTurns: ConversationTurnRecord[]
): ConversationTurnRecord | null {
  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const t = recentTurns[i];
    if (
      t.intent === "delegate_subagent" ||
      t.intent === "generate_image" ||
      isDocumentGenerationTask(t.user_text) ||
      detectRequestedFormats(t.user_text).length > 0
    ) {
      return t;
    }
  }
  return null;
}

export function detectExplicitCliBackend(text: string): SubagentBackend | undefined {
  const m =
    text.match(/(?:让|用|试用|使用|调用|交给|通过|走|转交|请)\s*(workbuddy|codebuddy|cbc|opencode|open-code|claude|gemini|aider|codex|agy|antigravity)\b/i) ||
    text.match(/^(workbuddy|codebuddy|cbc|opencode|open-code|claude|gemini|aider|codex|agy|antigravity)\s*(?:[:：]|帮我|来|去|执行|生成|画|整理|分析|看看)/i);
  if (!m) return undefined;
  const raw = m[1].toLowerCase();
  if (raw === "antigravity") return "agy";
  if (raw === "open-code") return "opencode";
  if (raw === "codebuddy" || raw === "cbc") return "workbuddy";
  return raw as SubagentBackend;
}

/**
 * Route an unpacked WeChat message to the appropriate Intent and Model Tier.
 * Uses fast model for semantic classification when configured, with deterministic fast-paths and offline heuristics.
 */
export async function classifyMessageIntent(params: {
  config: AppConfig;
  unpacked: UnpackedClawBotMessage;
  recentTurns: ConversationTurnRecord[];
  recentArticle: ArticleRecord | null;
  referencedArticle: ArticleRecord | null;
}): Promise<IntentDecision> {
  const { config, unpacked, recentTurns, recentArticle, referencedArticle } = params;
  const text = unpacked.userText.trim();

  // 1. If message has media items (image / file), route to multimodal_ingest (delegated to CLI routing chain)
  if (
    unpacked.mediaItems.some((m) => m.kind === "image" || m.kind === "file")
  ) {
    const wantsIdea = /(?:想法|灵感|观点|seed|03_ideas)/i.test(text);
    const wantsDeep = /(?:深度|详细拆解|架构分析|推导|批判|对比)/i.test(text);
    const explicitCli = detectExplicitCliBackend(text);
    const useCodex = /(?:codex|改代码|修复|更新.*topic|主题页)/i.test(text);
    const targetSubagent: SubagentBackend =
      explicitCli || (useCodex ? "codex" : getPreferredCliBackend(config, "agy"));
    return {
      intent: "multimodal_ingest",
      complexity: wantsDeep ? "deep" : "fast",
      subagentTarget: targetSubagent,
      reason: "Message contains image or file attachment from WeChat (delegated to CLI subagent)",
      targetArticleId: referencedArticle?.id ?? recentArticle?.id ?? null,
      slots: {
        coreContent: text,
        multimodalTarget: wantsIdea ? "idea" : "inbox",
        subagentTarget: targetSubagent,
      },
    };
  }

  // 2. If message contains an HTTP(S) URL (WeChat MP or external web article)
  if (unpacked.urls.length > 0) {
    const targetUrl = unpacked.urls[0];
    const inlineNote = text
      .replace(targetUrl, "")
      .replace(/https?:\/\/[^\s"'<>\\]+/gi, "")
      .trim();
    const triageHint = detectTriageHint(inlineNote);
    return {
      intent: "ingest_link",
      complexity: "fast",
      reason: "Message contains an article or web URL",
      slots: {
        url: targetUrl,
        userNotes: inlineNote,
        triageHint,
      },
    };
  }

  // 3. Explicit deterministic prefixes (zero latency)
  const explicitIdea = text.match(/^(?:想法|灵感|观点|我有一个想法|idea)\s*[:：]\s*([\s\S]+)$/i);
  if (explicitIdea) {
    const body = explicitIdea[1].trim();
    const isComplex = body.length > 260 || /(?:帮我推演|展开分析|深度思考|结合知识库)/i.test(body);
    return {
      intent: "capture_idea",
      complexity: isComplex ? "deep" : "fast",
      reason: "Explicit idea capture prefix",
      targetArticleId: referencedArticle?.id ?? recentArticle?.id ?? null,
      slots: {
        coreContent: body,
      },
    };
  }

  if (/^(?:深读|精读|优先|process_now)$/i.test(text)) {
    return {
      intent: "article_followup",
      complexity: "fast",
      reason: "Explicit triage priority command",
      targetArticleId: referencedArticle?.id ?? recentArticle?.id ?? null,
      slots: {
        articleSubAction: "triage",
        triageHint: "process_now",
      },
    };
  }

  // 3.5 Deterministic fast-path for task correction / retry ("不是这个，是你帮我生成...你看看我之前的需求")
  const priorTask = findPriorComplexTaskTurn(recentTurns);
  const isCorrectionOrRetry =
    /(?:不是这个.*(?:帮我生成|指南|需求)|你看看我之前的需求|按我之前的需求|刚才没生成|重新帮我生成|重新生成|没收到.*生成的文件)/i.test(
      text
    );
  if (isCorrectionOrRetry && priorTask) {
    const combinedPrompt = `${priorTask.user_text}\n\n【用户补充纠偏说明】：${text}`;
    const explicitCli =
      detectExplicitCliBackend(text) ||
      detectExplicitCliBackend(priorTask.user_text);
    if (priorTask.intent === "generate_image") {
      const preferred = explicitCli || getPreferredCliBackend(config, "agy");
      return {
        intent: "generate_image",
        complexity: "deep",
        subagentTarget: preferred,
        reason: "User is correcting/retrying a prior image generation task",
        targetArticleId: referencedArticle?.id ?? null,
        slots: {
          coreContent: combinedPrompt,
          imagePrompt: combinedPrompt,
          subagentTarget: preferred,
          isTaskRetryOrCorrection: true,
        },
      };
    }
    const formats = detectRequestedFormats(combinedPrompt);
    const preferred = explicitCli || getPreferredCliBackend(config, "agy");
    return {
      intent: "delegate_subagent",
      complexity: "deep",
      subagentTarget: preferred,
      reason: "User is correcting/retrying a prior complex document generation task",
      targetArticleId: referencedArticle?.id ?? null,
      slots: {
        coreContent: combinedPrompt,
        subagentTarget: preferred,
        requestedFormats: formats.length > 0 ? formats : ["md", "html", "pdf"],
        wantsFileDelivery: true,
        needsWebSearch: /(?:搜一下|搜索|查一下|检索|网上|karpathy|arxiv)/i.test(combinedPrompt),
        isTaskRetryOrCorrection: true,
      },
    };
  }

  // 3.6 Deterministic check for "文件呢 我没看到" right after a complex task
  if (
    /^(?:文件呢|文件怎么没发|怎么没有文件|文件没看到|没看到文件|把刚才生成的文件发我)/i.test(
      text
    ) &&
    priorTask &&
    priorTask.intent !== "generate_image"
  ) {
    const formats = detectRequestedFormats(priorTask.user_text);
    // If the prior complex task did NOT deposit any file or failed with fake placeholder, re-run/complete it!
    if (
      decodeArtifactPaths(priorTask.deposited_path).length === 0 ||
      priorTask.assistant_reply.includes("已完成任务）") ||
      priorTask.assistant_reply.includes("已完成执行）")
    ) {
      const preferred = getPreferredCliBackend(config, "agy");
      return {
        intent: "delegate_subagent",
        complexity: "deep",
        subagentTarget: preferred,
        reason: "User asked for missing files from prior complex task that did not finish delivering",
        targetArticleId: referencedArticle?.id ?? null,
        slots: {
          coreContent: priorTask.user_text,
          subagentTarget: preferred,
          requestedFormats: formats.length > 0 ? formats : ["md"],
          wantsFileDelivery: true,
          needsWebSearch: /(?:搜一下|搜索|查一下|检索|网上|karpathy|arxiv)/i.test(
            priorTask.user_text
          ),
          isTaskRetryOrCorrection: true,
        },
      };
    }
    return {
      intent: "send_file",
      complexity: "fast",
      reason: "User asked for files produced in the previous turn",
      targetArticleId: referencedArticle?.id ?? null,
      slots: {
        fileTarget: "recent_generated",
        fileQuery: priorTask.deposited_path || priorTask.user_text,
        requestedFormats: formats.length > 0 ? formats : ["md", "html", "pdf"],
        wantsFileDelivery: true,
      },
    };
  }

  // 4. Primary Intent Router: fast model semantic classification
  if (config.llm.apiKey && text.length > 0) {
    try {
      return await callLlmIntentRouter({
        config,
        unpacked,
        recentTurns,
        recentArticle,
        referencedArticle,
      });
    } catch (err) {
      console.warn("[Router] LLM intent router warning, falling back to heuristic router:", err);
    }
  }

  // 5. Heuristic Fallback Router (when offline or no API key)
  return buildHeuristicIntentDecision({
    unpacked,
    recentTurns,
    recentArticle,
    referencedArticle,
    config,
  });
}

async function callLlmIntentRouter(params: {
  config: AppConfig;
  unpacked: UnpackedClawBotMessage;
  recentTurns: ConversationTurnRecord[];
  recentArticle: ArticleRecord | null;
  referencedArticle: ArticleRecord | null;
}): Promise<IntentDecision> {
  const { config, unpacked, recentTurns, recentArticle, referencedArticle } = params;

  const recentTurnsSummary =
    recentTurns.length > 0
      ? recentTurns
          .map(
            (t, idx) =>
              `[${idx + 1}] 用户(${t.intent}/${t.complexity}): ${t.user_text.slice(0, 450)}\n    助手(${t.model_used}): ${t.assistant_reply.slice(0, 220)}\n    已生成/沉淀文件: ${t.deposited_path || "无（未生成文件）"}`
          )
          .join("\n")
      : "（无最近对话）";

  const recentArticleInfo = recentArticle
    ? `ID=#${recentArticle.id}, 标题=《${recentArticle.title || recentArticle.url}》, 创建时间=${recentArticle.created_at}, 状态=${recentArticle.status}/${recentArticle.triage}`
    : "（无）";

  const refArticleInfo = referencedArticle
    ? `ID=#${referencedArticle.id}, 标题=《${referencedArticle.title || referencedArticle.url}》`
    : "（未命中特定文章）";

  const refRawInfo = unpacked.refContext
    ? `引用标题: ${unpacked.refContext.title || "无"}\n引用正文: ${(unpacked.refContext.quotedText || "").slice(0, 300)}\n局部划词(partial_text): ${unpacked.refContext.partialText || "无"}`
    : "（用户未引用历史消息）";

  const cliChain = config.llm.cliRoutingChain ?? ["agy", "codex"];
  const systemPrompt = `你是用户的随身个人助理兼第二大脑（Personal Knowledge Base: ${config.vaultRoot}）的「意图识别与模型复杂度调度器」。
用户在手机微信上向你发送了一条消息（可能是打字、语音转文字或长按引用追问）。请精准判断用户的真实意图（intent）、任务复杂度（complexity）以及结构化交付槽位（slots）。

### 可选意图 (intent) 枚举与定义：
1. "capture_idea"：用户表达了自己的**原创思考、个人判断、假说、灵感、洞见**（即使没有写“想法：”前缀，只要是用户有价值的个人观点/洞察，或者说“把刚才我们聊的这点存成想法”），应归入个人想法种子库 \`03_ideas/seeds/\`。
2. "capture_inbox"：用户想随手记录一条**日常备忘、待办事项（Todo）、日程提醒、临时摘抄或未分类碎片**（例如“记一下明天下午开会”、“存一下这个备忘”），归入 \`01_inputs/inbox/\`。
3. "article_followup"：用户正在针对**被引用的文章**或**刚刚发送的公众号/网页文章**进行互动。细分子动作 \`articleSubAction\`：
   - "annotate"：对文章补充一句简短评价或关注点批注；
   - "triage"：调整文章分诊状态（如“这篇只留作参考”->reference，“加入优先精读”->process_now，“只存原文”->keep_raw）；
   - "qa"：针对那篇文章的具体内容提问、追问细节；
   - "deepen"：要求现在对那篇文章进行深度阅读拆解、批判性分析或升级伴读笔记。
4. "vault_query"：用户正在**单纯查询、检索或提问他的个人知识库/历史收藏文章**（不需要生成新文档文件导出，只要求在微信里回答，例如“我之前关于本体论的大纲写到哪了？”、“查一下我知识库里关于上下文工程的观点”）。
5. "web_search"：用户希望**单纯联网检索外部公开信息并在微信里回答**（不要求结合知识库撰写长篇指南或导出多格式文件，例如“帮我上网搜一下最近 Anthropic 发布了什么”、“查一下最新的 Bun 版本特性”）。
6. "generate_image"：用户要求**画图、生成概念插图、生成文章配图或视觉海报**（将转交本机 AGY 或 Codex CLI 调用内置生图工具生成图片并发回微信）。
7. "delegate_subagent"：需要执行**复合深度研究、撰写学习指南/报告/长文并导出文件（如 md/html/pdf）、或多文件知识库深度治理**。包括但不限于：
   - **复合检索+综合写作+多格式文件生成交付**：例如“帮我搜一下 Andrej Karpathy 的 LLM Wiki，结合我的知识库构建过程整理一份新手学习指南，生成 markdown/html/pdf 格式发给我”；
   - **对前序复杂任务的纠偏或重做要求**：例如用户说“不是这个，是你帮我生成中文版适合新手的指南啊，你看看我之前的需求”；
   - **知识库治理与研发任务**：把文章升级为第二阶段 deep 并更新主题页、同步读书笔记、巡检整理 inbox、深入调研 arXiv 论文、或修改本地项目代码。
8. "send_file"：用户要求把**知识库里已有的某篇笔记、伴读卡或刚刚已生成好的文件**发送到微信上（例如“把伴读笔记发文件给我”、“把原文发我看看”、“把 now.md 发给我”）。
   - ⚠️ 注意：如果用户要求**新生成/整理**一份指南或报告并发给他（如“整理一个指南，生成 md/html/pdf 发给我”），或者指出刚才发错了文件、要求按之前需求**生成**新指南（“不是这个，是你帮我生成中文版指南”），必须归类为 \`"delegate_subagent"\` 而不是 \`"send_file"\`！
9. "general_assistant"：日常自由对话、技术方案探讨、头脑风暴、问题解答、翻译润色、或查看助手帮助说明。

### 复杂度 (complexity) 与结构化槽位 (slots) 评估准则：
- "fast"：简单想法记录、备忘速记、文章批注/分诊修改、直接发送已有文件、简单事实查找、快速联网信息检索、日常轻量问答。
- "deep"：
  1. 跨多篇知识库笔记的深度综合对比、理论体系推演、研究进度与规划建议；
  2. 复合型任务（外部检索 + 结合个人知识库 + 撰写指南/报告 + 生成多格式文件如 md/html/pdf 并推送微信）；
  3. 针对文章的深度追问、逻辑漏洞批判、或要求深度拆解（articleSubAction="deepen"）；
  4. 生图（generate_image）或多文件知识库治理/写代码（delegate_subagent）。
- \`targetArticleId\` 规则：**只有当用户的消息确实是在讨论「最近入库文章」或「引用文章」时才填数字 ID；如果用户开启了一个全新的话题或任务（与上一篇公众号文章无关），必须填 \`null\`！**

请严格输出合法的 JSON 对象（不要包含 Markdown 代码块包裹之外的多余文字）：
{
  "intent": "capture_idea | capture_inbox | article_followup | vault_query | web_search | generate_image | delegate_subagent | send_file | general_assistant",
  "complexity": "fast | deep",
  "subagentTarget": "agy | codex | opencode | claude | gemini | aider（当 complexity=deep 或 intent 为 generate_image / delegate_subagent 时填写）",
  "reason": "简短说明意图与复杂度判断依据",
  "targetArticleId": 数字ID或null,
  "slots": {
    "articleSubAction": "annotate | triage | qa | deepen（仅 article_followup 时填写）",
    "triageHint": "keep_raw | reference | process_later | process_now（可选）",
    "searchQuery": "用于检索知识库或外部网页的核心关键词（空格分隔）",
    "ideaTitle": "若为 capture_idea 或 capture_inbox，提炼一个简明标题",
    "ideaSlug": "3到5个英文单词小写下划线短名，如 llm_wiki_beginner_guide",
    "coreContent": "整理后的用户核心任务指令（若是纠偏/继续前序任务，请合并前序对话中的完整原始需求！）",
    "fileTarget": "latest_note | latest_source | vault_file | recent_generated（仅 send_file 时填写）",
    "fileQuery": "当 fileTarget=vault_file 时填写目标文件名或关键词",
    "requestedFormats": ["md", "html", "pdf"],
    "wantsFileDelivery": true或false,
    "needsWebSearch": true或false,
    "isTaskRetryOrCorrection": true或false,
    "documentTitle": "若用户要求撰写指南/报告/文档，提炼中文文档标题",
    "documentSlug": "若用户要求撰写指南/报告/文档，提炼英文小写下划线文件名如 llm_wiki_beginner_guide"
  }
}`;

  const userPrompt = `【用户最新发送的消息】
${unpacked.userText}

【微信引用消息上下文 (ref_msg)】
${refRawInfo}
引用匹配到的文章记录：${refArticleInfo}

【用户最近一篇入库文章】
${recentArticleInfo}

【最近对话历史】
${recentTurnsSummary}`;

  const res = await callAgentLlm({
    config,
    tier: "fast",
    systemPrompt,
    userPrompt,
    jsonMode: true,
    temperature: 0.1,
    timeoutMs: 25_000,
  });

  const parsed = parseJsonSafe<Partial<IntentDecision>>(res.text);
  const validIntents: AgentIntentKind[] = [
    "capture_idea",
    "capture_inbox",
    "ingest_link",
    "article_followup",
    "vault_query",
    "web_search",
    "multimodal_ingest",
    "generate_image",
    "delegate_subagent",
    "send_file",
    "general_assistant",
  ];
  const intent: AgentIntentKind = validIntents.includes(parsed.intent as AgentIntentKind)
    ? (parsed.intent as AgentIntentKind)
    : "general_assistant";
  const complexity: ModelTier =
    parsed.complexity === "deep" || intent === "delegate_subagent" || intent === "generate_image"
      ? "deep"
      : "fast";
  const explicitCli = detectExplicitCliBackend(unpacked.userText);
  const resolvedSubagent =
    explicitCli ||
    parsed.slots?.subagentTarget ||
    (typeof parsed.subagentTarget === "string" && parsed.subagentTarget.trim()
      ? (parsed.subagentTarget.trim() as SubagentBackend)
      : undefined);
  const subagentTarget: SubagentBackend | undefined =
    resolvedSubagent
      ? resolvedSubagent
      : complexity === "deep"
        ? intent === "delegate_subagent"
          ? getPreferredCliBackend(config, "codex")
          : getPreferredCliBackend(config, "agy")
        : undefined;

  const combinedTextForSlots = [
    unpacked.userText,
    parsed.slots?.coreContent || "",
  ].join("\n");
  const detectedFormats = detectRequestedFormats(
    combinedTextForSlots,
    parsed.slots?.requestedFormats
  );
  const wantsFileDelivery = detectWantsFileDelivery(
    combinedTextForSlots,
    parsed.slots?.wantsFileDelivery
  );
  const needsWebSearch =
    parsed.slots?.needsWebSearch === true ||
    /(?:搜一下|搜索|查一下|检索|网上|karpathy|arxiv|最新)/i.test(combinedTextForSlots);

  // Only inherit recentArticle.id for article-specific intents! Never pollute unrelated tasks.
  const shouldFallbackToRecentArticle =
    intent === "article_followup" ||
    intent === "capture_idea" ||
    (intent === "send_file" &&
      (parsed.slots?.fileTarget === "latest_note" ||
        parsed.slots?.fileTarget === "latest_source"));

  const resolvedTargetArticleId =
    typeof parsed.targetArticleId === "number"
      ? parsed.targetArticleId
      : referencedArticle?.id ??
        (shouldFallbackToRecentArticle ? recentArticle?.id ?? null : null);

  return {
    intent,
    complexity,
    subagentTarget,
    reason: parsed.reason || "Classified by LLM intent router",
    targetArticleId: resolvedTargetArticleId,
    slots: {
      articleSubAction: parsed.slots?.articleSubAction,
      triageHint: parsed.slots?.triageHint,
      searchQuery: parsed.slots?.searchQuery,
      ideaTitle: parsed.slots?.ideaTitle,
      ideaSlug: parsed.slots?.ideaSlug,
      coreContent: parsed.slots?.coreContent || unpacked.userText,
      fileTarget: parsed.slots?.fileTarget,
      fileQuery: parsed.slots?.fileQuery,
      imagePrompt: parsed.slots?.imagePrompt,
      subagentTarget,
      requestedFormats: detectedFormats.length > 0 ? detectedFormats : undefined,
      wantsFileDelivery,
      needsWebSearch,
      isTaskRetryOrCorrection: parsed.slots?.isTaskRetryOrCorrection,
      documentTitle: parsed.slots?.documentTitle,
      documentSlug: parsed.slots?.documentSlug || parsed.slots?.ideaSlug,
    },
  };
}

export function buildHeuristicIntentDecision(params: {
  unpacked: UnpackedClawBotMessage;
  recentTurns?: ConversationTurnRecord[];
  recentArticle: ArticleRecord | null;
  referencedArticle: ArticleRecord | null;
  config?: AppConfig;
}): IntentDecision {
  const { unpacked, recentArticle, referencedArticle, config } = params;
  const text = unpacked.userText.trim();
  const targetArticle = referencedArticle ?? recentArticle;

  // 0. Check generate_image intent first (before send_file, since user may say "画一张图发给我")
  if (
    /(?:画一张|画一幅|画一只|画一个|画个.*图|生成一张.*图|生成一幅.*图|生成.*图片|生成.*配图|生成.*插图|生图|文生图|generate.*image)/i.test(
      text
    )
  ) {
    const explicitCli = detectExplicitCliBackend(text);
    const preferred: SubagentBackend = explicitCli || "agy";
    return {
      intent: "generate_image",
      complexity: "deep",
      subagentTarget: preferred,
      reason: "Heuristic match for image generation request",
      targetArticleId: referencedArticle?.id ?? null,
      slots: {
        coreContent: text,
        imagePrompt: text,
        subagentTarget: preferred,
      },
    };
  }

  // 0.3 Check compound document / learning guide generation task (before send_file!)
  if (isDocumentGenerationTask(text)) {
    const formats = detectRequestedFormats(text);
    const preferred = config ? getPreferredCliBackend(config, "agy") : "agy";
    return {
      intent: "delegate_subagent",
      complexity: "deep",
      subagentTarget: preferred,
      reason: "Heuristic match for compound research & multi-format document generation task",
      targetArticleId: referencedArticle?.id ?? null,
      slots: {
        coreContent: text,
        subagentTarget: preferred,
        requestedFormats: formats.length > 0 ? formats : ["md"],
        wantsFileDelivery: detectWantsFileDelivery(text),
        needsWebSearch: /(?:搜一下|搜索|查一下|检索|网上|karpathy|arxiv)/i.test(text),
      },
    };
  }

  // 0.5 Check explicit CLI delegation (codex, agy, opencode, claude, gemini, aider)
  const explicitCli = detectExplicitCliBackend(text);
  if (explicitCli) {
    return {
      intent: "delegate_subagent",
      complexity: "deep",
      subagentTarget: explicitCli,
      reason: `Heuristic match for ${explicitCli} subagent task`,
      targetArticleId: referencedArticle?.id ?? null,
      slots: {
        coreContent: text,
        subagentTarget: explicitCli,
        requestedFormats: detectRequestedFormats(text),
        wantsFileDelivery: detectWantsFileDelivery(text),
      },
    };
  }

  if (
    /^(?:把.*做第二阶段|同步.*微信读书|巡检.*知识库)/i.test(text)
  ) {
    const preferred = config ? getPreferredCliBackend(config, "codex") : "codex";
    return {
      intent: "delegate_subagent",
      complexity: "deep",
      subagentTarget: preferred,
      reason: "Heuristic match for vault deep governance subagent task",
      targetArticleId: referencedArticle?.id ?? null,
      slots: {
        coreContent: text,
        subagentTarget: preferred,
      },
    };
  }

  if (
    /^(?:调研.*arxiv|调研.*论文)/i.test(text)
  ) {
    const preferred = config ? getPreferredCliBackend(config, "agy") : "agy";
    return {
      intent: "delegate_subagent",
      complexity: "deep",
      subagentTarget: preferred,
      reason: "Heuristic match for research subagent task",
      targetArticleId: referencedArticle?.id ?? null,
      slots: {
        coreContent: text,
        subagentTarget: preferred,
      },
    };
  }

  // 1. Check send_file intent
  if (
    /(?:发文件|发给我|发我微信|导出|发送.*(?:伴读|笔记|原文|\.md|\.pdf|\.html)|文件呢)/i.test(
      text
    )
  ) {
    const wantsSource = /原文|source/i.test(text);
    const hasSpecificPath = text.match(/([a-zA-Z0-9_/-]+\.(?:md|html|pdf))/)?.[1];
    const formats = detectRequestedFormats(text);
    return {
      intent: "send_file",
      complexity: "fast",
      reason: "Heuristic match for file delivery request",
      targetArticleId: targetArticle?.id ?? null,
      slots: {
        fileTarget: hasSpecificPath
          ? "vault_file"
          : wantsSource
            ? "latest_source"
            : "latest_note",
        fileQuery: hasSpecificPath || text,
        requestedFormats: formats.length > 0 ? formats : undefined,
        wantsFileDelivery: true,
      },
    };
  }

  // 2. Check vault_query intent
  if (
    /^(?:问|查询|检索|搜索|查一下|搜一下|找一下|ask|\?)\s*[:：]?\s*/i.test(text) ||
    /(?:我的知识库|知识库里|之前写过|研究大纲|到哪一步)/i.test(text)
  ) {
    const cleanQ = text.replace(/^(?:问|查询|检索|搜索|查一下|搜一下|找一下|ask|\?)\s*[:：]?\s*/i, "").trim();
    const isComplex = cleanQ.length > 40 || /(?:对比|综合|推演|为什么|演进|体系)/i.test(cleanQ);
    return {
      intent: "vault_query",
      complexity: isComplex ? "deep" : "fast",
      reason: "Heuristic match for knowledge base query",
      slots: {
        searchQuery: cleanQ || text,
        coreContent: text,
      },
    };
  }

  // 3. Check capture_inbox (todo / memo / reminder)
  if (/^(?:待办|备忘|速记|提醒我|todo|inbox)\s*[:：]?\s*/i.test(text)) {
    const body = text.replace(/^(?:待办|备忘|速记|提醒我|todo|inbox)\s*[:：]?\s*/i, "").trim();
    return {
      intent: "capture_inbox",
      complexity: "fast",
      reason: "Heuristic match for inbox/todo capture",
      slots: {
        coreContent: body || text,
        ideaTitle: (body || text).slice(0, 36),
      },
    };
  }

  // 4. Natural language idea expression (without rigid prefix)
  if (
    /(?:我突然想到|我想到|我觉得有个点|有个灵感|记个想法|我的观点是|我认为.*本质上是)/i.test(
      text
    )
  ) {
    return {
      intent: "capture_idea",
      complexity: text.length > 200 ? "deep" : "fast",
      reason: "Heuristic match for natural language personal thought",
      targetArticleId: targetArticle?.id ?? null,
      slots: {
        coreContent: text,
      },
    };
  }

  // 5. Quoted message (ref_msg) referencing an article
  if (referencedArticle) {
    const isQuestion = /[?？]|(?:怎么|如何|为什么|什么意思|展开讲|深读|拆解)/i.test(text);
    const triageHint = detectTriageHint(text);
    return {
      intent: "article_followup",
      complexity: isQuestion ? "deep" : "fast",
      reason: "Message quotes a known article via ref_msg",
      targetArticleId: referencedArticle.id,
      slots: {
        articleSubAction: triageHint
          ? "triage"
          : /深读|拆解/i.test(text)
            ? "deepen"
            : isQuestion
              ? "qa"
              : "annotate",
        triageHint,
        coreContent: text,
      },
    };
  }

  // 6. Recent article within 15 minutes
  if (recentArticle) {
    const ageMs = Date.now() - new Date(recentArticle.created_at).getTime();
    if (ageMs <= 15 * 60 * 1000) {
      const isQuestion = /[?？]|(?:这篇文章|里面提到|怎么理解)/i.test(text);
      return {
        intent: "article_followup",
        complexity: isQuestion ? "deep" : "fast",
        reason: "Follow-up within 15 minutes of recent article",
        targetArticleId: recentArticle.id,
        slots: {
          articleSubAction: isQuestion ? "qa" : "annotate",
          coreContent: text,
        },
      };
    }
  }

  // 7. Default to general_assistant
  return {
    intent: "general_assistant",
    complexity: text.length > 160 ? "deep" : "fast",
    reason: "Default conversational assistant fallback",
    slots: {
      coreContent: text,
    },
  };
}

function detectTriageHint(text: string): TriageLevel | undefined {
  if (!text) return undefined;
  if (/(?:优先|精读|深读|立即处理|process_now)/i.test(text)) return "process_now";
  if (/(?:只做参考|留作参考|参考即可|备查|reference)/i.test(text)) return "reference";
  if (/(?:只存原文|仅保留原文|不用处理|keep_raw)/i.test(text)) return "keep_raw";
  if (/(?:稍后处理|以后再看|process_later)/i.test(text)) return "process_later";
  return undefined;
}
