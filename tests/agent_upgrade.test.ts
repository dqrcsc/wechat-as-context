import "./support/isolation.ts";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.ts";
import {
  LLM_PROVIDER_PRESETS,
  loadConfig,
  parseDotEnvFile,
  saveProjectDotEnv,
} from "../src/config.ts";
import { resolveModelEndpoint } from "../src/agent/llm.ts";
import { ContextDatabase } from "../src/db.ts";
import { WeChatContextPipeline } from "../src/pipeline.ts";
import {
  decryptAes128Ecb,
  encryptAes128Ecb,
  parseWeChatAesKey,
  prepareMediaForUpload,
} from "../src/clawbot/media.ts";
import { unpackClawBotMessage } from "../src/clawbot/client.ts";
import {
  scanLocalAgentClis,
  setSubagentTestRunner,
  SubagentRunRequest,
} from "../src/agent/subagent_cli.ts";
import { createHttpHandler } from "../src/http.ts";
import { setAsrTestRunner } from "../src/extractor/asr.ts";
import {
  detectSourcePlatform,
  extractUrlsFromMixedText,
  sanitizeSharedLinkMessage,
} from "../src/extractor/sanitizer.ts";
import { findVaultFilesByQuery } from "../src/vault/context.ts";

const originalFetch = globalThis.fetch;
const databases: ContextDatabase[] = [];
const CLI_ENV_KEYS = ["AGY_BIN", "CODEX_BIN", "OPENCODE_BIN", "CLAUDE_BIN", "GEMINI_BIN"] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSubagentTestRunner(null);
  setAsrTestRunner(null);
  for (const key of CLI_ENV_KEYS) {
    delete process.env[key];
  }
  for (const db of databases.splice(0)) {
    db.db.close();
  }
});

function createAgentFixture(withLlmKey = true) {
  for (const key of CLI_ENV_KEYS) {
    process.env[key] = process.execPath;
  }
  const root = mkdtempSync(join(tmpdir(), "wx-agent-upgrade-"));
  mkdirSync(join(root, "00_home"), { recursive: true });
  mkdirSync(join(root, "01_inputs", "inbox"), { recursive: true });
  mkdirSync(join(root, "01_inputs", "articles", "wechat"), { recursive: true });
  mkdirSync(join(root, "01_inputs", "articles", "web"), { recursive: true });
  mkdirSync(join(root, "01_inputs", "video"), { recursive: true });
  mkdirSync(join(root, "03_ideas", "seeds"), { recursive: true });
  mkdirSync(join(root, "04_topics", "ai"), { recursive: true });

  writeFileSync(
    join(root, "00_home", "now.md"),
    "---\ntype: home\n---\n当前主线：知识工程、本体论（Ontology）与 Agent 上下文工程。"
  );
  writeFileSync(
    join(root, "04_topics", "ai", "ontology_notes.md"),
    "---\ntype: topic\n---\n# Ontology & Context\n本体论在智能体上下文中的核心作用是提供显式语义约束与因果图谱。"
  );

  const config: AppConfig = {
    projectRoot: root,
    dataDir: root,
    dbPath: join(root, "wechat_context.db"),
    vaultRoot: root,
    wechatArticlesDir: join(root, "01_inputs", "articles", "wechat"),
    webArticlesDir: join(root, "01_inputs", "articles", "web"),
    videoDir: join(root, "01_inputs", "video"),
    inboxDir: join(root, "01_inputs", "inbox"),
    papersDir: join(root, "01_inputs", "papers"),
    ideasSeedsDir: join(root, "03_ideas", "seeds"),
    port: 0,
    annotationWaitSeconds: 0,
    llm: {
      apiKey: withLlmKey ? "test-gemini-key" : "",
      baseUrl: "https://llm.example.test/v1",
      model: "gemini-2.5-flash",
      fastModel: "gemini-2.5-flash",
      proModel: "gemini-2.5-pro",
      allowCodexFallback: false,
    },
  };

  const db = new ContextDatabase(config.dbPath);
  databases.push(db);
  const pipeline = new WeChatContextPipeline(config, db);
  pipeline.clawbot.saveCredentials({
    botToken: "bot-token-123",
    baseUrl: "https://ilink.example.test",
    botId: "bot@im.bot",
    userId: "user@im.wechat",
    savedAt: new Date().toISOString(),
  });
  return { root, config, db, pipeline };
}

