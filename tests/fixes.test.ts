import "./support/isolation.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSkillsDirectoryHealth, loadConfig, type AppConfig } from "../src/config.ts";
import { ContextDatabase } from "../src/db.ts";
import { WeChatContextPipeline } from "../src/pipeline.ts";
import { splitWeChatTextChunks } from "../src/clawbot/client.ts";
import { downloadAndDecryptCdnMedia } from "../src/clawbot/media.ts";
import { discoverGeneratedArtifacts, isCliBackendInCooldown, runCliSubagent, setSubagentTestRunner, spawnCliWithTimeout } from "../src/agent/subagent_cli.ts";
import { compileMarkdownToHtml, ensureMultiFormatDeliverables } from "../src/agent/doc_exporter.ts";
import {
  clearVaultMarkdownCache,
  extractSearchKeywords,
  findSiblingMultiFormatFiles,
  findVaultFilesByQuery,
  getVaultCacheStats,
  searchVaultNotes,
} from "../src/vault/context.ts";
import { formatLiveTaskStatusReport, TaskProgressReporter } from "../src/agent/progress.ts";
import { callAgentLlm } from "../src/agent/llm.ts";
import { extractGeneralWebArticle, normalizeExternalWebUrl } from "../src/extractor/web.ts";
import { createHttpHandler } from "../src/http.ts";
import { handleSaveConfigRequest } from "../src/web_config.ts";

const originalFetch = globalThis.fetch;
const databases: ContextDatabase[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  setSubagentTestRunner(null);
  for (const db of databases.splice(0)) db.db.close();
});

function fixture(key = "") {
  const root = mkdtempSync(join(tmpdir(), "wx-fixes-"));
  const config: AppConfig = {
    projectRoot: root, dataDir: root, dbPath: join(root, "wechat_context.db"),
    vaultRoot: root, vaultMode: "standalone", vaultEnabled: false,
    wechatArticlesDir: join(root, "articles"), ideasSeedsDir: join(root, "ideas"),
    inboxDir: join(root, "inbox"), papersDir: join(root, "papers"),
    port: 0, annotationWaitSeconds: 0,
    llm: { apiKey: key, baseUrl: "https://model.example.test/v1", model: "fast",
      fastModel: "fast", proModel: "pro", allowCodexFallback: false },
  };
  const db = new ContextDatabase(config.dbPath); databases.push(db);
  return { root, config, db, pipeline: new WeChatContextPipeline(config, db) };
}

test("view commands and a second worker cannot reset or repeat an active Agent task", async () => {
  const f = fixture();
  const article = f.db.enqueueArticle({msgid:"view-fixture",url:"https://mp.weixin.qq.com/s/view",sender_id:"owner"}).record;
  const task = f.db.enqueueAgentTask("message-1", "owner", JSON.stringify({ from_user_id: "owner" }));
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let executions = 0;
  f.pipeline.agent.processClawBotMessage = async () => {
    executions++; started(); await gate;
    return { replyText: "fixture", modelUsed: "mock" };
  };
  globalThis.fetch = (async () => { throw new Error("Unexpected network"); }) as unknown as typeof fetch;
  const running = f.pipeline.drainAgentQueue();
  try {
    await entered;
    const db2 = new ContextDatabase(f.config.dbPath); databases.push(db2);
    const second = new WeChatContextPipeline(f.config, db2);
    second.agent.processClawBotMessage = async () => {
      executions++; return { replyText: "duplicate", modelUsed: "mock" };
    };
    for (const args of [["list", "--json"], ["show", String(article.id), "--json"], ["doctor", "--json"]]) {
      const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
        env: { PATH: process.env.PATH, IGNORE_HOME_DOTENV: "true", WECHAT_CONTEXT_DATA_DIR: f.root, VAULT_ROOT: f.root },
      });
      expect(proc.exitCode).toBe(0);
      if (args[0] === "show") expect(proc.stdout.toString()).toContain(article.url);
    }
    expect((db2.db.query("SELECT status FROM agent_tasks WHERE id = ?").get(task.id) as any).status).toBe("processing");
    expect(await second.drainAgentQueue()).toBe(0);
    expect(executions).toBe(1);
  } finally { release(); await running; }
  expect((f.db.db.query("SELECT status FROM agent_tasks WHERE id = ?").get(task.id) as any).status).toBe("done");
});

