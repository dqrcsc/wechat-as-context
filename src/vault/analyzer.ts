import { AppConfig } from "../config.ts";
import { resolveModelEndpoint } from "../agent/llm.ts";
import { TriageLevel } from "../db.ts";
import { ExtractedWeChatArticle } from "../extractor/wechat.ts";
import { VaultContextSnapshot } from "./context.ts";
import { ANALYSIS_CONTEXT_POLICY, formatAnalysisContext, loadAnalysisContext, type AnalysisContextSnapshot } from "./analysis_context.ts";
import { ARTICLE_REVIEW_POLICY } from "./analysis_policy.ts";
import { applyValidationContract } from "./validation_contract.ts";

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
  const resolvedEp = resolveModelEndpoint(config, "fast");
  const hasApiAuth = Boolean(
    config.llm.apiKey || (config.llm.fastProvider && resolvedEp.apiKey)
  );

  if (hasApiAuth) {
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
${ARTICLE_REVIEW_POLICY}

请严格输出合法 JSON，不加外层文本：
{
  "english_slug": "3到6个英文单词的小写下划线短名",
  "triage": "keep_raw / reference / process_later / process_now 四选一",
  "validation_contract": "无业务试验则为 null；否则按下述结构输出一个对象，两份正文共用",
  "wechat_reply": "手机微信紧凑初筛，纯文本，最终含统计段落尽量控制在 450–650 字左右（弹性参考目标，非刚性字数指标，以说清关键条件为准，不机械截断）",
  "companion_note_markdown": "完整 Markdown 正文，可详细展开论证与实验，不含 frontmatter 和一级标题"
}
validation_contract 对象结构：{"metrics":[{"name":"指标短名","numerator":"分子短名","denominator":"分母短名","direction":"increase 或 decrease","minimum_gain":{"unit":"percentage_points 或 relative_percent","value":5}}]}。
只选1个主要比率指标，确需防止副作用时再加1个；最多3个。value 是建议的最低改善门槛，尚不能提出时用 null；非负数，百分点最多100，0表示不得恶化。指标定义必须能从样本判定，不得把率的绝对水平写成改善幅度。
有试验时，微信和伴读各在业务验证部分放且仅放一次 {{VALIDATION_CONTRACT}}，由程序插入同一段指标定义、公式及通过/失败条件；业务验证部分除该占位符外，严禁出现“显著、波动范围、置信区间、百分点、相对提升、相对下降”等字样（含“未见显著优势”等否定表述，失败结论统一写“未观察到预期增益”），正文其他位置也不得另写或转述本试验的指标单位、数值门槛或统计结论，不得把数字写在指标名称/分子/分母中规避结构字段。无试验则 validation_contract 为 null，两份正文均不放占位符。
微信与伴读正文使用以下模块，伴读用二级标题：
1. 🎯 批注回应：有实质批注才写；仅链接标题则省略，节省手机篇幅。
2. 💧 脱水干货：核心判断、推理和关键证据，区分主张与事实；微信限1–2个要点。
3. 💡 观点碰撞：说明已有判断→文章增量→判断如何变化。选择补充、挑战、适用边界、新问题，不用“深度契合”代替分析，也不为碰撞强造作者错误。没有可追溯的既有观点则写成待讨论假设；推演明确标“分析判断”，保留触发条件。
4. 🏢 业务与规划启发：正在解决的问题→文章启发→可能的方案调整→最小验证动作；明确是分析建议，不冒充已批准任务。按共享规范展示验证六项，先选被测变量，再交代两组信息、唯一差异、验收判据及失败结论范围。无直接关联时简短说明，不强行写业务启发。
5. 🔍 边界与待验证：证据强弱、实施前提、反例、可能失效的情形。
6. 🚦 分诊与下一步：固定分成“逐段精读价值”“场景验证价值”“分诊与下一步”三项，分别给理由。先判断是否有与当前业务相关的实质未决问题，再决定 triage；若上文提出值得继续检验的业务假设，默认 process_later，不能在结尾又以篇幅短/细节浅降为 reference。若认为试验不值得做，须解释为何没有实质后续价值。process_now 还须明确即时请求、决策期限或可追溯紧迫性。
微信精简（尽量提炼压缩，非刚性指标）：观点碰撞只留一组已有判断→增量/边界；业务只选一个候选，将验证假设、样本与反例、A/B等量信息和唯一改动、规则确认与独立复核尽量压成2–3句连贯短文（无需拆成编号子标题），指标和通过/失败条件交给占位符。边界一句，分诊三项合成一句。统计段落之外尽量控制在200–300字左右；详细样本分层、推演和解释放伴读，不重复铺陈。
初筛微信和伴读正文不得输出具体笔记标题、文件路径、Markdown 笔记链接或 [[WikiLink]]，不得宣称已建立知识关系。具体笔记链接留到精读查证全文后。候选片段仅供比较观点，不等于用户认可的观点或现行公司规划。
输出前逐项核对：转述是否保留原文“往往/可能/在某范围”等限定，是否把未展开推成做错；微信和伴读两份正文是否都能逐项核对A/B信息与被测变量，验收是否有明确判据，失败是否只涉及已测试范围；两种阅读价值及 triage 是否自洽。发现问题先修正输出，不要仅声称已遵守规则。`;

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
    candidate_excerpts: vaultContext.matchedNotes.map((m, i) => ({ candidate: i + 1,
      evidence_scope: "background_only_not_article_evidence", excerpt: m.excerpt })),
    article: { evidence_scope: "current_article_author_claims_not_verified_facts",
      title: article.title, author: article.author, publishDate: article.publishDate,
      url: article.url, body: bodyExcerpt },
  }, null, 2);

  const resolvedEp = resolveModelEndpoint(config, "fast");
  const endpoint = `${(resolvedEp.baseUrl || config.llm.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const targetModel = resolvedEp.model || config.llm.fastModel || config.llm.model;
  const authKey = resolvedEp.apiKey || config.llm.apiKey;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const sendCompletionRequest = (useJsonObjectFormat: boolean) =>
    fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authKey}`,
      },
      body: JSON.stringify({
        model: targetModel,
        temperature: 0.2,
        ...(useJsonObjectFormat ? { response_format: { type: "json_object" } } : {}),
        messages,
      }),
    });

  let resp = await sendCompletionRequest(true);
  if (resp.status === 400) {
    resp = await sendCompletionRequest(false);
  }

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
  const rendered = applyValidationContract(parsed);

  return {
    english_slug:
      typeof parsed.english_slug === "string" && parsed.english_slug.trim()
        ? parsed.english_slug.trim()
        : "wechat_article",
    triage,
    // Compatibility field: retrieval candidates only, never model-invented links.
    related_vault_nodes: [...new Set(vaultContext.matchedNotes.map((m) => m.wikiLink))],
    wechat_reply: rendered.wechat_reply.trim(),
    companion_note_markdown: rendered.companion_note_markdown.trim(),
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
    ["💧 脱水干货", `原文导读/摘录（未核验）：\n${article.digest || previewPoints.join("\n") || "正文已提取，待人工阅读。"}`],
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
