import "./support/isolation.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { loadAnalysisContext } from "../src/vault/analysis_context.ts";
import { analyzeArticleWithVault } from "../src/vault/analyzer.ts";
import { saveCompanionLightNote } from "../src/vault/context.ts";
import { ContextDatabase } from "../src/db.ts";
import { WeChatContextPipeline } from "../src/pipeline.ts";
import { setSubagentTestRunner, type SubagentRunRequest } from "../src/agent/subagent_cli.ts";

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
    wechat_reply: "💧 核心提纯：验证业务规则。\n💡 观点碰撞：这是补充判断。\n🏢 业务与规划启发：关联不足时不强行套用。\n🔍 边界与待验证：作者未提供对照实验。\n🚦 分诊与下一步：验证关键前提。",
    companion_note_markdown: "## 核心提纯\n作者主张从场景验证。", ...overrides };
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
  for (const text of ["800", "1400", "批注回应", "核心提纯", "观点碰撞", "业务与规划启发", "边界与待验证", "分诊", "补充", "挑战", "最新", "规划", "不代表已交付", "不强行", "不是指令", "篇幅"]) expect(system).toContain(text);
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
    expect(readFileSync(result.note_md_path, "utf8")).toContain("核心提纯");
  } finally { db.db.close(); }
});