test("a worker recovers unfinished tasks after the previous lock owner exits", async () => {
  const f = fixture();
  const task = f.db.enqueueAgentTask("interrupted", "owner", "{}");
  const dbModule = join(import.meta.dir, "../src/db.ts");
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { ContextDatabase } from ${JSON.stringify(dbModule)};
    const db = new ContextDatabase(${JSON.stringify(f.config.dbPath)});
    await db.withLock('agent_queue', async () => {
      db.updateAgentTaskStatus(${task.id}, 'processing');
      process.exit(0);
    });
  `]);
  expect(child.exitCode).toBe(0);
  let calls = 0;
  f.pipeline.agent.processClawBotMessage = async () => {
    calls++; return { replyText: "recovered", modelUsed: "mock" };
  };
  expect(await f.pipeline.drainAgentQueue()).toBe(1);
  expect(calls).toBe(1);
  expect(await f.pipeline.drainAgentQueue()).toBe(0);
});

test("same-named attachments keep distinct content and replay reuses the correct bytes", async () => {
  const f = fixture();
  mkdirSync(f.config.papersDir!, { recursive: true });
  const legacyPath = join(f.config.papersDir!, "report.pdf");
  writeFileSync(legacyPath, "%PDF-legacy");
  const payloads = ["%PDF-content-A", "%PDF-content-B", "%PDF-content-B"];
  globalThis.fetch = (async () => new Response(payloads.shift())) as unknown as typeof fetch;
  const download = () => downloadAndDecryptCdnMedia({
    media: { full_url: "https://media.example.test/report" },
    saveDir: f.config.papersDir!, suggestedFileName: "report.pdf",
  });
  const [a, b] = await Promise.all([download(), download()]);
  const replay = await download();
  expect(a.filePath).not.toBe(b.filePath);
  expect(readFileSync(a.filePath).equals(a.buffer)).toBe(true);
  expect(readFileSync(b.filePath).equals(b.buffer)).toBe(true);
  expect(replay.filePath).toBe(b.filePath);
  expect(readFileSync(legacyPath, "utf8")).toBe("%PDF-legacy");
});

function fileMessage(name: string) {
  return { message_id: name, from_user_id: "owner", message_type: 1,
    item_list: [{ type: 4, file_item: { file_name: name,
      media: { full_url: `https://media.example.test/${name}` } } }] };
}

for (const cliFails of [false, true]) {
  test(`PDF without API-readable content stays archived without invented analysis (CLI fails=${cliFails})`, async () => {
    const f = fixture("synthetic-key");
    let modelCalls = 0;
    globalThis.fetch = (async (input: any) => {
      if (String(input).startsWith("https://media.example.test/")) return new Response("%PDF-1.4\nPDF_EVIDENCE");
      modelCalls++;
      return Response.json({ choices: [{ message: { content: "INVENTED_PDF_ANALYSIS" } }] });
    }) as unknown as typeof fetch;
    if (cliFails) {
      f.config.llm.allowCodexFallback = true;
      setSubagentTestRunner(async () => { throw new Error("offline"); });
    }
    const result = await f.pipeline.agent.processClawBotMessage({
      messageKey: "pdf", senderId: "owner", rawMessage: fileMessage("report.pdf"),
    });
    expect(modelCalls).toBe(0);
    expect(result.replyText).toContain("未解析");
    expect(result.replyText).not.toContain("内容提炼");
    expect(readFileSync(result.depositedPath!, "utf8")).toContain("未解析");
    expect(result.replyText).not.toContain("INVENTED_PDF_ANALYSIS");
  });
}

test("PDF can still be analyzed by a successful local CLI that receives its actual file", async () => {
  const f = fixture(); f.config.llm.allowCodexFallback = true;
  globalThis.fetch = (async () => new Response("%PDF-1.4\nLOCAL_PDF_EVIDENCE")) as unknown as typeof fetch;
  setSubagentTestRunner(async req => {
    expect(readFileSync(req.imagePaths![0], "utf8")).toContain("LOCAL_PDF_EVIDENCE");
    return { backend: req.backend, modelUsed: "fixture-cli", outputText: "CLI_PDF_ANALYSIS", generatedFiles: [], generatedImages: [] };
  });
  const result = await f.pipeline.agent.processClawBotMessage({messageKey:"pdf-cli", senderId:"owner", rawMessage:fileMessage("report.pdf")});
  expect(result.replyText).toContain("CLI_PDF_ANALYSIS");
  expect(result.replyText).not.toContain("未解析");
});

test("mixed PDF and image attachments do not silently analyze only the image", async () => {
  const f = fixture("synthetic-key");
  let apiCalls = 0;
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith("report.pdf")) return new Response("%PDF-1.4\nEVIDENCE");
    if (String(url).endsWith("image.png")) return new Response(new Uint8Array([0x89,0x50,0x4e,0x47,0]));
    apiCalls++; return Response.json({ choices: [{ message: { content: "PARTIAL_AS_COMPLETE" } }] });
  }) as unknown as typeof fetch;
  const msg: any = fileMessage("report.pdf");
  msg.item_list.push({type:2,image_item:{media:{full_url:"https://media.example.test/image.png"}}});
  const result = await f.pipeline.agent.processClawBotMessage({messageKey:"mixed",senderId:"owner",rawMessage:msg});
  expect(apiCalls).toBe(0);
  expect(result.replyText).toContain("未解析");
});

for (const name of ["note.txt", "image.png"]) {
  test(`supported API attachment still supplies evidence: ${name}`, async () => {
    const f = fixture("synthetic-key");
    let apiCalls = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).startsWith("https://media.example.test/")) return name.endsWith(".txt")
        ? new Response("TEXT_EVIDENCE") : new Response(new Uint8Array([0x89,0x50,0x4e,0x47,0]));
      apiCalls++;
      const body = JSON.parse(init.body);
      expect(JSON.stringify(body)).toContain(name.endsWith(".txt") ? "TEXT_EVIDENCE" : "data:image/png;base64,");
      return Response.json({ choices: [{ message: { content: "SUPPORTED_ANALYSIS" } }] });
    }) as unknown as typeof fetch;
    const result = await f.pipeline.agent.processClawBotMessage({messageKey:name,senderId:"owner",rawMessage:fileMessage(name)});
    expect(apiCalls).toBe(1);
    expect(result.replyText).toContain("SUPPORTED_ANALYSIS");
  });
}

test("BYOCLI without an API key routes an explicit Codex request into the Agent queue", async () => {
  const f = fixture(); f.config.llm.allowCodexFallback = true;
  const raw = {from_user_id:"owner",message_type:1,item_list:[{type:1,text_item:{text:"让 codex 帮我整理这些文件"}}]};
  f.db.db.query("INSERT INTO inbound_messages(message_key,payload) VALUES (?,?)").run("cli-only",JSON.stringify(raw));
  f.pipeline.processPendingMessages();
  expect(f.db.getPendingAgentTasks()).toHaveLength(1);
  let calls = 0;
  setSubagentTestRunner(async req => {
    calls++; expect(req.backend).toBe("codex");
    return {backend:req.backend,modelUsed:"mock-cli",outputText:"CLI_DONE",generatedFiles:[],generatedImages:[]};
  });
  expect(await f.pipeline.drainAgentQueue()).toBe(1);
  expect(calls).toBe(1);
});

test("an annotation explicitly targeting an older article never lands on the latest article", async () => {
  const f = fixture();
  const older = f.db.enqueueArticle({msgid:"old",url:"https://mp.weixin.qq.com/s/old",sender_id:"owner"}).record;
  const newer = f.db.enqueueArticle({msgid:"new",url:"https://mp.weixin.qq.com/s/new",sender_id:"owner"}).record;
  const result = await (f.pipeline.agent as any).handleArticleFollowup({
    senderId:"owner", decision:{targetArticleId:older.id,slots:{articleSubAction:"annotate"}},
    unpacked:{userText:"belongs to old"}, referencedArticle:older, recentArticle:newer,
  });
  expect(f.db.getArticleById(older.id)!.user_notes).toBe("belongs to old");
  expect(f.db.getArticleById(newer.id)!.user_notes).toBe("");
  expect(result.replyText).toContain(`#${older.id}`);
});

