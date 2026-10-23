import "./support/isolation.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { ContextDatabase } from "../src/db.ts";
import { WeChatContextPipeline } from "../src/pipeline.ts";
import { ensureMultiFormatDeliverables } from "../src/agent/doc_exporter.ts";
import { findSiblingMultiFormatFiles } from "../src/vault/context.ts";
import { TaskProgressReporter } from "../src/agent/progress.ts";

const databases: ContextDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.db.close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wx-followup-"));
  const config: AppConfig = { projectRoot: root, dataDir: root, dbPath: join(root, "test.db"),
    vaultRoot: root, vaultMode: "standalone", vaultEnabled: false,
    wechatArticlesDir: join(root,"articles"), ideasSeedsDir: join(root,"ideas"),
    port: 0, annotationWaitSeconds: 0, taskHeartbeatSeconds: 0,
    llm: { apiKey: "", baseUrl: "https://invalid.example", model: "mock", allowCodexFallback: false } };
  const db = new ContextDatabase(config.dbPath); databases.push(db);
  const pipeline = new WeChatContextPipeline(config, db);
  const send = (paths: string[], formats: string[], target = "recent_generated") => (pipeline.agent as any).handleSendFile({
    senderId: "fixture", unpacked: { userText: "请发送文件" },
    decision: { slots: { fileTarget: target, requestedFormats: formats } },
    recentTurns: [{ deposited_path: paths.join(", ") }],
    recentArticle: { id: 1, title: "fixture", note_md_path: paths[0] },
  });
  return { root, config, db, pipeline, send };
}
function childProbe(file: string, mode = "") {
  const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", file), mode], {
    env: { PATH: process.env.PATH, IGNORE_HOME_DOTENV: "true" },
  });
  expect(proc.exitCode).toBe(0);
  return JSON.parse(proc.stdout.toString());
}
for (const mode of ["failed", "unclaimed"]) {
  test(`AGY ${mode} cannot claim another task's image`, () => {
    const result = childProbe("agy-process-probe.ts", mode);
    expect(result.ok).toBe(false);
  });
}
test("AGY accepts its unique expected image without scanning shared folders", () => {
  const result = childProbe("agy-process-probe.ts", "expected");
  expect(result.ok).toBe(true);
  expect(result.result.generatedImages).toHaveLength(1);
  expect(basename(result.result.generatedImages[0])).toMatch(/^agy_img_/);
});
test("Codex CLI generates expected image via built-in image_gen and supports AGY -> Codex image fallback", () => {
  const directCodex = childProbe("agy-process-probe.ts", "codex_expected");
  expect(directCodex.ok).toBe(true);
  expect(directCodex.result.backend).toBe("codex");
  expect(directCodex.result.generatedImages).toHaveLength(1);
  expect(basename(directCodex.result.generatedImages[0])).toMatch(/^codex_img_/);

  const fallbackCodex = childProbe("agy-process-probe.ts", "agy_to_codex_fallback");
  expect(fallbackCodex.ok).toBe(true);
  expect(fallbackCodex.callsCount).toBe(2);
  expect(fallbackCodex.result.backend).toBe("codex");
  expect(fallbackCodex.result.modelUsed).toContain("fallback from agy");
  expect(basename(fallbackCodex.result.generatedImages[0])).toMatch(/^codex_img_/);
});
test("unknown AGY model retry reports default model instead of claiming the rejected model", () => {
  const result = childProbe("agy-process-probe.ts", "retry");
  expect(result.retriedWithoutModel).toBe(true);
  expect(result.result.modelUsed).toContain("default");
  expect(result.result.modelUsed).not.toBe("agy (unsupported-model-fixture)");
});

