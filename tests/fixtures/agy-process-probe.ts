import { mock, spyOn } from "bun:test";
import * as os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

const root = mkdtempSync(join(os.tmpdir(), "wx-agy-regression-"));
const fakeHome = join(root, "home");
mkdirSync(fakeHome);
mock.module("node:os", () => ({ ...os, homedir: () => fakeHome }));
const { runCliSubagent } = await import("../../src/agent/subagent_cli.ts");
const mode = process.argv[2];
const generated = join(root, "generated"); mkdirSync(generated);
const binary = join(root, "fake-agy"); writeFileSync(binary, "mock");
process.env.AGY_BIN = binary;
const calls: string[][] = [];
const stream = (text: string) => new Response(text).body;
spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
  calls.push(args);
  if (mode === "retry") {
    return { stdout: stream(calls.length === 1 ? "" : "DEFAULT_OUTPUT"),
      stderr: stream(calls.length === 1 ? "invalid model selection" : ""),
      exited: Promise.resolve(calls.length === 1 ? 1 : 0), kill() {} };
  }
  const expected = args[2].match(/建议路径：([^）]+)/)?.[1];
  const target = mode === "expected" ? expected! : join(generated, "other-task.png");
  writeFileSync(target, "IMAGE_FIXTURE");
  const now = new Date(Date.now() + 50); utimesSync(target, now, now);
  return { stdout: stream(mode === "failed" ? "" : "done"),
    stderr: stream(mode === "failed" ? "backend failed" : ""),
    exited: Promise.resolve(mode === "failed" ? 1 : 0), kill() {} };
}) as any);
const config: any = { projectRoot: root, dataDir: root, vaultRoot: root,
  llm: { allowCodexFallback: true, cliRoutingChain: ["agy"] } };
try {
  const result = await runCliSubagent({ config, backend: "agy", prompt: "fixture",
    preferredModel: "unsupported-model-fixture", expectGeneratedImage: mode !== "retry", timeoutMs: 100 });
  console.log(JSON.stringify({ ok: true, result, retriedWithoutModel: calls.length === 2 && !calls[1].includes("--model") }));
} catch (error: any) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
}
