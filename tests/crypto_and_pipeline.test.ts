import "./support/isolation.ts";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { extractTextFromClawBotMessage } from "../src/clawbot/client.ts";
import { parseWeChatHtmlToArticle } from "../src/extractor/wechat.ts";
import {
  ensureStarterVaultInitialized,
  findVaultFilesByQuery,
  gatherVaultContext,
} from "../src/vault/context.ts";
import { expandHomePath } from "../src/config.ts";

describe("wechat-as-context core modules", () => {
  test("extractTextFromClawBotMessage extracts text, voice transcription, and embedded WeChat URLs", () => {
    const msg = {
      message_id: "1001",
      from_user_id: "user@im.wechat",
      message_type: 1,
      item_list: [
        {
          type: 1,
          text_item: {
            text: "https://mp.weixin.qq.com/s/XyorU2Yx7tEsfbY1jqnRDg",
          },
        },
        {
          type: 3,
          voice_item: {
            text: "重点看看这篇对上下文工程的启发",
          },
        },
      ],
    };

    const extracted = extractTextFromClawBotMessage(msg);
    expect(extracted).toContain("https://mp.weixin.qq.com/s/XyorU2Yx7tEsfbY1jqnRDg");
    expect(extracted).toContain("重点看看这篇对上下文工程的启发");
  });

  test("parseWeChatHtmlToArticle extracts #js_content and metadata into clean Markdown", () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="Harness Engineering 与知识库架构演进" />
          <meta property="og:description" content="探讨如何将微信公众号文章变成 AI Agent 的高质量输入。" />
        </head>
        <body>
          <a id="js_name">架构深思录</a>
          <div id="js_content">
            <h2>一、为什么需要结构化输入</h2>
            <p>很多人的收藏夹沦为数字坟场，核心原因是缺乏与个人知识库的自动连接。</p>
            <img data-src="https://mmbiz.qpic.cn/mmbiz_png/demo/640?wx_fmt=png" alt="架构图" />
            <p>通过 <strong>Context Engineering</strong> 可以解决这一问题。</p>
          </div>
        </body>
      </html>
    `;

    const parsed = parseWeChatHtmlToArticle(
      sampleHtml,
      "https://mp.weixin.qq.com/s/demo123"
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("Harness Engineering 与知识库架构演进");
    expect(parsed!.author).toBe("架构深思录");
    expect(parsed!.markdownBody).toContain("## 一、为什么需要结构化输入");
    expect(parsed!.markdownBody).toContain("**Context Engineering**");
    expect(parsed!.imageUrls.length).toBe(1);
    expect(parsed!.imageUrls[0]).toContain("mmbiz.qpic.cn");
  });

  test("gatherVaultContext retrieves relevant nodes from an isolated vault", () => {
    const root = mkdtempSync(join(tmpdir(), "wx-vault-test-"));
    mkdirSync(join(root, "00_home")); mkdirSync(join(root, "03_ideas"));
    writeFileSync(join(root, "00_home/now.md"), "Current focus: Harness Engineering Context Engineering Agent knowledge systems");
    writeFileSync(join(root, "03_ideas/harness.md"), "Harness Engineering Context Engineering Agent 记忆管理与知识库");
    const ctx = gatherVaultContext(
      root,
      "Harness Engineering Context Engineering Agent 记忆管理与知识库"
    );
    expect(ctx.nowSummary.length).toBeGreaterThan(20);
    expect(ctx.matchedNotes.length).toBeGreaterThan(0);
  });

  test("gatherVaultContext and findVaultFilesByQuery support arbitrary non-numbered Obsidian vaults and custom domain terms", () => {
    const root = mkdtempSync(join(tmpdir(), "wx-obsidian-generic-"));
    mkdirSync(join(root, "Research", "Biotech"), { recursive: true });
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    writeFileSync(
      join(root, "now.md"),
      "Current research: **CRISPR基因编辑** and [[ProteinFolding]] in drug discovery."
    );
    writeFileSync(
      join(root, "Research", "Biotech", "ProteinFolding.md"),
      "# ProteinFolding\nAlphaFold and CRISPR基因编辑 accelerate therapeutic target discovery."
    );
    writeFileSync(
      join(root, ".obsidian", "workspace.md"),
      "CRISPR基因编辑 should be ignored in .obsidian hidden dir"
    );

    const ctx = gatherVaultContext(
      root,
      "最新关于 CRISPR基因编辑 与蛋白质设计的进展"
    );
    expect(ctx.nowSummary).toContain("CRISPR基因编辑");
    expect(ctx.matchedNotes.length).toBe(1);
    expect(ctx.matchedNotes[0].wikiLink).toBe("[[ProteinFolding]]");

    const found = findVaultFilesByQuery(root, "ProteinFolding");
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].relativePath).toBe(join("Research", "Biotech", "ProteinFolding.md"));
  });

  test("ensureStarterVaultInitialized creates starter directories and now.md without overwriting existing files", () => {
    const root = mkdtempSync(join(tmpdir(), "wx-starter-vault-"));
    const mockConfig: any = {
      projectRoot: root,
      dataDir: join(root, "data"),
      dbPath: join(root, "data", "db.sqlite"),
      vaultRoot: join(root, "my_vault"),
      wechatArticlesDir: join(root, "my_vault", "01_inputs", "articles", "wechat"),
      ideasSeedsDir: join(root, "my_vault", "03_ideas", "seeds"),
    };

    const firstInit = ensureStarterVaultInitialized(mockConfig);
    expect(firstInit.createdDirs.length).toBeGreaterThan(0);
    expect(firstInit.createdFiles.length).toBe(2);
    const nowPath = join(root, "my_vault", "00_home", "now.md");
    expect(existsSync(nowPath)).toBe(true);

    writeFileSync(nowPath, "CUSTOM USER FOCUS", "utf-8");
    const secondInit = ensureStarterVaultInitialized(mockConfig);
    expect(secondInit.createdFiles.length).toBe(0);
    expect(readFileSync(nowPath, "utf-8")).toBe("CUSTOM USER FOCUS");
    expect(expandHomePath("~/test_vault")).toContain("test_vault");
  });
});
