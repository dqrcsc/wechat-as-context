import { mock } from "bun:test";
import * as fs from "node:fs";
import { resolve, join } from "node:path";
const repo = resolve(import.meta.dir, "../..");
const envPath = join(repo, ".env");
const originalExists = fs.existsSync, originalRead = fs.readFileSync;
mock.module("node:fs", () => ({ ...fs,
  existsSync: (p: any) => String(p) === envPath ? true : originalExists(p),
  readFileSync: (p: any, ...args: any[]) => String(p) === envPath
    ? "IGNORE_HOME_DOTENV=true\nLLM_FAST_MODEL=project-fixture\nTASK_HEARTBEAT_SECONDS=0\n"
    : (originalRead as any)(p, ...args),
}));
process.env.IGNORE_HOME_DOTENV = "true";
process.env.LLM_FAST_MODEL = "shell-fixture";
process.env.TASK_HEARTBEAT_SECONDS = "60";
const { loadConfig } = await import("../../src/config.ts");
const startup = loadConfig(), reload = loadConfig(undefined, repo);
const injected = loadConfig({ IGNORE_HOME_DOTENV: "true", LLM_FAST_MODEL: "injected", TASK_HEARTBEAT_SECONDS: "12" }, repo);
console.log(JSON.stringify({ startup: [startup.llm.fastModel, startup.taskHeartbeatSeconds],
  reload: [reload.llm.fastModel, reload.taskHeartbeatSeconds], injected: [injected.llm.fastModel, injected.taskHeartbeatSeconds] }));
