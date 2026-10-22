import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextDatabase } from "../src/db.ts";
import { WeChatContextPipeline } from "../src/pipeline.ts";
import { createIdeaSeedInVault, saveCompanionLightNote } from "../src/vault/context.ts";
import { saveRawArticleToVault } from "../src/extractor/wechat.ts";
import { analyzeArticleWithVault } from "../src/vault/analyzer.ts";
import { LOCAL_HOST, createHttpHandler } from "../src/http.ts";
import type { AppConfig } from "../src/config.ts";

const originalFetch = globalThis.fetch;
const databases: ContextDatabase[] = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const db of databases.splice(0)) db.db.close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wx-context-regression-"));
  const config: AppConfig = { projectRoot: root, dataDir: root, dbPath: join(root, "wechat_context.db"), vaultRoot: root, wechatArticlesDir: join(root, "articles"), ideasSeedsDir: join(root, "ideas"), port: 0, annotationWaitSeconds: 0, llm: { apiKey: "", baseUrl: "https://example.invalid", model: "fixture", allowCodexFallback: false } };
  const db = new ContextDatabase(config.dbPath); databases.push(db);
  const pipeline = new WeChatContextPipeline(config, db);
  pipeline.clawbot.saveCredentials({ botToken: "fixture", baseUrl: "https://example.invalid", botId: "fixture", userId: "user", savedAt: "fixture" });
  return { root, config, db, pipeline };
}
function article(title: string, url: string) { return { title, url, author: "fixture", publishDate: "2026-10-21", digest: "", markdownBody: `BODY ${title}`, imageUrls: [], extractorUsed: "native_http" as const }; }
const vaultContext = { nowSummary: "", queueSummary: "", topicsOverview: "", matchedNotes: [] };
function mockJson(data: any, status = 200) { globalThis.fetch = (async () => Response.json(data, { status })) as any; }
function batch(text: string, id = "1") { return { get_updates_buf: `cursor_${id}`, msgs: [{ message_id: id, from_user_id: "user", message_type: 1, item_list: [{ type: 1, text_item: { text } }] }] }; }
function existingDeep(f: ReturnType<typeof fixture>) {
  mkdirSync(f.config.wechatArticlesDir, { recursive: true });
  const source = join(f.config.wechatArticlesDir, "legacy_source.md");
  const note = join(f.config.wechatArticlesDir, "legacy_source_note.md");
  writeFileSync(source, '---\nprocess_level: deep\ntriage: process_now\n---\nORIGINAL EVIDENCE\n');
  writeFileSync(note, '---\nprocess_level: deep\ntriage: process_now\n---\nHUMAN DEEP NOTE\n');
  const row = f.db.enqueueArticle({ msgid: "original", url: "https://mp.weixin.qq.com/s/original", sender_id: "user", channel: "clawbot" }).record;
  f.db.updateArticle(row.id, { source_md_path: source, note_md_path: note, process_level: "deep", status: "deep_done" });
  return { source, note, id: row.id };
}

test("same-date Chinese fallback articles cannot overwrite each other", async () => {
  const f = fixture();
  const a = article("知识工程随想", "https://mp.weixin.qq.com/s/a"); const b = article("组织管理经验", "https://mp.weixin.qq.com/s/b");
  const aa = await analyzeArticleWithVault({ config: f.config, article: a, userNotes: "", vaultContext });
  const bb = await analyzeArticleWithVault({ config: f.config, article: b, userNotes: "", vaultContext });
  expect(aa.english_slug).toBe(bb.english_slug);
  const pa = await saveRawArticleToVault({ wechatArticlesDir: f.root, article: a, slug: aa.english_slug });
  const pb = await saveRawArticleToVault({ wechatArticlesDir: f.root, article: b, slug: bb.english_slug });
  expect(pa).not.toBe(pb); expect(readFileSync(pa, "utf8")).toContain(a.markdownBody); expect(readFileSync(pb, "utf8")).toContain(b.markdownBody);
  const before = readFileSync(pa); await saveRawArticleToVault({ wechatArticlesDir: f.root, article: { ...a, markdownBody: "replacement" }, slug: aa.english_slug }); expect(readFileSync(pa)).toEqual(before);
});

