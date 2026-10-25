import "./support/isolation.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { ContextDatabase } from "../src/db.ts";
import { WeChatContextPipeline } from "../src/pipeline.ts";

test("automatic outbox maintenance preserves three old failures byte-for-byte without retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "wx-history-"));
  const config = loadConfig({ IGNORE_HOME_DOTENV: "true", VAULT_ROOT: "none", WECHAT_CONTEXT_DATA_DIR: root });
  const db = new ContextDatabase(config.dbPath);
  try {
    for (let i = 0; i < 3; i++) {
      db.queueReply(`failed-${i}`, "fixture", `historical-${i}`);
      db.db.query("UPDATE reply_outbox SET status = 'failed', attempts = 3, error = 'fixture failure' WHERE id = ?").run(`failed-${i}`);
    }
    const before = db.db.query("SELECT * FROM reply_outbox WHERE status = 'failed' ORDER BY id").all();
    for (let i = 0; i < 510; i++) {
      db.queueReply(`sent-${i}`, "fixture", "delivered");
      db.db.query("UPDATE reply_outbox SET status = 'sent' WHERE id = ?").run(`sent-${i}`);
    }
    // No credentials or network mock: any retry would fail the isolation boundary.
    await new WeChatContextPipeline(config, db).flushReplies();
    expect(db.db.query("SELECT * FROM reply_outbox WHERE status = 'failed' ORDER BY id").all()).toEqual(before);
    expect(db.db.query("SELECT count(*) AS n FROM reply_outbox WHERE status = 'sent'").get()).toEqual({ n: 500 });
  } finally { db.db.close(); }
});

test("a sent snapshot shared by a failed delivery remains available for diagnosis", () => {
  const root = mkdtempSync(join(tmpdir(), "wx-history-media-"));
  const db = new ContextDatabase(join(root, "test.db"));
  try {
    const source = join(root, "source.txt"); writeFileSync(source, "immutable fixture");
    db.queueMediaReply("sent", "fixture", "file", source);
    db.queueMediaReply("failed", "fixture", "file", source);
    db.db.query("UPDATE reply_outbox SET status = 'sent' WHERE id = 'sent'").run();
    db.db.query("UPDATE reply_outbox SET status = 'failed', attempts = 3 WHERE id = 'failed'").run();
    const row = db.db.query("SELECT media_path FROM reply_outbox WHERE id = 'failed'").get() as { media_path: string };
    expect(db.pruneSentOutboxMedia(0)).toBe(0);
    expect(readFileSync(row.media_path, "utf8")).toBe("immutable fixture");
  } finally { db.db.close(); }
});
