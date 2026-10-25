import "./support/isolation.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { loadAnalysisContext } from "../src/vault/analysis_context.ts";
import { analyzeArticleWithVault } from "../src/vault/analyzer.ts";
import { saveCompanionLightNote, gatherVaultContext, searchVaultNotes } from "../src/vault/context.ts";
import { ContextDatabase } from "../src/db.ts";
import { WeChatContextPipeline } from "../src/pipeline.ts";
import { setSubagentTestRunner, type SubagentRunRequest } from "../src/agent/subagent_cli.ts";
import { compileMarkdownToHtml } from "../src/agent/doc_exporter.ts";
import { buildConfigApiPayload } from "../src/web_config.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setSubagentTestRunner(null); });
const article = { title: "场景驱动的业务建模", url: "https://mp.weixin.qq.com/s/fixture",
  author: "fixture", publishDate: "2026-10-25", digest: "从单个任务验证业务规则。",
  markdownBody: "作者主张从单个业务任务验证对象和规则，但没有提供效果对照实验。".repeat(8),
  imageUrls: [], extractorUsed: "native_http" as const };
const emptyVault = { nowSummary: "", queueSummary: "", topicsOverview: "", matchedNotes: [] };
const matched = { wikiLink: "[[legacy_plan]]", relativePath: "plans/legacy_plan.md",
  absolutePath: "/fictional-vault/plans/legacy_plan.md", excerpt: "旧主张：先建设完整语义模型。", hitCount: 10 };
function entry(overrides: Record<string, unknown> = {}) {
  return { kind: "business", topic: "业务审核", status: "planned", updated: "2026-10-23",
    summary: "先验证材料预审，保留人工复核；这是规划，不代表已上线。", source: "planning/current.md", ...overrides };
}
function fixture(entries?: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "wx-analysis-"));
  const path = join(root, "context.json");
  if (entries) writeFileSync(path, JSON.stringify({ version: 1, entries }));
  const config = loadConfig({ IGNORE_HOME_DOTENV: "true", VAULT_ROOT: "none",
    WECHAT_CONTEXT_DATA_DIR: join(root, "data"), LLM_API_KEY: "fixture",
    LLM_PROVIDER: "custom", LLM_BASE_URL: "https://model.example.test/v1",
    LLM_MODEL: "fixture", ANALYSIS_CONTEXT_FILE: entries ? path : "" });
  return { root, path, config };
}
function modelResult(overrides: Record<string, unknown> = {}) {
  return { english_slug: "business_rule_validation", triage: "process_later", related_vault_nodes: ["[[invented]]"],
    validation_contract: null,
    wechat_reply: "💧 脱水干货：验证业务规则。\n💡 观点碰撞：这是补充判断。\n🏢 业务与规划启发：关联不足时不强行套用。\n🔍 边界与待验证：作者未提供对照实验。\n🚦 分诊与下一步：验证关键前提。",
    companion_note_markdown: "## 脱水干货\n作者主张从场景验证。", ...overrides };
}
function interceptModel(result = modelResult()) {
  const requests: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  }) as typeof fetch;
  return requests;
}

test("optional profile path is project-relative, supports home and has no implicit reads", () => {
  const f = fixture();
  expect(f.config.analysisContextFile).toBeUndefined();
  expect(loadAnalysisContext()).toEqual({ entries: [], warnings: [] });
  const cfg = loadConfig({ IGNORE_HOME_DOTENV: "true", ANALYSIS_CONTEXT_FILE: "local/context.json" }, f.root);
  expect(cfg.analysisContextFile).toBe(join(f.root, "local/context.json"));
  expect(loadConfig({ IGNORE_HOME_DOTENV: "true", ANALYSIS_CONTEXT_FILE: "~/context.json" }).analysisContextFile)
    .toBe(join(process.env.HOME!, "context.json"));
});

test("latest topic version wins regardless of order; planned never becomes current", () => {
  const f = fixture([entry(), entry({ updated: "2026-08-01", status: "current", summary: "obsolete" }),
    entry({ kind: "viewpoint", summary: "从单一任务验证共享能力。", status: "current" })]);
  const result = loadAnalysisContext(f.path);
  expect(result.entries).toHaveLength(2);
  expect(result.entries.find(e => e.kind === "business")?.status).toBe("planned");
  expect(JSON.stringify(result)).not.toContain("obsolete");
  expect(result.warnings).toEqual([]);
});