for (const target of ["recent_generated", "latest_note"]) {
  test(`${target} sends current source and completes partially requested formats`, async () => {
    const f = fixture(), path = join(f.root, "guide.md");
    writeFileSync(path, "# Guide\nOLD_BODY");
    const [old] = await ensureMultiFormatDeliverables({ markdownPath: path, outputDir: f.root, baseFileStem: "guide", requestedFormats: ["html"] });
    writeFileSync(path, "# Guide\nNEW_BODY");
    const result = await f.send([path], ["md", "html"], target);
    expect(result.mediaDeliveries).toHaveLength(2);
    const html = result.mediaDeliveries.find((x: any) => x.mediaPath.endsWith(".html")).mediaPath;
    expect(html).not.toBe(old);
    expect(readFileSync(html, "utf8")).toContain("NEW_BODY");
    expect(readFileSync(old, "utf8")).toContain("OLD_BODY");
    expect(result.missingFormats).toEqual([]);
  });
}
test("sibling lookup never mixes revisions, while explicit historical HTML keeps its own PDF", async () => {
  const f = fixture(), path = join(f.root, "guide.md");
  writeFileSync(path, "# Old");
  const [oldHtml] = await ensureMultiFormatDeliverables({ markdownPath: path, outputDir: f.root, baseFileStem: "guide", requestedFormats: ["html"] });
  const oldPdf = oldHtml.replace(/\.html$/, ".pdf"); writeFileSync(oldPdf, "%PDF-1.7\n" + "fixture".repeat(100) + "\n%%EOF\n");
  writeFileSync(path, "# New");
  const [newHtml] = await ensureMultiFormatDeliverables({ markdownPath: path, outputDir: f.root, baseFileStem: "guide", requestedFormats: ["html"] });
  expect(findSiblingMultiFormatFiles(path, ["html", "pdf"])).toEqual([newHtml]);
  expect(findSiblingMultiFormatFiles(oldHtml, ["html", "pdf"])).toEqual([oldHtml, oldPdf]);
  const sent = await f.send([oldHtml], ["html", "pdf"]);
  expect(sent.mediaDeliveries.map((d: any) => d.mediaPath)).toEqual([oldHtml, oldPdf]);
});
test("changed embedded image invalidates exports even when Markdown bytes do not change", async () => {
  const f = fixture(), md = join(f.root, "image.md"), img = join(f.root, "image.png");
  writeFileSync(md, "![image](image.png)"); writeFileSync(img, "IMAGE_ONE");
  const [old] = await ensureMultiFormatDeliverables({ markdownPath: md, outputDir: f.root, baseFileStem: "image", requestedFormats: ["html"] });
  writeFileSync(img, "IMAGE_TWO");
  const sent = await f.send([md], ["html"]);
  const html = sent.mediaDeliveries[0].mediaPath;
  expect(html).not.toBe(old);
  expect(readFileSync(html, "utf8")).toContain(Buffer.from("IMAGE_TWO").toString("base64"));
});
test("custom title exports retain verifiable source identity and never mix revisions", async () => {
  const f = fixture(), md = join(f.root, "guide.md");
  writeFileSync(md, "# Current");
  const [html] = await ensureMultiFormatDeliverables({markdownPath:md,outputDir:f.root,baseFileStem:"guide",title:"Custom display title",requestedFormats:["html"]});
  expect(findSiblingMultiFormatFiles(md,["html"])).toEqual([html]);
  expect(findSiblingMultiFormatFiles(html,["md"])).toEqual([md]);
  writeFileSync(md,"# Changed");
  expect(findSiblingMultiFormatFiles(md,["html"])).toEqual([]);
  expect(findSiblingMultiFormatFiles(html,["md"])).toEqual([]);
});
test("resending a recorded MD and HTML pair without formats uses the current source", async () => {
  const f = fixture(), md = join(f.root,"guide.md");
  writeFileSync(md,"# OLD_BODY");
  const [old] = await ensureMultiFormatDeliverables({markdownPath:md,outputDir:f.root,baseFileStem:"guide",requestedFormats:["html"]});
  writeFileSync(md,"# NEW_BODY");
  const result = await f.send([md,old],[]);
  expect(result.mediaDeliveries).toHaveLength(2);
  const html = result.mediaDeliveries.find((d:any)=>d.mediaPath.endsWith(".html")).mediaPath;
  expect(html).not.toBe(old);
  expect(readFileSync(html,"utf8")).toContain("NEW_BODY");
});
test("a source document named _sources remains its own source", async () => {
  const f = fixture(), md = join(f.root,"guide_sources.md");
  writeFileSync(md,"# Sources"); writeFileSync(join(f.root,"guide.md"),"# Different document");
  const [html] = await ensureMultiFormatDeliverables({markdownPath:md,outputDir:f.root,baseFileStem:"guide_sources",requestedFormats:["html"]});
  expect(findSiblingMultiFormatFiles(md,["md","html"])).toEqual([md,html]);
});
test("resending independent Markdown documents preserves every document and attachment", async () => {
  const f = fixture(), first = join(f.root,"first.md"), second = join(f.root,"second.md"), image = join(f.root,"photo.png");
  writeFileSync(first,"# FIRST_OLD"); writeFileSync(second,"# SECOND_OLD"); writeFileSync(image,"IMAGE");
  const [firstOld] = await ensureMultiFormatDeliverables({markdownPath:first,outputDir:f.root,baseFileStem:"first",requestedFormats:["html"]});
  const [secondOld] = await ensureMultiFormatDeliverables({markdownPath:second,outputDir:f.root,baseFileStem:"second",requestedFormats:["html"]});
  writeFileSync(first,"# FIRST_NEW"); writeFileSync(second,"# SECOND_NEW");
  const result = await f.send([first,firstOld,second,secondOld,image],[]);
  const files = result.mediaDeliveries.map((d:any)=>d.mediaPath);
  expect(files).toHaveLength(5);
  expect(files).toContain(first); expect(files).toContain(second); expect(files).toContain(image);
  expect(files).not.toContain(firstOld); expect(files).not.toContain(secondOld);
});
test("PDF failure reports the missing format without sending an older PDF", async () => {
  const f = fixture(), path = join(f.root, "guide.md"); writeFileSync(path, "# Current");
  writeFileSync(join(f.root,"guide_export_1111111111111111.pdf"), "%PDF-old");
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ exited: Promise.resolve(1), kill() {} })) as any);
  try {
    const result = await f.send([path], ["md", "html", "pdf"]);
    expect(result.mediaDeliveries.map((x:any) => x.mediaPath.split(".").pop())).toEqual(["md", "html"]);
    expect(result.missingFormats).toEqual(["pdf"]);
    expect(result.replyText).toContain("PDF");
    expect(result.replyText).toContain("未生成");
  } finally { spawn.mockRestore(); }
});
test("unassociated daily outputs are not used as a fallback", async () => {
  const f = fixture(), dir = (f.pipeline.agent as any).getOutputsDir();
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,`${new Date().toISOString().slice(0,10).replace(/-/g,"_")}_guide.md`),"# Unrelated");
  const result = await f.send([], ["pdf"]);
  expect(result.mediaDeliveries ?? []).toEqual([]);
  expect(result.outcome).toBe("failed");
  expect(result.replyText).toContain("未找到");
});

