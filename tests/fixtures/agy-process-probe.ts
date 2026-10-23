import "../support/isolation.ts";
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
process.env.CODEX_BIN = binary;
const calls: string[][] = [];
const stream = (text: string) => new Response(text).body;
spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
  calls.push(args);
  if (mode === "retry") {
    return { stdout: stream(calls.length === 1 ? "" : "DEFAULT_OUTPUT"),
      stderr: stream(calls.length === 1 ? "invalid model selection" : ""),
      exited: Promise.resolve(calls.length === 1 ? 1 : 0), kill() {} };
  }
  if (mode === "agy_to_codex_fallback" && calls.length === 1) {
    return { stdout: stream(""), stderr: stream("agy timeout"), exited: Promise.resolve(1), kill() {} };
  }
  const fullArgStr = args.join("\n");
  const expected = fullArgStr.match(/建议路径：([^）\n]+)/)?.[1];
  const target = (mode === "expected" || mode === "codex_expected" || mode === "agy_to_codex_fallback") ? expected! : join(generated, "other-task.png");
  writeFileSync(target, "IMAGE_FIXTURE");
  const now = new Date(Date.now() + 50); utimesSync(target, now, now);
  return { stdout: stream(mode === "failed" ? "" : "done"),
    stderr: stream(mode === "failed" ? "backend failed" : ""),
    exited: Promise.resolve(mode === "failed" ? 1 : 0), kill() {} };
}) as any);
const chain = mode === "agy_to_codex_fallback" ? ["agy", "codex"] : mode === "codex_expected" ? ["codex"] : ["agy"];
const primaryBackend = mode === "codex_expected" ? "codex" : "agy";
const config: any = { projectRoot: root, dataDir: root, vaultRoot: root,
  llm: { allowCodexFallback: true, cliRoutingChain: chain } };
try {
  const result = await runCliSubagent({ config, backend: primaryBackend, prompt: "fixture",
    preferredModel: "unsupported-model-fixture", expectGeneratedImage: mode !== "retry", timeoutMs: 100 });
  console.log(JSON.stringify({ ok: true, result, callsCount: calls.length, retriedWithoutModel: calls.length === 2 && !calls[1].includes("--model") }));
} catch (error: any) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
}