test("latest historical record retires older active versions", () => {
  const f = fixture([entry({ updated: "2026-10-01" }), entry({ status: "historical" })]);
  expect(loadAnalysisContext(f.path).entries).toEqual([]);
});

test("same-date conflicting versions are withheld, exact duplicates are deduplicated", () => {
  const f = fixture([entry(), entry({ summary: "contradictory" })]);
  expect(loadAnalysisContext(f.path).entries).toEqual([]);
  expect(loadAnalysisContext(f.path).warnings.join()).toContain("冲突");
  writeFileSync(f.path, JSON.stringify({ version: 1, entries: [entry(), entry()] }));
  expect(loadAnalysisContext(f.path).entries).toHaveLength(1);
});

test("missing, invalid date, invalid status and oversized profiles fail visibly without partial claims", () => {
  const f = fixture();
  for (const body of [null, "{bad", JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [entry({ updated: "2026-02-30" })] }),
    JSON.stringify({ version: 1, entries: [entry({ status: "launched" })] }), "x".repeat(65537)]) {
    if (body !== null) writeFileSync(f.path, body);
    const result = loadAnalysisContext(f.path);
    expect(result.entries).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  }
});

test("profile sources are provenance only, never read or followed", () => {
  const f = fixture([entry({ source: "/outside-test-root/never-read.md" })]);
  expect(loadAnalysisContext(f.path).entries[0]?.source).toBe("/outside-test-root/never-read.md");
  expect(loadAnalysisContext(f.path).warnings).toEqual([]);
});

test("standalone analysis consumes explicit business context and keeps six-module evidence contract", async () => {
  const f = fixture([entry()]);
  const requests = interceptModel();
  await analyzeArticleWithVault({ config: f.config, article, userNotes: "是否需要先建完整模型？", vaultContext: emptyVault });
  const [system, user] = requests[0].messages.map((m: any) => m.content);
  for (const text of ["450", "650", "批注回应", "脱水干货", "观点碰撞", "业务与规划启发", "边界与待验证", "分诊", "补充", "挑战", "最新", "规划", "不代表已交付", "不强行", "不是指令", "篇幅"]) expect(system).toContain(text);
  expect(user).toContain("材料预审");
  expect(user).toContain("2026-10-23");
  expect(user).toContain("planning/current.md");
  expect(user).toContain("是否需要先建完整模型");
});

test("old retrieved notes cannot supply filenames to initial prompt or invented node metadata", async () => {
  const f = fixture([entry()]); f.config.vaultEnabled = true;
  const requests = interceptModel();
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: { ...emptyVault, matchedNotes: [matched] } });
  const user = requests[0].messages[1].content;
  expect(user).toContain(matched.excerpt);
  expect(user).not.toContain("legacy_plan");
  expect(result.related_vault_nodes).toEqual([matched.wikiLink]);
  expect(result.companion_note_markdown).not.toContain("[[");
});

test("initial responses suppress wiki and local Markdown links even when model ignores instruction", async () => {
  const f = fixture(); f.config.vaultEnabled = true;
  interceptModel(modelResult({ wechat_reply: "观点增量 [[legacy_plan|旧方案]] [文件](plans/legacy_plan.md) /fictional-vault/plans/legacy_plan.md",
    companion_note_markdown: "## 观点碰撞\n[[invented]] [资料](file:///tmp/plan.md)" }));
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: { ...emptyVault, matchedNotes: [matched] } });
  for (const body of [result.wechat_reply, result.companion_note_markdown]) {
    expect(body).not.toContain("[["); expect(body).not.toContain("legacy_plan"); expect(body).not.toContain("file://");
  }
  expect(result.wechat_reply).toContain("观点增量");
});

test("disabled vault excludes retrieved snippets and candidates; no profile means no invented company", async () => {
  const f = fixture();
  const requests = interceptModel();
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: { ...emptyVault, matchedNotes: [matched] } });
  expect(requests[0].messages[1].content).not.toContain(matched.excerpt);
  expect(requests[0].messages[1].content).toContain("未配置观点与业务背景");
  expect(result.related_vault_nodes).toEqual([]);
});

