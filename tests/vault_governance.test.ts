import "./support/isolation.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.ts";
import type { ContextDatabase, ScheduledTaskRecord } from "../src/db.ts";
import { parseGeneralHtmlToArticle } from "../src/extractor/web.ts";
import { renderSchedulerManagedBlock, syncScheduledTasksToVaultQueue } from "../src/scheduler/vault_sync.ts";

test("web captures resolve root, relative, query, fragment and nested image links", () => {
  const html = `<article><h1>Fixture</h1><p>${"Source evidence. ".repeat(20)}</p>
    <a href="/tag/ai?a=1&amp;b=2">AI</a><a href="../about">About</a>
    <a href="?source=author">Author</a><a href="#section">Section</a>
    <a href="//example.org/page">Other</a><a href="https://example.net/keep">Keep</a>
    <a href="/author"><img src="https://example.org/avatar.png" alt="Portrait"></a></article>`;
  const article = parseGeneralHtmlToArticle(html, "https://medium.com/publication/post")!;
  expect(article.markdownBody).toContain("[AI](https://medium.com/tag/ai?a=1&b=2)");
  expect(article.markdownBody).toContain("[About](https://medium.com/about)");
  expect(article.markdownBody).toContain("[Author](https://medium.com/publication/post?source=author)");
  expect(article.markdownBody).toContain("[Section](https://medium.com/publication/post#section)");
  expect(article.markdownBody).toContain("[Other](https://example.org/page)");
  expect(article.markdownBody).toContain("[Keep](https://example.net/keep)");
  expect(article.markdownBody).toContain("](https://medium.com/author)");
  expect(article.imageUrls).toEqual(["https://example.org/avatar.png"]);
  expect(article.publishDate).toBe("");
});

test("scheduler projections flatten, bound and escape titles without changing records", () => {
  const title = "A\n**bold** [link](x) <tag> | `code` " + "长".repeat(100);
  const tasks = [
    { id: 1, status: "active", schedule_type: "once" },
    { id: 2, status: "paused", schedule_type: "cron", cron_expr: "0 8 * * *" },
    { id: 3, status: "completed", schedule_type: "once" },
  ].map(t => ({ ...t, title, updated_at: "2026-11-06T00:00:00Z", timezone: "Asia/Shanghai" })) as ScheduledTaskRecord[];
  const before = JSON.stringify(tasks);
  const block = renderSchedulerManagedBlock(tasks);
  const rows = block.split("\n").filter(line => line.includes("**#"));
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row).toContain("A \\*\\*bold\\*\\* \\[link\\](x) &lt;tag&gt; \\| \\`code\\`");
    expect(row).toContain("...");
    expect(row.length).toBeLessThan(240);
  }
  expect(JSON.stringify(tasks)).toBe(before);

  const root = mkdtempSync(join(tmpdir(), "vault-governance-"));
  mkdirSync(join(root, "00_home"));
  const path = join(root, "00_home/queue.md");
  writeFileSync(path, "# User queue\n\nKeep this task.\n\n" + block + "\n\nKeep this footer.\n");
  const config = { vaultRoot: root, vaultMode: "structured_vault", vaultEnabled: true } as AppConfig;
  const db = { listScheduledTasks: () => tasks } as unknown as ContextDatabase;
  syncScheduledTasksToVaultQueue(config, db);
  const once = readFileSync(path, "utf8");
  syncScheduledTasksToVaultQueue(config, db);
  expect(readFileSync(path, "utf8")).toBe(once);
  expect(once).toStartWith("# User queue\n\nKeep this task.\n\n");
  expect(once).toEndWith("\n\nKeep this footer.\n");
});