test("multiple ideas from one article remain separate, replay capture is idempotent", () => {
  const f = fixture(); const base = { ideasSeedsDir: f.config.ideasSeedsDir, slug: "idea_from_article_1" };
  const a = createIdeaSeedInVault({ ...base, thoughtText: "FIRST" }); const b = createIdeaSeedInVault({ ...base, thoughtText: "SECOND" });
  expect(a).not.toBe(b); expect(readFileSync(a, "utf8")).toContain("FIRST");
  const c = createIdeaSeedInVault({ ...base, thoughtText: "CAPTURE", captureId: "message-1" });
  expect(createIdeaSeedInVault({ ...base, thoughtText: "REPLAY", captureId: "message-1" })).toBe(c);
  expect(readFileSync(c, "utf8")).toContain("CAPTURE"); expect(readFileSync(c, "utf8")).not.toContain("REPLAY");
});

test("light writer preserves all existing note and source bytes, including human edits", () => {
  const f = fixture(); const { source, note } = existingDeep(f); const src = readFileSync(source); const body = readFileSync(note);
  saveCompanionLightNote({ sourceMdPath: source, sourceUrl: "https://mp.weixin.qq.com/s/original", title: "fixture", author: "fixture", triage: "reference", relatedVaultNodes: [], noteMarkdownBody: "REPLACEMENT" });
  expect(readFileSync(source)).toEqual(src); expect(readFileSync(note)).toEqual(body);
});

test("repeat ingest and new batch annotations preserve legacy paths, deep status and bytes", async () => {
  const f = fixture(); const { source, note, id } = existingDeep(f); const src = readFileSync(source); const body = readFileSync(note);
  globalThis.fetch = (async () => { throw new Error("No network for existing article"); }) as any;
  expect((await f.pipeline.processArticleById(id)).status).toBe("deep_done");
  mockJson(batch("new annotation")); await f.pipeline.clawbot.getUpdates(); expect(f.pipeline.processPendingMessages()).toBe(1);
  expect(f.db.getArticleById(id)?.user_notes).toContain("new annotation"); expect(f.db.getArticleById(id)?.process_level).toBe("deep");
  expect(readFileSync(source)).toEqual(src); expect(readFileSync(note)).toEqual(body);
});

test("successful first ingestion is reusable without rewriting files or fetching again", async () => {
  const f = fixture(); const row = f.db.enqueueArticle({ msgid: "first", url: "https://mp.weixin.qq.com/s/new", channel: "cli" }).record;
  globalThis.fetch = (async () => new Response(`<meta property="og:title" content="测试文章"><div id="js_content"><p>${"fixture content ".repeat(20)}</p></div>`)) as any;
  const first = await f.pipeline.processArticleById(row.id, { sendWeChatReply: false }); const source = readFileSync(first.source_md_path); const note = readFileSync(first.note_md_path);
  globalThis.fetch = (async () => { throw new Error("unexpected refetch"); }) as any;
  const second = await f.pipeline.processArticleById(row.id); expect(second.source_md_path).toBe(first.source_md_path); expect(second.status).toBe("light_done");
  expect(readFileSync(first.source_md_path)).toEqual(source); expect(readFileSync(first.note_md_path)).toEqual(note);
});

test("entire message batch and cursor commit atomically; duplicate batch is ignored", async () => {
  const f = fixture(); mockJson(batch("想法：first")); await f.pipeline.clawbot.getUpdates();
  expect(f.db.getState("clawbot_updates_buf")).toBe("cursor_1"); expect(f.db.pendingMessages().length).toBe(1);
  await f.pipeline.clawbot.getUpdates(); expect(f.db.pendingMessages().length).toBe(1);
  f.pipeline.processPendingMessages(); await f.pipeline.clawbot.getUpdates(); expect(f.pipeline.processPendingMessages()).toBe(0); expect(readdirSync(f.config.ideasSeedsDir).length).toBe(1);
});

test("invalid message rolls back batch and cursor together", async () => {
  const f = fixture(); const data = batch("想法：first"); (data.msgs as any[]).push({ from_user_id: "user", item_list: [] }); mockJson(data);
  await expect(f.pipeline.clawbot.getUpdates()).rejects.toThrow("stable message_id");
  expect(f.db.getState("clawbot_updates_buf")).toBeNull(); expect(f.db.pendingMessages()).toEqual([]);
});