test("profile errors remain user-visible even when model omits them", async () => {
  const f = fixture(); f.config.analysisContextFile = f.path;
  interceptModel();
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
  expect(result.wechat_reply).toContain("背景材料未完整采用");
  expect(result.companion_note_markdown).toContain("背景材料未完整采用");
});

test("no-key and model failure fallbacks explicitly defer collision and never expose candidate links", async () => {
  const f = fixture([entry()]); f.config.vaultEnabled = true;
  for (const key of ["", "fixture"]) {
    f.config.llm.apiKey = key;
    globalThis.fetch = (async () => { throw new Error("fixture failure"); }) as unknown as typeof fetch;
    const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "关注规则验证", vaultContext: { ...emptyVault, matchedNotes: [matched] } });
    expect(result.wechat_reply).toContain("未完成模型分析");
    expect(result.wechat_reply).toContain("观点碰撞");
    expect(result.wechat_reply).toContain("业务与规划启发");
    expect(result.wechat_reply).not.toContain("legacy_plan");
    expect(result.companion_note_markdown).not.toContain("[[");
    expect(result.related_vault_nodes).toEqual([matched.wikiLink]);
  }
});

test("incomplete model JSON is an explicit fallback, not a claimed completed analysis", async () => {
  const f = fixture();
  interceptModel(modelResult({ companion_note_markdown: "" }));
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
  expect(result.wechat_reply).toContain("未完成模型分析");
});

test("deep reading receives current background and treats note links as unverified candidates", async () => {
  const f = fixture([entry()]); f.config.vaultEnabled = true;
  f.config.llm.allowCodexFallback = true;
  f.config.vaultRoot = f.root;
  mkdirSync(f.config.dataDir, { recursive: true });
  mkdirSync(join(f.root, "04_topics"));
  writeFileSync(join(f.root, "04_topics", "business_rules.md"), "# 业务建模\n场景驱动的业务建模应验证权限规则。");
  const db = new ContextDatabase(f.config.dbPath);
  try {
    const source = join(f.root, "source.md"), note = join(f.root, "source_note.md");
    writeFileSync(source, article.markdownBody); writeFileSync(note, "## 已有初筛\n待核验。");
    const row = db.enqueueArticle({ msgid: "deep-fixture", url: article.url, channel: "clawbot", sender_id: "fixture-user" }).record;
    db.updateArticle(row.id, { title: article.title, source_md_path: source, note_md_path: note,
      user_notes: "请关注业务规则的边界", status: "light_done" });
    const calls: SubagentRunRequest[] = [];
    setSubagentTestRunner(async req => {
      calls.push(req);
      return { backend: req.backend, modelUsed: "fixture-cli", outputText: "候选关系待全文核验。", generatedFiles: [], generatedImages: [] };
    });
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({
      intent: "article_followup", complexity: "deep", targetArticleId: row.id,
      slots: { articleSubAction: "deepen" }, reason: "explicit deep reading",
    }) } }] })) as unknown as typeof fetch;
    const pipeline = new WeChatContextPipeline(f.config, db);
    const result = await pipeline.agent.processClawBotMessage({ messageKey: "deep-request", senderId: "fixture-user",
      rawMessage: { message_id: "deep-request", from_user_id: "fixture-user", message_type: 1,
        item_list: [{ type: 1, text_item: { text: `深度拆解第 #${row.id} 篇文章，核验观点关系` } }] } });
    expect(calls.length).toBeGreaterThan(0);
    const prompt = calls[0].prompt;
    for (const value of ["材料预审", "2026-10-23", "请关注业务规则的边界", "[[business_rules]]", "待全文核验", "不代表已交付"]) expect(prompt).toContain(value);
    for (const value of ["保留频率、范围和条件", "两组逐条核对", "不能推出必须采用规则引擎", "证据不足/试验无效", "固定差值", "百分点", "A = 0"]) expect(prompt).toContain(value);
    expect(prompt).not.toContain("对比现有输入与补充业务规则的输入");
    expect(result.replyText).toContain("待全文核验");
    expect(readFileSync(note, "utf8")).toBe("## 已有初筛\n待核验。");
    expect(db.getArticleById(row.id)?.process_level).not.toBe("deep");
  } finally { db.db.close(); }
});