describe("WeChat Agent V2 Upgrade (6 Extension Scenarios + Two-Tier LLM Router)", () => {
  test("C2C AES-128-ECB supports both raw 16-byte base64 key and 32-char hex base64 key", () => {
    const rawKey = randomBytes(16);
    const hexKey = rawKey.toString("hex");
    const base64Raw = rawKey.toString("base64");
    const base64HexAscii = Buffer.from(hexKey, "ascii").toString("base64");

    expect(parseWeChatAesKey(base64Raw)).toEqual(rawKey);
    expect(parseWeChatAesKey(base64HexAscii)).toEqual(rawKey);
    expect(parseWeChatAesKey(undefined, hexKey)).toEqual(rawKey);

    const plain = Buffer.from("Hello 个人知识库 & WeChat C2C Media!", "utf-8");
    const cipher = encryptAes128Ecb(plain, rawKey);
    expect(cipher.length % 16).toBe(0);
    const decrypted = decryptAes128Ecb(cipher, rawKey);
    expect(decrypted.toString("utf-8")).toBe("Hello 个人知识库 & WeChat C2C Media!");
  });

  test("unpackClawBotMessage separates user text, voice transcription, ref_msg partial_text, and media items", () => {
    const msg = {
      message_id: "9001",
      from_user_id: "user@im.wechat",
      message_type: 1,
      item_list: [
        {
          type: 3,
          voice_item: {
            text: "针对这段话，我觉得本体论还能解决记忆冲突",
          },
          ref_msg: {
            title: "文章 #12《Agent Memory 综述》",
            svr_id: "778899",
            message_item: {
              type: 1,
              text_item: {
                text: "向量检索无法处理跨时间步的状态覆盖问题。",
              },
            },
            partial_text: {
              startindex: 0,
              endindex: 20,
            },
          },
        },
      ],
    };

    const unpacked = unpackClawBotMessage(msg);
    expect(unpacked.userText).toBe("针对这段话，我觉得本体论还能解决记忆冲突");
    expect(unpacked.voiceTranscriptions).toEqual([
      "针对这段话，我觉得本体论还能解决记忆冲突",
    ]);
    expect(unpacked.refContext?.title).toContain("#12");
    expect(unpacked.refContext?.partialText).toBe("向量检索无法处理跨时间步的状态覆盖问题。");
  });

  test("Two-tier LLM router uses gemini-2.5-flash for routing and escalates complex vault_query to gemini-2.5-pro", async () => {
    const f = createAgentFixture(true);
    const modelsCalled: string[] = [];
    const typingStatuses: number[] = [];

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/ilink/bot/getconfig")) {
        return Response.json({ ret: 0, typing_ticket: "ticket_abc" });
      }
      if (u.includes("/ilink/bot/sendtyping")) {
        const body = JSON.parse(String(init?.body || "{}"));
        typingStatuses.push(body.status);
        return Response.json({ ret: 0 });
      }
      if (u.includes("/ilink/bot/getupdates")) {
        return Response.json({
          ret: 0,
          get_updates_buf: "buf_vault_1",
          msgs: [
            {
              message_id: "msg_vault_1",
              from_user_id: "user@im.wechat",
              context_token: "ctx_1",
              message_type: 1,
              item_list: [
                {
                  type: 1,
                  text_item: {
                    text: "请结合我知识库里的本体论笔记，深度推演一下为什么本体能提供语义约束？",
                  },
                },
              ],
            },
          ],
        });
      }
      if (u.includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body || "{}"));
        modelsCalled.push(body.model);
        if (body.response_format?.type === "json_object") {
          // Intent router response from gemini-2.5-flash
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: "vault_query",
                    complexity: "deep",
                    reason: "Requires cross-note synthesis on ontology",
                    slots: {
                      searchQuery: "本体 语义约束",
                    },
                  }),
                },
              },
            ],
          });
        }
        // Deep execution response from gemini-2.5-pro
        return Response.json({
          choices: [
            {
              message: {
                content:
                  "根据你的笔记 [[ontology_notes]]，本体论通过显式语义约束与因果图谱解决上下文歧义。",
              },
            },
          ],
        });
      }
      if (u.includes("/ilink/bot/sendmessage")) {
        return Response.json({ ret: 0, message_id: "out_1" });
      }
      return Response.json({ ret: 0 });
    }) as any;

    await f.pipeline.pollClawBotUpdates(5_000);

    // Verify 1st call was gemini-2.5-flash (router) and 2nd call was gemini-2.5-pro (deep executor)
    expect(modelsCalled).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    // Verify sendtyping status=1 (start) and status=2 (stop) were sent!
    expect(typingStatuses).toContain(1);
    expect(typingStatuses).toContain(2);

    const turns = f.db.getRecentConversationTurns("user@im.wechat");
    expect(turns.length).toBe(1);
    expect(turns[0].intent).toBe("vault_query");
    expect(turns[0].complexity).toBe("deep");
    expect(turns[0].model_used).toBe("gemini-2.5-pro");
    expect(turns[0].assistant_reply).toContain("[[ontology_notes]]");
  });

  test("Natural language idea without prefix is routed to capture_idea and saved to 03_ideas/seeds/", async () => {
    const f = createAgentFixture(true);

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body || "{}"));
        if (body.response_format?.type === "json_object") {
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: "capture_idea",
                    complexity: "fast",
                    reason: "User expressed original thought without prefix",
                    slots: {
                      ideaSlug: "context_drift_hypothesis",
                      coreContent:
                        "我感觉现在的 Agent 评测太关注单步准确率，忽略了长周期的上下文漂移。",
                    },
                  }),
                },
              },
            ],
          });
        }
        return Response.json({
          choices: [
            {
              message: {
                content: "这个视角非常犀利，长周期漂移正是 Harness 评测的核心盲区。",
              },
            },
          ],
        });
      }
      return Response.json({ ret: 0 });
    }) as any;

    const res = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_nl_idea_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "nl_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "我感觉现在的 Agent 评测太关注单步准确率，忽略了长周期的上下文漂移。",
            },
          },
        ],
      },
    });

    expect(res.replyText).toContain("💡 想法已保存：03_ideas/seeds/");
    expect(res.replyText).toContain("思考共鸣");
    const seeds = readdirSync(f.config.ideasSeedsDir);
    expect(seeds.length).toBe(1);
    expect(readFileSync(join(f.config.ideasSeedsDir, seeds[0]), "utf-8")).toContain(
      "长周期的上下文漂移"
    );
  });

  test("Scenario 3: Non-WeChat external web URL is extracted and deposited into 01_inputs/articles/web/", async () => {
    const f = createAgentFixture(false);

    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("arxiv.org")) {
        return new Response(
          `<!DOCTYPE html><html><head><meta property="og:title" content="Scaling Test-Time Compute for Agents"/><meta name="author" content="DeepMind"/></head><body><article><h1>Scaling Test-Time Compute</h1><p>${"Test-time compute scaling improves agentic reasoning and verification over long horizons. ".repeat(10)}</p></article></body></html>`,
          { status: 200 }
        );
      }
      return Response.json({ ret: 0 });
    }) as any;

    await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_web_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "web_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "https://arxiv.org/abs/2610.12345 这篇优先精读",
            },
          },
        ],
      },
    });

    const processed = await f.pipeline.drainReadyQueue();
    expect(processed.length).toBe(1);
    expect(processed[0].title).toBe("Scaling Test-Time Compute for Agents");
    expect(processed[0].source_md_path).toContain("01_inputs/articles/web/");
    expect(existsSync(processed[0].source_md_path)).toBe(true);
    expect(existsSync(processed[0].note_md_path)).toBe(true);
  });

  test("Scenario 4 & 6: Multimodal image C2C AES-128-ECB decrypt + outbound Markdown file C2C AES-128-ECB upload", async () => {
    const f = createAgentFixture(false);
    const aesKey = randomBytes(16);
    // PNG magic bytes + payload
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("FAKE_IMAGE_CONTENT_FOR_OCR"),
    ]);
    const encryptedPng = encryptAes128Ecb(fakePng, aesKey);
    const sentMessages: any[] = [];
    const subagentCalls: SubagentRunRequest[] = [];

    setSubagentTestRunner(async (req) => {
      subagentCalls.push(req);
      return {
        backend: req.backend,
        modelUsed: `${req.backend} (${req.preferredModel || "default"})`,
        outputText: "从图片中提取到白板架构草图：包含三层本体语义网络与动作契约层。",
        generatedImages: [],
        generatedFiles: [],
      };
    });

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("novac2c.cdn.weixin.qq.com/c2c/download")) {
        return new Response(new Uint8Array(encryptedPng), { status: 200 });
      }
      if (u.includes("/ilink/bot/getuploadurl")) {
        return Response.json({
          ret: 0,
          upload_param: "enc_upload_param_1",
          upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload?test=1",
        });
      }
      if (u.includes("novac2c.cdn.weixin.qq.com/c2c/upload")) {
        return new Response("", {
          status: 200,
          headers: { "x-encrypted-param": "downloaded_enc_param_xyz" },
        });
      }
      if (u.includes("/ilink/bot/sendmessage")) {
        sentMessages.push(JSON.parse(String(init?.body || "{}")));
        return Response.json({ ret: 0 });
      }
      return Response.json({ ret: 0 });
    }) as any;

    // 1. Test inbound encrypted image -> decrypted and saved to 01_inputs/inbox/
    const imgResult = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_img_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "img_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 2,
            image_item: {
              aeskey: aesKey.toString("hex"),
              media: {
                encrypt_query_param: "test_img_param",
              },
            },
          },
          {
            type: 1,
            text_item: {
              text: "白板架构草图备忘",
            },
          },
        ],
      },
    });

    expect(imgResult.depositedPath).toBeTruthy();
    expect(existsSync(imgResult.depositedPath!)).toBe(true);
    expect(subagentCalls.length).toBe(1);
    expect(subagentCalls[0].backend).toBe("agy");
    expect(subagentCalls[0].imagePaths?.length).toBe(1);
    expect(imgResult.replyText).toContain("三层本体语义网络");
    const assetsDir = join(f.config.inboxDir!, "assets");
    const assetFiles = readdirSync(assetsDir);
    expect(assetFiles.length).toBe(1);
    expect(readFileSync(join(assetsDir, assetFiles[0]))).toEqual(fakePng);

    // 2. Test outbound file send ("把 00_home/now.md 发文件给我")
    const sendRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_sendfile_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "send_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "把 00_home/now.md 发文件给我",
            },
          },
        ],
      },
    });

    expect(sendRes.mediaDeliveries?.length).toBe(1);
    await f.pipeline.flushReplies();

    // Verify a FILE message (type = 4) was sent via sendmessage with C2C encrypted media ref
    const fileMsg = sentMessages.find(
      (m) => m.msg?.item_list?.[0]?.type === 4
    );
    expect(fileMsg).toBeTruthy();
    expect(fileMsg.msg.item_list[0].file_item.file_name).toBe("now.md");
    expect(fileMsg.msg.item_list[0].file_item.media.encrypt_query_param).toBe(
      "downloaded_enc_param_xyz"
    );
  });

  test("CLI Subagent Delegation: generate_image via AGY sends encrypted image (type=2) to WeChat, and delegate_subagent invokes Codex CLI", async () => {
    const f = createAgentFixture(false);
    const sentMessages: any[] = [];
    const subagentCalls: SubagentRunRequest[] = [];

    const generatedPngPath = join(f.root, "generated_ontology_arch.png");
    writeFileSync(
      generatedPngPath,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("GENERATED_BY_AGY_IMAGE_SUBAGENT"),
      ])
    );

    setSubagentTestRunner(async (req) => {
      subagentCalls.push(req);
      if (req.expectGeneratedImage) {
        return {
          backend: "agy",
          modelUsed: "agy (gemini-2.5-pro)",
          outputText: "已为你绘制知识工程三层架构图，包含原始材料层、本体语义层与智能体上下文层。",
          generatedImages: [generatedPngPath],
          generatedFiles: [],
        };
      }
      return {
        backend: req.backend,
        modelUsed: "codex-cli",
        outputText: "已完成微信读书笔记同步与深度归档，更新了 04_topics/ai/ontology_notes.md。",
        generatedImages: [],
        generatedFiles: [join(f.root, "04_topics", "ai", "ontology_notes.md")],
      };
    });

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/ilink/bot/getuploadurl")) {
        return Response.json({
          ret: 0,
          upload_param: "enc_img_upload_param",
          upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload?img=1",
        });
      }
      if (u.includes("novac2c.cdn.weixin.qq.com/c2c/upload")) {
        return new Response("", {
          status: 200,
          headers: { "x-encrypted-param": "uploaded_img_enc_param_999" },
        });
      }
      if (u.includes("/ilink/bot/sendmessage")) {
        sentMessages.push(JSON.parse(String(init?.body || "{}")));
        return Response.json({ ret: 0 });
      }
      return Response.json({ ret: 0 });
    }) as any;

    // 1. User asks to generate an image -> routed to generate_image -> AGY CLI -> encrypted image sent to WeChat
    const genRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_gen_img_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "gen_img_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "帮我画一张知识工程三层架构图发给我",
            },
          },
        ],
      },
    });

    expect(genRes.modelUsed).toBe("agy (gemini-2.5-pro)");
    expect(genRes.mediaDeliveries?.length).toBe(1);
    expect(genRes.mediaDeliveries?.[0].mediaType).toBe("image");

    await f.pipeline.flushReplies();

    const imageMsg = sentMessages.find(
      (m) => m.msg?.item_list?.[0]?.type === 2
    );
    expect(imageMsg).toBeTruthy();
    expect(imageMsg.msg.item_list[0].image_item.media.encrypt_query_param).toBe(
      "uploaded_img_enc_param_999"
    );

    // 2. User delegates vault maintenance to Codex -> routed to delegate_subagent -> Codex CLI
    const codexRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_codex_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "codex_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "让 codex 帮我同步微信读书笔记并整理知识库索引",
            },
          },
        ],
      },
    });

    expect(codexRes.modelUsed).toBe("codex-cli");
    expect(codexRes.replyText).toContain("已完成微信读书笔记同步与深度归档");
    expect(subagentCalls.length).toBe(2);
    expect(subagentCalls[1].backend).toBe("codex");
  });

  test("Hierarchical Fallback Chain: 2.5-flash Router -> Local CLI (unavailable) -> Pro Model (unavailable) -> 2.5-flash Fallback", async () => {
    const f = createAgentFixture(true);
    const executionSequence: string[] = [];

    // Simulate Local CLI (agy/codex) failing
    setSubagentTestRunner(async (req) => {
      executionSequence.push(`cli:${req.backend}`);
      throw new Error("Local CLI subagent offline");
    });

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body || "{}"));
        if (body.response_format?.type === "json_object") {
          executionSequence.push(`router:${body.model}`);
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: "delegate_subagent",
                    complexity: "deep",
                    reason: "Complex multi-note research task",
                    slots: {
                      subagentTarget: "agy",
                    },
                  }),
                },
              },
            ],
          });
        }

        // Non-router execution calls:
        executionSequence.push(`api:${body.model}`);
        if (body.model === "gemini-2.5-pro") {
          // Simulate Pro model quota/availability failure (503)
          return new Response("Pro model capacity exhausted", { status: 503 });
        }

        // Fast model (gemini-2.5-flash) ultimate fallback succeeds!
        return Response.json({
          choices: [
            {
              message: {
                content:
                  "【兜底完成】尽管本地 CLI 与 Pro 模型暂不可用，已由 gemini-2.5-flash 基于知识库 [[ontology_notes]] 完成推演总结。",
              },
            },
          ],
        });
      }
      return Response.json({ ret: 0 });
    }) as any;

    const res = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_cascade_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "cascade_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "让 agy 帮我深度综合知识库里的本体论笔记",
            },
          },
        ],
      },
    });

    // Verify exact 4-step cascade order:
    // 1. router:gemini-2.5-flash -> 2. cli:agy -> 3. api:gemini-2.5-pro -> 4. api:gemini-2.5-flash
    expect(executionSequence).toEqual([
      "router:gemini-2.5-flash",
      "cli:agy",
      "api:gemini-2.5-pro",
      "api:gemini-2.5-flash",
    ]);
    expect(res.modelUsed).toBe("gemini-2.5-flash (fallback from gemini-2.5-pro)");
    expect(res.replyText).toContain("【兜底完成】");
  });

  test("Universal LLM provider presets support Gemini, DeepSeek, OpenCode Go, and saveProjectDotEnv preserves comments", () => {
    // 1. Verify OpenCode Go / Zen preset auto-detection via OPENCODE_API_KEY
    const opencodeCfg = loadConfig({
      IGNORE_HOME_DOTENV: "true",
      LLM_PROVIDER: "opencode",
      OPENCODE_API_KEY: "oc_go_test_key_123",
    });
    expect(opencodeCfg.llm.provider).toBe("opencode");
    expect(opencodeCfg.llm.apiKey).toBe("oc_go_test_key_123");
    expect(opencodeCfg.llm.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(opencodeCfg.llm.fastModel).toBe("glm-5.1");

    // 2. Verify DeepSeek preset auto-detection via DEEPSEEK_API_KEY
    const deepseekCfg = loadConfig({
      IGNORE_HOME_DOTENV: "true",
      LLM_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "ds_test_key_456",
    });
    expect(deepseekCfg.llm.provider).toBe("deepseek");
    expect(deepseekCfg.llm.apiKey).toBe("ds_test_key_456");
    expect(deepseekCfg.llm.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(deepseekCfg.llm.proModel).toBe("deepseek-reasoner");

    // 3. Verify Google Gemini preset via GOOGLE_API_KEY alias
    const geminiCfg = loadConfig({
      IGNORE_HOME_DOTENV: "true",
      LLM_PROVIDER: "gemini",
      GOOGLE_API_KEY: "AIza_google_test_789",
    });
    expect(geminiCfg.llm.provider).toBe("gemini");
    expect(geminiCfg.llm.apiKey).toBe("AIza_google_test_789");

    // 4. Verify saveProjectDotEnv updates, adds, and deletes keys while preserving comments
    const tmpProj = mkdtempSync(join(tmpdir(), "wx-dotenv-test-"));
    writeFileSync(
      join(tmpProj, ".env"),
      "# Header comment\nLLM_PROVIDER=gemini\nOLD_KEY=to_delete\n"
    );
    saveProjectDotEnv(tmpProj, {
      LLM_PROVIDER: "opencode",
      OPENCODE_API_KEY: "oc_secret_999",
      OLD_KEY: null,
    });
    const rawSaved = readFileSync(join(tmpProj, ".env"), "utf-8");
    expect(rawSaved).toContain("# Header comment");
    const parsed = parseDotEnvFile(join(tmpProj, ".env"));
    expect(parsed.LLM_PROVIDER).toBe("opencode");
    expect(parsed.OPENCODE_API_KEY).toBe("oc_secret_999");
    expect(parsed.OLD_KEY).toBeUndefined();
  });

  test("Local AI Agent CLI scanner and multi-CLI routing chain support opencode, claude, codex, agy, and custom CLIs", async () => {
    const f = createAgentFixture(false);
    f.config.llm.allowCodexFallback = true;
    f.config.llm.cliRoutingChain = ["opencode", "claude", "codex"];
    f.config.llm.customCliAgents = [
      {
        id: "my-custom-cli",
        name: "My Custom Agent",
        binaryPath: "/bin/echo",
        argsTemplate: "custom-run {{PROMPT}}",
      },
    ];

    const scanned = scanLocalAgentClis(f.config);
    const ids = scanned.map((c) => c.id);
    expect(ids).toContain("agy");
    expect(ids).toContain("codex");
    expect(ids).toContain("opencode");
    expect(ids).toContain("claude");
    expect(ids).toContain("gemini");
    expect(ids).toContain("my-custom-cli");

    const opencodeItem = scanned.find((c) => c.id === "opencode")!;
    expect(opencodeItem.enabledInRoute).toBe(true);
    expect(opencodeItem.routePriority).toBe(1);

    // Test explicit delegation to OpenCode CLI from WeChat message: "让 opencode 帮我巡检知识库"
    const invokedBackends: string[] = [];
    setSubagentTestRunner(async (req: SubagentRunRequest) => {
      invokedBackends.push(req.backend);
      if (req.backend === "opencode") {
        // Simulate opencode failing so it falls back to #2 in cliRoutingChain (claude)
        throw new Error("opencode temporary failure");
      }
      return {
        backend: req.backend,
        modelUsed: `${req.backend}-cli`,
        outputText: `已由 ${req.backend} CLI 完成知识库多文件巡检。`,
        generatedImages: [],
        generatedFiles: [],
      };
    });

    const res = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_opencode_delegate",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "oc_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "让 opencode 帮我巡检整理知识库收集箱",
            },
          },
        ],
      },
    });

    // Should try preferred "opencode" first, then fall back along cliRoutingChain to "claude"
    expect(invokedBackends).toEqual(["opencode", "claude"]);
    expect(res.replyText).toContain("已由 claude CLI 完成知识库多文件巡检");
  });

  test("HTML Configuration Studio & REST API (/config, /api/config, /api/config/scan-cli) view, modify, and add config items", async () => {
    const f = createAgentFixture(true);
    const handler = createHttpHandler(f.db, f.pipeline);

    // 1. GET /config returns the interactive HTML studio with dark-mode and accessible form controls
    const htmlRes = await handler(new Request("http://127.0.0.1:8787/config"));
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    const html = await htmlRes.text();
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('id="config-form"');
    expect(html).toContain('id="providers-list-container"');
    expect(html).toContain('class="custom-select"');
    expect(html).toContain('id="llm-fast-model"');
    expect(html).toContain('id="llm-pro-model"');
    expect(html).toContain('appearance: base-select');
    expect(html).toContain('isProviderReadyForModels');
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).toBeTruthy();
    expect(() => new Function(scriptMatch![1])).not.toThrow();

    // 2. GET /api/config returns presets, discoveredClis, and current config
    const getRes = await handler(new Request("http://127.0.0.1:8787/api/config"));
    expect(getRes.status).toBe(200);
    const getPayload = (await getRes.json()) as any;
    expect(getPayload.ok).toBe(true);
    expect(getPayload.providerPresets.length).toBe(LLM_PROVIDER_PRESETS.length);
    expect(getPayload.discoveredClis.some((c: any) => c.id === "opencode")).toBe(true);

    // 3. POST /api/config updates multi-provider config, cross-provider fast/pro models, and CLI routing chain
    const multiProvidersJson = JSON.stringify([
      {
        id: "gemini",
        name: "Google Gemini",
        envKeyName: "GEMINI_API_KEY",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        models: ["gemini-2.5-flash", "gemini-2.5-pro"],
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        envKeyName: "DEEPSEEK_API_KEY",
        baseUrl: "https://api.deepseek.com/v1",
        models: ["deepseek-chat", "deepseek-reasoner"],
      },
    ]);
    const postRes = await handler(
      new Request("http://127.0.0.1:8787/api/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8787",
        },
        body: JSON.stringify({
          updates: {
            VAULT_ROOT: f.root,
            LLM_PROVIDER: "gemini",
            GEMINI_API_KEY: "AIza-gemini-fast-key",
            DEEPSEEK_API_KEY: "sk-deepseek-pro-key",
            LLM_FAST_PROVIDER: "gemini",
            LLM_FAST_MODEL: "gemini-2.5-flash",
            LLM_PRO_PROVIDER: "deepseek",
            LLM_PRO_MODEL: "deepseek-reasoner",
            LLM_PROVIDERS_CONFIG: multiProvidersJson,
            CLI_ROUTING_CHAIN: "opencode,agy,codex",
            CUSTOM_USER_FLAG: "enabled_via_ui",
          },
          deletedKeys: [],
        }),
      })
    );
    expect(postRes.status).toBe(200);
    const postPayload = (await postRes.json()) as any;
    expect(postPayload.ok).toBe(true);
    expect(postPayload.config.llm.providers.length).toBeGreaterThanOrEqual(2);
    expect(postPayload.config.llm.fastProvider).toBe("gemini");
    expect(postPayload.config.llm.fastModel).toBe("gemini-2.5-flash");
    expect(postPayload.config.llm.proProvider).toBe("deepseek");
    expect(postPayload.config.llm.proModel).toBe("deepseek-reasoner");
    expect(postPayload.envValues.CLI_ROUTING_CHAIN).toBe("opencode,agy,codex");
    expect(postPayload.envValues.CUSTOM_USER_FLAG).toBe("enabled_via_ui");

    // 4. Verify resolveModelEndpoint routes Fast to Gemini and Deep to DeepSeek
    const fastEp = resolveModelEndpoint(f.pipeline.config, "fast");
    const deepEp = resolveModelEndpoint(f.pipeline.config, "deep");
    expect(fastEp.providerId).toBe("gemini");
    expect(fastEp.apiKey).toBe("AIza-gemini-fast-key");
    expect(fastEp.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(fastEp.model).toBe("gemini-2.5-flash");
    expect(deepEp.providerId).toBe("deepseek");
    expect(deepEp.apiKey).toBe("sk-deepseek-pro-key");
    expect(deepEp.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(deepEp.model).toBe("deepseek-reasoner");

    // 5. Verify POST /api/config/init-vault creates all 7 required subdirectories and starter files in a brand-new folder
    const brandNewVault = join(f.root, "brand_new_vault");
    const initVaultRes = await handler(
      new Request("http://127.0.0.1:8787/api/config/init-vault", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8787",
        },
        body: JSON.stringify({
          vaultRoot: brandNewVault,
        }),
      })
    );
    expect(initVaultRes.status).toBe(200);
    const initVaultPayload = (await initVaultRes.json()) as any;
    expect(initVaultPayload.ok).toBe(true);
    expect(initVaultPayload.vaultExists).toBe(true);
    expect(initVaultPayload.createdDirs.length).toBeGreaterThanOrEqual(7);
    expect(initVaultPayload.createdFiles.length).toBe(2);
    expect(initVaultPayload.vaultSubdirs.length).toBe(7);
    expect(initVaultPayload.vaultSubdirs.every((s: any) => s.exists === true)).toBe(true);

    // 6. Verify calling POST /api/config/init-vault again on an existing non-empty vault skips all existing dirs/files and never deletes or overwrites anything
    const customArticlePath = join(brandNewVault, "01_inputs", "articles", "wechat", "my_existing_note.md");
    writeFileSync(customArticlePath, "# 珍贵存量笔记\n绝不可删除或覆盖", "utf-8");
    const customNowPath = join(brandNewVault, "00_home", "now.md");
    writeFileSync(customNowPath, "# 用户自定义主线\n不可被覆盖", "utf-8");

    const secondInitRes = await handler(
      new Request("http://127.0.0.1:8787/api/config/init-vault", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8787",
        },
        body: JSON.stringify({
          vaultRoot: brandNewVault,
        }),
      })
    );
    const secondInitPayload = (await secondInitRes.json()) as any;
    expect(secondInitPayload.ok).toBe(true);
    expect(secondInitPayload.createdDirs).toEqual([]);
    expect(secondInitPayload.skippedDirs.length).toBeGreaterThanOrEqual(7);
    expect(secondInitPayload.createdFiles).toEqual([]);
    expect(secondInitPayload.skippedFiles.length).toBe(2);
    expect(readFileSync(customArticlePath, "utf-8")).toBe("# 珍贵存量笔记\n绝不可删除或覆盖");
    expect(readFileSync(customNowPath, "utf-8")).toBe("# 用户自定义主线\n不可被覆盖");
  });

  test("Complex compound task (web search + vault architecture + multi-format MD/HTML/PDF delivery + follow-up '文件呢' + retry '你看看我之前的需求')", async () => {
    // This orchestration test must not depend on a local browser process.
    // PDF rendering failures have dedicated coverage; real rendering is a separate integration check.
    const originalSpawn = Bun.spawn;
    const pdfSpawn = spyOn(Bun, "spawn").mockImplementation(((args: any, options: any) => {
      if (Array.isArray(args) && args.some((arg: string) => arg.startsWith("--print-to-pdf="))) {
        return { exited: Promise.resolve(1), kill() {} };
      }
      return originalSpawn(args, options);
    }) as any);
    try {
    const f = createAgentFixture(true);
    mkdirSync(join(f.root, "04_topics", "knowledge_systems"), { recursive: true });
    mkdirSync(join(f.root, "01_inputs", "articles", "clippings"), { recursive: true });
    mkdirSync(join(f.root, "_system"), { recursive: true });

    // Create an old clipping so we verify the system does NOT mistakenly send old clippings over newly generated guides
    writeFileSync(
      join(f.root, "01_inputs", "articles", "clippings", "2026_05_12_llm_wiki.md"),
      "---\ntitle: \"LLM Wiki\"\n---\nRaw English clipping of Karpathy gist."
    );
    writeFileSync(
      join(f.root, "04_topics", "knowledge_systems", "llm_wiki.md"),
      "---\ntype: topic\n---\n# LLM Wiki\n三层架构：Raw Sources + LLM-maintained Wiki + Schema (AGENTS.md)，核心操作 Ingest / Query / Lint。"
    );
    writeFileSync(
      join(f.root, "AGENTS.md"),
      "# Personal Knowledge Base Governance\n单点真相、跨任务 AI 共用上下文、人写与 AI 写显式分离。"
    );

    // Also insert an unrelated recent article (#5 蚂蚁取消前端工程师) to verify targetArticleId is NOT polluted
    f.db.enqueueArticle({
      msgid: "msg_ant_fe",
      url: "https://mp.weixin.qq.com/s/ant_fe",
      title: "蚂蚁取消前端工程师，大厂岗位合并潮来了",
      digest: "大厂岗位合并与全栈化趋势",
      sender_id: "user@im.wechat",
    });

    const promptsSeen: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/chat/completions") || u.includes(":generateContent")) {
        const body = JSON.parse(String(init?.body || "{}"));
        const allText = JSON.stringify(body);
        promptsSeen.push(allText);

        if (body.response_format?.type === "json_object") {
          // Router LLM call
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: "delegate_subagent",
                    complexity: "deep",
                    targetArticleId: null,
                    reason: "Compound web research + vault synthesis + multi-format MD/HTML/PDF export",
                    slots: {
                      coreContent:
                        "帮我搜一下Andrej karpathy的LLM Wiki，以及结合我的知识库构建过程、组织方式，整理一个相关的知识库构建的学习指南，便于能够分享给新手，让他们能有个初步的认知，后续开启知识库以及跨任务的AI共用上下文。最好是markdown格式的、html格式的、pdf格式的，各自生成，发给我。",
                      requestedFormats: ["md", "html", "pdf"],
                      wantsFileDelivery: true,
                      needsWebSearch: true,
                      documentTitle: "LLM Wiki 与个人知识库新手学习指南",
                      documentSlug: "llm_wiki_beginner_guide",
                    },
                  }),
                },
              },
            ],
          });
        }

        // Pro synthesis call
        return Response.json({
          choices: [
            {
              message: {
                content: `---
title: "从聊天记录到复利资产：LLM Wiki 与个人知识库构建新手学习指南"
date: 2026-10-22
tags: [llm-wiki, karpathy, 知识库, 新手指南]
---

# 从聊天记录到复利资产：LLM Wiki 与个人知识库构建新手学习指南

## 一、为什么要做这件事：Andrej Karpathy 的 LLM Wiki 核心思想

每次和 AI 聊天后关掉窗口，知识就清零了。LLM Wiki 的核心是把静态原始资料编译为可持续复利的 Markdown 知识库。

| 维度 | 传统 RAG | LLM Wiki |
| --- | --- | --- |
| 知识状态 | 临时检索切片 | 持续编译结构化演进 |
| 跨任务复用 | 每次从零拼凑 | 多智能体共用单点真相 |

## 二、我的知识库演进与目录架构

- \`00_home/\`：当前关注主线
- \`01_inputs/\`：不可变原始输入层
- \`03_ideas/\`：人类原创想法种子
- \`04_topics/\`：AI 持续编译的主题百科
- \`05_outputs/\`：研究报告与对外分享指南
- \`_system/\`：治理契约与日志

## 三、新手 7 天启动路线图

1. 建立最小目录与 \`AGENTS.md\`
2. 跑通 Ingest -> Query -> Lint 闭环
`,
              },
            },
          ],
        });
      }
      return Response.json({ ret: 0 });
    }) as any;

    // Turn 1: User sends the complex multi-format research & guide generation request
    const turn1Res = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_complex_turn_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "c_turn_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "帮我搜一下Andrej karpathy的LLM Wiki，以及结合我的知识库构建过程、组织方式，整理一个相关的知识库构建的学习指南，便于能够分享给新手，让他们能有个初步的认知，后续开启知识库以及跨任务的AI共用上下文。最好是markdown格式的、html格式的、pdf格式的，各自生成，发给我。",
            },
          },
        ],
      },
    });

    // Verify unrelated article #5 was NOT injected into the synthesis prompt
    expect(promptsSeen.some((p) => p.includes("蚂蚁取消前端工程师") && p.includes("关联文章 #"))).toBe(false);

    // MD/HTML succeed; the isolated browser failure must report missing PDF.
    expect(turn1Res.outcome).toBe("partial");
    expect(turn1Res.missingFormats).toEqual(["pdf"]);
    expect(turn1Res.mediaDeliveries?.length).toBeGreaterThanOrEqual(2);
    const deliveredExts = (turn1Res.mediaDeliveries || []).map((m) =>
      m.mediaPath.slice(m.mediaPath.lastIndexOf("."))
    );
    expect(deliveredExts).toContain(".md");
    expect(deliveredExts).toContain(".html");
    for (const item of turn1Res.mediaDeliveries || []) {
      expect(existsSync(item.mediaPath)).toBe(true);
    }

    // Turn 2: User asks "文件呢 我没看到" -> should locate the newly generated sibling files (.md, .html, .pdf), NOT the old clipping
    const turn2Res = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_complex_turn_2",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "c_turn_2",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "文件呢 我没看到",
            },
          },
        ],
      },
    });

    expect(turn2Res.mediaDeliveries?.length).toBeGreaterThanOrEqual(2);
    expect(
      turn2Res.mediaDeliveries?.every((m) => m.mediaPath.includes("llm_wiki_beginner_guide"))
    ).toBe(true);
    expect(
      turn2Res.mediaDeliveries?.some((m) => m.mediaPath.includes("2026_05_12_llm_wiki.md"))
    ).toBe(false);

    // Turn 3: User says "不是这个，是你帮我生成中文版适合新手的指南啊，你看看我之前的需求"
    const turn3Res = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_complex_turn_3",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "c_turn_3",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "不是这个，是你帮我生成中文版适合新手的指南啊，你看看我之前的需求",
            },
          },
        ],
      },
    });

    expect(turn3Res.replyText).toContain("新手学习指南");
    expect(turn3Res.modelUsed).not.toBe("vault_deliverable_compiler");
    expect(turn3Res.mediaDeliveries?.length).toBeGreaterThanOrEqual(2);
    expect(
      turn3Res.mediaDeliveries?.every((m) => m.mediaPath.includes("llm_wiki_beginner_guide"))
    ).toBe(true);
    } finally { pdfSpawn.mockRestore(); }
  }, 15_000);

  test("Long-running task periodic heartbeat push & instant '还在跑吗 / 进度' status query while running", async () => {
    const f = createAgentFixture(true);
    f.config.taskHeartbeatSeconds = 0.12;
    f.config.llm.allowCodexFallback = true;
    f.config.llm.cliRoutingChain = ["opencode", "claude"];

    const sentWeChatTexts: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/ilink/bot/sendmessage")) {
        const body = JSON.parse(String(init?.body || "{}"));
        const txt = body?.msg?.item_list?.[0]?.text_item?.text || "";
        if (txt) sentWeChatTexts.push(txt);
        return Response.json({ ret: 0, message_id: "out_hb" });
      }
      if (u.includes("/ilink/bot/getconfig")) {
        return Response.json({ ret: 0, typing_ticket: "ticket_hb" });
      }
      if (u.includes("/ilink/bot/sendtyping")) {
        return Response.json({ ret: 0 });
      }
      return Response.json({ ret: 0 });
    }) as any;

    let statusWhileRunning = "";
    setSubagentTestRunner(async (req: SubagentRunRequest) => {
      if (req.backend === "opencode") {
        await Bun.sleep(160);
        throw new Error("opencode timeout after 160ms");
      }
      req.onActivity?.("已产生流式输出 4.2 KB · 最新动态：正在扫描 04_topics/ 目录");
      await Bun.sleep(180);

      // While task is actively running inside claude CLI, user sends "还在跑吗"
      const statusRes = await f.pipeline.agent.processClawBotMessage({
        messageKey: "msg_status_query_mid_flight",
        senderId: "user@im.wechat",
        rawMessage: {
          message_id: "sq_1",
          from_user_id: "user@im.wechat",
          message_type: 1,
          item_list: [{ type: 1, text_item: { text: "还在跑吗？" } }],
        },
      });
      statusWhileRunning = statusRes.replyText;

      return {
        backend: "claude",
        modelUsed: "claude-cli",
        outputText: "已完成全库巡检并修复 3 处双向链接。",
        generatedImages: [],
        generatedFiles: [],
      };
    });

    const taskRawMsg = {
      message_id: "long_task_1",
      from_user_id: "user@im.wechat",
      message_type: 1,
      item_list: [
        {
          type: 1,
          text_item: { text: "让 opencode 深度巡检我的知识库双向链接" },
        },
      ],
    };

    f.db.enqueueAgentTask(
      "msg_long_task_1",
      "user@im.wechat",
      JSON.stringify(taskRawMsg)
    );

    const processedCount = await f.pipeline.drainAgentQueue();
    expect(processedCount).toBe(1);

    // 1. Verify initial progress notice, periodic heartbeat, and CLI fallback alert were pushed to WeChat
    expect(sentWeChatTexts.some((t) => t.includes("已收到复合任务"))).toBe(true);
    expect(
      sentWeChatTexts.some(
        (t) => t.includes("正在持续处理中") && t.includes("状态同步")
      )
    ).toBe(true);
    expect(
      sentWeChatTexts.some(
        (t) =>
          t.includes("自动切换至备用智能体 [claude]") && t.includes("任务未中断")
      )
    ).toBe(true);

    // 2. Verify mid-flight "还在跑吗？" query returned live active status with stage & activity
    expect(statusWhileRunning).toContain("正在后台运行中（未异常中断）");
    expect(statusWhileRunning).toContain("claude");
    expect(statusWhileRunning).toContain("已产生流式输出 4.2 KB");

    // 3. Verify post-completion "进度" query reports task completed
    const postStatus = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_status_query_after",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "sq_2",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "进度" } }],
      },
    });
    expect(postStatus.replyText).toContain("当前无正在运行的长任务");
    expect(postStatus.replyText).toContain("✅ 已完成");

  });

  test("Proactive Push to WeChat (pushToWeChat / CLI push / POST /api/push): pushes text, images, multi-format MD/HTML deliverables, and syncs conversation_turns", async () => {
    const f = createAgentFixture(false);
    const sentMessages: any[] = [];

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/ilink/bot/getuploadurl")) {
        return Response.json({
          ret: 0,
          upload_param: "push_upload_param",
          upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload?push=1",
        });
      }
      if (u.includes("novac2c.cdn.weixin.qq.com/c2c/upload")) {
        return new Response("", {
          status: 200,
          headers: { "x-encrypted-param": "push_cdn_encrypted_param_777" },
        });
      }
      if (u.includes("/ilink/bot/sendmessage")) {
        sentMessages.push(JSON.parse(String(init?.body || "{}")));
        return Response.json({ ret: 0, message_id: `out_push_${sentMessages.length}` });
      }
      return Response.json({ ret: 0 });
    }) as any;

    // 1. Prepare a Markdown file and a PNG image on disk
    const notePath = join(f.root, "05_outputs", "codex_push_report.md");
    mkdirSync(join(f.root, "05_outputs"), { recursive: true });
    writeFileSync(
      notePath,
      `---\ntitle: "Codex 与 Antigravity 主动推送测试报告"\n---\n\n# 核心结论\n\n支持从电脑端直接将结论与多格式文件推送到手机微信。\n`,
      "utf-8"
    );

    const pngPath = join(f.root, "05_outputs", "arch_diagram.png");
    writeFileSync(
      pngPath,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("PUSH_IMAGE_DATA"),
      ])
    );

    // 2. Push text + Markdown (with --formats md,html compilation) + PNG image
    const pushRes = await f.pipeline.pushToWeChat({
      text: "这是在 Antigravity 中为你整理好的架构结论与报告附件：",
      files: [notePath, pngPath],
      formats: ["md", "html"],
    });

    expect(pushRes.ok).toBe(true);
    expect(pushRes.recipient).toBe("user@im.wechat");
    expect(pushRes.queuedCount).toBe(4); // 1 text + 2 files (.md, .html) + 1 image (.png)
    expect(pushRes.sentCount).toBe(4);
    expect(pushRes.failedCount).toBe(0);
    expect(pushRes.missingFormats).toEqual([]);
    const exportedHtml = pushRes.compiledFiles.find(p => p.endsWith(".html"));
    expect(exportedHtml).toBeDefined();
    expect(existsSync(exportedHtml!)).toBe(true);
    expect(readFileSync(exportedHtml!, "utf8")).toContain("主动推送测试报告");

    // Verify WeChat sendmessage payloads: 1 TEXT (type=1), 2 FILE (type=4), 1 IMAGE (type=2)
    expect(sentMessages.length).toBe(4);
    expect(sentMessages[0].msg.item_list[0].type).toBe(1);
    expect(sentMessages[0].msg.item_list[0].text_item.text).toContain("架构结论与报告附件");
    expect(sentMessages[1].msg.item_list[0].type).toBe(4);
    expect(sentMessages[1].msg.item_list[0].file_item.file_name).toBe("codex_push_report.md");
    expect(sentMessages[2].msg.item_list[0].type).toBe(4);
    expect(sentMessages[2].msg.item_list[0].file_item.file_name).toMatch(/^codex_push_report_export_[a-f0-9]{16}\.html$/);
    expect(sentMessages[3].msg.item_list[0].type).toBe(2);

    // 3. Verify conversation_turns recorded the push so follow-up on WeChat has context
    const turns = f.db.getRecentConversationTurns("user@im.wechat", 5);
    expect(turns.length).toBe(1);
    expect(turns[0].intent).toBe("cli_push");
    expect(turns[0].deposited_path).toContain(exportedHtml!);

    // 4. Verify CLI `push --queue-only --json` works in isolated fixture without network calls
    const cliProc = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "push",
        "--text",
        "来自 CLI 的离线入队测试消息",
        "--queue-only",
        "--json",
      ],
      {
        env: {
          ...process.env,
          WECHAT_CONTEXT_DATA_DIR: f.root,
          VAULT_ROOT: f.root,
          LLM_API_KEY: "",
        },
      }
    );
    expect(cliProc.exitCode).toBe(0);
    const cliJson = JSON.parse(cliProc.stdout.toString());
    expect(cliJson.ok).toBe(true);
    expect(cliJson.queuedCount).toBe(1);
    expect(cliJson.pendingCount).toBe(1);
    // A successful CLI response is insufficient: prove it wrote this fixture's queue.
    expect(f.db.db.query("SELECT status, attempts FROM reply_outbox WHERE text = ?")
      .all("来自 CLI 的离线入队测试消息")).toEqual([{ status: "pending", attempts: 0 }]);

    // 5. Verify local HTTP POST /api/push endpoint
    const handler = createHttpHandler(f.db, f.pipeline);
    const httpPushRes = await handler(
      new Request("http://127.0.0.1:8787/api/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8787",
        },
        body: JSON.stringify({
          text: "通过本地 /api/push 接口推送的通知",
        }),
      })
    );
    expect(httpPushRes.status).toBe(200);
    const httpPushBody = (await httpPushRes.json()) as any;
    expect(httpPushBody.ok).toBe(true);
    expect(httpPushBody.sentCount).toBe(1);
  });

  test("Standalone (No-Vault) Mode: works without any external knowledge base (VAULT_ROOT=none) for doctor, article analysis, standalone idea, and push", () => {
    const tmpDataDir = mkdtempSync(join(tmpdir(), "wx-standalone-mode-"));
    const cfg = loadConfig({
      IGNORE_HOME_DOTENV: "true",
      WECHAT_CONTEXT_DATA_DIR: tmpDataDir,
      VAULT_ROOT: "none",
      LLM_API_KEY: "",
    });

    expect(cfg.vaultEnabled).toBe(false);
    expect(cfg.vaultMode).toBe("standalone");
    expect(cfg.vaultRoot).toBe(join(tmpDataDir, "archive"));
    expect(cfg.wechatArticlesDir).toBe(join(tmpDataDir, "archive", "wechat"));
    expect(cfg.ideasSeedsDir).toBe(join(tmpDataDir, "archive", "ideas"));

    const db = new ContextDatabase(cfg.dbPath);
    databases.push(db);
    const pipeline = new WeChatContextPipeline(cfg, db);
    pipeline.clawbot.saveCredentials({
      botToken: "standalone-token",
      baseUrl: "https://ilink.example.test",
      botId: "bot@im.bot",
      userId: "user@im.wechat",
      savedAt: new Date().toISOString(),
    });

    // 1. Verify `doctor --json` succeeds (`ok: true`) even when no knowledge base directory exists on disk yet
    const docProc = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "doctor",
        "--json",
      ],
      {
        env: {
          ...process.env,
          IGNORE_HOME_DOTENV: "true",
          WECHAT_CONTEXT_DATA_DIR: tmpDataDir,
          VAULT_ROOT: "none",
          LLM_API_KEY: "",
        },
      }
    );
    expect(docProc.exitCode).toBe(0);
    const docData = JSON.parse(docProc.stdout.toString());
    expect(docData.ok).toBe(true);
    expect(docData.vaultMode).toBe("standalone");
    expect(docData.vaultEnabled).toBe(false);

    // 2. Verify `idea "独立想法"` works without requiring an article_id or pre-existing vault
    const ideaProc = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "idea",
        "无知识库模式下的独立闪念记录",
      ],
      {
        env: {
          ...process.env,
          IGNORE_HOME_DOTENV: "true",
          WECHAT_CONTEXT_DATA_DIR: tmpDataDir,
          VAULT_ROOT: "none",
          LLM_API_KEY: "",
        },
      }
    );
    expect(ideaProc.exitCode).toBe(0);
    expect(existsSync(cfg.ideasSeedsDir)).toBe(true);
    expect(readdirSync(cfg.ideasSeedsDir).length).toBe(1);
    expect(existsSync(join(cfg.vaultRoot, "00_home"))).toBe(false);

    // 3. Verify Generic Folder Mode: pointing VAULT_ROOT at a normal folder without 00_home
    const genericVault = mkdtempSync(join(tmpdir(), "wx-generic-obsidian-"));
    writeFileSync(join(genericVault, "MyNote.md"), "# 任意普通笔记\n测试解耦检索", "utf-8");
    const genericCfg = loadConfig({
      IGNORE_HOME_DOTENV: "true",
      WECHAT_CONTEXT_DATA_DIR: tmpDataDir,
      VAULT_ROOT: genericVault,
      LLM_API_KEY: "",
    });
    expect(genericCfg.vaultEnabled).toBe(true);
    expect(genericCfg.vaultMode).toBe("generic_folder");
  });

  test("Multi-Platform Share Sanitizer & 10-Second Annotation Window: strips Xiaohongshu/Douyin boilerplate without breaking 10s voice follow-up", async () => {
    // 1. Unit assertions on URL boundary & share boilerplate stripping
    const xhsRaw =
      "67 架构师老王发布了一篇小红书笔记，快来看吧！ 😆 A1b2C3 😆 http://xhslink.com/a/abc123xyz，复制本条信息，打开【小红书】App查看精彩内容！";
    expect(extractUrlsFromMixedText(xhsRaw)).toEqual(["http://xhslink.com/a/abc123xyz"]);
    const xhsSanitized = sanitizeSharedLinkMessage(xhsRaw);
    expect(xhsSanitized.url).toBe("http://xhslink.com/a/abc123xyz");
    expect(xhsSanitized.platform).toBe("xiaohongshu");
    expect(xhsSanitized.userNotes).toBe("");

    const dyRaw =
      "4.89 复制打开抖音，看看【AI前沿的作品】大模型Agent架构演进 # AI # 深度学习 https://v.douyin.com/iYabc123/ 05/18 Q@K.ca :8pm";
    const dySanitized = sanitizeSharedLinkMessage(dyRaw);
    expect(dySanitized.url).toBe("https://v.douyin.com/iYabc123/");
    expect(dySanitized.platform).toBe("douyin");
    expect(dySanitized.extractedTitle).toBe("大模型Agent架构演进");
    expect(dySanitized.userNotes).toBe("");

    const dyRealWorldRaw =
      "6.12 复制打开抖音，看看【许哈哈😄的作品】用ai学ai，才是唯一正确路径 # ai# 如何用... https://v.douyin.com/xRQ5FCRDsTI/ 05/21 sRx:/ :2pm e@B.gb";
    const dyRealWorldSanitized = sanitizeSharedLinkMessage(dyRealWorldRaw);
    expect(dyRealWorldSanitized.url).toBe("https://v.douyin.com/xRQ5FCRDsTI/");
    expect(dyRealWorldSanitized.extractedTitle).toBe("用ai学ai，才是唯一正确路径");
    expect(dyRealWorldSanitized.userNotes).toBe("");

    const dyWithComment =
      "4.89 复制打开抖音，看看【AI前沿的作品】大模型Agent架构演进 https://v.douyin.com/iYabc123/ 这个视频讲的状态机拆解非常值得借鉴";
    const dyCommentSanitized = sanitizeSharedLinkMessage(dyWithComment);
    expect(dyCommentSanitized.userNotes).toBe("这个视频讲的状态机拆解非常值得借鉴");

    // 2. End-to-end 10-second annotationWaitSeconds preservation when pasting Xiaohongshu share text followed by voice
    const f = createAgentFixture(false);
    f.config.annotationWaitSeconds = 10;

    globalThis.fetch = (async () => Response.json({ ret: 0 })) as any;

    // Message 1: Paste Xiaohongshu share link with boilerplate
    await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_xhs_share_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "msg_xhs_share_1",
        from_user_id: "user@im.wechat",
        context_token: "ctx_xhs_wait",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: { text: xhsRaw },
          },
        ],
      },
    });
    const pendingAfterShare = f.db.listArticles({ limit: 5 })[0];
    expect(pendingAfterShare).toBeDefined();
    expect(pendingAfterShare.url).toBe("http://xhslink.com/a/abc123xyz");
    // Crucial: boilerplate must NOT pollute user_notes, so 10s wait window stays open!
    expect(pendingAfterShare.user_notes).toBe("");
    const processedBeforeWindow = await f.pipeline.drainReadyQueue();
    expect(processedBeforeWindow.length).toBe(0);

    // Message 2: Send follow-up voice message within the 10s window
    await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_xhs_voice_2",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "msg_xhs_voice_2",
        from_user_id: "user@im.wechat",
        context_token: "ctx_xhs_wait",
        message_type: 1,
        item_list: [
          {
            type: 3,
            voice_item: {
              text: "这篇小红书笔记里的多智能体对比图很清晰，重点记入我的本体论主题",
            },
          },
        ],
      },
    });
    const pendingAfterVoice = f.db.getArticleById(pendingAfterShare.id)!;
    expect(pendingAfterVoice.user_notes).toContain("这篇小红书笔记里的多智能体对比图很清晰");
  });

  test("Medium Article Ingestion: detects Member-Only paywall truncation and falls back to Freedium mirror", async () => {
    const f = createAgentFixture(false);
    const mediumUrl = "https://medium.com/@karpathy/software-3-0-context-engineering-abcdef123456";
    const replies: string[] = [];

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/ilink/bot/sendmessage")) {
        const body = JSON.parse(String(init?.body || "{}"));
        replies.push(body?.msg?.item_list?.[0]?.text_item?.text || "");
        return Response.json({ ret: 0 });
      }
      if (u.startsWith("https://freedium.cfd/")) {
        return new Response(
          `<!DOCTYPE html><html><head><title>Software 3.0 & Context Engineering</title><meta name="author" content="Andrej Karpathy"></head>
          <body><article>
            <h1>Software 3.0 & Context Engineering</h1>
            <p>In the era of autonomous LLM agents, context engineering replaces manual boilerplate coding as the primary architectural discipline.</p>
            <p>${"Ontology and structured memory graphs provide deterministic semantic constraints over long-horizon agent workflows. ".repeat(12)}</p>
          </article></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      if (u === mediumUrl) {
        return new Response(
          `<!DOCTYPE html><html><head><title>Software 3.0 & Context Engineering | Medium</title></head>
          <body><article><h1>Software 3.0 & Context Engineering</h1><p>Short preview paragraph...</p>
          <div>Member-only story. Read the rest of this story with a free account.</div></article></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      return Response.json({ ret: 0 });
    }) as any;

    const ingestRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_medium_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "msg_medium_1",
        from_user_id: "user@im.wechat",
        context_token: "ctx_medium",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: `${mediumUrl} 这篇关于 Context Engineering 的深度思考值得沉淀`,
            },
          },
        ],
      },
    });
    expect(ingestRes.replyText).toContain("Medium 深度文章");

    const processed = await f.pipeline.drainReadyQueue();
    expect(processed.length).toBe(1);
    const article = processed[0];
    expect(article.status).toBe("light_done");
    expect(article.title).toContain("Software 3.0 & Context Engineering");
    expect(article.source_md_path.startsWith(f.config.webArticlesDir!)).toBe(true);

    const mdContent = readFileSync(article.source_md_path, "utf-8");
    expect(mdContent).toContain("source_type: medium_article");
    expect(mdContent).toContain("Ontology and structured memory graphs provide deterministic semantic constraints");
  });

  test("YouTube Video Ingestion: extracts watch page, InnerTube captions, and chapter timestamps into 01_inputs/video/", async () => {
    const f = createAgentFixture(false);
    const ytUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

    const playerResponse = {
      videoDetails: {
        videoId: "dQw4w9WgXcQ",
        title: "Building Effective Agents with Ontology & Context",
        author: "Anthropic Research",
        lengthSeconds: "750",
        shortDescription: "00:00 Introduction to Agent Loops\n03:00 Ontology & Context Engineering\n\nDeep dive into reliable agent architectures.",
      },
      microformat: {
        playerMicroformatRenderer: {
          publishDate: "2026-05-20",
        },
      },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
              languageCode: "en",
              name: { simpleText: "English" },
            },
          ],
        },
      },
    };

    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("youtube.com/watch")) {
        return new Response(
          `<!DOCTYPE html><html><head><title>Building Effective Agents</title></head><body>
          <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
          </body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      if (u.includes("youtube.com/api/timedtext")) {
        return Response.json({
          events: [
            {
              tStartMs: 10000,
              dDurationMs: 5000,
              segs: [{ utf8: "Welcome to our talk on autonomous agent loops and context curation." }],
            },
            {
              tStartMs: 195000,
              dDurationMs: 6000,
              segs: [{ utf8: "Now let us examine how ontology constrains agent state transitions." }],
            },
          ],
        });
      }
      return Response.json({ ret: 0 });
    }) as any;

    const ingestRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_yt_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "msg_yt_1",
        from_user_id: "user@im.wechat",
        context_token: "ctx_yt",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: { text: ytUrl },
          },
        ],
      },
    });
    expect(ingestRes.replyText).toContain("YouTube 视频");

    const processed = await f.pipeline.drainReadyQueue();
    expect(processed.length).toBe(1);
    const videoRecord = processed[0];
    expect(videoRecord.status).toBe("light_done");
    // Must be stored in 01_inputs/video/, NOT 01_inputs/articles/web/
    expect(videoRecord.source_md_path.startsWith(f.config.videoDir!)).toBe(true);
    expect(videoRecord.note_md_path.startsWith(f.config.videoDir!)).toBe(true);
    expect(existsSync(videoRecord.source_md_path)).toBe(true);
    expect(existsSync(videoRecord.note_md_path)).toBe(true);

    const videoMd = readFileSync(videoRecord.source_md_path, "utf-8");
    expect(videoMd).toContain("type: source");
    expect(videoMd).toContain("source_type: youtube_video");
    expect(videoMd).toContain('duration: "12:30"');
    expect(videoMd).toContain("### 00:00 Introduction to Agent Loops");
    expect(videoMd).toContain("### 03:00 Ontology & Context Engineering");
    expect(videoMd).toContain("Now let us examine how ontology constrains agent state transitions.");

    // Verify vault search finds the video note inside 01_inputs/video/
    const searchHits = findVaultFilesByQuery(f.root, "Anthropic Research");
    expect(searchHits.some((h) => h.relativePath.startsWith("01_inputs/video/"))).toBe(true);
  });

  test("Xiaohongshu Dual-Modality Ingestion: routes Image-Carousel Note (Vision OCR) to articles/web/ and Spoken Video (ASR) to video/", async () => {
    const f = createAgentFixture(true);
    const asrCalls: string[] = [];
    setAsrTestRunner(async ({ mediaUrl }) => {
      asrCalls.push(mediaUrl || "");
      return {
        transcript: "大家好，今天用三分钟讲透如何把小红书和抖音的口播干货自动沉淀进个人知识库与微信AI上下文。",
        engineUsed: "local_funasr",
      };
    });

    const xhsImageShare =
      "67 极客笔记发布了一篇小红书笔记 😆 http://xhslink.com/a/xhs_img_card，复制本条信息，打开【小红书】App查看精彩内容！";
    const xhsVideoShare =
      "89 AI口播君发布了一篇小红书笔记 😆 http://xhslink.com/a/xhs_spoken_vid，复制本条信息，打开【小红书】App查看精彩内容！";

    const imageNoteState = {
      note: {
        firstNoteId: "66aabbcc1122",
        noteDetailMap: {
          "66aabbcc1122": {
            note: {
              noteId: "66aabbcc1122",
              type: "normal",
              title: "Agent架构设计5张核心神图",
              desc: "建议收藏慢慢看 #AI架构 #Agent",
              user: { nickname: "极客笔记" },
              imageList: [
                { urlDefault: "https://sns-webpic.xhscdn.com/slide1.jpg" },
                { urlDefault: "https://sns-webpic.xhscdn.com/slide2.jpg" },
              ],
            },
          },
        },
      },
    };

    const videoNoteState = {
      note: {
        firstNoteId: "66ddeeff3344",
        noteDetailMap: {
          "66ddeeff3344": {
            note: {
              noteId: "66ddeeff3344",
              type: "video",
              title: "3分钟讲透个人知识库与微信上下文打通",
              desc: "口播干货分享 #知识库 #AI",
              user: { nickname: "AI口播君" },
              video: {
                capa: { duration: 185 },
                media: {
                  stream: {
                    h264: [{ masterUrl: "https://sns-video.xhscdn.com/stream_spoken.mp4" }],
                  },
                },
              },
            },
          },
        },
      },
    };

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === "http://xhslink.com/a/xhs_img_card") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://www.xiaohongshu.com/explore/66aabbcc1122?xsec_token=tok_img" },
        });
      }
      if (u.includes("xiaohongshu.com/explore/66aabbcc1122")) {
        return new Response(
          `<!DOCTYPE html><html><body><script>window.__INITIAL_STATE__=${JSON.stringify(imageNoteState)}</script></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      if (u === "http://xhslink.com/a/xhs_spoken_vid") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://www.xiaohongshu.com/explore/66ddeeff3344?xsec_token=tok_vid" },
        });
      }
      if (u.includes("xiaohongshu.com/explore/66ddeeff3344")) {
        return new Response(
          `<!DOCTYPE html><html><body><script>window.__INITIAL_STATE__=${JSON.stringify(videoNoteState)}</script></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      if (u.includes("sns-webpic.xhscdn.com/slide")) {
        return new Response(new Uint8Array(Buffer.alloc(256, 0xff)), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      if (u.includes("llm.example.test")) {
        const body = JSON.parse(String(init?.body || "{}"));
        const promptStr = JSON.stringify(body);
        if (promptStr.includes("图文卡片解析器") || promptStr.includes("image_url")) {
          return Response.json({
            choices: [
              {
                message: {
                  content:
                    "### [图 1]\n- **核心架构**：ReAct 循环与 Plan-and-Execute 树状状态机对比\n\n### [图 2]\n- **关键结论**：Ontology 显式约束能将长链路幻觉率降低 60%",
                },
              },
            ],
          });
        }
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  triage: "deep",
                  wechatCardReply: "已提炼小红书核心信号",
                  noteMarkdownBody: "## 核心信号\n小红书多模态提取完成",
                  relatedVaultNodes: ["[[ontology_notes]]"],
                }),
              },
            },
          ],
        });
      }
      return Response.json({ ret: 0 });
    }) as any;

    // 1. Process Xiaohongshu Image-Carousel Note
    await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_xhs_img",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "msg_xhs_img",
        from_user_id: "user@im.wechat",
        context_token: "ctx_xhs_dual",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: xhsImageShare } }],
      },
    });
    const processedImg = await f.pipeline.drainReadyQueue();
    expect(processedImg.length).toBe(1);
    const imgArticle = processedImg[0];
    expect(imgArticle.status).toBe("light_done");
    expect(imgArticle.source_md_path.startsWith(f.config.webArticlesDir!)).toBe(true);
    const imgMd = readFileSync(imgArticle.source_md_path, "utf-8");
    expect(imgMd).toContain("source_type: xiaohongshu_note");
    expect(imgMd).toContain("## 笔记配图（共 2 张）");
    expect(imgMd).toContain("## 图集卡片内容提取（Vision OCR）");
    expect(imgMd).toContain("ReAct 循环与 Plan-and-Execute 树状状态机对比");

    // 2. Process Xiaohongshu Spoken Video Note
    await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_xhs_vid",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "msg_xhs_vid",
        from_user_id: "user@im.wechat",
        context_token: "ctx_xhs_dual",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: xhsVideoShare } }],
      },
    });
    const processedVid = await f.pipeline.drainReadyQueue();
    expect(processedVid.length).toBe(1);
    const vidArticle = processedVid[0];
    expect(vidArticle.status).toBe("light_done");
    expect(vidArticle.source_md_path.startsWith(f.config.videoDir!)).toBe(true);
    expect(asrCalls).toEqual(["https://sns-video.xhscdn.com/stream_spoken.mp4"]);
    const vidMd = readFileSync(vidArticle.source_md_path, "utf-8");
    expect(vidMd).toContain("type: source");
    expect(vidMd).toContain("source_type: xiaohongshu_video");
    expect(vidMd).toContain("大家好，今天用三分钟讲透如何把小红书和抖音的口播干货自动沉淀进个人知识库");
  });

  test("Douyin Spoken Video & WeChat Native Video (type=5): transcribes audio into 01_inputs/video/ and cleans up temporary video files", async () => {
    const f = createAgentFixture(false);
    const asrMediaUrls: string[] = [];
    const asrLocalFilesExistDuringRun: boolean[] = [];

    setAsrTestRunner(async ({ mediaUrl, mediaPath }) => {
      if (mediaUrl) asrMediaUrls.push(mediaUrl);
      if (mediaPath) asrLocalFilesExistDuringRun.push(existsSync(mediaPath));
      return {
        transcript: "这段口播视频详细拆解了为什么大模型长周期记忆必须引入知识图谱与本体论约束。",
        engineUsed: "local_funasr",
      };
    });

    const douyinShareText =
      "4.89 复制打开抖音，看看【AI架构师的作品】为什么RAG需要知识图谱与本体 https://v.douyin.com/iYdouyin99/";
    const douyinRouterData = {
      loaderData: {
        "video_(id)/page": {
          videoInfoRes: {
            item_list: [
              {
                aweme_id: "7399887766554433221",
                desc: "为什么RAG需要知识图谱与本体 #AI #知识工程",
                create_time: 1747700000,
                author: { nickname: "AI架构师" },
                video: {
                  duration: 95000,
                  play_addr: {
                    url_list: ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200fg10000"],
                  },
                },
              },
            ],
          },
        },
      },
    };

    const rawAesKey = randomBytes(16);
    const encryptedVideoBytes = encryptAes128Ecb(Buffer.from("FAKE_MP4_BINARY_STREAM"), rawAesKey);

    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u === "https://v.douyin.com/iYdouyin99/") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://www.iesdouyin.com/share/video/7399887766554433221/" },
        });
      }
      if (u.includes("iesdouyin.com/share/video/7399887766554433221")) {
        return new Response(
          `<!DOCTYPE html><html><body><script>window._ROUTER_DATA = ${JSON.stringify(douyinRouterData)}</script></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      if (u.includes("wx_video_cdn_param_1")) {
        return new Response(new Uint8Array(encryptedVideoBytes), { status: 200 });
      }
      return Response.json({ ret: 0, typing_ticket: "tk" });
    }) as any;

    // 1. Douyin spoken video ingestion
    await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_dy_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "msg_dy_1",
        from_user_id: "user@im.wechat",
        context_token: "ctx_dy",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: douyinShareText } }],
      },
    });
    const processedDy = await f.pipeline.drainReadyQueue();
    expect(processedDy.length).toBe(1);
    const dyRecord = processedDy[0];
    expect(dyRecord.status).toBe("light_done");
    expect(dyRecord.source_md_path.startsWith(f.config.videoDir!)).toBe(true);
    // Watermark URL playwm/ must be converted to play/
    expect(asrMediaUrls).toEqual(["https://aweme.snssdk.com/aweme/v1/play/?video_id=v0200fg10000"]);
    const dyMd = readFileSync(dyRecord.source_md_path, "utf-8");
    expect(dyMd).toContain("type: source");
    expect(dyMd).toContain("source_type: douyin_video");
    expect(dyMd).toContain("这段口播视频详细拆解了为什么大模型长周期记忆必须引入知识图谱与本体论约束");

    // 2. Native WeChat video message (type=5) ingestion + temporary .mp4 deletion
    const wxVidRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_wxvid_2",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "msg_wxvid_2",
        from_user_id: "user@im.wechat",
        context_token: "ctx_wxvid",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: { text: "这段视频号讨论帮我转写归档" },
          },
          {
            type: 5,
            video_item: {
              media: {
                encrypt_query_param: "wx_video_cdn_param_1",
                aes_key: rawAesKey.toString("base64"),
              },
            },
          },
        ],
      },
    });
    expect(wxVidRes.replyText).toContain("已完成视频语音转写并归档至知识库");
    expect(asrLocalFilesExistDuringRun).toEqual([true]);
    const videoFilesInDir = readdirSync(f.config.videoDir!);
    expect(videoFilesInDir.some((name) => name.endsWith(".mp4"))).toBe(false);
    expect(videoFilesInDir.filter((name) => name.endsWith(".md")).length).toBeGreaterThanOrEqual(3);
    const inboxAssetsDir = join(f.config.inboxDir!, "assets");
    if (existsSync(inboxAssetsDir)) {
      expect(readdirSync(inboxAssetsDir).some((name) => name.endsWith(".mp4"))).toBe(false);
    }
  });
});