test("pipeline status query honors disabled and custom heartbeat settings", () => {
  const f = fixture(); f.db.enqueueAgentTask("task", "fixture", "{}");
  for (const seconds of [0, 60]) {
    f.config.taskHeartbeatSeconds = seconds;
    f.db.db.query("INSERT INTO inbound_messages(message_key,payload) VALUES (?,?)").run(`query-${seconds}`, JSON.stringify({ from_user_id: "fixture", item_list: [{ type: 1, text_item: { text: "进度" } }] }));
    f.pipeline.processPendingMessages();
    const replies = f.db.db.query("SELECT text FROM reply_outbox").all() as {text:string}[];
    const text = replies[replies.length - 1].text;
    if (seconds === 0) expect(text).not.toContain("每隔");
    else expect(text).toContain("每隔 60 秒");
  }
});
test("explicit heartbeat options override legacy env including zero; stop clears a custom timer", async () => {
  const f = fixture(), previous = process.env.TASK_HEARTBEAT_MS;
  const timers: number[] = [];
  const interval = spyOn(globalThis,"setInterval").mockImplementation(((_fn: any, ms: number) => {timers.push(ms); return 123;}) as any);
  const clear = spyOn(globalThis,"clearInterval").mockImplementation(() => {});
  process.env.TASK_HEARTBEAT_MS="100";
  try {
    for (const seconds of [0,60]) {
      const r = new TaskProgressReporter({db:f.db,messageKey:"task",senderId:"fixture",heartbeatIntervalSeconds:seconds});
      await r.start("fixture"); r.stop();
    }
    expect(timers).toEqual([60_000]);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    interval.mockRestore(); clear.mockRestore();
    if(previous === undefined) delete process.env.TASK_HEARTBEAT_MS; else process.env.TASK_HEARTBEAT_MS=previous;
  }
});
test("startup and reload share project env precedence; explicit injected env remains authoritative", () => {
  const result = childProbe("config-entry-probe.ts");
  expect(result.startup).toEqual(["project-fixture",0]);
  expect(result.reload).toEqual(result.startup);
  expect(result.injected).toEqual(["injected",12]);
});

test("PDF success publishes the same current revision as HTML and preserves the old PDF", () => {
  const result = childProbe("pdf-render-probe.ts");
  expect(result.rendered).toBe(true);
  expect(result.names).toHaveLength(2);
  expect(result.names[0].replace(/\.html$/, "")).toBe(result.names[1].replace(/\.pdf$/, ""));
  expect(result.body).toBe(true);
  expect(result.oldPreserved).toBe(true);
});

test("application config normalizes legacy heartbeat and keeps explicit zero authoritative", () => {
  const f = fixture();
  for (const [seconds, legacy, expected] of [[undefined,"120",0.12],["0","120",0],["60","120",60],["invalid","120",25],["9999999999",undefined,25]] as const) {
    const config = loadConfig({IGNORE_HOME_DOTENV:"true",TASK_HEARTBEAT_SECONDS:seconds,TASK_HEARTBEAT_MS:legacy},f.root);
    expect(config.taskHeartbeatSeconds).toBe(expected);
  }
});