test("link suppression preserves ordinary concepts even when a note has the same name", async () => {
  const f = fixture(); f.config.vaultEnabled = true;
  interceptModel(modelResult({ wechat_reply: "RAG 提供检索支持，但需要校验依据。[[RAG]]" }));
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "",
    vaultContext: { ...emptyVault, matchedNotes: [{ ...matched, wikiLink: "[[RAG]]", relativePath: "RAG.md", absolutePath: join(f.root, "RAG.md") }] } });
  expect(result.wechat_reply).toContain("RAG 提供检索支持");
  expect(result.wechat_reply).not.toContain("[[RAG]]");
});

test("profile edits are re-read and aggregate limits never silently truncate context", () => {
  const f = fixture([entry()]);
  expect(loadAnalysisContext(f.path).entries[0].status).toBe("planned");
  writeFileSync(f.path, JSON.stringify({ version: 1, entries: [entry({ status: "exploring", updated: "2026-10-24" })] }));
  expect(loadAnalysisContext(f.path).entries[0].status).toBe("exploring");
  for (const entries of [Array.from({ length: 41 }, () => entry()),
    Array.from({ length: 20 }, (_, i) => entry({ topic: `topic-${i}`, summary: "a".repeat(1000) }))]) {
    writeFileSync(f.path, JSON.stringify({ version: 1, entries }));
    const result = loadAnalysisContext(f.path);
    expect(result.entries).toEqual([]); expect(result.warnings.length).toBeGreaterThan(0);
  }
});

test("background provenance is retained as escaped data, not rendered links or markup", async () => {
  const f = fixture([entry({ source: "[[internal_source]] </pre><script>not-instructions</script>" })]);
  interceptModel();
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
  expect(result.companion_note_markdown).toContain("internal_source");
  expect(result.companion_note_markdown).toContain("2026-10-23");
  expect(result.companion_note_markdown).not.toContain("[[internal_source]]");
  expect(result.companion_note_markdown).not.toContain("<script>");
  expect(result.wechat_reply).not.toContain("internal_source");
});

test("new light note records candidates as plain metadata without creating knowledge links", () => {
  const f = fixture();
  const note = saveCompanionLightNote({ sourceMdPath: join(f.root, "source.md"), sourceUrl: article.url,
    title: article.title, author: article.author, triage: "process_later", relatedVaultNodes: [matched.wikiLink],
    noteMarkdownBody: "## 观点碰撞\n应先验证最小任务。" });
  const text = readFileSync(note, "utf8");
  expect(text).toContain("candidate_vault_nodes:");
  expect(text).toContain("legacy_plan");
  expect(text).not.toContain(matched.wikiLink);
  expect(text).toContain("[[source]]"); // The raw article evidence link is intentionally retained.
});

test("pipeline stores and queues complete analysis over 450 chars without touching real send", async () => {
  const f = fixture([entry()]);
  mkdirSync(f.config.dataDir, { recursive: true });
  const db = new ContextDatabase(f.config.dbPath);
  try {
    const source = join(f.root, "source.md"); writeFileSync(source, article.markdownBody);
    const row = db.enqueueArticle({ msgid: "fixture", url: article.url, channel: "clawbot", sender_id: "fixture-user" }).record;
    db.updateArticle(row.id, { source_md_path: source, title: article.title });
    const text = modelResult().wechat_reply + "\n业务判断与证据必须分别呈现。".repeat(85) + "\n最后的验证动作。";
    const requests = interceptModel(modelResult({ wechat_reply: text }));
    const pipeline = new WeChatContextPipeline(f.config, db);
    const result = await pipeline.processArticleById(row.id);
    expect(result.short_summary).toBe(text);
    const reply = db.db.query("SELECT text, status, attempts FROM reply_outbox WHERE id = ?").get(`article_${row.id}_light`) as any;
    expect(reply.text).toBe(text); expect(reply.status).toBe("pending"); expect(reply.attempts).toBe(0);
    expect(requests).toHaveLength(1);
    expect(readFileSync(result.note_md_path, "utf8")).toContain("脱水干货");
  } finally { db.db.close(); }
});