test("pending messages survive reopen after cursor commit", async () => {
  const f = fixture(); mockJson(batch("想法：durable")); await f.pipeline.clawbot.getUpdates();
  const db2 = new ContextDatabase(f.config.dbPath); databases.push(db2); const restarted = new WeChatContextPipeline(f.config, db2);
  expect(restarted.processPendingMessages()).toBe(1); expect(db2.pendingMessages()).toEqual([]); expect(readdirSync(f.config.ideasSeedsDir).length).toBe(1);
});

test("failure after idea file write rolls back acknowledgement and safely retries", async () => {
  const f = fixture(); mockJson(batch("想法：keep exactly once")); await f.pipeline.clawbot.getUpdates();
  const queue = f.db.queueReply.bind(f.db); f.db.queueReply = () => { throw new Error("injected DB effect failure"); };
  expect(f.pipeline.processPendingMessages()).toBe(0); expect(f.db.pendingMessages().length).toBe(1);
  f.db.queueReply = queue; expect(f.pipeline.processPendingMessages()).toBe(1); expect(readdirSync(f.config.ideasSeedsDir).length).toBe(1);
  expect(f.db.db.query("SELECT * FROM reply_outbox").all().length).toBe(1);
});

test("receive and send reject HTTP and business failures", async () => {
  const f = fixture();
  for (const [data, status] of [[{ error: "denied" }, 401], [{ ret: -1, errcode: 123, errmsg: "denied" }, 200]] as const) {
    mockJson(data, status); await expect(f.pipeline.clawbot.getUpdates()).rejects.toThrow(); await expect(f.pipeline.clawbot.sendTextMessage("user", "test")).rejects.toThrow();
  }
  expect(f.db.getState("clawbot_updates_buf")).toBeNull();
});

test("reply errors are durable, bounded and reuse the same client id", async () => {
  const f = fixture(); f.db.queueReply("stable-client-id", "user", "reply"); const ids: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => { ids.push(JSON.parse(init.body).msg.client_id); return Response.json({ errcode: 1, errmsg: "denied" }); }) as any;
  for (let n = 0; n < 5; n++) await f.pipeline.flushReplies();
  expect(ids).toEqual(["stable-client-id", "stable-client-id", "stable-client-id"]);
  const row: any = f.db.db.query("SELECT * FROM reply_outbox").get(); expect(row.status).toBe("failed"); expect(row.attempts).toBe(3); expect(row.error).toContain("denied");
});

test("successful reply is recorded and never replayed", async () => {
  const f = fixture(); f.db.queueReply("id", "user", "reply"); let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ ret: 0 }); }) as any;
  await f.pipeline.flushReplies(); await f.pipeline.flushReplies(); expect(calls).toBe(1); expect((f.db.db.query("SELECT status FROM reply_outbox").get() as any).status).toBe("sent");
});

test("a crash on the last attempt leaves visible uncertain delivery, not endless pending", async () => {
  const f = fixture(); f.db.queueReply("id", "user", "reply"); f.db.db.query("UPDATE reply_outbox SET attempts = 3").run();
  globalThis.fetch = (async () => { throw new Error("must not send"); }) as any; await f.pipeline.flushReplies();
  expect((f.db.db.query("SELECT status FROM reply_outbox").get() as any).status).toBe("failed");
});

test("two database connections cannot process the same operation concurrently", async () => {
  const f = fixture(); const db2 = new ContextDatabase(f.config.dbPath); databases.push(db2);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = f.db.withLock("sync", () => waiting);
  await expect(db2.withLock("sync", async () => {})).rejects.toThrow("busy"); release(); await first;
  await db2.withLock("sync", async () => {});
});

test("explicit triage changes only frontmatter, never source or note body", () => {
  const f = fixture(); const { source, note, id } = existingDeep(f); const sourceBody = readFileSync(source, "utf8").split("---\n").slice(2).join("---\n"); const noteBody = readFileSync(note, "utf8").split("---\n").slice(2).join("---\n");
  f.pipeline.markArticleTriage(id, "reference", "deep");
  expect(readFileSync(source, "utf8").split("---\n").slice(2).join("---\n")).toBe(sourceBody); expect(readFileSync(note, "utf8").split("---\n").slice(2).join("---\n")).toBe(noteBody);
});