test("Markdown images render as images and exported local images are embedded", async () => {
  const f = fixture(); mkdirSync(join(f.root,"assets"));
  writeFileSync(join(f.root,"assets","diagram.png"),new Uint8Array([0x89,0x50,0x4e,0x47,0]));
  const md = "# Report\n\n![diagram](assets/diagram.png)";
  expect(compileMarkdownToHtml(md)).toContain('<img');
  const path = join(f.root,"note.md"); writeFileSync(path,md);
  const files = await ensureMultiFormatDeliverables({markdownPath:path,outputDir:f.root,baseFileStem:"note",requestedFormats:["html"]});
  const html = readFileSync(files[0],"utf8");
  expect(html).toContain("data:image/png;base64,");
  expect(html).not.toContain('!<a');
});

test("changed Markdown produces current HTML without overwriting existing human exports", async () => {
  const f = fixture(); const path = join(f.root,"note.md");
  const humanHtml = join(f.root,"note.html"); writeFileSync(humanHtml,"HUMAN_EXPORT");
  writeFileSync(path,"# First\nOLD_TEXT");
  const options = {markdownPath:path,outputDir:f.root,baseFileStem:"note",requestedFormats:["html" as const]};
  const [first] = await ensureMultiFormatDeliverables(options);
  writeFileSync(path,"# Second\nNEW_TEXT");
  const [second] = await ensureMultiFormatDeliverables({...options,existingFiles:[first]});
  expect(readFileSync(second,"utf8")).toContain("NEW_TEXT");
  expect(second).not.toBe(first);
  expect(readFileSync(first,"utf8")).toContain("OLD_TEXT");
  expect(readFileSync(humanHtml,"utf8")).toBe("HUMAN_EXPORT");
  expect((await ensureMultiFormatDeliverables(options))[0]).toBe(second);
});

test("failed PDF regeneration never returns an older PDF for changed source", async () => {
  const f = fixture(); const path = join(f.root, "note.md");
  const stalePdf = join(f.root, "note.pdf");
  writeFileSync(path, "# Updated report\nNEW_TEXT");
  writeFileSync(stalePdf, "%PDF-OLD_CONTENT");
  // No browser is launched, even on machines that have Chrome installed.
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
    exited: Promise.resolve(1), kill() {},
  })) as any);
  try {
    const files = await ensureMultiFormatDeliverables({
      markdownPath: path, outputDir: f.root, baseFileStem: "note",
      existingFiles: [stalePdf], requestedFormats: ["pdf"],
    });
    expect(files).toEqual([]);
    expect(readFileSync(stalePdf, "utf8")).toBe("%PDF-OLD_CONTENT");
  } finally { spawn.mockRestore(); }
});

test("artifact discovery requires an explicit path inside an allowed root and rejects symlink escapes", () => {
  const f = fixture(); const generated = join(f.root,"generated"); mkdirSync(generated);
  const unrelated = join(generated,"unrelated.md"), declared = join(generated,"declared.md"), outside = join(f.root,"outside.md");
  for (const p of [unrelated,declared,outside]) writeFileSync(p,"artifact");
  const escaped = join(generated,"escape.md"); symlinkSync(outside,escaped);
  const found = discoverGeneratedArtifacts(generated,`${declared}\n${outside}\n${escaped}`,Date.now()-1000);
  expect(found.files).toEqual([declared]);
});

test("Gemini grounded requests retain images instead of silently dropping evidence", async () => {
  const f = fixture("synthetic-key"); f.config.llm.baseUrl="https://generativelanguage.googleapis.com/v1beta/openai";
  globalThis.fetch = (async (_url: any,init?: any) => {
    const parts = JSON.parse(init.body).contents[0].parts;
    expect(parts).toContainEqual({inlineData:{mimeType:"image/png",data:"IMAGE_EVIDENCE"}});
    return Response.json({candidates:[{content:{parts:[{text:"with image"}]}}]});
  }) as unknown as typeof fetch;
  await callAgentLlm({config:f.config,tier:"fast",systemPrompt:"system",userPrompt:"question",enableWebSearch:true,images:[{mimeType:"image/png",base64Data:"IMAGE_EVIDENCE"}]});
});

test("external URL validation rejects private IPv4/IPv6 literals and redirects before a second fetch", async () => {
  for (const host of ["127.0.0.2","172.16.0.1","169.254.169.254","[::1]","[::ffff:127.0.0.1]","[fc00::1]","192.168.1.1"]) {
    expect(() => normalizeExternalWebUrl(`http://${host}/secret`)).toThrow();
  }
  expect(normalizeExternalWebUrl("https://example.test/article")).toBe("https://example.test/article");
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    calls.push(String(input));
    return new Response(null,{status:302,headers:{location:"http://127.0.0.2/secret"}});
  }) as unknown as typeof fetch;
  await expect(extractGeneralWebArticle("https://example.test/article")).rejects.toThrow();
  expect(calls).toEqual(["https://example.test/article"]);
});

test("Jina fallback is opt-in and reports its actual extraction source", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url=String(input);calls.push(url);
    return url.startsWith("https://r.jina.ai/")
      ? new Response(`Title: Example\nMarkdown Content:\n${"article body ".repeat(30)}`)
      : new Response("too short");
  }) as unknown as typeof fetch;
  const url="https://example.test/article?token=synthetic";
  await expect(extractGeneralWebArticle(url)).rejects.toThrow();
  expect(calls).toEqual([url]);
  calls.length=0;
  const result=await extractGeneralWebArticle(url,"","","",{allowJinaFallback:true});
  expect(result.extractorUsed).toBe("jina_reader");
  expect(calls).toEqual([url,`https://r.jina.ai/${url}`]);
});

