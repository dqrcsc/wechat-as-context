import "./support/isolation.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { ContextDatabase } from "../src/db.ts";
import { WeChatContextPipeline } from "../src/pipeline.ts";
import { downloadAndDecryptCdnMedia } from "../src/clawbot/media.ts";
import { discoverGeneratedArtifacts, setSubagentTestRunner } from "../src/agent/subagent_cli.ts";
import { compileMarkdownToHtml, ensureMultiFormatDeliverables } from "../src/agent/doc_exporter.ts";
import { findSiblingMultiFormatFiles } from "../src/vault/context.ts";
import { formatLiveTaskStatusReport, TaskProgressReporter } from "../src/agent/progress.ts";
import { callAgentLlm } from "../src/agent/llm.ts";
import { extractGeneralWebArticle, normalizeExternalWebUrl } from "../src/extractor/web.ts";
import { createHttpHandler } from "../src/http.ts";

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
