import { AppConfig } from "../config.ts";
import { resolveModelEndpoint } from "../agent/llm.ts";
import { TriageLevel } from "../db.ts";
import { ExtractedWeChatArticle } from "../extractor/wechat.ts";
import { VaultContextSnapshot } from "./context.ts";
import { ANALYSIS_CONTEXT_POLICY, formatAnalysisContext, loadAnalysisContext, type AnalysisContextSnapshot } from "./analysis_context.ts";

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
  const { config, article, userNotes } = params;
  const vaultContext = config.vaultEnabled === false
    ? { nowSummary: "", queueSummary: "", topicsOverview: "", matchedNotes: [] }
    : params.vaultContext;
  const background = loadAnalysisContext(config.analysisContextFile);
  let result: LightAnalysisResult | undefined;

  if (config.llm.apiKey) {
    try {
      result = await callOpenAICompatibleAnalysis(
        config,
        article,
        userNotes,
        vaultContext,
        background
      );
    } catch (err) {
      console.warn(
        `[Analyzer] LLM API call failed, falling back to local heuristic digest:`,
        err
      );
    }
  }

  result ??= buildFallbackAnalysis(article, userNotes, vaultContext);
  result.wechat_reply = sanitizeInitialText(result.wechat_reply, vaultContext);
  result.companion_note_markdown = sanitizeInitialText(result.companion_note_markdown, vaultContext);
  if (background.warnings.length) {
    const notice = `⚠️ 背景材料未完整采用：${background.warnings.join("；")}`;
    result.wechat_reply += `\n\n${notice}`;
    result.companion_note_markdown += `\n\n${notice}`;
  }
  // Keep the exact selected snapshot as plain provenance, not semantic note links.
  if (background.entries.length) {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "[": "&#91;", "]": "&#93;" };
    const provenance = JSON.stringify(background.entries, null, 2).replace(/[&<>\[\]]/g, char => entities[char]);
    result.companion_note_markdown += `\n\n## 分析背景快照（溯源，非实时核验）\n\n<pre>${provenance}</pre>`;
  }
  return result;
}