test("obsolete HTTP fields are rejected before enqueue and current push fields are honored", async () => {
  const f=fixture(); const handler=createHttpHandler(f.db,f.pipeline);
  const post=(route:string,body:any)=>handler(new Request(`http://127.0.0.1:8787${route}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));
  expect((await post("/api/push",{text:"report",docPath:"/tmp/test.md",exportFormats:["html"]})).status).toBe(400);
  expect((await post("/api/ingest",{url:"https://mp.weixin.qq.com/s/test",annotation:"note"})).status).toBe(400);
  expect(f.db.listArticles()).toHaveLength(0);
  expect(f.db.db.query("SELECT * FROM reply_outbox").all()).toHaveLength(0);
  let received:any;
  f.pipeline.pushToWeChat=async (options:any)=>{received=options;return {ok:true} as any;};
  expect((await post("/api/push",{files:["/tmp/test.md"],formats:["md","html"]})).status).toBe(200);
  expect(received.files).toEqual(["/tmp/test.md"]);
  expect(received.formats).toEqual(["md","html"]);
  for (const [method,path] of [["POST","/api/sync"],["GET","/api/articles"],["GET","/api/ideas"]]) {
    expect((await handler(new Request(`http://127.0.0.1:8787${path}`,{method}))).status).toBe(404);
    expect(readFileSync(join(import.meta.dir,"../README.md"),"utf8")).not.toContain(`| \`${method} ${path}\` |`);
  }
});

test("a failed grounded search never quietly becomes an ungrounded answer", async () => {
  const f=fixture("synthetic-key");f.config.llm.baseUrl="https://generativelanguage.googleapis.com/v1beta/openai";
  const calls:string[]=[];
  globalThis.fetch=(async (input:any)=>{calls.push(String(input));return new Response("search unavailable",{status:400});}) as unknown as typeof fetch;
  await expect(callAgentLlm({config:f.config,tier:"deep",systemPrompt:"s",userPrompt:"latest facts",enableWebSearch:true})).rejects.toThrow();
  expect(calls).toHaveLength(2);
  expect(calls.every(url=>url.includes(":generateContent"))).toBe(true);
});

test("projectRootOverride .env takes precedence over process.env even when IGNORE_HOME_DOTENV is set", () => {
  const f = fixture();
  writeFileSync(join(f.root, ".env"), "IGNORE_HOME_DOTENV=true\nLLM_FAST_MODEL=gemini-2.5-flash\n");
  const prevFast = process.env.LLM_FAST_MODEL;
  const prevIgnore = process.env.IGNORE_HOME_DOTENV;
  process.env.LLM_FAST_MODEL = "gemini-3.8-flash";
  process.env.IGNORE_HOME_DOTENV = "true";
  try {
    const cfg = loadConfig(undefined, f.root);
    expect(cfg.llm.fastModel).toBe("gemini-2.5-flash");
  } finally {
    if (prevFast === undefined) delete process.env.LLM_FAST_MODEL;
    else process.env.LLM_FAST_MODEL = prevFast;
    if (prevIgnore === undefined) delete process.env.IGNORE_HOME_DOTENV;
    else process.env.IGNORE_HOME_DOTENV = prevIgnore;
  }
});

test("findSiblingMultiFormatFiles discovers versioned _export_<revision> files and send_file compiles requested HTML on demand", async () => {
  const f = fixture();
  const outputsDir = join(f.root, "outputs");
  mkdirSync(outputsDir, { recursive: true });
  const mdPath = join(outputsDir, "guide.md");
  writeFileSync(mdPath, "# Guide\n\nContent for sibling test");
  const deliverables = await ensureMultiFormatDeliverables({
    markdownPath: mdPath,
    outputDir: outputsDir,
    baseFileStem: "guide",
    requestedFormats: ["md", "html"],
  });
  expect(deliverables).toHaveLength(2);
  const siblings = findSiblingMultiFormatFiles(mdPath, ["md", "html"]);
  expect(siblings).toEqual(deliverables);

  // Also test on-demand HTML compilation in handleSendFile when only .md exists
  const notePath = join(outputsDir, "fresh_note.md");
  writeFileSync(notePath, "# Fresh Note\n\nCompile me on demand");
  const sendRes = await (f.pipeline.agent as any).handleSendFile({
    senderId: "owner",
    unpacked: { userText: "把刚才生成的 html 发给我" },
    decision: {
      intent: "send_file",
      slots: { fileTarget: "recent_generated", requestedFormats: ["html"] },
    },
    recentTurns: [
      {
        id: 1,
        sender_id: "owner",
        user_text: "生成一份测试笔记",
        intent: "research_and_write",
        reply_text: "已生成",
        model_used: "mock",
        deposited_path: notePath,
        created_at: new Date().toISOString(),
      },
    ],
    recentArticles: [],
  });
  expect(sendRes.mediaDeliveries).toHaveLength(1);
  expect(sendRes.mediaDeliveries[0].mediaPath).toMatch(/fresh_note_export_[a-f0-9]{16}\.html$/);
});

test("discoverGeneratedArtifacts discovers standalone outputs/ relative paths and expectedPaths", () => {
  const f = fixture();
  const generated = join(f.root, "generated");
  const outputs = join(f.root, "outputs", "research_notes");
  mkdirSync(generated, { recursive: true });
  mkdirSync(outputs, { recursive: true });
  const expectedImg = join(generated, "agy_img_2026_10_22_deadbeef.png");
  const relDoc = join(outputs, "standalone_guide.md");
  writeFileSync(expectedImg, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]));
  writeFileSync(relDoc, "# Standalone Guide");
  const found = discoverGeneratedArtifacts(
    generated,
    "已生成文档 outputs/research_notes/standalone_guide.md",
    Date.now() - 1000,
    f.root,
    [expectedImg]
  );
  expect(found.images).toEqual([expectedImg]);
  expect(found.files).toEqual([relDoc]);
});