test("self sources, renamed notes and symlink aliases are excluded before the top-six limit", () => {
  const f = fixture(); const dir = join(f.root, "04_topics"); mkdirSync(dir);
  const source = join(dir, "source.md"), note = join(dir, "old_note.md");
  writeFileSync(source, "ontology ".repeat(30));
  writeFileSync(note, "ontology OLD_TRIAGE_REFERENCE ".repeat(30));
  symlinkSync(source, join(dir, "alias.md"));
  writeFileSync(join(dir, "renamed_note.md"), `---\nsource_path: ${JSON.stringify(source)}\n---\nontology OLD_ANALYSIS`.repeat(1));
  writeFileSync(join(dir, "relative_note.md"), "---\nsource_path: source.md\n---\nontology OLD_RELATIVE_ANALYSIS");
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, `independent_${i}.md`), "ontology independent evidence");
  const options = { excludePaths: [source, note] };
  const matches = searchVaultNotes(f.root, ["ontology"], 6, undefined, options);
  expect(matches).toHaveLength(6);
  expect(matches.every(m => m.relativePath.includes("independent_"))).toBe(true);
  const ctx = gatherVaultContext(f.root, "ontology", options);
  expect(ctx.matchedNotes).toEqual(matches);
});

test("source_url identifies tracked WeChat copies without suppressing a different issue or same title", () => {
  const f = fixture(); const dir = join(f.root, "04_topics"); mkdirSync(dir);
  const url = "https://mp.weixin.qq.com/s?__biz=fixture&mid=100&idx=1&sn=abc&scene=1";
  const copy = "https://mp.weixin.qq.com/s?scene=3&idx=1&mid=100&__biz=fixture&sn=abc#section";
  writeFileSync(join(dir, "copy.md"), `---\nsource_url: ${JSON.stringify(copy)}\n---\n# Same title\nontology SELF`);
  writeFileSync(join(dir, "copy_note.md"), `---\nsource_url: '${copy}'\n---\nontology SELF_NOTE`);
  writeFileSync(join(dir, "different.md"), `---\nsource_url: ${JSON.stringify(copy.replace("idx=1", "idx=2"))}\n---\n# Same title\nontology OTHER`);
  writeFileSync(join(dir, "independent.md"), "# Same title\nontology INDEPENDENT");
  const ctx = gatherVaultContext(f.root, "ontology", { excludeSourceUrls: [url] });
  expect(ctx.matchedNotes.map(m => m.relativePath).sort()).toEqual(["04_topics/different.md", "04_topics/independent.md"]);
  expect(gatherVaultContext(f.root, "ontology").matchedNotes).toHaveLength(4);
});

test("configured focus aliases cannot reintroduce self analysis through non-search context", () => {
  const f = fixture(); const source = join(f.root, "source.md");
  writeFileSync(source, "SELF_ANALYSIS ontology");
  const ctx = gatherVaultContext(f.root, "ontology", { nowFile: source, queueFile: source, topicsFile: source, excludePaths: [source] });
  expect(ctx.nowSummary).toBe(""); expect(ctx.queueSummary).toBe(""); expect(ctx.topicsOverview).toBe("");
  expect(ctx.matchedNotes).toEqual([]);
});

test("external URL identity retains meaningful query differences and ignores fragments", () => {
  const f = fixture();
  writeFileSync(join(f.root, "self.md"), '---\nsource_url: "https://example.test/post?b=2&a=1#section"\n---\nontology SELF');
  writeFileSync(join(f.root, "other.md"), '---\nsource_url: "https://example.test/post?a=1&b=3"\n---\nontology OTHER');
  expect(gatherVaultContext(f.root, "ontology", { excludeSourceUrls: ["https://example.test/post?a=1&b=2"] }).matchedNotes.map(m => m.relativePath)).toEqual(["other.md"]);
});