async function callOpenAICompatibleAnalysis(
  config: AppConfig,
  article: ExtractedWeChatArticle,
  userNotes: string,
  vaultContext: VaultContextSnapshot,
  background: AnalysisContextSnapshot
): Promise<LightAnalysisResult> {
  const systemPrompt = `你是用户的文章精读搭档。初筛的目标是帮助判断“哪些观点值得更新，对正在做的事有什么用”，不是给文章寻找归档位置。
${ANALYSIS_CONTEXT_POLICY}

请严格输出合法 JSON，不加外层文本：
{
  "english_slug": "3到6个英文单词的小写下划线短名",
  "triage": "keep_raw / reference / process_later / process_now 四选一",
  "wechat_reply": "手机微信直接展示的较完整分析，纯文本，建议 800–1400 字，按信息量调整，不凑字数，不截断结论",
  "companion_note_markdown": "完整 Markdown 正文，不含 frontmatter 和一级标题"
}
微信与伴读正文使用以下模块，伴读用二级标题：
1. 🎯 批注回应：有批注才写，直接回答关注点，指出文章未回答的内容。
2. 💧 核心提纯：核心判断、推理和关键证据，区分主张与事实。
3. 💡 观点碰撞：说明已有判断→文章增量→判断如何变化。选择补充、挑战、适用边界、新问题，不用“深度契合”代替分析，不只寻找支持证据。没有可追溯的既有观点则写成待讨论假设。
4. 🏢 业务与规划启发：正在解决的问题→文章启发→可能的方案调整→最小验证动作；明确是分析建议，不冒充已批准任务。无直接关联时简短说明，不强行写业务启发。
5. 🔍 边界与待验证：证据强弱、实施前提、反例、可能失效的情形。
6. 🚦 分诊与下一步：解释优先级、是否值得精读及具体追问/验证。不能只因篇幅短就否定精读价值；process_now 需要明确当前决策价值或紧迫性，不能把背景队列当作执行授权。
初筛微信和伴读正文不得输出具体笔记标题、文件路径、Markdown 笔记链接或 [[WikiLink]]，不得宣称已建立知识关系。具体笔记链接留到精读查证全文后。候选片段仅供比较观点，不等于用户认可的观点或现行公司规划。`;

  const bodyExcerpt = article.markdownBody.length > 14000
    ? article.markdownBody.slice(0, 14000) + "\n\n...(正文过长已截断，不代表已阅读全文)"
    : article.markdownBody;
  const userPrompt = JSON.stringify({
    user_annotation: userNotes.trim() || "（无额外批注）",
    analysis_background: formatAnalysisContext(background),
    focus: vaultContext.nowSummary || "（未提供）",
    queue: vaultContext.queueSummary || "（未提供）",
    topics: vaultContext.topicsOverview || "（未提供）",
    // The model compares ideas; filenames and hit counts are not evidence of resonance.
    candidate_excerpts: vaultContext.matchedNotes.map((m, i) => ({ candidate: i + 1, excerpt: m.excerpt })),
    article: { title: article.title, author: article.author, publishDate: article.publishDate,
      url: article.url, body: bodyExcerpt },
  }, null, 2);

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
  if (!parsed || typeof parsed.wechat_reply !== "string" || !parsed.wechat_reply.trim() ||
      typeof parsed.companion_note_markdown !== "string" || !parsed.companion_note_markdown.trim()) {
    throw new Error("Incomplete analysis response");
  }
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
    // Compatibility field: retrieval candidates only, never model-invented links.
    related_vault_nodes: [...new Set(vaultContext.matchedNotes.map((m) => m.wikiLink))],
    wechat_reply: parsed.wechat_reply.trim(),
    companion_note_markdown: parsed.companion_note_markdown.trim(),
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

/** Guard against the most common model regressions; semantic quality still needs review. */
function sanitizeInitialText(text: string, context: VaultContextSnapshot): string {
  let clean = text
    .replace(/\[\[[^\]\n]+\]\]/g, "（笔记线索留待精读核验）")
    .replace(/\[[^\]\n]*\]\((?:[^)\n]*\.md(?:#[^)\n]*)?|(?:file|obsidian):[^)\n]*)\)/gi, "（笔记链接留待精读核验）");
  for (const note of context.matchedNotes) {
    for (const ref of [note.absolutePath, note.relativePath].filter(Boolean)) {
      clean = clean.split(ref).join("（笔记线索留待精读核验）");
    }
  }
  return clean;
}

function buildFallbackAnalysis(
  article: ExtractedWeChatArticle,
  userNotes: string,
  vaultContext: VaultContextSnapshot
): LightAnalysisResult {
  const paragraphs = article.markdownBody.split(/\n{2,}/).map(p => p.trim())
    .filter(p => p.length > 30 && !p.startsWith("!["));
  const previewPoints = paragraphs.slice(0, 3).map(p => `- ${p.slice(0, 240)}${p.length > 240 ? "…" : ""}`);
  const englishWords = article.title.toLowerCase().match(/[a-z0-9]+/g)?.join("_") || "";
  const sections = [
    ["分析状态", "未完成模型分析，以下仅为本地原文摘录，不代表已完成观点或业务判断。"],
    ...(userNotes ? [["🎯 批注回应", `已记录，待精读回应：${userNotes}`]] : []),
    ["💧 核心提纯", `原文导读/摘录（未核验）：\n${article.digest || previewPoints.join("\n") || "正文已提取，待人工阅读。"}`],
    ["💡 观点碰撞", "待精读核验已有判断与文章之间的补充、挑战及适用边界；关键词命中不代表观点一致。"],
    ["🏢 业务与规划启发", "尚未完成关联分析，不据此认定适用项目或生成业务承诺。"],
    ["🔍 边界与待验证", "未评估论据强弱、实施前提及反例；不能仅凭导读判断结论成立。"],
    ["🚦 分诊与下一步", "process_later：待模型可用或桌面精读后再判断价值，优先回应批注并核验关键证据。"],
  ];
  return {
    english_slug: englishWords.length >= 4 ? englishWords : `wechat_${article.publishDate.replace(/-/g, "_")}`,
    triage: "process_later",
    related_vault_nodes: [...new Set(vaultContext.matchedNotes.map(m => m.wikiLink))],
    wechat_reply: sections.map(([heading, body]) => `${heading}：\n${body}`).join("\n\n"),
    companion_note_markdown: sections.map(([heading, body]) => `## ${heading}\n\n${body}`).join("\n\n"),
  };
}