test("TASK_HEARTBEAT_SECONDS configures custom heartbeat interval and supports 0 to disable periodic pushes", async () => {
  const f = fixture();
  writeFileSync(join(f.root, ".env"), "TASK_HEARTBEAT_SECONDS=60\n");
  const cfg60 = loadConfig(undefined, f.root);
  expect(cfg60.taskHeartbeatSeconds).toBe(60);

  writeFileSync(join(f.root, ".env"), "TASK_HEARTBEAT_SECONDS=0\n");
  const cfg0 = loadConfig(undefined, f.root);
  expect(cfg0.taskHeartbeatSeconds).toBe(0);

  f.db.enqueueAgentTask("hb-msg", "owner", JSON.stringify({
    from_user_id: "owner",
    item_list: [{ type: 1, text_item: { text: "测试进度心跳配置" } }],
  }));
  expect(formatLiveTaskStatusReport(f.db, "owner", 60)).toContain("每隔 60 秒");
  expect(formatLiveTaskStatusReport(f.db, "owner", 0)).not.toContain("每隔");

  const pushed: string[] = [];
  const reporter = new TaskProgressReporter({
    db: f.db,
    messageKey: "hb-msg",
    senderId: "owner",
    heartbeatIntervalSeconds: 0,
    sendProgressCallback: async (_to, text) => {
      pushed.push(text);
    },
  });
  await reporter.start("初始化", "已启动");
  reporter.stop("已完成");
  expect(pushed).toEqual(["已启动"]);
});

test("explicit Codex image generation and multi-turn retry preserve requested CLI backend and pruneSentOutboxMedia cleans aged sent snapshots", async () => {
  const f = fixture();
  f.config.llm.allowCodexFallback = true;
  f.config.llm.cliRoutingChain = ["agy", "codex"];

  const fakeImg = join(f.root, "codex_cat.png");
  writeFileSync(fakeImg, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const seenRequests: Array<{ backend: string; expectGeneratedImage?: boolean; prompt: string }> = [];
  setSubagentTestRunner(async (req) => {
    seenRequests.push({
      backend: req.backend,
      expectGeneratedImage: req.expectGeneratedImage,
      prompt: req.prompt,
    });
    return {
      backend: req.backend,
      modelUsed: `${req.backend}-cli`,
      outputText: "已使用内置 image_gen 生成小猫插画",
      generatedImages: req.expectGeneratedImage ? [fakeImg] : [],
      generatedFiles: [],
    };
  });

  // 1. User explicitly asks Codex to generate an image ("试用codex帮我生成一张图片吧 小猫的图片")
  const genRes = await f.pipeline.agent.processClawBotMessage({
    messageKey: "codex-img-1",
    senderId: "owner",
    rawMessage: {
      message_id: "codex-img-1",
      from_user_id: "owner",
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: "试用codex帮我生成一张图片吧 小猫的图片" } }],
    },
  });
  expect(seenRequests).toHaveLength(1);
  expect(seenRequests[0].backend).toBe("codex");
  expect(seenRequests[0].expectGeneratedImage).toBe(true);
  expect(genRes.modelUsed).toBe("codex-cli");
  expect(genRes.mediaDeliveries).toHaveLength(1);

  // 2. User replies "按我之前的需求重新生成" -> should retry generate_image with codex and original prompt
  const retryRes = await f.pipeline.agent.processClawBotMessage({
    messageKey: "codex-img-retry",
    senderId: "owner",
    rawMessage: {
      message_id: "codex-img-retry",
      from_user_id: "owner",
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: "按我之前的需求重新生成" } }],
    },
  });
  expect(seenRequests).toHaveLength(2);
  expect(seenRequests[1].backend).toBe("codex");
  expect(seenRequests[1].expectGeneratedImage).toBe(true);
  expect(seenRequests[1].prompt).toContain("小猫的图片");
  expect(retryRes.mediaDeliveries).toHaveLength(1);

  // 3. Verify pruneSentOutboxMedia removes aged sent snapshots only when no pending row shares the snapshot
  f.db.queueMediaReply("sent-img", "owner", "image", fakeImg);
  const outboxRow = f.db.db.query("SELECT media_path FROM reply_outbox WHERE id = 'sent-img'").get() as { media_path: string };
  expect(readFileSync(outboxRow.media_path).length).toBeGreaterThan(0);
  f.db.db.query("UPDATE reply_outbox SET status = 'sent' WHERE id = 'sent-img'").run();
  // Other rows from genRes/retryRes sharing the same snapshot are still pending, so it must NOT be pruned yet
  expect(f.db.pruneSentOutboxMedia(0)).toBe(0);
  // Once all rows referencing the snapshot are sent, pruneSentOutboxMedia(0) cleans it up
  f.db.db.query("UPDATE reply_outbox SET status = 'sent'").run();
  expect(f.db.pruneSentOutboxMedia(0)).toBe(1);
});

test("handleSaveConfigRequest respects standalone and generic_folder modes without polluting with numbered directories", async () => {
  const f = fixture();
  // 1. Standalone mode (VAULT_ROOT=none)
  const standaloneArchive = join(f.root, "data", "archive");
  const saveStandaloneRes = await handleSaveConfigRequest(
    new Request("http://127.0.0.1:8787/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updates: {
          IGNORE_HOME_DOTENV: "true",
          VAULT_ROOT: "none",
          TASK_HEARTBEAT_SECONDS: "30",
        },
        deletedKeys: [],
      }),
    }),
    f.db,
    f.pipeline
  );
  expect(saveStandaloneRes.status).toBe(200);
  expect(f.pipeline.config.vaultMode).toBe("standalone");
  expect(existsSync(join(standaloneArchive, "00_home"))).toBe(false);
  expect(existsSync(join(standaloneArchive, "04_topics"))).toBe(false);

  // 2. Generic folder mode (existing non-numbered Obsidian vault)
  const genericVault = join(f.root, "my_obsidian_notes");
  mkdirSync(genericVault, { recursive: true });
  writeFileSync(join(genericVault, "daily.md"), "# Daily Note\n");
  const saveGenericRes = await handleSaveConfigRequest(
    new Request("http://127.0.0.1:8787/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updates: {
          IGNORE_HOME_DOTENV: "true",
          VAULT_ROOT: genericVault,
          TASK_HEARTBEAT_SECONDS: "45",
        },
        deletedKeys: [],
      }),
    }),
    f.db,
    f.pipeline
  );
  expect(saveGenericRes.status).toBe(200);
  expect(f.pipeline.config.vaultMode).toBe("generic_folder");
  expect(existsSync(join(genericVault, "00_home"))).toBe(false);
  expect(existsSync(join(genericVault, "04_topics"))).toBe(false);
  expect(existsSync(join(genericVault, "05_outputs"))).toBe(false);
});