test("pipeline excludes stored article and preexisting same-source analysis from the actual model request", async () => {
  const f = fixture([entry()]); f.config.vaultEnabled = true; f.config.vaultRoot = f.root;
  mkdirSync(f.config.dataDir, { recursive: true });
  const dir = join(f.root, "04_topics"); mkdirSync(dir);
  const source = join(dir, "source.md"), oldNote = join(dir, "renamed_old_note.md");
  writeFileSync(source, article.markdownBody);
  writeFileSync(oldNote, `---\nsource_url: ${JSON.stringify(article.url)}\n---\n${article.title} OLD_ANALYSIS_REFERENCE`);
  writeFileSync(join(dir, "independent.md"), `${article.title} INDEPENDENT_BACKGROUND`);
  const db = new ContextDatabase(f.config.dbPath);
  try {
    const row = db.enqueueArticle({ msgid: "self-case", url: article.url, channel: "cli" }).record;
    db.updateArticle(row.id, { source_md_path: source, title: article.title });
    const requests = interceptModel();
    const result = await new WeChatContextPipeline(f.config, db).processArticleById(row.id, { sendWeChatReply: false });
    const payload = JSON.parse(requests[0].messages[1].content);
    expect(payload.article.body).toContain(article.markdownBody);
    expect(payload.candidate_excerpts.length).toBeGreaterThan(0);
    expect(JSON.stringify(payload.candidate_excerpts)).not.toContain(article.markdownBody);
    expect(JSON.stringify(payload.candidate_excerpts)).not.toContain("OLD_ANALYSIS_REFERENCE");
    expect(JSON.stringify(payload.candidate_excerpts)).toContain("INDEPENDENT_BACKGROUND");
    expect(JSON.parse(result.related_vault_nodes)).toEqual(["[[independent]]"]);
    expect(readFileSync(oldNote, "utf8")).toContain("OLD_ANALYSIS_REFERENCE");
  } finally { db.db.close(); }
});

test("analysis separates background evidence and demands a falsifiable business plan and two-part triage", async () => {
  const f = fixture([entry()]); f.config.vaultEnabled = true;
  const requests = interceptModel();
  await analyzeArticleWithVault({ config: f.config, article, userNotes: "[链接] 文章标题",
    vaultContext: { ...emptyVault, matchedNotes: [{ ...matched, excerpt: "背景讨论 VendorExample 路线，但不构成当前文章的作者立场。" }] } });
  const system = requests[0].messages[0].content, payload = JSON.parse(requests[0].messages[1].content);
  expect(payload.candidate_excerpts[0].evidence_scope).toBe("background_only_not_article_evidence");
  expect(payload.article.evidence_scope).toBe("current_article_author_claims_not_verified_facts");
  expect(payload.article.body).not.toContain("VendorExample");
  for (const text of ["原文未提及", "不是本文作者的立场", "观点相近不等于效果已验证", "强判断", "验证假设", "正常与异常样本", "对照基线", "通过/失败条件", "业务责任人", "建议阈值", "逐段精读", "场景验证", "process_later", "实质未决问题", "紧迫性"]) expect(system).toContain(text);
  expect(system).toContain("仅为链接标题");
  for (const text of ["转述不得加强原文的逻辑强度", "逐字找到", "样本与反例", "对照与唯一改动", "规则确认与独立复核", "相同业务事实及规则", "微信回复与伴读均须直接展示", "默认 process_later"]) expect(system).toContain(text);
  expect(system).not.toContain("当前决策价值或紧迫性");
});

// Request-contract regressions from real previews; not a semantic judge of model output.
test("article review preserves qualifiers and distinguishes missing detail from demonstrated error", async () => {
  const f = fixture(); const requests = interceptModel();
  const source = "问题往往在于缺少业务说明。本文将对象、关系、动作与约束放在同一说明框架中。";
  await analyzeArticleWithVault({ config: f.config, article: { ...article, markdownBody: source }, userNotes: "", vaultContext: emptyVault });
  const system = requests[0].messages[0].content;
  expect(JSON.parse(requests[0].messages[1].content).article.body).toBe(source);
  for (const text of ["保留频率、范围和条件", "往往", "根本原因", "框架合并不等于执行职责混淆", "未展开不等于做错", "分析判断", "统计显著"]) expect(system).toContain(text);
});

test("business experiment distinguishes equal-information representation from information supplementation", async () => {
  const f = fixture([entry()]); const requests = interceptModel();
  await analyzeArticleWithVault({ config: f.config, article, userNotes: "结构化表达有没有增益？", vaultContext: emptyVault });
  const system = requests[0].messages[0].content;
  for (const text of ["先声明被测变量", "表达结构", "信息补充", "同一份经业务方确认的事实与规则清单", "两组逐条核对", "自然语言段落", "结构化字段", "不能归因于结构化表达"]) expect(system).toContain(text);
  expect(system).not.toContain("对比现有输入与补充业务规则的输入");
});

test("experiment outcomes remain scoped and include operational acceptance and inconclusive results", async () => {
  const f = fixture([entry()]); const requests = interceptModel();
  await analyzeArticleWithVault({ config: f.config, article, userNotes: "试验没改善意味着什么？", vaultContext: emptyVault });
  const system = requests[0].messages[0].content;
  for (const text of ["运行前", "明确判据", "仅写“明显改善”不构成验收", "未观察到预期增益", "本次样本、模型、规则与配置", "不能推出必须采用规则引擎", "证据不足", "不宣称普遍有效"]) expect(system).toContain(text);
});

