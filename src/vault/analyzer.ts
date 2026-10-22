import { relative } from "node:path";
import { AppConfig } from "../config.ts";
import { resolveModelEndpoint } from "../agent/llm.ts";
import { TriageLevel } from "../db.ts";
import { ExtractedWeChatArticle } from "../extractor/wechat.ts";
import { VaultContextSnapshot } from "./context.ts";

export interface LightAnalysisResult {
  english_slug: string;
  triage: TriageLevel;
  related_vault_nodes: string[];
  wechat_reply: string;
  companion_note_markdown: string;
}

export async function analyzeArticleWithVault(params: {
  config: AppConfig;
  article: ExtractedWeChatArticle;
  userNotes: string;
  vaultContext: VaultContextSnapshot;
}): Promise<LightAnalysisResult> {
  const { config, article, userNotes, vaultContext } = params;

  if (config.llm.apiKey) {
    try {
      return await callOpenAICompatibleAnalysis(
        config,
        article,
        userNotes,
        vaultContext
      );
    } catch (err) {
      console.warn(
        `[Analyzer] LLM API call failed, falling back to local heuristic digest:`,
        err
      );
    }
  }

  return buildFallbackAnalysis(config, article, userNotes, vaultContext);
}

async function callOpenAICompatibleAnalysis(
  config: AppConfig,
  article: ExtractedWeChatArticle,
  userNotes: string,
  vaultContext: VaultContextSnapshot
): Promise<LightAnalysisResult> {
  const hasVaultContext = Boolean(
    config.vaultEnabled !== false &&
      (vaultContext.nowSummary.trim() ||
        vaultContext.queueSummary.trim() ||
        vaultContext.matchedNotes.length > 0)
  );

  const matchedNotesText =
    vaultContext.matchedNotes.length > 0
      ? vaultContext.matchedNotes
          .map(
            (m, i) =>
              `${i + 1}. ${m.wikiLink} (${m.relativePath}, 命中 ${m.hitCount} 次)\n摘要片段：${m.excerpt}`
          )
          .join("\n\n")
      : "（未检索到直接命中的既有笔记）";

  const systemPrompt = hasVaultContext
    ? `你是一个专为用户的个人知识库（${config.vaultRoot}）服务的「深度阅读与知识内化分析师」。
用户在手机上读到一篇文章并转发给你。你的任务不是写平庸的全文缩写，而是以用户的当前研究/写作主线为锚点，提取真正有增量的部分。

请严格输出一个合法的 JSON 对象（不要使用多余的外层包裹文本），结构如下：
{
  "english_slug": "3到6个英文单词的小写下划线短名，用于文件名，如 agent_context_memory_design",
  "triage": "reference 或 process_later 或 process_now 或 keep_raw 四选一（如果很有深度且紧扣用户当前主线选 process_later 或 process_now；如果只是了解信息选 reference）",
  "related_vault_nodes": ["[[节点名1]]", "[[节点名2]]"],
  "wechat_reply": "直接发回给用户手机微信的精简初筛卡片（纯文本，控制在 280~450 字以内，分段清晰，包含：1. 🎯 批注回应（若用户有批注） 2. 💧 脱水干货 3. 🔗 知识库碰撞点 4. 🚦 分诊建议与是否值得回电脑精读）",
  "companion_note_markdown": "存入本地 _note.md 的完整 Markdown 正文（不含 YAML frontmatter 和一级标题），必须包含以下四个二级标题章节：\n## 核心提纯 (Core Signal)\n## 与个人知识库的碰撞 (Vault Resonance & Delta)\n## 对当前主线的启发 (For Active Lines)\n## 候选想法与深读追问 (Candidate Idea Seeds & Questions)"
}`
    : `你是一个专业的「深度阅读与核心价值提纯分析师」。
用户在手机微信上转发了一篇文章给你。请为该文章做高信息密度的结构化提纯，无需假设用户存在外部知识库。

请严格输出一个合法的 JSON 对象（不要使用多余的外层包裹文本），结构如下：
{
  "english_slug": "3到6个英文单词的小写下划线短名，用于文件名，如 agent_context_memory_design",
  "triage": "reference 或 process_later 或 process_now 或 keep_raw 四选一（如果很有深度值得精读选 process_later 或 process_now；如果只是了解信息选 reference）",
  "related_vault_nodes": [],
  "wechat_reply": "直接发回给用户手机微信的精简阅读卡片（纯文本，控制在 280~450 字以内，分段清晰，包含：1. 🎯 批注回应（若用户有批注） 2. 💧 脱水干货与核心结论 3. 🔍 关键论据与亮点审视 4. 🚦 分诊建议与延伸思考）",
  "companion_note_markdown": "存入本地 _note.md 的完整 Markdown 正文（不含 YAML frontmatter 和一级标题），必须包含以下四个二级标题章节：\n## 核心提纯 (Core Signal)\n## 关键论据与方法拆解 (Key Arguments & Evidence)\n## 实践启发与局限审视 (Takeaways & Critical View)\n## 延伸思考与深读追问 (Follow-up Questions)"
}`;

  const bodyExcerpt =
    article.markdownBody.length > 14000
      ? article.markdownBody.slice(0, 14000) + "\n\n...(正文过长已截断)"
      : article.markdownBody;

  const userPrompt = hasVaultContext
    ? `【用户转发时的个人批注/问题】
${userNotes.trim() || "（无额外批注，请结合我的知识库关注点主动提炼）"}

【用户知识库当前焦点 (${config.vaultLayout?.nowFile || "00_home/now.md"} 节选)】
${vaultContext.nowSummary || "（未读取到）"}

【用户知识库待办队列 (${config.vaultLayout?.queueFile || "00_home/queue.md"} 节选)】
${vaultContext.queueSummary || "（未读取到）"}

【知识库中检索到的相关既有笔记】
${matchedNotesText}

【待分析的文章】
- 标题：${article.title}
- 公众号/作者：${article.author}
- 发布日期：${article.publishDate}
- 原文链接：${article.url}

【文章正文 Markdown】
${bodyExcerpt}`
    : `【用户转发时的个人批注/问题】
${userNotes.trim() || "（无额外批注，请直接提炼文章核心价值与关键论据）"}

【待分析的文章】
- 标题：${article.title}
- 公众号/作者：${article.author}
- 发布日期：${article.publishDate}
- 原文链接：${article.url}

【文章正文 Markdown】
${bodyExcerpt}`;

  const resolvedEp = resolveModelEndpoint(config, "fast");
  const endpoint = `${(resolvedEp.baseUrl || config.llm.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const resp = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolvedEp.apiKey || config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.fastModel || config.llm.model || resolvedEp.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty LLM response content");
  }

  const parsed = parseJsonFromLlm(content);
  const validTriage: TriageLevel[] = [
    "keep_raw",
    "reference",
    "process_later",
    "process_now",
  ];
  const triage: TriageLevel = validTriage.includes(parsed.triage)
    ? parsed.triage
    : "process_later";

  return {
    english_slug:
      typeof parsed.english_slug === "string" && parsed.english_slug.trim()
        ? parsed.english_slug.trim()
        : "wechat_article",
    triage,
    related_vault_nodes: Array.isArray(parsed.related_vault_nodes)
      ? parsed.related_vault_nodes.map(String)
      : vaultContext.matchedNotes.map((m) => m.wikiLink),
    wechat_reply:
      typeof parsed.wechat_reply === "string" && parsed.wechat_reply.trim()
        ? parsed.wechat_reply.trim()
        : "已抓取并生成初筛伴读笔记。",
    companion_note_markdown:
      typeof parsed.companion_note_markdown === "string" &&
      parsed.companion_note_markdown.trim()
        ? parsed.companion_note_markdown.trim()
        : parsed.wechat_reply || "",
  };
}

function parseJsonFromLlm(raw: string): any {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function formatRelDir(vaultRoot: string, targetDir: string, fallback: string): string {
  const rel = relative(vaultRoot, targetDir).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return fallback;
  return rel.endsWith("/") ? rel : `${rel}/`;
}

function buildFallbackAnalysis(
  config: AppConfig,
  article: ExtractedWeChatArticle,
  userNotes: string,
  vaultContext: VaultContextSnapshot
): LightAnalysisResult {
  const relatedNodes = vaultContext.matchedNotes.map((m) => m.wikiLink);
  const paragraphs = article.markdownBody
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 30 && !p.startsWith("!["));
  const previewPoints = paragraphs.slice(0, 3).map((p) => `- ${p.slice(0, 140)}...`);

  const englishWords =
    article.title
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.join("_") || "";
  const slug =
    englishWords.length >= 4
      ? englishWords
      : `wechat_${article.publishDate.replace(/-/g, "_")}`;

  const wechatRelDir = formatRelDir(
    config.vaultRoot,
    config.wechatArticlesDir,
    "01_inputs/articles/wechat/"
  );
  const ideasRelDir = formatRelDir(
    config.vaultRoot,
    config.ideasSeedsDir,
    "03_ideas/seeds/"
  );

  const wechatReply = [
    `✅ 已入库：《${article.title}》（${article.author}）`,
    userNotes ? `🎯 你的批注：${userNotes}` : "",
    `💧 原文摘要：\n${article.digest || previewPoints[0] || "已提取完整正文 Markdown"}`,
    relatedNodes.length > 0
      ? `🔗 命中知识库节点：${relatedNodes.slice(0, 4).join("、")}`
      : `🔗 命中知识库节点：暂无直接命中`,
    `🚦 状态：已存入 ${wechatRelDir}（提示：配置 LLM_API_KEY 后可开启深度碰撞初筛；回复「想法：...」可直接沉淀至 ${ideasRelDir}）`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const companionMarkdown = [
    "## 核心提纯 (Core Signal)",
    "",
    userNotes ? `> **转发时个人关注点**：${userNotes}\n` : "",
    article.digest ? `- **文章导读**：${article.digest}` : "",
    ...previewPoints,
    "",
    "## 与个人知识库的碰撞 (Vault Resonance & Delta)",
    "",
    ...(vaultContext.matchedNotes.length > 0
      ? vaultContext.matchedNotes.map(
          (m) => `- **${m.wikiLink}**（\`${m.relativePath}\`，关键词命中 ${m.hitCount} 次）`
        )
      : ["- 暂未检索到高频共现节点，可在电脑端调用 Agent 进一步交叉比对。"]),
    "",
    "## 对当前主线的启发 (For Active Lines)",
    "",
    "- 原文已完整保存，可在 Codex / AntiGravity / OpenCode 中通过 `wx-ctx show` 结合当前研究或创作主线进行深度拆解。",
    "",
    "## 候选想法与深读追问 (Candidate Idea Seeds & Questions)",
    "",
    `- 待深读时提炼个人判断至 \`${ideasRelDir}\`。`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    english_slug: slug,
    triage: "process_later",
    related_vault_nodes: relatedNodes,
    wechat_reply: wechatReply,
    companion_note_markdown: companionMarkdown,
  };
}