test("outbox flushReplies enforces exponential backoff when requested and recovers after backoff window", async () => {
  const f = fixture();
  f.pipeline.clawbot.saveCredentials({
    botToken: "tok",
    baseUrl: "https://ilink.example.test",
    botId: "bot1",
    userId: "owner",
    savedAt: new Date().toISOString(),
  });
  f.db.queueReply("backoff-1", "owner", "Hello after wake");

  let callCount = 0;
  let shouldFail = true;
  globalThis.fetch = (async () => {
    callCount++;
    if (shouldFail) {
      return new Response("network down", { status: 502 });
    }
    return Response.json({ ret: 0 });
  }) as unknown as typeof fetch;

  // Attempt 1 fails at t = 1000ms -> sets next_retry_at = 6000ms (+5000ms)
  await f.pipeline.flushReplies({ enforceRetryBackoff: true, nowMs: 1000 });
  expect(callCount).toBe(1);
  let row = f.db.db.query("SELECT status, attempts, next_retry_at FROM reply_outbox WHERE id = 'backoff-1'").get() as any;
  expect(row.status).toBe("pending");
  expect(row.attempts).toBe(1);
  expect(row.next_retry_at).toBe(6000);

  // Calling before 6000ms with enforceRetryBackoff=true does NOT burn an attempt
  await f.pipeline.flushReplies({ enforceRetryBackoff: true, nowMs: 3500 });
  expect(callCount).toBe(1);

  // Calling at t = 6000ms triggers Attempt 2; still failing -> sets next_retry_at = 21000ms (+15000ms)
  await f.pipeline.flushReplies({ enforceRetryBackoff: true, nowMs: 6000 });
  expect(callCount).toBe(2);
  row = f.db.db.query("SELECT status, attempts, next_retry_at FROM reply_outbox WHERE id = 'backoff-1'").get() as any;
  expect(row.status).toBe("pending");
  expect(row.attempts).toBe(2);
  expect(row.next_retry_at).toBe(21000);

  // Network recovers before t = 21000ms; calling at t = 21000ms succeeds on Attempt 3
  shouldFail = false;
  await f.pipeline.flushReplies({ enforceRetryBackoff: true, nowMs: 21000 });
  expect(callCount).toBe(3);
  row = f.db.db.query("SELECT status, attempts, next_retry_at FROM reply_outbox WHERE id = 'backoff-1'").get() as any;
  expect(row.status).toBe("sent");
  expect(row.attempts).toBe(3);
  expect(row.next_retry_at).toBe(0);
});

test("busy agent queue allows fast-lane ideas/articles to bypass blocking and sends queue-position ack for queued tasks", () => {
  const f = fixture("synthetic-llm-key");
  // Simulate a heavy task currently running in agent_tasks
  const runningTask = f.db.enqueueAgentTask("heavy-1", "owner", "{}");
  f.db.updateAgentTaskStatus(runningTask.id, "processing", "", "正在执行深度调研");

  // 1. User sends "想法：在长任务运行期间顺手记录一个灵感" -> bypasses agent_tasks and saves immediately
  f.db.db
    .query("INSERT INTO inbound_messages(message_key, payload) VALUES (?, ?)")
    .run(
      "fast-idea-1",
      JSON.stringify({
        message_id: "fast-idea-1",
        from_user_id: "owner",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "想法：在长任务运行期间顺手记录一个灵感" } }],
      })
    );

  // 2. User sends another heavy task ("帮我再画一张风景图") -> enqueued in agent_tasks AND gets immediate queue-position ack
  f.db.db
    .query("INSERT INTO inbound_messages(message_key, payload) VALUES (?, ?)")
    .run(
      "heavy-2",
      JSON.stringify({
        message_id: "heavy-2",
        from_user_id: "owner",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "帮我再画一张风景图" } }],
      })
    );

  expect(f.pipeline.processPendingMessages()).toBe(2);

  // Fast-lane idea was NOT blocked in agent_tasks; only heavy-2 is pending in agent_tasks
  const pendingTasks = f.db.getPendingAgentTasks();
  expect(pendingTasks).toHaveLength(1);
  expect(pendingTasks[0].message_key).toBe("heavy-2");

  // Outbox has both the immediate idea confirmation and the queue-position ack for heavy-2
  const outboxRows = f.db.db.query("SELECT id, text FROM reply_outbox ORDER BY rowid ASC").all() as Array<{
    id: string;
    text: string;
  }>;
  expect(outboxRows.some((r) => r.text.includes("💡 想法已保存"))).toBe(true);
  expect(
    outboxRows.some(
      (r) => r.id.startsWith("queue_ack_") && r.text.includes("前方有 1 个任务正在执行")
    )
  ).toBe(true);
});

test("spawnCliWithTimeout escalates from SIGTERM to SIGKILL and unblocks streams when a process ignores SIGTERM", async () => {
  const signals: number[] = [];
  // Create a stream that never closes on its own (simulating an orphaned child holding stdout open)
  const hangingStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial output before hang\n"));
    },
  });
  const neverExit = new Promise<number>(() => {});
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => ({
    pid: 99999,
    stdout: hangingStream,
    stderr: new Response("some warning\n").body,
    exited: neverExit,
    kill(sig?: number) {
      signals.push(sig ?? 15);
    },
  })) as any);

  try {
    const res = await spawnCliWithTimeout("mock-cli", ["--run"], process.cwd(), 100);
    expect(res.timedOut).toBe(true);
    expect(res.cleanOut).toContain("partial output before hang");
    expect(signals).toEqual([15, 9]);
  } finally {
    spawnSpy.mockRestore();
  }
});