const statisticsSlot = "{{VALIDATION_CONTRACT}}";
function statisticsContract(unit = "percentage_points", value: number | null = 5, direction = "increase") {
  return { metrics: [{ name: "准确率", numerator: "正确判定样本数", denominator: "有效样本总数",
    direction, minimum_gain: { unit, value } }] };
}
function withStatistics(contract: unknown) {
  return modelResult({ validation_contract: contract,
    wechat_reply: `🏢 业务验证\n${statisticsSlot}\n🚦 process_later`,
    companion_note_markdown: `## 业务验证\n${statisticsSlot}\n## 下一步\nprocess_later` });
}

test("one validated statistics contract renders identical definitions and gates in both outputs", async () => {
  const f = fixture(); const requests = interceptModel(withStatistics(statisticsContract()));
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
  const mobile = result.wechat_reply.split("🏢 业务验证\n")[1].split("\n🚦")[0];
  const note = result.companion_note_markdown.split("## 业务验证\n")[1].split("\n## 下一步")[0];
  expect(mobile).toBe(note);
  expect(mobile).toContain("准确率 = 正确判定样本数 / 有效样本总数");
  expect(mobile).toContain("(B - A) × 100");
  expect(mobile).toContain("≥ 5 个百分点");
  expect(mobile).toContain("不是波动范围");
  expect(mobile).toContain("不作统计显著性判断");
  expect(result.wechat_reply).not.toContain(statisticsSlot);
  expect(requests[0].messages[0].content).toContain("validation_contract");
});

test("relative improvement and percentage points have distinct units and zero-baseline handling", async () => {
  const f = fixture(); interceptModel(withStatistics(statisticsContract("relative_percent", 15)));
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
  expect(result.wechat_reply).toContain("(B - A) / A × 100%");
  expect(result.wechat_reply).toContain("相对提升 ≥ 15%");
  expect(result.wechat_reply).not.toContain("≥ 15 个百分点");
  expect(result.wechat_reply).toContain("A = 0 时相对变化不可计算");
  expect(result.wechat_reply).toContain("分母为 0");
});

test("decreasing error rates use the correct sign and unconfirmed gates cannot declare acceptance", async () => {
  const f = fixture(); interceptModel(withStatistics(statisticsContract("percentage_points", null, "decrease")));
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
  expect(result.wechat_reply).toContain("(A - B) × 100");
  expect(result.wechat_reply).toContain("门槛待定");
  expect(result.wechat_reply).toContain("不能判定通过");
  expect(result.wechat_reply).toContain("本次样本、模型、规则与配置");
});

test("missing or malformed statistics and ambiguous slots fail visibly instead of publishing mismatched gates", async () => {
  const f = fixture();
  const cases = [undefined, { metrics: [] }, statisticsContract("percent", 15), statisticsContract("percentage_points", -1),
    statisticsContract("percentage_points", 101),
    { metrics: [{ ...statisticsContract().metrics[0], minimum_gain: { unit: "relative_percent", value: "15" } }] },
    statisticsContract("percentage_points", 5, "sideways"),
    { metrics: [{ ...statisticsContract().metrics[0], numerator: "" }] }];
  const responses = cases.map(withStatistics);
  responses.push(withStatistics(null), { ...withStatistics(statisticsContract()), wechat_reply: "Missing slot" },
    { ...withStatistics(statisticsContract()), companion_note_markdown: `${statisticsSlot}\n${statisticsSlot}` });
  for (const response of responses) {
    interceptModel(response);
    const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
    expect(result.wechat_reply).toContain("未完成模型分析");
    expect(result.wechat_reply).not.toContain(statisticsSlot);
  }
});

test("no-experiment responses stay unchanged and request defines the compact phone format", async () => {
  const f = fixture(); const response = modelResult(); const requests = interceptModel(response);
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
  expect(result.wechat_reply).toBe(response.wechat_reply);
  const prompt = requests[0].messages[0].content;
  for (const text of ["固定差值", "波动范围", "百分点", "相对提升", "A = 0", "置信区间", "450–650", "非刚性", "无需拆成编号子标题", "严禁出现“显著、波动范围、置信区间、百分点、相对提升、相对下降”", "脱水干货", "仅链接标题则省略", "详细样本分层"]) expect(prompt).toContain(text);
  expect(prompt).not.toContain("800–1400");
});

