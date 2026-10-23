import "./support/isolation.ts";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContextDatabase } from "../src/db.ts";
import { WeChatClawBotClient } from "../src/clawbot/client.ts";
import { createTestWorkspace } from "./support/workspace.ts";

const project = resolve(import.meta.dir, "..");
const outside = join(process.env.WXCTX_TEST_ROOT!, "..", "outside-test-boundary.db");
function seed(path: string) {
  const db = new ContextDatabase(path);
  db.setState("clawbot_credentials", JSON.stringify({ botToken: "fixture-token", baseUrl: "https://ilinkai.weixin.qq.com",
    botId: "fixture-bot", userId: "fixture-recipient", savedAt: new Date().toISOString() }));
  db.db.close();
}

test("isolated CLI ignores deployment dotenv/data and queues only in its fixture database", () => {
  const root = mkdtempSync(join(tmpdir(), "isolation-regression-"));
  const source = join(root, "deployment"), fixture = join(root, "fixture");
  mkdirSync(source); mkdirSync(fixture); mkdirSync(join(source, ".git"));
  cpSync(join(project, "src"), join(source, "src"), { recursive: true });
  cpSync(join(project, "package.json"), join(source, "package.json"));
  symlinkSync(join(project, "node_modules"), join(source, "node_modules"), "dir");
  const sentinelPath = join(source, "data", "wechat_context.db");
  seed(sentinelPath); seed(join(fixture, "wechat_context.db"));
  writeFileSync(join(source, ".env"), `WECHAT_CONTEXT_DATA_DIR=${join(source, "data")}\nOPENAI_API_KEY=must-not-leak\nVAULT_ROOT=none\n`);
  const sentinelFiles = [sentinelPath, sentinelPath + "-wal", sentinelPath + "-shm"];
  const snapshot = () => sentinelFiles.map(path => existsSync(path) ? readFileSync(path) : null);
  const sentinel = snapshot(), envBefore = readFileSync(join(source, ".env"));
  const isolated = createTestWorkspace(source);
  for (const omitted of [".env", "data", ".git"]) expect(existsSync(join(isolated.project, omitted))).toBe(false);
  expect((isolated.env as any).OPENAI_API_KEY).toBeUndefined();
  const cli = Bun.spawnSync([process.execPath, join(isolated.project, "src/cli.ts"), "push", "--text",
    "来自 CLI 的离线入队测试消息", "--queue-only", "--json"], {
    cwd: isolated.project,
    env: { WECHAT_CONTEXT_DATA_DIR: fixture, VAULT_ROOT: "none", IGNORE_HOME_DOTENV: "true" },
  });
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout.toString()).pendingCount).toBe(1);
  const db = new Database(join(fixture, "wechat_context.db"), { readonly: true });
  expect(db.query("SELECT text,status,attempts FROM reply_outbox").all()).toEqual([
    { text: "来自 CLI 的离线入队测试消息", status: "pending", attempts: 0 },
  ]); db.close();
  expect(snapshot()).toEqual(sentinel);
  expect(readFileSync(join(source, ".env"))).toEqual(envBefore);
});

test("database guard rejects parent traversal, readonly opens, URI paths and escaping symlinks", () => {
  expect(() => new ContextDatabase(outside)).toThrow("outside workspace");
  expect(() => new Database(outside, { readonly: true })).toThrow("outside workspace");
  expect(() => Database.open(outside)).toThrow("outside workspace");
  expect(() => new Database(`file:${outside}`)).toThrow("unsupported database path");
  const root = mkdtempSync(join(tmpdir(), "escape-"));
  const link = join(root, "outside"); symlinkSync("/", link, "dir");
  expect(() => new ContextDatabase(join(link, "tmp", "forbidden.db"))).toThrow("outside workspace");
  const dangling = join(root, "dangling.db"); symlinkSync(outside, dangling);
  expect(() => new Database(dangling)).toThrow();
  expect(existsSync(outside)).toBe(false);
});

test("unmocked WeChat text and media requests fail locally; mocks still work", async () => {
  const root = mkdtempSync(join(tmpdir(), "network-")), path = join(root, "db.sqlite");
  seed(path); const db = new ContextDatabase(path), client = new WeChatClawBotClient(db);
  const file = join(root, "file.txt"); writeFileSync(file, "fixture attachment");
  try {
    await expect(client.sendTextMessage("fixture-recipient", "never send")).rejects.toThrow("unmocked network request blocked");
    await expect(client.sendMediaFile("fixture-recipient", file)).rejects.toThrow("unmocked network request blocked");
    const blockedFetch = globalThis.fetch; let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ ret: 0 }); }) as any;
    try { await client.sendTextMessage("fixture-recipient", "mock only"); expect(calls).toBe(1); }
    finally { globalThis.fetch = blockedFetch; }
    await expect(fetch("https://example.invalid")).rejects.toThrow("unmocked network request blocked");
  } finally { db.db.close(); }
});

test("SQLite secondary file access is blocked in direct and prepared SQL", () => {
  const db = new Database(":memory:");
  try {
    for (const method of ["exec", "run", "query", "prepare"] as const) {
      expect(() => (db[method] as (sql: string) => unknown).call(db, "/* test */ ATTACH DATABASE ? AS other")).toThrow("SQL file access blocked");
      expect(() => (db[method] as (sql: string) => unknown).call(db, "VACUUM INTO ?")).toThrow("SQL file access blocked");
    }
    expect(() => db.exec("SELECT load_extension('fixture')")).toThrow("SQL file access blocked");
    expect(() => db.loadExtension("fixture")).toThrow("SQLite extensions blocked");
    expect(db.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
  } finally { db.close(); }
});

test("Bun child keeps database, HOME and network guards even with an empty environment", () => {
  const code = `
    import {Database} from 'bun:sqlite';
    let dbBlocked=false,networkBlocked=false;
    try {new Database(${JSON.stringify(outside)});} catch(e) {dbBlocked=String(e).includes('outside workspace');}
    try {await fetch('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage',{method:'POST'});} catch(e) {networkBlocked=String(e).includes('unmocked network request blocked');}
    console.log(JSON.stringify({dbBlocked,networkBlocked,home:process.env.HOME,root:process.env.WXCTX_TEST_ROOT}));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", code], { env: {} });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ dbBlocked: true, networkBlocked: true,
    home: process.env.HOME, root: process.env.WXCTX_TEST_ROOT });
  expect(() => Bun.spawnSync(["curl", "https://example.invalid"])).toThrow("external process blocked");
});

test("test workspace environment has no inherited model keys or injection options", () => {
  const source = mkdtempSync(join(tmpdir(), "empty-source-"));
  const saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "host-key-canary";
  try {
    const { env } = createTestWorkspace(source);
    expect(Object.keys(env).sort()).toEqual(["HOME", "IGNORE_HOME_DOTENV", "PATH", "TEMP", "TMP", "TMPDIR", "WXCTX_TEST_ROOT", "WXCTX_TEST_TOKEN"]);
    expect(JSON.stringify(env)).not.toContain("host-key-canary");
    expect(env.HOME).not.toBe(process.env.HOME);
  } finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
});