test("splitWeChatTextChunks and sendTextMessage split oversized text replies at natural boundaries", async () => {
  const f = fixture();
  f.pipeline.clawbot.saveCredentials({
    botToken: "tok",
    baseUrl: "https://ilink.example.test",
    botId: "bot1",
    userId: "owner",
    savedAt: new Date().toISOString(),
  });

  const para1 = "第一段内容：".padEnd(1400, "甲");
  const para2 = "第二段内容：".padEnd(1400, "乙");
  const para3 = "第三段内容：".padEnd(600, "丙");
  const longText = `${para1}\n\n${para2}\n\n${para3}`;

  const chunks = splitWeChatTextChunks(longText, 2500);
  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toBe(para1);
  expect(chunks[1]).toBe(`${para2}\n\n${para3}`);

  const sentPayloads: Array<{ clientId: string; text: string }> = [];
  globalThis.fetch = (async (_url: any, init?: any) => {
    const body = JSON.parse(init.body);
    sentPayloads.push({
      clientId: body.msg.client_id,
      text: body.msg.item_list[0].text_item.text,
    });
    return Response.json({ ret: 0 });
  }) as unknown as typeof fetch;

  await f.pipeline.clawbot.sendTextMessage("owner", longText, "msg-long");
  expect(sentPayloads).toEqual([
    { clientId: "msg-long", text: para1 },
    { clientId: "msg-long_part_2", text: `${para2}\n\n${para3}` },
  ]);
});

test("vault markdown cache reuses unchanged files, invalidates on edit, and skips _export_<revision>.md files", () => {
  const f = fixture();
  clearVaultMarkdownCache();
  const topicsDir = join(f.root, "04_topics");
  mkdirSync(topicsDir, { recursive: true });

  const primaryNote = join(topicsDir, "ontology_design.md");
  const derivedExport = join(topicsDir, "ontology_design_export_0123456789abcdef.md");
  writeFileSync(primaryNote, "---\ntitle: Ontology\n---\n# Ontology Architecture\nCore knowledge graph patterns.");
  writeFileSync(derivedExport, "# Ontology Architecture\nCore knowledge graph patterns.");

  const firstHits = searchVaultNotes(f.root, ["ontology"]);
  expect(firstHits).toHaveLength(1);
  expect(firstHits[0].absolutePath).toBe(primaryNote);
  const statsAfterFirst = getVaultCacheStats();
  expect(statsAfterFirst.misses).toBe(1);

  // Second query hits in-memory cache without re-reading disk
  const secondHits = findVaultFilesByQuery(f.root, "ontology");
  expect(secondHits).toHaveLength(1);
  expect(secondHits[0].absolutePath).toBe(primaryNote);
  const statsAfterSecond = getVaultCacheStats();
  expect(statsAfterSecond.hits).toBeGreaterThan(statsAfterFirst.hits);
  expect(statsAfterSecond.misses).toBe(1);

  // Editing the file changes size/mtimeMs and invalidates cache entry
  writeFileSync(
    primaryNote,
    "---\ntitle: Ontology\n---\n# Ontology Architecture\nUpdated with world model synthesis."
  );
  const thirdHits = searchVaultNotes(f.root, ["world model"]);
  expect(thirdHits).toHaveLength(1);
  expect(thirdHits[0].excerpt).toContain("Updated with world model synthesis.");
  expect(getVaultCacheStats().misses).toBe(2);
});

test("pruneHistoricalRecords cleans aged terminal tasks and bounds completed inbound/outbox rows", () => {
  const f = fixture();
  const nowMs = Date.parse("2026-10-23T12:00:00.000Z");
  const oldIso = new Date(nowMs - 40 * 24 * 60 * 60 * 1000).toISOString();
  const recentIso = new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString();

  const oldTask = f.db.enqueueAgentTask("old-task", "owner", "{}");
  f.db.updateAgentTaskStatus(oldTask.id, "done");
  f.db.db.query("UPDATE agent_tasks SET updated_at = ? WHERE id = ?").run(oldIso, oldTask.id);

  const recentTask = f.db.enqueueAgentTask("recent-task", "owner", "{}");
  f.db.updateAgentTaskStatus(recentTask.id, "done");
  f.db.db.query("UPDATE agent_tasks SET updated_at = ? WHERE id = ?").run(recentIso, recentTask.id);

  for (let i = 1; i <= 5; i++) {
    f.db.db.query("INSERT INTO inbound_messages(message_key, payload, status) VALUES (?, '{}', 'done')").run(`in-${i}`);
    f.db.db.query("INSERT INTO reply_outbox(id, recipient, text, status) VALUES (?, 'owner', 'ok', 'sent')").run(`out-${i}`);
  }

  const pruned = f.db.pruneHistoricalRecords({
    nowMs,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    keepRecentInbound: 3,
    keepRecentOutbox: 2,
  });
  expect(pruned).toEqual({
    agentTasksPruned: 1,
    inboundPruned: 2,
    outboxPruned: 3,
  });
  expect(f.db.db.query("SELECT message_key FROM agent_tasks").all()).toEqual([
    { message_key: "recent-task" },
  ]);
});

test("auditSkillsDirectoryHealth detects missing YAML frontmatter and nested node_modules", () => {
  const f = fixture();
  const skillsRoot = join(f.root, "skills");
  const goodSkill = join(skillsRoot, "good-skill");
  const badSkill = join(skillsRoot, "bad-skill");
  const heavySkill = join(skillsRoot, "heavy-skill", "scripts", "node_modules");
  mkdirSync(goodSkill, { recursive: true });
  mkdirSync(badSkill, { recursive: true });
  mkdirSync(heavySkill, { recursive: true });

  writeFileSync(join(goodSkill, "SKILL.md"), "---\nname: good-skill\ndescription: valid\n---\n# Good\n");
  writeFileSync(join(badSkill, "SKILL.md"), "# Missing Frontmatter\n");

  const health = auditSkillsDirectoryHealth(skillsRoot);
  expect(health.exists).toBe(true);
  expect(health.totalSkills).toBe(2);
  expect(health.invalidSkillFiles).toEqual([join(badSkill, "SKILL.md")]);
  expect(health.heavyNodeModulesDirs).toEqual([heavySkill]);
});