test("local HTTP rejects cross-origin, rebound hosts and non-WeChat URLs before enqueue", async () => {
  const f = fixture(); const handler = createHttpHandler(f.db, f.pipeline);
  const request = (url: string, origin?: string, host = "127.0.0.1") => new Request(`http://${host}:8787/api/ingest`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ url }) });
  expect((await handler(request("https://mp.weixin.qq.com/s/ok", "https://evil.invalid"))).status).toBe(403);
  expect((await handler(request("https://mp.weixin.qq.com/s/ok", undefined, "evil.invalid"))).status).toBe(403);
  expect((await handler(request("http://127.0.0.1/private"))).status).toBe(400);
  expect(f.db.listArticles().length).toBe(0);
  const server = Bun.serve({ hostname: LOCAL_HOST, port: 0, fetch: handler }); try { expect(server.hostname).toBe("127.0.0.1"); } finally { server.stop(true); }
});

test("health reports configuration separately from verified connection", async () => {
  const f = fixture(); const response = await createHttpHandler(f.db, f.pipeline)(new Request("http://127.0.0.1:8787/health")); const body = await response.json() as any;
  expect(body.credentialsConfigured).toBe(true); expect(body.connectionVerified).toBe(false);
});

test("local list/show/doctor CLI uses fixture data and never alters documents", () => {
  const f = fixture(); const { source, note, id } = existingDeep(f); const sourceBytes = readFileSync(source); const noteBytes = readFileSync(note);
  for (const args of [["list", "--json"], ["show", String(id), "--json"], ["doctor", "--json"]]) {
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], { env: { ...process.env, WECHAT_CONTEXT_DATA_DIR: f.root, VAULT_ROOT: f.root, LLM_API_KEY: "fixture", LLM_BASE_URL: "https://example.invalid" } });
    expect(proc.exitCode).toBe(0); const data = JSON.parse(proc.stdout.toString()); expect(data.ok).toBe(true);
    if (args[0] === "doctor") { expect(data.scope).toBe("local_configuration_only"); expect(data.checks.clawbot).toContain("connection not verified"); }
  }
  expect(readFileSync(source)).toEqual(sourceBytes); expect(readFileSync(note)).toEqual(noteBytes);
});

test("processing incomplete legacy article reuses original evidence instead of refetching", async () => {
  const f = fixture(); mkdirSync(f.config.wechatArticlesDir, { recursive: true });
  const source = join(f.config.wechatArticlesDir, "original.md"); writeFileSync(source, '---\nprocess_level: raw\ntriage: process_later\n---\nORIGINAL SOURCE TEXT THAT MUST BE USED IN THE ANALYSIS.\n'); const before = readFileSync(source);
  const row = f.db.enqueueArticle({ msgid: "raw", url: "https://mp.weixin.qq.com/s/raw", title: "Raw" }).record; f.db.updateArticle(row.id, { source_md_path: source, status: "extracting" });
  globalThis.fetch = (async () => { throw new Error("must not refetch existing source"); }) as any;
  const updated = await f.pipeline.processArticleById(row.id, { sendWeChatReply: false });
  expect(updated.status).toBe("light_done"); expect(updated.source_md_path).toBe(source); expect(readFileSync(source)).toEqual(before); expect(readFileSync(updated.note_md_path, "utf8")).toContain("ORIGINAL SOURCE TEXT");
});

test("recovery after note write preserves note and repairs interrupted status", async () => {
  const f = fixture(); const { source, note, id } = existingDeep(f); f.db.updateArticle(id, { status: "analyzing", process_level: "light" }); const before = readFileSync(note);
  const updated = await f.pipeline.processArticleById(id); expect(updated.process_level).toBe("deep"); expect(updated.status).toBe("deep_done"); expect(readFileSync(note)).toEqual(before); expect(f.db.db.query("SELECT * FROM reply_outbox").all().length).toBe(1);
});