test("business prose cannot reintroduce statistical conclusions beside the shared contract", async () => {
  const f = fixture();
  for (const extra of ["若未达业务门槛则未见显著优势。", "差值小于5%在波动范围内。", "微信提升10个百分点，伴读相对提升15%。"]) {
    const response = withStatistics(statisticsContract());
    response.companion_note_markdown = response.companion_note_markdown.replace("\n## 下一步", `\n${extra}\n## 下一步`);
    interceptModel(response);
    const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
    expect(result.wechat_reply).toContain("未完成模型分析");
    expect(result.companion_note_markdown).not.toContain(extra);
  }
});

test("companion note provenance <pre> block compiles to clean HTML code block without double-escaping entities", async () => {
  const f = fixture([entry({ source: "[[internal_source]] </pre><script>not-instructions</script>" })]);
  interceptModel();
  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
  const html = compileMarkdownToHtml(result.companion_note_markdown, article.title);
  expect(html).toContain('<div class="code-block"><pre><code>[');
  expect(html).not.toContain("&amp;#91;");
  expect(html).not.toContain("&lt;pre&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;not-instructions&lt;/script&gt;");
});

test("analyzer honors resolved fastProvider model and retries without response_format on HTTP 400", async () => {
  const f = fixture([entry()]);
  f.config.llm.apiKey = "";
  f.config.llm.model = "default-other-model";
  f.config.llm.fastModel = undefined;
  f.config.llm.fastProvider = "deepseek";
  f.config.llm.providers = [
    {
      id: "deepseek",
      name: "DeepSeek",
      envKeyName: "DEEPSEEK_API_KEY",
      apiKey: "ds-secret",
      baseUrl: "https://deepseek.example.test/v1",
      models: ["deepseek-chat"],
    },
  ];

  const seenBodies: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    seenBodies.push(body);
    if (body.response_format) {
      return new Response("response_format json_object not supported", { status: 400 });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(modelResult()) } }] });
  }) as typeof fetch;

  const result = await analyzeArticleWithVault({ config: f.config, article, userNotes: "", vaultContext: emptyVault });
  expect(seenBodies).toHaveLength(2);
  expect(seenBodies[0].model).toBe("deepseek-chat");
  expect(seenBodies[0].response_format).toEqual({ type: "json_object" });
  expect(seenBodies[1].model).toBe("deepseek-chat");
  expect(seenBodies[1].response_format).toBeUndefined();
  expect(result.wechat_reply).not.toContain("未完成模型分析");
});

test("doctor CLI and buildConfigApiPayload report analysisContext entries and warnings", () => {
  const f = fixture([entry()]);
  f.config.projectRoot = f.root;
  writeFileSync(
    join(f.root, ".env"),
    `IGNORE_HOME_DOTENV=true\nVAULT_ROOT=none\nWECHAT_CONTEXT_DATA_DIR=${f.config.dataDir}\nANALYSIS_CONTEXT_FILE=${f.path}\n`
  );
  mkdirSync(f.config.dataDir, { recursive: true });
  const db = new ContextDatabase(f.config.dbPath);
  try {
    const pipeline = new WeChatContextPipeline(f.config, db);
    const payload = buildConfigApiPayload(db, pipeline) as any;
    expect(payload.config.analysisContextFile).toBe(f.path);
    expect(payload.config.analysisContext.entries).toHaveLength(1);

    const proc = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../src/cli.ts"), "doctor", "--json"],
      {
        env: {
          PATH: process.env.PATH,
          IGNORE_HOME_DOTENV: "true",
          VAULT_ROOT: "none",
          WECHAT_CONTEXT_DATA_DIR: f.config.dataDir,
          ANALYSIS_CONTEXT_FILE: f.path,
        },
      }
    );
    expect(proc.exitCode).toBe(0);
    const report = JSON.parse(proc.stdout.toString());
    expect(report.analysisContextFile).toBe(f.path);
    expect(report.analysisContext.entries).toHaveLength(1);
    expect(report.checks.analysisContext).toContain("ok (1 active entries)");
  } finally {
    db.db.close();
  }
});