test("handleCaptureInbox and handleCaptureIdea preserve full verbatim user text alongside shortened router summary", async () => {
  const f = fixture("synthetic-key");
  const fullMeetingMemo = [
    "工程架构同步会议纪要：",
    "1. 已完成项：异步消息队列增加指数退避与死信保护；",
    "2. 本周重点：优化长连接断线重连策略，补充端到端压测用例；",
    "3. 后续待办：整理接口契约文档并完成跨模块联调验收。",
  ].join("\n");

  globalThis.fetch = (async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              intent: "capture_inbox",
              complexity: "fast",
              reason: "Forwarded meeting memo",
              slots: {
                ideaTitle: "工程架构同步纪要与待办",
                ideaSlug: "arch_sync_memo",
                coreContent: "同步异步队列改造进展及本周联调待办摘要。",
              },
            }),
          },
        },
      ],
    })) as unknown as typeof fetch;

  const res = await f.pipeline.agent.processClawBotMessage({
    messageKey: "memo-inbox-1",
    senderId: "owner",
    rawMessage: {
      message_id: "memo-inbox-1",
      from_user_id: "owner",
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: fullMeetingMemo } }],
    },
  });

  expect(res.depositedPath).toBeTruthy();
  const saved = readFileSync(res.depositedPath!, "utf8");
  expect(saved).toContain("同步异步队列改造进展及本周联调待办摘要。");
  expect(saved).toContain("异步消息队列增加指数退避与死信保护");
  expect(saved).toContain("优化长连接断线重连策略");
  expect(saved).toContain("整理接口契约文档并完成跨模块联调验收");

  // Also verify CLI `inbox --json` returns the recorded turn with full user_text
  const proc = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), "inbox", "--json"],
    {
      env: {
        PATH: process.env.PATH,
        IGNORE_HOME_DOTENV: "true",
        WECHAT_CONTEXT_DATA_DIR: f.root,
        VAULT_ROOT: f.root,
      },
    }
  );
  expect(proc.exitCode).toBe(0);
  const inboxReport = JSON.parse(proc.stdout.toString());
  expect(inboxReport.ok).toBe(true);
  expect(inboxReport.turnsCount).toBe(1);
  expect(inboxReport.turns[0].user_text).toContain("优化长连接断线重连策略");
});

test("sendTextMessage recovers from stale context_token (ret=-2) and resumes multi-chunk send without duplicating delivered chunks", async () => {
  const f = fixture();
  f.pipeline.clawbot.saveCredentials({
    botToken: "tok",
    baseUrl: "https://ilink.example.test",
    botId: "bot1",
    userId: "owner",
    savedAt: new Date().toISOString(),
  });
  f.pipeline.clawbot.setContextToken("owner", "stale-ctx-token-999");

  const para1 = "第一段长内容：".padEnd(1500, "甲");
  const para2 = "第二段长内容：".padEnd(1500, "乙");
  const longText = `${para1}\n\n${para2}`;

  const calls: Array<{ clientId: string; contextToken?: string }> = [];
  let failSecondChunkOnce = true;

  globalThis.fetch = (async (_url: any, init?: any) => {
    const body = JSON.parse(init.body);
    const clientId = body.msg.client_id;
    const contextToken = body.msg.context_token;
    calls.push({ clientId, contextToken });

    if (contextToken === "stale-ctx-token-999") {
      return Response.json({ ret: -2, errmsg: "prepare failed" });
    }
    if (clientId === "multi-msg_part_2" && failSecondChunkOnce) {
      failSecondChunkOnce = false;
      return new Response("gateway timeout", { status: 502 });
    }
    return Response.json({ ret: 0 });
  }) as unknown as typeof fetch;

  // First call: chunk 1 fails with ret=-2 on stale token, retries chunk 1 without token & succeeds, then chunk 2 fails with 502
  await expect(
    f.pipeline.clawbot.sendTextMessage("owner", longText, "multi-msg")
  ).rejects.toThrow("502");
  expect(f.pipeline.clawbot.getContextToken("owner")).toBeUndefined();

  // Second call (retry): skips already-delivered chunk 1 and only sends chunk 2!
  await f.pipeline.clawbot.sendTextMessage("owner", longText, "multi-msg");

  expect(calls).toEqual([
    { clientId: "multi-msg", contextToken: "stale-ctx-token-999" },
    { clientId: "multi-msg", contextToken: undefined },
    { clientId: "multi-msg_part_2", contextToken: undefined },
    { clientId: "multi-msg_part_2", contextToken: undefined },
  ]);
});

test("extractSearchKeywords segments Chinese compounds via Intl.Segmenter and searchVaultNotes downweights _system/log.md", () => {
  const f = fixture();
  clearVaultMarkdownCache();
  const kws = extractSearchKeywords("分布式系统架构设计：微服务时代的容错与可观测性实践");
  expect(kws.some((k) => k.includes("架构设计") || k === "架构" || k === "设计")).toBe(true);

  mkdirSync(join(f.root, "04_topics"), { recursive: true });
  mkdirSync(join(f.root, "_system"), { recursive: true });
  writeFileSync(
    join(f.root, "04_topics", "system_architecture.md"),
    "# 系统架构设计与容错\n系统架构设计的核心是明确模块边界与故障隔离机制。"
  );
  writeFileSync(
    join(f.root, "_system", "log.md"),
    "# System Log\n" + "架构设计 ".repeat(14)
  );

  const hits = searchVaultNotes(f.root, ["架构设计"], 2);
  expect(hits).toHaveLength(2);
  expect(hits[0].relativePath).toBe("04_topics/system_architecture.md");
  expect(hits[1].relativePath).toBe("_system/log.md");
});

test("CLI circuit breaker cooldown deprioritizes a failing backend on subsequent invocations", async () => {
  const f = fixture();
  f.config.llm.allowCodexFallback = true;
  f.config.llm.cliRoutingChain = ["opencode", "claude"];

  const seenOrder: string[] = [];
  setSubagentTestRunner(async (req) => {
    seenOrder.push(req.backend);
    if (req.backend === "opencode") {
      throw new Error("opencode broken");
    }
    return {
      backend: req.backend,
      modelUsed: `${req.backend}-cli`,
      outputText: "ok",
      generatedImages: [],
      generatedFiles: [],
    };
  });

  // Run 1: tries opencode first, fails -> records cooldown -> falls back to claude
  await runCliSubagent({
    config: f.config,
    backend: "opencode",
    prompt: "task 1",
    honorCooldownInTests: true,
  });
  expect(isCliBackendInCooldown("opencode")).toBe(true);

  // Run 2: because opencode is in cooldown, tries healthy claude FIRST without waiting for opencode to fail again
  await runCliSubagent({
    config: f.config,
    backend: "opencode",
    prompt: "task 2",
    honorCooldownInTests: true,
  });
  expect(seenOrder).toEqual(["opencode", "claude", "claude"]);
});
